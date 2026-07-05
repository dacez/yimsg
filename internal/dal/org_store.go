package dal

import (
	"database/sql"
	"fmt"
	"strconv"

	"yimsg/internal/shard"
)

// OrgStore provides org tag graph operations（org_id 分片）。
//
// tag 图是标准同步域：节点（org_tag）与边（org_tag_item）共用 org_version.max_seq
// 单一 seq 空间，任何结构变更 bump seq 并留 tombstone；展示排序走 rank 索引、
// 同步游标走 seq 索引，两者正交。
type OrgStore struct{ db *shard.DB }

// NewOrgStore creates an OrgStore backed by the given shard.
func NewOrgStore(db *shard.DB) *OrgStore { return &OrgStore{db: db} }

const orgTagSelectFields = `org_id, tag_id, name, avatar, status, seq, created_at, updated_at`
const orgTagItemSelectFields = `org_id, tag_id, child_tag_id, uid, title, rank, sort_key, status, seq, created_at, updated_at`

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

// UpsertTag 写入或更新一个 tag 节点（根 tag 传 tagID == orgID）并 bump seq。
// 改名时在同事务内级联重算"以其为子 tag"的边的 sort_key 并逐行 bump seq。
func (s *OrgStore) UpsertTag(orgID, tagID int64, name, avatar string, now int64) (int64, error) {
	var newSeq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var oldName string
		hadRow := true
		if err := tx.QueryRow(
			"SELECT name FROM org_tag WHERE org_id = ? AND tag_id = ? AND status = ?",
			orgID, tagID, OrgTagActive,
		).Scan(&oldName); err != nil {
			if !isNoRows(err) {
				return err
			}
			hadRow = false
		}

		var err error
		newSeq, err = bumpOrgSeq(tx, orgID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO org_tag (org_id, tag_id, name, avatar, status, seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(org_id, tag_id) DO UPDATE SET
			   name = excluded.name,
			   avatar = excluded.avatar,
			   status = excluded.status,
			   seq = excluded.seq,
			   updated_at = excluded.updated_at`,
			orgID, tagID, name, avatar, OrgTagActive, newSeq, now, now,
		); err != nil {
			return err
		}

		// 改名级联：以其为子 tag 的 ACTIVE 边重算 sort_key（tag 边无备注语义，投影即 tag 名）。
		if hadRow && oldName != name {
			_, err := s.refreshEdgeSortKeys(tx, orgID, "child_tag_id = ?", tagID, ContactSortKey("", name), now)
			return err
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("upsert org tag: %w", err)
	}
	return newSeq, nil
}

// refreshEdgeSortKeys 重算命中谓词的 ACTIVE 边 sort_key，逐行 bump seq，返回变更行数。
func (s *OrgStore) refreshEdgeSortKeys(tx *sql.Tx, orgID int64, predicate string, keyID int64, sortKey string, now int64) (int64, error) {
	rows, err := tx.Query(
		`SELECT tag_id, child_tag_id, uid FROM org_tag_item
		 WHERE org_id = ? AND `+predicate+` AND status = ? AND sort_key != ?`,
		orgID, keyID, OrgTagActive, sortKey,
	)
	if err != nil {
		return 0, err
	}
	type edgeKey struct{ tagID, childTagID, uid int64 }
	var keys []edgeKey
	for rows.Next() {
		var k edgeKey
		if err := rows.Scan(&k.tagID, &k.childTagID, &k.uid); err != nil {
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
			`UPDATE org_tag_item SET sort_key = ?, seq = ?, updated_at = ?
			 WHERE org_id = ? AND tag_id = ? AND child_tag_id = ? AND uid = ?`,
			sortKey, seq, now, orgID, k.tagID, k.childTagID, k.uid,
		); err != nil {
			return 0, err
		}
	}
	return int64(len(keys)), nil
}

// GetTag 返回单个 tag 节点（含 tombstone），不存在返回 nil。
func (s *OrgStore) GetTag(orgID, tagID int64) (*OrgTag, error) {
	row := s.db.Reader.QueryRow(
		`SELECT `+orgTagSelectFields+` FROM org_tag WHERE org_id = ? AND tag_id = ?`,
		orgID, tagID,
	)
	t, err := scanOrgTag(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get org tag: %w", err)
	}
	return &t, nil
}

// ListInfos 批量读取组织展示资料：根 tag（tag_id == org_id）的 ACTIVE 行投影。
func (s *OrgStore) ListInfos(orgIDs []int64) ([]OrgTag, error) {
	ids := positiveInt64s(orgIDs)
	if len(ids) == 0 {
		return nil, nil
	}
	query := `SELECT ` + orgTagSelectFields + ` FROM org_tag
	 WHERE org_id IN (` + placeholders(len(ids)) + `) AND tag_id = org_id AND status = ?`
	args := append(int64sToAny(ids), OrgTagActive)
	return queryRows(s.db.Reader, "list org infos", query, scanOrgTag, args...)
}

// DeleteTag 墓碑一个 tag 节点及其两个方向的关联边（下挂边 tag_id=X、被挂边 child_tag_id=X），
// 同事务内逐行 bump seq。被挂在别处的子节点不受影响（DAG）。根 tag 不允许删除。
func (s *OrgStore) DeleteTag(orgID, tagID int64, now int64) (bool, error) {
	if tagID == orgID {
		return false, fmt.Errorf("delete org tag: cannot delete root tag")
	}
	var found bool
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var exists int
		if err := tx.QueryRow(
			"SELECT 1 FROM org_tag WHERE org_id = ? AND tag_id = ? AND status = ?",
			orgID, tagID, OrgTagActive,
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
			"UPDATE org_tag SET status = ?, seq = ?, updated_at = ? WHERE org_id = ? AND tag_id = ?",
			OrgTagDeleted, seq, now, orgID, tagID,
		); err != nil {
			return err
		}
		return s.tombstoneEdges(tx, orgID, "(tag_id = ? OR child_tag_id = ?)", now, tagID, tagID)
	})
	if err != nil {
		return false, fmt.Errorf("delete org tag: %w", err)
	}
	return found, nil
}

// tombstoneEdges 墓碑命中谓词的全部 ACTIVE 边，逐行 bump seq。
func (s *OrgStore) tombstoneEdges(tx *sql.Tx, orgID int64, predicate string, now int64, args ...any) error {
	queryArgs := append([]any{orgID}, args...)
	queryArgs = append(queryArgs, OrgTagActive)
	rows, err := tx.Query(
		"SELECT tag_id, child_tag_id, uid FROM org_tag_item WHERE org_id = ? AND "+predicate+" AND status = ?",
		queryArgs...,
	)
	if err != nil {
		return err
	}
	type edgeKey struct{ tagID, childTagID, uid int64 }
	var keys []edgeKey
	for rows.Next() {
		var k edgeKey
		if err := rows.Scan(&k.tagID, &k.childTagID, &k.uid); err != nil {
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
			`UPDATE org_tag_item SET status = ?, seq = ?, updated_at = ?
			 WHERE org_id = ? AND tag_id = ? AND child_tag_id = ? AND uid = ?`,
			OrgTagDeleted, seq, now, orgID, k.tagID, k.childTagID, k.uid,
		); err != nil {
			return err
		}
	}
	return nil
}

// UpsertItem 写入或更新一条边（child_tag_id 与 uid 互斥）并 bump seq。
// 返回 (新 seq, 写入前该 uid 在本组织是否已有其他 ACTIVE 边)；uid=0（tag 边）时第二个返回值恒为 true。
// 上层用 hadActive=false 判定"第一条边"以联动通讯录组织行。
func (s *OrgStore) UpsertItem(orgID, tagID, childTagID, uid int64, title string, rank int64, sortKey string, now int64) (int64, bool, error) {
	if (childTagID == 0) == (uid == 0) {
		return 0, false, fmt.Errorf("upsert org tag item: child_tag_id and uid are mutually exclusive")
	}
	var newSeq int64
	hadActive := true
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		if uid > 0 {
			var count int64
			if err := tx.QueryRow(
				"SELECT COUNT(*) FROM org_tag_item WHERE org_id = ? AND uid = ? AND status = ?",
				orgID, uid, OrgTagActive,
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
			`INSERT INTO org_tag_item (org_id, tag_id, child_tag_id, uid, title, rank, sort_key, status, seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(org_id, tag_id, child_tag_id, uid) DO UPDATE SET
			   title = excluded.title,
			   rank = excluded.rank,
			   sort_key = excluded.sort_key,
			   status = excluded.status,
			   seq = excluded.seq,
			   updated_at = excluded.updated_at`,
			orgID, tagID, childTagID, uid, title, rank, sortKey, OrgTagActive, newSeq, now, now,
		)
		return err
	})
	if err != nil {
		return 0, false, fmt.Errorf("upsert org tag item: %w", err)
	}
	return newSeq, hadActive, nil
}

// RemoveItem 墓碑一条边并 bump seq。
// 返回 (removed, uid 在本组织是否仍有其他 ACTIVE 边)；上层用 stillActive=false 判定"最后一条边"（离职）。
func (s *OrgStore) RemoveItem(orgID, tagID, childTagID, uid int64, now int64) (bool, bool, error) {
	var found bool
	stillActive := false
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var exists int
		if err := tx.QueryRow(
			"SELECT 1 FROM org_tag_item WHERE org_id = ? AND tag_id = ? AND child_tag_id = ? AND uid = ? AND status = ?",
			orgID, tagID, childTagID, uid, OrgTagActive,
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
			`UPDATE org_tag_item SET status = ?, seq = ?, updated_at = ?
			 WHERE org_id = ? AND tag_id = ? AND child_tag_id = ? AND uid = ?`,
			OrgTagDeleted, seq, now, orgID, tagID, childTagID, uid,
		); err != nil {
			return err
		}
		if uid > 0 {
			var count int64
			if err := tx.QueryRow(
				"SELECT COUNT(*) FROM org_tag_item WHERE org_id = ? AND uid = ? AND status = ?",
				orgID, uid, OrgTagActive,
			).Scan(&count); err != nil {
				return err
			}
			stillActive = count > 0
		}
		return nil
	})
	if err != nil {
		return false, false, fmt.Errorf("remove org tag item: %w", err)
	}
	return found, stillActive, nil
}

// ListItemsPage 是 tag 展开的展示通道 keyset 分页：仅 ACTIVE 行，
// 展示序 (rank, sort_key, child_tag_id, uid) 升序，索引即最终顺序。
// cursorParts 为不透明游标解码后的 keyset 字段 [rank, sort_key, child_tag_id, uid]；
// backward=true 时按反方向查询，调用方需把结果反转回展示序。
func (s *OrgStore) ListItemsPage(orgID, tagID int64, cursorParts []string, backward bool, limit int64) ([]OrgTagItem, error) {
	where := "org_id = ? AND tag_id = ? AND status = ?"
	args := []interface{}{orgID, tagID, OrgTagActive}

	orderBy := "rank, sort_key, child_tag_id, uid"
	if backward {
		orderBy = "rank DESC, sort_key DESC, child_tag_id DESC, uid DESC"
	}
	if len(cursorParts) >= 4 {
		rank, err1 := strconv.ParseInt(cursorParts[0], 10, 64)
		childTagID, err2 := strconv.ParseInt(cursorParts[2], 10, 64)
		uid, err3 := strconv.ParseInt(cursorParts[3], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			return nil, fmt.Errorf("invalid org tag item cursor")
		}
		if backward {
			where += " AND (rank, sort_key, child_tag_id, uid) < (?, ?, ?, ?)"
		} else {
			where += " AND (rank, sort_key, child_tag_id, uid) > (?, ?, ?, ?)"
		}
		args = append(args, rank, cursorParts[1], childTagID, uid)
	}

	args = append(args, limit)
	return queryRows(s.db.Reader, "list org tag items page",
		`SELECT `+orgTagItemSelectFields+`
		 FROM org_tag_item WHERE `+where+`
		 ORDER BY `+orderBy+` LIMIT ?`,
		scanOrgTagItem, args...,
	)
}

// ListTagNames 批量读取 ACTIVE tag 的 (name, avatar)，供展开响应填充子 tag 展示字段。
func (s *OrgStore) ListTagNames(orgID int64, tagIDs []int64) (map[int64][2]string, error) {
	ids := positiveInt64s(tagIDs)
	result := make(map[int64][2]string, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	query := `SELECT tag_id, name, avatar FROM org_tag
	 WHERE org_id = ? AND tag_id IN (` + placeholders(len(ids)) + `) AND status = ?`
	args := append([]any{orgID}, int64sToAny(ids)...)
	args = append(args, OrgTagActive)
	rows, err := s.db.Reader.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list org tag names: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var tagID int64
		var name, avatar string
		if err := rows.Scan(&tagID, &name, &avatar); err != nil {
			return nil, fmt.Errorf("list org tag names: %w", err)
		}
		result[tagID] = [2]string{name, avatar}
	}
	return result, rows.Err()
}

// SyncPage 返回 seq > afterSeq 的一页增量：节点与边按 seq 升序合并计数（含 tombstone）。
// 调用方传 limit+1 探测 has_more 的语义由本方法内联处理：返回 (tags, items, hasMore)。
func (s *OrgStore) SyncPage(orgID, afterSeq, limit int64) ([]OrgTag, []OrgTagItem, bool, error) {
	probe := limit + 1
	tags, err := queryRows(s.db.Reader, "sync org tags",
		`SELECT `+orgTagSelectFields+` FROM org_tag
		 WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		scanOrgTag, orgID, afterSeq, probe,
	)
	if err != nil {
		return nil, nil, false, err
	}
	items, err := queryRows(s.db.Reader, "sync org tag items",
		`SELECT `+orgTagItemSelectFields+` FROM org_tag_item
		 WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		scanOrgTagItem, orgID, afterSeq, probe,
	)
	if err != nil {
		return nil, nil, false, err
	}

	// 两路按 seq 归并，截断到 limit：seq 在 org 内全局唯一，归并即全序。
	total := int64(len(tags) + len(items))
	hasMore := total > limit
	var outTags []OrgTag
	var outItems []OrgTagItem
	ti, ii := 0, 0
	for int64(len(outTags)+len(outItems)) < limit && (ti < len(tags) || ii < len(items)) {
		takeTag := ii >= len(items) || (ti < len(tags) && tags[ti].Seq < items[ii].Seq)
		if takeTag {
			outTags = append(outTags, tags[ti])
			ti++
		} else {
			outItems = append(outItems, items[ii])
			ii++
		}
	}
	return outTags, outItems, hasMore, nil
}

// ListDirectMemberUIDs 返回某 tag 直属 ACTIVE 人边的 uid 列表。
func (s *OrgStore) ListDirectMemberUIDs(orgID, tagID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT uid FROM org_tag_item WHERE org_id = ? AND tag_id = ? AND uid > 0 AND status = ?",
		orgID, tagID, OrgTagActive,
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
		"SELECT DISTINCT uid FROM org_tag_item WHERE org_id = ? AND uid > 0 AND status = ?",
		orgID, OrgTagActive,
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
		changed, err = s.refreshEdgeSortKeys(tx, orgID, "uid = ?", uid, sortKey, now)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("update org member sort keys: %w", err)
	}
	return changed, nil
}

// WouldCreateCycle 报告把 childTagID 挂到 parentTagID 下是否成环：
// 从 childTagID 沿 ACTIVE 边向下 BFS，可达集合中出现 parentTagID 即成环。
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
				"SELECT child_tag_id FROM org_tag_item WHERE org_id = ? AND tag_id = ? AND child_tag_id > 0 AND status = ?",
				orgID, tagID, OrgTagActive,
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

// Purge 物理删除本组织节点与边的 tombstone 并升 gc_safe_seq 水位线（三步同事务）。
func (s *OrgStore) Purge(orgID int64) (int64, error) {
	var deleted int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var maxTagSeq, maxItemSeq int64
		if err := tx.QueryRow(
			"SELECT COALESCE(MAX(seq), 0) FROM org_tag WHERE org_id = ? AND status = ?",
			orgID, OrgTagDeleted,
		).Scan(&maxTagSeq); err != nil {
			return err
		}
		if err := tx.QueryRow(
			"SELECT COALESCE(MAX(seq), 0) FROM org_tag_item WHERE org_id = ? AND status = ?",
			orgID, OrgTagDeleted,
		).Scan(&maxItemSeq); err != nil {
			return err
		}
		maxDeletedSeq := maxTagSeq
		if maxItemSeq > maxDeletedSeq {
			maxDeletedSeq = maxItemSeq
		}
		if maxDeletedSeq == 0 {
			return nil
		}

		r1, err := tx.Exec("DELETE FROM org_tag WHERE org_id = ? AND status = ?", orgID, OrgTagDeleted)
		if err != nil {
			return err
		}
		r2, err := tx.Exec("DELETE FROM org_tag_item WHERE org_id = ? AND status = ?", orgID, OrgTagDeleted)
		if err != nil {
			return err
		}
		n1, _ := r1.RowsAffected()
		n2, _ := r2.RowsAffected()
		deleted = n1 + n2

		_, err = tx.Exec(
			`INSERT INTO org_version (org_id, gc_safe_seq, max_seq) VALUES (?, ?, ?)
			 ON CONFLICT(org_id) DO UPDATE SET
			   gc_safe_seq = MAX(org_version.gc_safe_seq, excluded.gc_safe_seq),
			   max_seq = MAX(org_version.max_seq, excluded.max_seq)`,
			orgID, maxDeletedSeq, maxDeletedSeq,
		)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("org gc: %w", err)
	}
	return deleted, nil
}

// ListPurgeable returns up to limit org IDs that have tag graph tombstones.
func (s *OrgStore) ListPurgeable(limit, afterOrgID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		`SELECT org_id FROM (
		   SELECT org_id FROM org_tag WHERE status = ?
		   UNION
		   SELECT org_id FROM org_tag_item WHERE status = ?
		 ) WHERE org_id > ? ORDER BY org_id ASC LIMIT ?`,
		OrgTagDeleted, OrgTagDeleted, afterOrgID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list purgeable orgs: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

func scanOrgTag(row rowScanner) (OrgTag, error) {
	var t OrgTag
	err := row.Scan(&t.OrgID, &t.TagID, &t.Name, &t.Avatar, &t.Status, &t.Seq, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func scanOrgTagItem(row rowScanner) (OrgTagItem, error) {
	var i OrgTagItem
	err := row.Scan(&i.OrgID, &i.TagID, &i.ChildTagID, &i.UID, &i.Title, &i.Rank, &i.SortKey, &i.Status, &i.Seq, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}
