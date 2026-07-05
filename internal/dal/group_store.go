package dal

import (
	"database/sql"
	"fmt"
	"strconv"

	"yimsg/internal/shard"
)

// GroupStore provides group-related database operations (group_info + group_member tables).
type GroupStore struct{ db *shard.DB }

// NewGroupStore creates a GroupStore backed by the given shard.
func NewGroupStore(db *shard.DB) *GroupStore { return &GroupStore{db: db} }

// CreateGroup creates a group with members in a single transaction.
func (s *GroupStore) CreateGroup(groupID int64, name string, ownerUID int64, memberUIDs []int64, now int64) error {
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		if _, err := tx.Exec(
			`INSERT INTO group_info (group_id, name, avatar, owner_uid, created_at, updated_at)
			 VALUES (?, ?, '', ?, ?, ?)`,
			groupID, name, ownerUID, now, now,
		); err != nil {
			return err
		}

		for _, uid := range memberUIDs {
			role := RoleMember
			if uid == ownerUID {
				role = RoleOwner
			}
			if _, err := tx.Exec(
				"INSERT INTO group_member (group_id, uid, role, joined_at) VALUES (?, ?, ?, ?)",
				groupID, uid, role, now,
			); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("create group: %w", err)
	}
	return nil
}

// GetInfo returns group metadata. Returns nil if not found.
func (s *GroupStore) GetInfo(groupID int64) (*GroupInfo, error) {
	var g GroupInfo
	err := s.db.Reader.QueryRow(
		`SELECT group_id, name, avatar, owner_uid, created_at, updated_at
		 FROM group_info WHERE group_id = ?`, groupID,
	).Scan(&g.GroupID, &g.Name, &g.Avatar, &g.OwnerUID, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get group info: %w", err)
	}
	return &g, nil
}

// ListByIDs returns group infos for multiple group IDs in a single query.
// IDs not found are silently skipped.
func (s *GroupStore) ListByIDs(groupIDs []int64) ([]GroupInfo, error) {
	if len(groupIDs) == 0 {
		return nil, nil
	}
	query := "SELECT group_id, name, avatar, owner_uid, created_at, updated_at FROM group_info WHERE group_id IN (" + placeholders(len(groupIDs)) + ")"
	args := int64sToAny(groupIDs)
	rows, err := s.db.Reader.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("get group info batch: %w", err)
	}
	defer rows.Close()
	var result []GroupInfo
	for rows.Next() {
		var g GroupInfo
		if err := rows.Scan(&g.GroupID, &g.Name, &g.Avatar, &g.OwnerUID, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, g)
	}
	return result, rows.Err()
}

// UpdateInfo updates group name and avatar.
func (s *GroupStore) UpdateInfo(groupID int64, name, avatar string, now int64) (bool, error) {
	r, err := s.db.Writer.Exec(
		"UPDATE group_info SET name = ?, avatar = ?, updated_at = ? WHERE group_id = ?",
		name, avatar, now, groupID,
	)
	if err != nil {
		return false, fmt.Errorf("update group info: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// AddMember adds a member to a group. Returns false if already exists.
func (s *GroupStore) AddMember(groupID, uid int64, role int8, now int64) (bool, error) {
	r, err := s.db.Writer.Exec(
		"INSERT OR IGNORE INTO group_member (group_id, uid, role, joined_at) VALUES (?, ?, ?, ?)",
		groupID, uid, role, now,
	)
	if err != nil {
		return false, fmt.Errorf("add group member: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// RemoveMember removes a member from a group.
func (s *GroupStore) RemoveMember(groupID, uid int64) (bool, error) {
	r, err := s.db.Writer.Exec(
		"DELETE FROM group_member WHERE group_id = ? AND uid = ?", groupID, uid,
	)
	if err != nil {
		return false, fmt.Errorf("remove group member: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// ListAllMembers returns all members of a group (unordered).
func (s *GroupStore) ListAllMembers(groupID int64) ([]GroupMember, error) {
	rows, err := s.db.Reader.Query(
		"SELECT group_id, uid, role, joined_at FROM group_member WHERE group_id = ?", groupID,
	)
	if err != nil {
		return nil, fmt.Errorf("get group members: %w", err)
	}
	defer rows.Close()
	return scanGroupMembers(rows)
}

// ListMembersPage 是群成员展示通道的 keyset 分页：抗中途增删漂移，不再使用 offset。
//
// 展示序：role 倒序、uid 升序（群主/管理员置顶）。cursorParts 为不透明游标解码后的 [role, uid]；
// 为空表示从对应方向起点开始。backward=true 时按反方向查询，调用方需把结果反转回展示序。
func (s *GroupStore) ListMembersPage(groupID int64, cursorParts []string, backward bool, limit int64) ([]GroupMember, error) {
	where := "group_id = ?"
	args := []interface{}{groupID}
	orderBy := "role DESC, uid ASC"
	if backward {
		orderBy = "role ASC, uid DESC"
	}
	if len(cursorParts) >= 2 {
		role, err1 := strconv.ParseInt(cursorParts[0], 10, 64)
		memberUID, err2 := strconv.ParseInt(cursorParts[1], 10, 64)
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("invalid member cursor")
		}
		// role 倒序、uid 升序：展示序向后 = role 更小，或同 role 下 uid 更大。
		if backward {
			where += " AND (role > ? OR (role = ? AND uid < ?))"
		} else {
			where += " AND (role < ? OR (role = ? AND uid > ?))"
		}
		args = append(args, role, role, memberUID)
	}
	args = append(args, limit)
	rows, err := s.db.Reader.Query(
		"SELECT group_id, uid, role, joined_at FROM group_member WHERE "+where+" ORDER BY "+orderBy+" LIMIT ?",
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("list group members: %w", err)
	}
	defer rows.Close()
	return scanGroupMembers(rows)
}

func (s *GroupStore) CountMembers(groupID int64) (int64, error) {
	var total int64
	if err := s.db.Reader.QueryRow("SELECT COUNT(*) FROM group_member WHERE group_id = ?", groupID).Scan(&total); err != nil {
		return 0, fmt.Errorf("count group members: %w", err)
	}
	return total, nil
}

// scanGroupMembers scans a group_member result set into a slice.
func scanGroupMembers(rows *sql.Rows) ([]GroupMember, error) {
	var result []GroupMember
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.GroupID, &m.UID, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

// IsMember checks if a user is a member of a group.
func (s *GroupStore) IsMember(groupID, uid int64) (bool, error) {
	var exists int
	err := s.db.Reader.QueryRow(
		"SELECT 1 FROM group_member WHERE group_id = ? AND uid = ?", groupID, uid,
	).Scan(&exists)
	if err != nil {
		if isNoRows(err) {
			return false, nil
		}
		return false, fmt.Errorf("check group membership: %w", err)
	}
	return true, nil
}
