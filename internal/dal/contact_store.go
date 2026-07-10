package dal

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"yimsg/internal/shard"
)

// ContactStore provides contact-related database operations.
// contacts 表是“通讯录排序/搜索投影 + 同步流”，不是普通 cache：
// sort_key 用于分页排序，search_text 用于搜索，二者都是投影，真实展示名由上层按
// remark_name 与 profile/group info 实时计算。
type ContactStore struct{ db *shard.DB }

// NewContactStore creates a ContactStore backed by the given shard.
func NewContactStore(db *shard.DB) *ContactStore { return &ContactStore{db: db} }

const contactSelectFields = `uid, type, id, status, remark_name, sort_key, search_text, seq, created_at, updated_at`

// normalizeName 归一化排序键基串：去空白并转小写。第一版用小写归一化，后续可扩展拼音/首字母。
func normalizeName(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// ContactSortKey 计算通讯录排序键投影：有备注按备注，否则按昵称/群名归一化。
func ContactSortKey(remarkName, displayName string) string {
	base := remarkName
	if strings.TrimSpace(base) == "" {
		base = displayName
	}
	return normalizeName(base)
}

// ContactSearchText 计算通讯录搜索投影：拼接 remark_name 与昵称/群名，明确不含 username。
// 后端与前端本地持久层规则保持一致。
func ContactSearchText(remarkName, displayName string) string {
	parts := make([]string, 0, 2)
	if r := strings.TrimSpace(remarkName); r != "" {
		parts = append(parts, r)
	}
	if d := strings.TrimSpace(displayName); d != "" {
		parts = append(parts, d)
	}
	return strings.Join(parts, " ")
}

// Upsert inserts or updates a contact and bumps max_seq. Returns the new seq.
// sortKey/searchText 由上层基于 remark_name 与昵称/群名/组织名预先算好传入。
func contactStorageKey(friendUID, groupID, orgID int64) (int64, int64) {
	switch {
	case friendUID > 0:
		return ContactTypeFriend, friendUID
	case groupID > 0:
		return ContactTypeGroup, groupID
	case orgID > 0:
		return ContactTypeOrg, orgID
	default:
		return 0, 0
	}
}

// For friend contacts: friendUID > 0, groupID = 0, orgID = 0.
// For group contacts:  friendUID = 0, groupID > 0, orgID = 0.
// For org contacts:    friendUID = 0, groupID = 0, orgID > 0.
func (s *ContactStore) Upsert(uid, friendUID, groupID, orgID int64, status uint8, remarkName, sortKey, searchText string, now int64) (int64, error) {
	typ, id := contactStorageKey(friendUID, groupID, orgID)
	var newSeq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var err error
		newSeq, err = bumpContactSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			`INSERT INTO contacts (uid, type, id, status, remark_name, sort_key, search_text, seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(uid, type, id) DO UPDATE SET
			   status = excluded.status,
			   remark_name = CASE WHEN excluded.remark_name = '' THEN contacts.remark_name ELSE excluded.remark_name END,
			   sort_key = CASE
			     WHEN excluded.remark_name != '' THEN excluded.sort_key
			     WHEN contacts.remark_name != '' THEN contacts.sort_key
			     ELSE excluded.sort_key
			   END,
			   search_text = CASE
			     WHEN excluded.remark_name != '' THEN excluded.search_text
			     WHEN contacts.remark_name != '' THEN contacts.search_text
			     ELSE excluded.search_text
			   END,
			   seq = excluded.seq,
			   updated_at = excluded.updated_at`,
			uid, typ, id, status, remarkName, sortKey, searchText, newSeq, now, now,
		)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("upsert contact: %w", err)
	}
	return newSeq, nil
}

