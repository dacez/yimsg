package dal

import (
	"database/sql"
	"fmt"

	"yimsg/internal/shard"
)

// BlocklistStore provides per-user blocklist operations.
type BlocklistStore struct{ db *shard.DB }

// NewBlocklistStore creates a BlocklistStore backed by the given shard.
func NewBlocklistStore(db *shard.DB) *BlocklistStore { return &BlocklistStore{db: db} }

// Upsert inserts or re-activates a blocklist row and bumps seq.
func (s *BlocklistStore) Upsert(uid, blockUID, now int64) (int64, error) {
	var newSeq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var err error
		newSeq, err = bumpBlocklistSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			`INSERT INTO blocklist (uid, block_uid, status, seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(uid, block_uid) DO UPDATE SET
			   status = excluded.status,
			   seq = excluded.seq,
			   updated_at = excluded.updated_at`,
			uid, blockUID, BlocklistActive, newSeq, now, now,
		)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("upsert blocklist: %w", err)
	}
	return newSeq, nil
}

// Delete marks a blocklist row as deleted and bumps seq.
func (s *BlocklistStore) Delete(uid, blockUID, now int64) (int64, bool, error) {
	var found bool
	var newSeq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var currentStatus uint8
		err := tx.QueryRow(
			"SELECT status FROM blocklist WHERE uid = ? AND block_uid = ?",
			uid, blockUID,
		).Scan(&currentStatus)
		if err != nil {
			if isNoRows(err) {
				return nil
			}
			return err
		}
		if currentStatus == BlocklistDeleted {
			return nil
		}
		found = true

		newSeq, err = bumpBlocklistSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			"UPDATE blocklist SET status = ?, seq = ?, updated_at = ? WHERE uid = ? AND block_uid = ?",
			BlocklistDeleted, newSeq, now, uid, blockUID,
		)
		return err
	})
	if err != nil {
		return 0, false, fmt.Errorf("delete blocklist: %w", err)
	}
	return newSeq, found, nil
}

// Get returns one blocklist row, or nil if not found.
func (s *BlocklistStore) Get(uid, blockUID int64) (*BlocklistEntry, error) {
	row := s.db.Reader.QueryRow(
		`SELECT uid, block_uid, status, seq, created_at, updated_at
		 FROM blocklist WHERE uid = ? AND block_uid = ?`,
		uid, blockUID,
	)
	var entry BlocklistEntry
	err := row.Scan(&entry.UID, &entry.BlockUID, &entry.Status, &entry.Seq, &entry.CreatedAt, &entry.UpdatedAt)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get blocklist: %w", err)
	}
	return &entry, nil
}

// List returns active blocklist rows.
func (s *BlocklistStore) List(uid, beforeSeq, limit int64) ([]BlocklistEntry, error) {
	return s.ListFiltered(uid, BlocklistFilter{}, beforeSeq, 0, limit)
}

func blocklistWhereClause(uid int64, filter BlocklistFilter) (string, []interface{}) {
	status := BlocklistActive
	if filter.Status != nil {
		status = *filter.Status
	}
	where := "uid = ? AND status = ?"
	args := []interface{}{uid, status}
	if uids := positiveInt64s(filter.UIDs); len(uids) > 0 {
		where += " AND block_uid IN (" + placeholders(len(uids)) + ")"
		for _, targetUID := range uids {
			args = append(args, targetUID)
		}
	}
	return where, args
}

func blocklistCursorClause(where string, args []interface{}, beforeSeq, afterSeq int64) (string, []interface{}, string) {
	if afterSeq > 0 {
		where += " AND seq > ?"
		args = append(args, afterSeq)
		return where, args, "seq ASC"
	}
	if beforeSeq > 0 {
		where += " AND seq < ?"
		args = append(args, beforeSeq)
	}
	return where, args, "seq DESC"
}

func (s *BlocklistStore) ListFiltered(uid int64, filter BlocklistFilter, beforeSeq, afterSeq, limit int64) ([]BlocklistEntry, error) {
	where, args := blocklistWhereClause(uid, filter)
	where, args, orderBy := blocklistCursorClause(where, args, beforeSeq, afterSeq)
	args = append(args, limit)
	return queryRows(s.db.Reader, "list blocklist",
		`SELECT uid, block_uid, status, seq, created_at, updated_at
		 FROM blocklist WHERE `+where+`
		 ORDER BY `+orderBy+`, block_uid ASC LIMIT ?`,
		scanBlocklistEntry, args...,
	)
}

func (s *BlocklistStore) Count(uid int64, filter BlocklistFilter) (int64, error) {
	where, args := blocklistWhereClause(uid, filter)
	var total int64
	if err := s.db.Reader.QueryRow("SELECT COUNT(*) FROM blocklist WHERE "+where, args...).Scan(&total); err != nil {
		return 0, fmt.Errorf("count blocklist: %w", err)
	}
	return total, nil
}

// Sync returns rows with seq > afterSeq, including deleted tombstones.
func (s *BlocklistStore) Sync(uid, afterSeq, limit int64) ([]BlocklistEntry, error) {
	return queryRows(s.db.Reader, "sync blocklist",
		`SELECT uid, block_uid, status, seq, created_at, updated_at
		 FROM blocklist
		 WHERE uid = ? AND seq > ?
		 ORDER BY seq ASC LIMIT ?`,
		scanBlocklistEntry, uid, afterSeq, limit,
	)
}

// IsBlocked reports whether an active blocklist row exists.
func (s *BlocklistStore) IsBlocked(uid, blockUID int64) (bool, error) {
	var exists int
	err := s.db.Reader.QueryRow(
		"SELECT 1 FROM blocklist WHERE uid = ? AND block_uid = ? AND status = ?",
		uid, blockUID, BlocklistActive,
	).Scan(&exists)
	if err != nil {
		if isNoRows(err) {
			return false, nil
		}
		return false, fmt.Errorf("is blocklist: %w", err)
	}
	return true, nil
}

// Purge physically deletes removed blocklist tombstones for one user.
func (s *BlocklistStore) Purge(uid int64) (int64, error) {
	return purgeUserSeqRows(s.db.Writer, uid, userSeqPurgeSpec{
		table:       "blocklist",
		predicate:   "status = ?",
		versionSpec: blocklistSeqSpec,
		errorPrefix: "purge blocklist",
	}, BlocklistDeleted)
}

// ListPurgeable returns up to limit UIDs that have removed blocklist tombstones.
func (s *BlocklistStore) ListPurgeable(limit, afterUID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		`SELECT DISTINCT uid FROM blocklist
		 WHERE status = ? AND uid > ?
		 ORDER BY uid ASC LIMIT ?`,
		BlocklistDeleted, afterUID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list purgeable blocklist: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

// GetVersion returns the gc_safe_seq and max_seq for a user.
func (s *BlocklistStore) GetVersion(uid int64) (gcSafeSeq, maxSeq int64, err error) {
	version, err := getSyncVersion(s.db.Reader, uid, blocklistSeqSpec)
	return version.GCSafeSeq, version.MaxSeq, err
}

func scanBlocklistEntry(row rowScanner) (BlocklistEntry, error) {
	var entry BlocklistEntry
	err := row.Scan(&entry.UID, &entry.BlockUID, &entry.Status, &entry.Seq, &entry.CreatedAt, &entry.UpdatedAt)
	return entry, err
}

func positiveInt64s(values []int64) []int64 {
	result := make([]int64, 0, len(values))
	for _, v := range values {
		if v > 0 {
			result = append(result, v)
		}
	}
	return result
}
