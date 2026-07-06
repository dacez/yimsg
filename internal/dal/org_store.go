package dal

import (
	"database/sql"
	"fmt"
	"strconv"

	"yimsg/internal/shard"
)

// OrgStore provides org operations（org_id 分片）。
//
// org_info / tag_info 是无 seq/status 的展示字典（与 group_info 同构，按需
// 查询、不参与同步）；tags 是组织架构唯一的同步域，任何结构变更
// bump org_version.max_seq 并留 tombstone；展示排序走 rank 索引、同步游标
// 走 seq 索引，两者正交。
type OrgStore struct{ db *shard.DB }

// NewOrgStore creates an OrgStore backed by the given shard.
func NewOrgStore(db *shard.DB) *OrgStore { return &OrgStore{db: db} }

const tagSelectFields = `org_id, tag_id, child_id, child_type, title, rank, sort_key, role, status, seq, created_at, updated_at`

// bumpOrgSeq 在事务内推进 org_version.max_seq 并返回新 seq（org 分片内单调）。
func bumpOrgSeq(tx *sql.Tx, orgID int64) (int64, error) {
	if _, err := tx.Exec(
		"INSERT INTO org_version (org_id, gc_safe_seq, max_seq) VALUES (?, 0, 1) ON CONFLICT(org_id) DO UPDATE SET max_seq = max_seq + 1",
		orgID,
	); err != nil {
		return 0, fmt.Errorf("bump org seq: %w", err)
	}
	var seq int64
	if err := tx.QueryRow("SELECT max_seq FROM org_version WHERE org_id = ?", orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("read org seq: %w", err)
	}
	return seq, nil
}

// ---- org_info：组织展示字典，无 seq/status，不参与同步 ----