// Delete soft-deletes a contact and bumps seq.
// friendUID / groupID / orgID 三者互斥（其余传 0）。
func (s *ContactStore) Delete(uid, friendUID, groupID, orgID int64) (int64, bool, error) {
	typ, id := contactStorageKey(friendUID, groupID, orgID)
	var found bool
	var newSeq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var exists int
		err := tx.QueryRow(
			"SELECT 1 FROM contacts WHERE uid = ? AND type = ? AND id = ? AND status != ?",
			uid, typ, id, ContactDeleted,
		).Scan(&exists)
		if err != nil {
			if isNoRows(err) {
				return nil
			}
			return err
		}
		found = true

		newSeq, err = bumpContactSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			"UPDATE contacts SET status = ?, seq = ? WHERE uid = ? AND type = ? AND id = ?",
			ContactDeleted, newSeq, uid, typ, id,
		)
		return err
	})
	if err != nil {
		return 0, false, fmt.Errorf("delete contact: %w", err)
	}
	return newSeq, found, nil
}

// AcceptRequest changes the recipient's own record from PENDING_INCOMING to FRIEND.
// 调用者必须是这条请求的接收方；申请方自身记录是 PENDING_OUTGOING，不会命中，返回 false。
func (s *ContactStore) AcceptRequest(uid, friendUID int64) (bool, error) {
	found, err := s.resolveRequest(uid, friendUID, ContactPendingIncoming, ContactFriend)
	if err != nil {
		return false, fmt.Errorf("accept request: %w", err)
	}
	return found, nil
}

// RejectRequest changes the recipient's own record from PENDING_INCOMING to DELETED.
// 调用者必须是这条请求的接收方；申请方自身记录是 PENDING_OUTGOING，不会命中，返回 false。
func (s *ContactStore) RejectRequest(uid, friendUID int64) (bool, error) {
	found, err := s.resolveRequest(uid, friendUID, ContactPendingIncoming, ContactDeleted)
	if err != nil {
		return false, fmt.Errorf("reject request: %w", err)
	}
	return found, nil
}

// AcceptCounterpartRequest changes the requester's own record from PENDING_OUTGOING to FRIEND。
// 在接收方 AcceptRequest 成功后，服务层调用本方法把申请方那一侧的记录同步翻成 FRIEND。
func (s *ContactStore) AcceptCounterpartRequest(uid, friendUID int64) (bool, error) {
	found, err := s.resolveRequest(uid, friendUID, ContactPendingOutgoing, ContactFriend)
	if err != nil {
		return false, fmt.Errorf("accept counterpart request: %w", err)
	}
	return found, nil
}

// RejectCounterpartRequest changes the requester's own record from PENDING_OUTGOING to DELETED。
// 在接收方 RejectRequest 成功后，服务层调用本方法把申请方那一侧的记录同步翻成 DELETED。
func (s *ContactStore) RejectCounterpartRequest(uid, friendUID int64) (bool, error) {
	found, err := s.resolveRequest(uid, friendUID, ContactPendingOutgoing, ContactDeleted)
	if err != nil {
		return false, fmt.Errorf("reject counterpart request: %w", err)
	}
	return found, nil
}

// resolveRequest atomically transitions a contact record matching fromStatus to newStatus and bumps seq.
func (s *ContactStore) resolveRequest(uid, friendUID int64, fromStatus, newStatus uint8) (bool, error) {
	var found bool
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		r, err := tx.Exec(
			"UPDATE contacts SET status = ? WHERE uid = ? AND type = ? AND id = ? AND status = ?",
			newStatus, uid, ContactTypeFriend, friendUID, fromStatus,
		)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return nil
		}
		found = true

		newSeq, err := bumpContactSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec("UPDATE contacts SET seq = ? WHERE uid = ? AND type = ? AND id = ?", newSeq, uid, ContactTypeFriend, friendUID)
		return err
	})
	return found, err
}

