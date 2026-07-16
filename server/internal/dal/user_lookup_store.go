package dal

import (
	"fmt"
	"yimsg/server/internal/shard"
)

type UserLookupStore struct{ db *shard.DB }

func NewUserLookupStore(db *shard.DB) *UserLookupStore { return &UserLookupStore{db: db} }

// InsertLookup inserts a username->uid mapping. Returns true if inserted, false if already exists.
func (s *UserLookupStore) Insert(username string, uid int64) (bool, error) {
	r, err := s.db.Writer.Exec(
		"INSERT OR IGNORE INTO user_lookup (username, uid) VALUES (?, ?)",
		username, uid,
	)
	if err != nil {
		return false, fmt.Errorf("insert lookup: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// DeleteLookup removes a username mapping.
func (s *UserLookupStore) Delete(username string) error {
	_, err := s.db.Writer.Exec("DELETE FROM user_lookup WHERE username = ?", username)
	if err != nil {
		return fmt.Errorf("delete lookup: %w", err)
	}
	return nil
}

// GetUID looks up a uid by username. Returns 0, nil if not found.
func (s *UserLookupStore) GetUID(username string) (int64, error) {
	var uid int64
	err := s.db.Reader.QueryRow("SELECT uid FROM user_lookup WHERE username = ?", username).Scan(&uid)
	if err != nil {
		if isNoRows(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("get uid: %w", err)
	}
	return uid, nil
}

// List returns up to limit (username → uid) pairs.
func (s *UserLookupStore) ListAll(limit int64) (map[string]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT username, uid FROM user_lookup LIMIT ?", limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list all lookups: %w", err)
	}
	defer rows.Close()
	result := make(map[string]int64)
	for rows.Next() {
		var username string
		var uid int64
		if err := rows.Scan(&username, &uid); err != nil {
			return nil, err
		}
		result[username] = uid
	}
	return result, rows.Err()
}
