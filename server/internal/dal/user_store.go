package dal

import (
	"fmt"

	"yimsg/server/internal/shard"
)

// UserStore provides user-related database operations.
type UserStore struct{ db *shard.DB }

// NewUserStore creates a UserStore backed by the given shard.
func NewUserStore(db *shard.DB) *UserStore { return &UserStore{db: db} }

// CreateUser inserts a new user record.
func (s *UserStore) Create(uid int64, username, passwordHash, nickname string, now int64) error {
	_, err := s.db.Writer.Exec(
		`INSERT INTO user_info (uid, username, password_hash, nickname, avatar, created_at, updated_at)
		 VALUES (?, ?, ?, ?, '', ?, ?)`,
		uid, username, passwordHash, nickname, now, now,
	)
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	return nil
}

// Get returns the full user record including password hash. Use GetInfo for public fields only.
func (s *UserStore) Get(uid int64) (*User, error) {
	var u User
	err := s.db.Reader.QueryRow(
		`SELECT uid, username, password_hash, nickname, avatar, created_at, updated_at
		 FROM user_info WHERE uid = ?`, uid,
	).Scan(&u.UID, &u.Username, &u.PasswordHash, &u.Nickname, &u.Avatar, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get user: %w", err)
	}
	return &u, nil
}

// GetInfo returns user public fields (no password hash). Returns nil if not found.
func (s *UserStore) GetInfo(uid int64) (*User, error) {
	var u User
	err := s.db.Reader.QueryRow(
		`SELECT uid, username, nickname, avatar, created_at, updated_at
		 FROM user_info WHERE uid = ?`, uid,
	).Scan(&u.UID, &u.Username, &u.Nickname, &u.Avatar, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get user info: %w", err)
	}
	return &u, nil
}

// ListByUIDs returns public fields for multiple UIDs in a single query.
// UIDs not found are silently skipped.
func (s *UserStore) ListByUIDs(uids []int64) ([]User, error) {
	if len(uids) == 0 {
		return nil, nil
	}
	query := "SELECT uid, username, nickname, avatar, created_at, updated_at FROM user_info WHERE uid IN (" + placeholders(len(uids)) + ")"
	args := int64sToAny(uids)
	rows, err := s.db.Reader.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("get user infos: %w", err)
	}
	defer rows.Close()
	var result []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.UID, &u.Username, &u.Nickname, &u.Avatar, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, u)
	}
	return result, rows.Err()
}

// UpdateProfile updates nickname and avatar.
func (s *UserStore) UpdateProfile(uid int64, nickname, avatar string, now int64) (bool, error) {
	r, err := s.db.Writer.Exec(
		"UPDATE user_info SET nickname = ?, avatar = ?, updated_at = ? WHERE uid = ?",
		nickname, avatar, now, uid,
	)
	if err != nil {
		return false, fmt.Errorf("update profile: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// UpdatePassword updates the password hash.
func (s *UserStore) UpdatePassword(uid int64, passwordHash string, now int64) (bool, error) {
	r, err := s.db.Writer.Exec(
		"UPDATE user_info SET password_hash = ?, updated_at = ? WHERE uid = ?",
		passwordHash, now, uid,
	)
	if err != nil {
		return false, fmt.Errorf("update password: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}