// UpdateRemark updates the remark name and recomputed projections for a contact.
// sortKey/searchText 由上层基于新备注与昵称/群名/组织名预先算好传入。Returns false if not found.
func (s *ContactStore) UpdateRemark(uid, friendUID, groupID, orgID int64, remarkName, sortKey, searchText string, now int64) (bool, error) {
	typ, id := contactStorageKey(friendUID, groupID, orgID)
	var found bool
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		r, err := tx.Exec(
			"UPDATE contacts SET remark_name = ?, sort_key = ?, search_text = ?, updated_at = ? WHERE uid = ? AND type = ? AND id = ? AND status != ?",
			remarkName, sortKey, searchText, now, uid, typ, id, ContactDeleted,
		)
		if err != nil {
			return err
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return nil
		}
		found = true

		newSeq, err := bumpContactSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec("UPDATE contacts SET seq = ? WHERE uid = ? AND type = ? AND id = ?", newSeq, uid, typ, id)
		return err
	})
	if err != nil {
		return false, fmt.Errorf("update remark: %w", err)
	}
	return found, nil
}

// List 返回展示序首页（无过滤）；游标续翻请用 ListPage。
func (s *ContactStore) List(uid, limit int64) ([]Contact, error) {
	return s.ListPage(uid, ContactListFilter{}, nil, false, limit)
}

func contactWhereClause(uid int64, filter ContactListFilter) (string, []interface{}) {
	where := "uid = ? AND status != ?"
	args := []interface{}{uid, ContactDeleted}
	if filter.Status != nil {
		where += " AND status = ?"
		args = append(args, *filter.Status)
	}
	if filter.FriendUID != 0 {
		where += " AND type = ? AND id = ?"
		args = append(args, ContactTypeFriend, filter.FriendUID)
	}
	if filter.GroupID != 0 {
		where += " AND type = ? AND id = ?"
		args = append(args, ContactTypeGroup, filter.GroupID)
	}
	if friendUIDs := positiveInt64s(filter.FriendUIDs); len(friendUIDs) > 0 {
		where += " AND type = ? AND id IN (" + placeholders(len(friendUIDs)) + ")"
		args = append(args, ContactTypeFriend)
		for _, friendUID := range friendUIDs {
			args = append(args, friendUID)
		}
	}
	if groupIDs := positiveInt64s(filter.GroupIDs); len(groupIDs) > 0 {
		where += " AND type = ? AND id IN (" + placeholders(len(groupIDs)) + ")"
		args = append(args, ContactTypeGroup)
		for _, groupID := range groupIDs {
			args = append(args, groupID)
		}
	}
	if filter.OrgID != 0 {
		where += " AND type = ? AND id = ?"
		args = append(args, ContactTypeOrg, filter.OrgID)
	}
	if orgIDs := positiveInt64s(filter.OrgIDs); len(orgIDs) > 0 {
		where += " AND type = ? AND id IN (" + placeholders(len(orgIDs)) + ")"
		args = append(args, ContactTypeOrg)
		for _, orgID := range orgIDs {
			args = append(args, orgID)
		}
	}
	return where, args
}