// UpsertOrgInfo 写入或更新组织展示资料。
func (s *OrgStore) UpsertOrgInfo(orgID int64, name, avatar string, now int64) error {
	if _, err := s.db.Writer.Exec(
		`INSERT INTO org_info (org_id, name, avatar, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(org_id) DO UPDATE SET
		   name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
		orgID, name, avatar, now, now,
	); err != nil {
		return fmt.Errorf("upsert org info: %w", err)
	}
	return nil
}

// GetOrgInfo 返回单个组织展示资料，不存在返回 nil。
func (s *OrgStore) GetOrgInfo(orgID int64) (*OrgInfo, error) {
	row := s.db.Reader.QueryRow(
		`SELECT org_id, name, avatar, created_at, updated_at FROM org_info WHERE org_id = ?`, orgID,
	)
	o, err := scanOrgInfo(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get org info: %w", err)
	}
	return &o, nil
}

// ListOrgInfos 批量读取组织展示资料。
func (s *OrgStore) ListOrgInfos(orgIDs []int64) ([]OrgInfo, error) {
	ids := positiveInt64s(orgIDs)
	if len(ids) == 0 {
		return nil, nil
	}
	query := `SELECT org_id, name, avatar, created_at, updated_at FROM org_info
	 WHERE org_id IN (` + placeholders(len(ids)) + `)`
	return queryRows(s.db.Reader, "list org infos", query, scanOrgInfo, int64sToAny(ids)...)
}

func scanOrgInfo(row rowScanner) (OrgInfo, error) {
	var o OrgInfo
	err := row.Scan(&o.OrgID, &o.Name, &o.Avatar, &o.CreatedAt, &o.UpdatedAt)
	return o, err
}

// ---- tag_info：tag（部门/横向分组）展示字典，无 seq/status，不参与同步 ----

// UpsertTagInfo 写入或更新一个 tag 的展示资料（不改动其挂载关系）。
func (s *OrgStore) UpsertTagInfo(orgID, tagID int64, name, avatar string, now int64) error {
	if _, err := s.db.Writer.Exec(
		`INSERT INTO tag_info (org_id, tag_id, name, avatar, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(org_id, tag_id) DO UPDATE SET
		   name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
		orgID, tagID, name, avatar, now, now,
	); err != nil {
		return fmt.Errorf("upsert tag info: %w", err)
	}
	return nil
}

// RenameTagInfo 改 tag 展示名/头像，并在改名时于同事务内级联刷新"以其为
// 子 tag"的 ACTIVE 边 sort_key（tag 边无备注语义，投影即 tag 名），逐行 bump seq。
func (s *OrgStore) RenameTagInfo(orgID, tagID int64, name, avatar string, now int64) error {
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var oldName string
		hadRow := true
		if err := tx.QueryRow(
			"SELECT name FROM tag_info WHERE org_id = ? AND tag_id = ?", orgID, tagID,
		).Scan(&oldName); err != nil {
			if !isNoRows(err) {
				return err
			}
			hadRow = false
		}
		if _, err := tx.Exec(
			`INSERT INTO tag_info (org_id, tag_id, name, avatar, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(org_id, tag_id) DO UPDATE SET
			   name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
			orgID, tagID, name, avatar, now, now,
		); err != nil {
			return err
		}
		if hadRow && oldName != name {
			_, err := s.refreshEdgeSortKeys(tx, orgID, "child_type = ? AND child_id = ?",
				[]any{TagChildTag, tagID}, ContactSortKey("", name), now)
			return err
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("rename tag info: %w", err)
	}
	return nil
}

// GetTagInfo 返回单个 tag 展示资料，不存在返回 nil。
func (s *OrgStore) GetTagInfo(orgID, tagID int64) (*TagInfo, error) {
	row := s.db.Reader.QueryRow(
		`SELECT org_id, tag_id, name, avatar, created_at, updated_at FROM tag_info WHERE org_id = ? AND tag_id = ?`,
		orgID, tagID,
	)
	t, err := scanTagInfo(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get tag info: %w", err)
	}
	return &t, nil
}

// ListTagInfos 批量读取本组织内的 tag 展示资料。
func (s *OrgStore) ListTagInfos(orgID int64, tagIDs []int64) ([]TagInfo, error) {
	ids := positiveInt64s(tagIDs)
	if len(ids) == 0 {
		return nil, nil
	}
	query := `SELECT org_id, tag_id, name, avatar, created_at, updated_at FROM tag_info
	 WHERE org_id = ? AND tag_id IN (` + placeholders(len(ids)) + `)`
	args := append([]any{orgID}, int64sToAny(ids)...)
	return queryRows(s.db.Reader, "list tag infos", query, scanTagInfo, args...)
}

// DeleteTagInfo 物理删除 tag 字典行（无 tombstone），并墓碑两个方向的关联边
// （下挂边 tag_id=X、被挂边 child_type=TAG,child_id=X），同事务内逐行 bump seq。
// 被挂在别处的子节点不受影响（DAG）。
func (s *OrgStore) DeleteTagInfo(orgID, tagID int64, now int64) (bool, error) {
	var found bool
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		res, err := tx.Exec("DELETE FROM tag_info WHERE org_id = ? AND tag_id = ?", orgID, tagID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		found = n > 0
		if !found {
			return nil
		}
		return s.tombstoneEdges(tx, orgID, "(tag_id = ? OR (child_type = ? AND child_id = ?))",
			now, tagID, TagChildTag, tagID)
	})
	if err != nil {
		return false, fmt.Errorf("delete tag info: %w", err)
	}
	return found, nil
}

func scanTagInfo(row rowScanner) (TagInfo, error) {
	var t TagInfo
	err := row.Scan(&t.OrgID, &t.TagID, &t.Name, &t.Avatar, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// refreshEdgeSortKeys 重算命中谓词的 ACTIVE 边 sort_key，逐行 bump seq，返回变更行数。
func (s *OrgStore) refreshEdgeSortKeys(tx *sql.Tx, orgID int64, predicate string, predicateArgs []any, sortKey string, now int64) (int64, error) {
	args := append([]any{orgID}, predicateArgs...)
	args = append(args, TagActive, sortKey)
	rows, err := tx.Query(
		`SELECT tag_id, child_id, child_type FROM tags
		 WHERE org_id = ? AND `+predicate+` AND status = ? AND sort_key != ?`,
		args...,
	)
	if err != nil {
		return 0, err
	}
	type edgeKey struct {
		tagID, childID int64
		childType      uint8
	}
	var keys []edgeKey
	for rows.Next() {
		var k edgeKey
		if err := rows.Scan(&k.tagID, &k.childID, &k.childType); err != nil {
			rows.Close()
			return 0, err
		}
		keys = append(keys, k)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, k := range keys {
		seq, err := bumpOrgSeq(tx, orgID)
		if err != nil {
			return 0, err
		}
		if _, err := tx.Exec(
			`UPDATE tags SET sort_key = ?, seq = ?, updated_at = ?
			 WHERE org_id = ? AND tag_id = ? AND child_id = ? AND child_type = ?`,
			sortKey, seq, now, orgID, k.tagID, k.childID, k.childType,
		); err != nil {
			return 0, err
		}
	}
	return int64(len(keys)), nil
}

// tombstoneEdges 墓碑命中谓词的全部 ACTIVE 边，逐行 bump seq。
func (s *OrgStore) tombstoneEdges(tx *sql.Tx, orgID int64, predicate string, now int64, args ...any) error {
	queryArgs := append([]any{orgID}, args...)
	queryArgs = append(queryArgs, TagActive)
	rows, err := tx.Query(
		"SELECT tag_id, child_id, child_type FROM tags WHERE org_id = ? AND "+predicate+" AND status = ?",
		queryArgs...,
	)
	if err != nil {
		return err
	}
	type edgeKey struct {
		tagID, childID int64
		childType      uint8
	}
	var keys []edgeKey
	for rows.Next() {
		var k edgeKey
		if err := rows.Scan(&k.tagID, &k.childID, &k.childType); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, k := range keys {
		seq, err := bumpOrgSeq(tx, orgID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`UPDATE tags SET status = ?, seq = ?, updated_at = ?
			 WHERE org_id = ? AND tag_id = ? AND child_id = ? AND child_type = ?`,
			TagDeleted, seq, now, orgID, k.tagID, k.childID, k.childType,
		); err != nil {
			return err
		}
	}
	return nil
}

// ---- tags：唯一的同步域 ----

// UpsertTag 写入或更新一条关系边并 bump seq。
// 返回 (新 seq, 写入前该 child 在本组织是否已有其他 ACTIVE 边)；
// childType=TagChildTag 时第二个返回值恒为 true。
// 上层用 hadActive=false 判定"人的第一条边"以联动通讯录组织行。
func (s *OrgStore) UpsertTag(orgID, tagID, childID int64, childType uint8, title string, rank int64, sortKey string, role uint8, now int64) (int64, bool, error) {
	var newSeq int64
	hadActive := true
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		if childType == TagChildPerson {
			var count int64
			if err := tx.QueryRow(
				"SELECT COUNT(*) FROM tags WHERE org_id = ? AND child_type = ? AND child_id = ? AND status = ?",
				orgID, TagChildPerson, childID, TagActive,
			).Scan(&count); err != nil {
				return err
			}
			hadActive = count > 0
		}
		var err error
		newSeq, err = bumpOrgSeq(tx, orgID)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			`INSERT INTO tags (org_id, tag_id, child_id, child_type, title, rank, sort_key, role, status, seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(org_id, tag_id, child_id, child_type) DO UPDATE SET
			   title = excluded.title,
			   rank = excluded.rank,
			   sort_key = excluded.sort_key,
			   role = excluded.role,
			   status = excluded.status,
			   seq = excluded.seq,
			   updated_at = excluded.updated_at`,
			orgID, tagID, childID, childType, title, rank, sortKey, role, TagActive, newSeq, now, now,
		)
		return err
	})
	if err != nil {
		return 0, false, fmt.Errorf("upsert tag: %w", err)
	}
	return newSeq, hadActive, nil
}

// RemoveTag 墓碑一条边并 bump seq。
// 返回 (removed, 该 child 在本组织是否仍有其他 ACTIVE 边)；
// 上层用 stillActive=false 判定"人的最后一条边"（离职）。
func (s *OrgStore) RemoveTag(orgID, tagID, childID int64, childType uint8, now int64) (bool, bool, error) {
	var found bool
	stillActive := false
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var exists int
		if err := tx.QueryRow(
			"SELECT 1 FROM tags WHERE org_id = ? AND tag_id = ? AND child_id = ? AND child_type = ? AND status = ?",
			orgID, tagID, childID, childType, TagActive,
		).Scan(&exists); err != nil {
			if isNoRows(err) {
				return nil
			}
			return err
		}
		found = true

		seq, err := bumpOrgSeq(tx, orgID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`UPDATE tags SET status = ?, seq = ?, updated_at = ?
			 WHERE org_id = ? AND tag_id = ? AND child_id = ? AND child_type = ?`,
			TagDeleted, seq, now, orgID, tagID, childID, childType,
		); err != nil {
			return err
		}
		if childType == TagChildPerson {
			var count int64
			if err := tx.QueryRow(
				"SELECT COUNT(*) FROM tags WHERE org_id = ? AND child_type = ? AND child_id = ? AND status = ?",
				orgID, TagChildPerson, childID, TagActive,
			).Scan(&count); err != nil {
				return err
			}
			stillActive = count > 0
		}
		return nil
	})
	if err != nil {
		return false, false, fmt.Errorf("remove tag: %w", err)
	}
	return found, stillActive, nil
}

// ListTagsPage 是展开的展示通道 keyset 分页：仅 ACTIVE 行，
// 展示序 (rank, sort_key, child_type, child_id) 升序，索引即最终顺序。
// cursorParts 为不透明游标解码后的 keyset 字段 [rank, sort_key, child_type, child_id]；
// backward=true 时按反方向查询，调用方需把结果反转回展示序。
func (s *OrgStore) ListTagsPage(orgID, tagID int64, cursorParts []string, backward bool, limit int64) ([]Tag, error) {
	where := "org_id = ? AND tag_id = ? AND status = ?"
	args := []interface{}{orgID, tagID, TagActive}

	orderBy := "rank, sort_key, child_type, child_id"
	if backward {
		orderBy = "rank DESC, sort_key DESC, child_type DESC, child_id DESC"
	}
	if len(cursorParts) >= 4 {
		rank, err1 := strconv.ParseInt(cursorParts[0], 10, 64)
		childType, err2 := strconv.ParseInt(cursorParts[2], 10, 64)
		childID, err3 := strconv.ParseInt(cursorParts[3], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			return nil, fmt.Errorf("invalid tag cursor")
		}
		if backward {
			where += " AND (rank, sort_key, child_type, child_id) < (?, ?, ?, ?)"
		} else {
			where += " AND (rank, sort_key, child_type, child_id) > (?, ?, ?, ?)"
		}
		args = append(args, rank, cursorParts[1], childType, childID)
	}

	args = append(args, limit)
	return queryRows(s.db.Reader, "list tags page",
		`SELECT `+tagSelectFields+`
		 FROM tags WHERE `+where+`
		 ORDER BY `+orderBy+` LIMIT ?`,
		scanTag, args...,
	)
}

// SyncPage 返回 seq > afterSeq 的一页增量关系边（含 tombstone）。
func (s *OrgStore) SyncPage(orgID, afterSeq, limit int64) ([]Tag, bool, error) {
	probe := limit + 1
	rows, err := queryRows(s.db.Reader, "sync tags",
		`SELECT `+tagSelectFields+` FROM tags
		 WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		scanTag, orgID, afterSeq, probe,
	)
	if err != nil {
		return nil, false, err
	}
	hasMore := int64(len(rows)) > limit
	if hasMore {
		rows = rows[:limit]
	}
	return rows, hasMore, nil
}

// ListDirectMemberUIDs 返回某父节点直属 ACTIVE 人边的 uid 列表。
func (s *OrgStore) ListDirectMemberUIDs(orgID, tagID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT child_id FROM tags WHERE org_id = ? AND tag_id = ? AND child_type = ? AND status = ?",
		orgID, tagID, TagChildPerson, TagActive,
	)
	if err != nil {
		return nil, fmt.Errorf("list org direct member uids: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

// ActiveMemberUIDs 返回本组织全体 ACTIVE 成员 uid（去重），供通知扇出。
func (s *OrgStore) ActiveMemberUIDs(orgID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT DISTINCT child_id FROM tags WHERE org_id = ? AND child_type = ? AND status = ?",
		orgID, TagChildPerson, TagActive,
	)
	if err != nil {
		return nil, fmt.Errorf("list org member uids: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

// UpdateMemberSortKeys 在成员昵称变化时重算其全部 ACTIVE 边的 sort_key，逐行 bump seq。
// 返回变更行数；0 表示投影已一致，无需扇出。
func (s *OrgStore) UpdateMemberSortKeys(orgID, uid int64, sortKey string, now int64) (int64, error) {
	var changed int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var err error
		changed, err = s.refreshEdgeSortKeys(tx, orgID, "child_type = ? AND child_id = ?",
			[]any{TagChildPerson, uid}, sortKey, now)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("update org member sort keys: %w", err)
	}
	return changed, nil
}

// WouldCreateCycle 报告把 childTagID 挂到 parentTagID 下是否成环：
// 从 childTagID 沿 ACTIVE tag 边向下 BFS，可达集合中出现 parentTagID 即成环。
func (s *OrgStore) WouldCreateCycle(orgID, parentTagID, childTagID int64) (bool, error) {
	if parentTagID == childTagID {
		return true, nil
	}
	visited := map[int64]struct{}{childTagID: {}}
	frontier := []int64{childTagID}
	for len(frontier) > 0 {
		next := make([]int64, 0)
		for _, tagID := range frontier {
			rows, err := s.db.Reader.Query(
				"SELECT child_id FROM tags WHERE org_id = ? AND tag_id = ? AND child_type = ? AND status = ?",
				orgID, tagID, TagChildTag, TagActive,
			)
			if err != nil {
				return false, fmt.Errorf("org cycle check: %w", err)
			}
			children, err := scanInt64Rows(rows)
			rows.Close()
			if err != nil {
				return false, fmt.Errorf("org cycle check: %w", err)
			}
			for _, child := range children {
				if child == parentTagID {
					return true, nil
				}
				if _, ok := visited[child]; ok {
					continue
				}
				visited[child] = struct{}{}
				next = append(next, child)
			}
		}
		frontier = next
	}
	return false, nil
}

// GetVersion returns the gc_safe_seq and max_seq for an org.
func (s *OrgStore) GetVersion(orgID int64) (gcSafeSeq, maxSeq int64, err error) {
	var version SyncVersion
	e := s.db.Reader.QueryRow(
		"SELECT gc_safe_seq, max_seq FROM org_version WHERE org_id = ?", orgID,
	).Scan(&version.GCSafeSeq, &version.MaxSeq)
	if e != nil {
		if isNoRows(e) {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("get org version: %w", e)
	}
	return version.GCSafeSeq, version.MaxSeq, nil
}

// Purge 物理删除本组织关系表 tombstone 并升 gc_safe_seq 水位线（三步同事务）。
func (s *OrgStore) Purge(orgID int64) (int64, error) {
	var deleted int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var maxSeq int64
		if err := tx.QueryRow(
			"SELECT COALESCE(MAX(seq), 0) FROM tags WHERE org_id = ? AND status = ?",
			orgID, TagDeleted,
		).Scan(&maxSeq); err != nil {
			return err
		}
		if maxSeq == 0 {
			return nil
		}

		res, err := tx.Exec("DELETE FROM tags WHERE org_id = ? AND status = ?", orgID, TagDeleted)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		deleted = n

		_, err = tx.Exec(
			`INSERT INTO org_version (org_id, gc_safe_seq, max_seq) VALUES (?, ?, ?)
			 ON CONFLICT(org_id) DO UPDATE SET
			   gc_safe_seq = MAX(org_version.gc_safe_seq, excluded.gc_safe_seq),
			   max_seq = MAX(org_version.max_seq, excluded.max_seq)`,
			orgID, maxSeq, maxSeq,
		)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("org gc: %w", err)
	}
	return deleted, nil
}

// ListPurgeable returns up to limit org IDs that have relation tombstones.
func (s *OrgStore) ListPurgeable(limit, afterOrgID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		`SELECT DISTINCT org_id FROM tags WHERE status = ? AND org_id > ? ORDER BY org_id ASC LIMIT ?`,
		TagDeleted, afterOrgID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list purgeable orgs: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

func scanTag(row rowScanner) (Tag, error) {
	var r Tag
	err := row.Scan(&r.OrgID, &r.TagID, &r.ChildID, &r.ChildType, &r.Title, &r.Rank, &r.SortKey, &r.Role, &r.Status, &r.Seq, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}
