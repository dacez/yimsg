package dal

import (
	"database/sql"
	"fmt"

	"yimsg/internal/shard"
)

// MutelistStore provides per-conversation mutelist operations.
type MutelistStore struct{ db *shard.DB }

// NewMutelistStore creates a MutelistStore backed by the given shard.
func NewMutelistStore(db *shard.DB) *MutelistStore {
	return &MutelistStore{db: db}
}

// Upsert writes a mutelist setting and bumps seq.
func (s *MutelistStore) Upsert(uid, toUID, groupID int64, muted bool, now int64) (int64, error) {
	var newSeq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var err error
		newSeq, err = bumpMutelistSeq(tx, uid)
		if err != nil {
			return err
		}
		status := MutelistDeleted
		if muted {
			status = MutelistActive
		}
		_, err = tx.Exec(
			`INSERT INTO mutelist (uid, to_uid, group_id, status, seq, updated_at)
 VALUES (?, ?, ?, ?, ?, ?)
 ON CONFLICT(uid, to_uid, group_id) DO UPDATE SET
   status = excluded.status,
   seq = excluded.seq,
   updated_at = excluded.updated_at`,
			uid, toUID, groupID, status, newSeq, now,
		)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("upsert mutelist: %w", err)
	}
	return newSeq, nil
}

// Get returns one mutelist row, or nil if not found.
func (s *MutelistStore) Get(uid, toUID, groupID int64) (*MutelistEntry, error) {
	row := s.db.Reader.QueryRow(
		`SELECT uid, to_uid, group_id, status, seq, updated_at
 FROM mutelist WHERE uid = ? AND to_uid = ? AND group_id = ?`,
		uid, toUID, groupID,
	)
	entry, err := scanMutelistEntry(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get mutelist: %w", err)
	}
	return &entry, nil
}

// List returns muted conversations only.
func (s *MutelistStore) List(uid, beforeSeq, limit int64) ([]MutelistEntry, error) {
	return s.ListFiltered(uid, MutelistFilter{}, beforeSeq, 0, limit)
}

func mutelistWhereClause(uid int64, filter MutelistFilter) (string, []interface{}) {
	status := MutelistActive
	if filter.Status != nil {
		status = *filter.Status
	}
	where := "uid = ? AND status = ?"
	args := []interface{}{uid, status}
	if filter.ToUID != 0 {
		where += " AND to_uid = ?"
		args = append(args, filter.ToUID)
	}
	if filter.GroupID != 0 {
		where += " AND group_id = ?"
		args = append(args, filter.GroupID)
	}
	if toUIDs := positiveInt64s(filter.ToUIDs); len(toUIDs) > 0 {
		where += " AND to_uid IN (" + placeholders(len(toUIDs)) + ")"
		for _, toUID := range toUIDs {
			args = append(args, toUID)
		}
	}
	if groupIDs := positiveInt64s(filter.GroupIDs); len(groupIDs) > 0 {
		where += " AND group_id IN (" + placeholders(len(groupIDs)) + ")"
		for _, groupID := range groupIDs {
			args = append(args, groupID)
		}
	}
	return where, args
}

func mutelistCursorClause(where string, args []interface{}, beforeSeq, afterSeq int64) (string, []interface{}, string) {
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

func (s *MutelistStore) ListFiltered(uid int64, filter MutelistFilter, beforeSeq, afterSeq, limit int64) ([]MutelistEntry, error) {
	where, args := mutelistWhereClause(uid, filter)
	where, args, orderBy := mutelistCursorClause(where, args, beforeSeq, afterSeq)
	args = append(args, limit)
	return queryRows(s.db.Reader, "list mutelist",
		`SELECT uid, to_uid, group_id, status, seq, updated_at
		 FROM mutelist WHERE `+where+`
 ORDER BY `+orderBy+`, to_uid ASC, group_id ASC LIMIT ?`,
		scanMutelistEntry, args...,
	)
}

func (s *MutelistStore) Count(uid int64, filter MutelistFilter) (int64, error) {
	where, args := mutelistWhereClause(uid, filter)
	var total int64
	if err := s.db.Reader.QueryRow("SELECT COUNT(*) FROM mutelist WHERE "+where, args...).Scan(&total); err != nil {
		return 0, fmt.Errorf("count mutelist: %w", err)
	}
	return total, nil
}

// Sync returns changed mutelist rows with seq > afterSeq, including deleted tombstones.
func (s *MutelistStore) Sync(uid, afterSeq, limit int64) ([]MutelistEntry, error) {
	return queryRows(s.db.Reader, "sync mutelist",
		`SELECT uid, to_uid, group_id, status, seq, updated_at
 FROM mutelist
 WHERE uid = ? AND seq > ?
 ORDER BY seq ASC LIMIT ?`,
		scanMutelistEntry, uid, afterSeq, limit,
	)
}

// Purge physically deletes disabled mutelist entries for one user.
func (s *MutelistStore) Purge(uid int64) (int64, error) {
	return purgeUserSeqRows(s.db.Writer, uid, userSeqPurgeSpec{
		table:       "mutelist",
		predicate:   "status = ?",
		versionSpec: mutelistSeqSpec,
		errorPrefix: "purge mutelist",
	}, MutelistDeleted)
}

// ListPurgeable returns up to limit UIDs that have disabled mutelist entries.
func (s *MutelistStore) ListPurgeable(limit, afterUID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		`SELECT DISTINCT uid FROM mutelist
		 WHERE status = ? AND uid > ?
		 ORDER BY uid ASC LIMIT ?`,
		MutelistDeleted, afterUID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list purgeable mutelist: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

// GetVersion returns the gc_safe_seq and max_seq for a user.
func (s *MutelistStore) GetVersion(uid int64) (gcSafeSeq, maxSeq int64, err error) {
	version, err := getSyncVersion(s.db.Reader, uid, mutelistSeqSpec)
	return version.GCSafeSeq, version.MaxSeq, err
}

func scanMutelistEntry(row rowScanner) (MutelistEntry, error) {
	var entry MutelistEntry
	if err := row.Scan(&entry.UID, &entry.ToUID, &entry.GroupID, &entry.Status, &entry.Seq, &entry.UpdatedAt); err != nil {
		return entry, err
	}
	return entry, nil
}