// ListPage 是通讯录展示通道的 keyset 分页：抗中途增删漂移，不再使用 offset。
//
// 展示序：PENDING 状态按 seq 倒序（新→旧），其余按 (sort_key, friend_uid, group_id) 升序。
// cursorParts 为不透明游标解码后的 keyset 字段（PENDING=[seq]，其余=[sort_key, friend_uid, group_id]）；
// 为空表示从对应方向起点开始。backward=true 时按反方向查询，调用方需把结果反转回展示序。
func (s *ContactStore) ListPage(uid int64, filter ContactListFilter, cursorParts []string, backward bool, limit int64) ([]Contact, error) {
	where, args := contactWhereClause(uid, filter)
	pending := filter.Status != nil && IsPendingStatus(*filter.Status)

	var orderBy string
	if pending {
		// seq 在 uid 内唯一，单字段 keyset 即可。
		orderBy = "seq DESC"
		if backward {
			orderBy = "seq ASC"
		}
		if len(cursorParts) >= 1 {
			seq, err := strconv.ParseInt(cursorParts[0], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid contact cursor: %w", err)
			}
			if backward {
				where += " AND seq > ?"
			} else {
				where += " AND seq < ?"
			}
			args = append(args, seq)
		}
	} else {
		orderBy = "sort_key, type, id"
		if backward {
			orderBy = "sort_key DESC, type DESC, id DESC"
		}
		if len(cursorParts) >= 3 {
			sortKey := cursorParts[0]
			typ, err1 := strconv.ParseInt(cursorParts[1], 10, 64)
			id, err2 := strconv.ParseInt(cursorParts[2], 10, 64)
			var err3 error
			if err1 != nil || err2 != nil || err3 != nil {
				return nil, fmt.Errorf("invalid contact cursor")
			}
			if backward {
				where += " AND (sort_key, type, id) < (?, ?, ?)"
			} else {
				where += " AND (sort_key, type, id) > (?, ?, ?)"
			}
			args = append(args, sortKey, typ, id)
		}
	}

	args = append(args, limit)
	return queryRows(s.db.Reader, "list contacts page",
		`SELECT `+contactSelectFields+`
		 FROM contacts WHERE `+where+`
		 ORDER BY `+orderBy+` LIMIT ?`,
		scanContact,
		args...,
	)
}

func (s *ContactStore) Count(uid int64, filter ContactListFilter) (int64, error) {
	where, args := contactWhereClause(uid, filter)
	var total int64
	if err := s.db.Reader.QueryRow("SELECT COUNT(*) FROM contacts WHERE "+where, args...).Scan(&total); err != nil {
		return 0, fmt.Errorf("count contacts: %w", err)
	}
	return total, nil
}

// Purge performs 3-step garbage collection on deleted contacts.
func (s *ContactStore) Purge(uid int64) (int64, error) {
	return purgeUserSeqRows(s.db.Writer, uid, userSeqPurgeSpec{
		table:       "contacts",
		predicate:   "status = ?",
		versionSpec: contactSeqSpec,
		errorPrefix: "contact gc",
	}, ContactDeleted)
}

