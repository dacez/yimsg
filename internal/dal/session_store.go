package dal

import (
	"fmt"
	"yimsg/internal/shard"
)

// SessionStore provides auth session operations (session table, token shard).
// Each session is the primary auth record: token → uid + expiry.
type SessionStore struct{ db *shard.DB }

// NewSessionStore creates a SessionStore backed by the given shard.
func NewSessionStore(db *shard.DB) *SessionStore { return &SessionStore{db: db} }

// Create inserts a new session record on login.
func (s *SessionStore) Create(token string, uid, createdAt, expireAt int64) error {
	_, err := s.db.Writer.Exec(
		"INSERT INTO session (token, uid, created_at, expire_at) VALUES (?, ?, ?, ?)",
		token, uid, createdAt, expireAt,
	)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

// Get returns the session for the given token, or nil if not found.
func (s *SessionStore) Get(token string) (*Session, error) {
	var sess Session
	err := s.db.Reader.QueryRow(
		"SELECT token, uid, created_at, expire_at FROM session WHERE token = ?", token,
	).Scan(&sess.Token, &sess.UID, &sess.CreatedAt, &sess.ExpireAt)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &sess, nil
}

// Delete removes a session by token (logout).
func (s *SessionStore) Delete(token string) error {
	_, err := s.db.Writer.Exec("DELETE FROM session WHERE token = ?", token)
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteByUID removes all sessions for a given UID (kick all devices).
func (s *SessionStore) DeleteByUID(uid int64) error {
	_, err := s.db.Writer.Exec("DELETE FROM session WHERE uid = ?", uid)
	if err != nil {
		return fmt.Errorf("delete sessions by uid: %w", err)
	}
	return nil
}

// Renew extends the expiry of an existing session.
func (s *SessionStore) Renew(token string, newExpireAt int64) error {
	_, err := s.db.Writer.Exec(
		"UPDATE session SET expire_at = ? WHERE token = ?", newExpireAt, token,
	)
	if err != nil {
		return fmt.Errorf("renew session: %w", err)
	}
	return nil
}

// Purge deletes up to limit expired sessions. Returns the number of rows deleted.
func (s *SessionStore) Purge(now, limit int64) (int64, error) {
	r, err := s.db.Writer.Exec("DELETE FROM session WHERE token IN (SELECT token FROM session WHERE expire_at <= ? LIMIT ?)", now, limit)
	if err != nil {
		return 0, fmt.Errorf("cleanup expired sessions: %w", err)
	}
	n, _ := r.RowsAffected()
	return n, nil
}
