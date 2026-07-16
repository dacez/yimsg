package dal

import (
	"fmt"
	"yimsg/server/internal/shard"
)

// UserSessionStore provides token index operations (user_session table, uid shard).
// It is the secondary index: token→uid lives in SessionStore (token shard),
// while uid→tokens lives here for enumeration and bulk removal.
type UserSessionStore struct{ db *shard.DB }

// NewUserSessionStore creates a UserSessionStore backed by the given shard.
func NewUserSessionStore(db *shard.DB) *UserSessionStore { return &UserSessionStore{db: db} }

// AddToken records a new token for the user (called on login).
func (s *UserSessionStore) AddToken(uid int64, token, device string, now int64) error {
	_, err := s.db.Writer.Exec(
		"INSERT INTO user_session (uid, token, device, created_at) VALUES (?, ?, ?, ?)",
		uid, token, device, now,
	)
	if err != nil {
		return fmt.Errorf("add token: %w", err)
	}
	return nil
}

// RemoveToken deletes a single token for the user (called on logout).
func (s *UserSessionStore) RemoveToken(uid int64, token string) error {
	_, err := s.db.Writer.Exec(
		"DELETE FROM user_session WHERE uid = ? AND token = ?", uid, token,
	)
	if err != nil {
		return fmt.Errorf("remove token: %w", err)
	}
	return nil
}

// ListTokens returns all active session tokens for the user.
func (s *UserSessionStore) ListTokens(uid int64) ([]UserSession, error) {
	rows, err := s.db.Reader.Query(
		"SELECT uid, token, device, created_at FROM user_session WHERE uid = ?", uid,
	)
	if err != nil {
		return nil, fmt.Errorf("get tokens: %w", err)
	}
	defer rows.Close()
	var result []UserSession
	for rows.Next() {
		var us UserSession
		if err := rows.Scan(&us.UID, &us.Token, &us.Device, &us.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, us)
	}
	return result, rows.Err()
}

// RemoveTokens deletes all tokens for the user (called on password change / account wipe).
func (s *UserSessionStore) RemoveTokens(uid int64) error {
	_, err := s.db.Writer.Exec("DELETE FROM user_session WHERE uid = ?", uid)
	if err != nil {
		return fmt.Errorf("remove all tokens: %w", err)
	}
	return nil
}

// ListAll returns up to limit distinct UIDs that have at least one active session.
// Used by session GC to enumerate users.
func (s *UserSessionStore) ListAll(limit int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT DISTINCT uid FROM user_session LIMIT ?", limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list session uids: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}