// ListPurgeable returns up to limit UIDs that have at least one deleted contact.
// Pass afterUID > 0 to resume scanning from after that UID (cursor-based pagination).
func (s *ContactStore) ListPurgeable(limit, afterUID int64) ([]int64, error) {
	var rows *sql.Rows
	var err error
	if afterUID > 0 {
		rows, err = s.db.Reader.Query(
			"SELECT DISTINCT uid FROM contacts WHERE status = ? AND uid > ? LIMIT ?",
			ContactDeleted, afterUID, limit,
		)
	} else {
		rows, err = s.db.Reader.Query(
			"SELECT DISTINCT uid FROM contacts WHERE status = ? LIMIT ?",
			ContactDeleted, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("list deleted contacts: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

// Get returns a single friend contact record, or nil if not found.
func (s *ContactStore) Get(uid, friendUID int64) (*Contact, error) {
	return s.GetByKey(uid, friendUID, 0, 0)
}

// GetByKey returns a single contact record by full key, or nil if not found.
func (s *ContactStore) GetByKey(uid, friendUID, groupID, orgID int64) (*Contact, error) {
	typ, id := contactStorageKey(friendUID, groupID, orgID)
	row := s.db.Reader.QueryRow(
		`SELECT `+contactSelectFields+`
		 FROM contacts WHERE uid = ? AND type = ? AND id = ?`,
		uid, typ, id,
	)
	c, err := scanContact(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get contact: %w", err)
	}
	return &c, nil
}

// SyncList returns contacts with seq > afterSeq for incremental sync.
func (s *ContactStore) SyncList(uid, afterSeq, limit int64) ([]Contact, error) {
	return queryRows(s.db.Reader, "sync contacts",
		`SELECT `+contactSelectFields+`
		 FROM contacts WHERE uid = ? AND seq > ?
		 ORDER BY seq ASC LIMIT ?`,
		scanContact, uid, afterSeq, limit,
	)
}

// UpdateFriendProjections 在好友昵称变化时重算无备注好友的 sort_key 并刷新所有相关好友的 search_text。
func (s *ContactStore) UpdateFriendProjections(uid int64, names map[int64]string, now int64) (int64, error) {
	return s.updateProjections(uid, ContactTypeFriend, names, now)
}

// UpdateGroupProjections 在群名变化时重算无备注收藏群的 sort_key 并刷新所有相关收藏群的 search_text。
func (s *ContactStore) UpdateGroupProjections(uid int64, names map[int64]string, now int64) (int64, error) {
	return s.updateProjections(uid, ContactTypeGroup, names, now)
}

// UpdateOrgProjections 在组织名变化时重算无备注组织行的 sort_key 并刷新 search_text。
func (s *ContactStore) UpdateOrgProjections(uid int64, names map[int64]string, now int64) (int64, error) {
	return s.updateProjections(uid, ContactTypeOrg, names, now)
}

// ListOrgIDs 返回该用户全部在职组织行的 org_id（status = FRIEND）。
func (s *ContactStore) ListOrgIDs(uid int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT id FROM contacts WHERE uid = ? AND type = 3 AND status = ? ORDER BY id ASC",
		uid, ContactFriend,
	)
	if err != nil {
		return nil, fmt.Errorf("list contact org ids: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

// updateProjections 重算 sort_key 与 search_text 投影：
//   - sort_key 仅在没有备注时随昵称/群名/组织名变化；
//   - search_text 始终包含昵称/群名/组织名，因此无论是否有备注，名称变化都会更新 search_text 并 bump seq；
//   - username 不参与，因此用户名变化不会进入这里。
//
// typ 是本类条目的统一目标类型（friend/group/org）。
func (s *ContactStore) updateProjections(uid, typ int64, names map[int64]string, now int64) (int64, error) {
	if uid == 0 || len(names) == 0 {
		return 0, nil
	}
	var changed int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		for id, name := range names {
			if id == 0 {
				continue
			}
			var remark, sortKey, searchText string
			err := tx.QueryRow(
				"SELECT remark_name, sort_key, search_text FROM contacts WHERE uid = ? AND type = ? AND id = ? AND status != ?",
				uid, typ, id, ContactDeleted,
			).Scan(&remark, &sortKey, &searchText)
			if err != nil {
				if isNoRows(err) {
					continue
				}
				return err
			}
			newSortKey := ContactSortKey(remark, name)
			newSearchText := ContactSearchText(remark, name)
			if newSortKey == sortKey && newSearchText == searchText {
				continue
			}
			newSeq, err := bumpContactSeq(tx, uid)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(
				"UPDATE contacts SET sort_key = ?, search_text = ?, seq = ?, updated_at = ? WHERE uid = ? AND type = ? AND id = ? AND status != ?",
				newSortKey, newSearchText, newSeq, now, uid, typ, id, ContactDeleted,
			); err != nil {
				return err
			}
			changed++
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("update contact projections: %w", err)
	}
	return changed, nil
}

// GetVersion returns the gc_safe_seq and max_seq for a user.
func (s *ContactStore) GetVersion(uid int64) (gcSafeSeq, maxSeq int64, err error) {
	version, err := getSyncVersion(s.db.Reader, uid, contactSeqSpec)
	return version.GCSafeSeq, version.MaxSeq, err
}

func scanContact(row rowScanner) (Contact, error) {
	var c Contact
	err := row.Scan(&c.UID, &c.Type, &c.ID, &c.Status, &c.RemarkName, &c.SortKey, &c.SearchText, &c.Seq, &c.CreatedAt, &c.UpdatedAt)
	switch c.Type {
	case ContactTypeFriend:
		c.FriendUID = c.ID
	case ContactTypeGroup:
		c.GroupID = c.ID
	case ContactTypeOrg:
		c.OrgID = c.ID
	}
	return c, err
}
