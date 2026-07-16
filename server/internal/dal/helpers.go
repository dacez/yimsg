package dal

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

type rowScanner interface {
	Scan(dest ...interface{}) error
}

type userSequenceSpec struct {
	versionTable string
	errorPrefix  string
}

type SyncVersion struct {
	GCSafeSeq int64
	MaxSeq    int64
}

type userSeqPurgeSpec struct {
	table       string
	predicate   string
	versionSpec userSequenceSpec
	errorPrefix string
}

func isNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}

// scanInt64Rows scans a single-column int64 result set into a slice.
// Used by ListPurgeable and similar methods that return a list of IDs.
func scanInt64Rows(rows *sql.Rows) ([]int64, error) {
	var result []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

// withTx executes fn within a transaction. On success, commits; on error or panic, rolls back.
func withTx(db *sql.DB, fn func(tx *sql.Tx) error) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

var (
	contactSeqSpec = userSequenceSpec{
		versionTable: "contacts_version",
		errorPrefix:  "contact seq",
	}
	blocklistSeqSpec = userSequenceSpec{
		versionTable: "blocklist_version",
		errorPrefix:  "blocklist seq",
	}
	mutelistSeqSpec = userSequenceSpec{
		versionTable: "mutelist_version",
		errorPrefix:  "mutelist seq",
	}
)

func bumpVersionSeq(tx *sql.Tx, uid int64, spec userSequenceSpec) (int64, error) {
	insertSQL := fmt.Sprintf("INSERT INTO %s (uid, gc_safe_seq, max_seq) VALUES (?, 0, 1) ON CONFLICT(uid) DO UPDATE SET max_seq = max_seq + 1", spec.versionTable)
	if _, err := tx.Exec(insertSQL, uid); err != nil {
		return 0, fmt.Errorf("bump %s: %w", spec.errorPrefix, err)
	}
	var seq int64
	selectSQL := fmt.Sprintf("SELECT max_seq FROM %s WHERE uid = ?", spec.versionTable)
	if err := tx.QueryRow(selectSQL, uid).Scan(&seq); err != nil {
		return 0, fmt.Errorf("read %s: %w", spec.errorPrefix, err)
	}
	return seq, nil
}

func getSyncVersion(db *sql.DB, uid int64, spec userSequenceSpec) (SyncVersion, error) {
	var version SyncVersion
	query := fmt.Sprintf("SELECT gc_safe_seq, max_seq FROM %s WHERE uid = ?", spec.versionTable)
	err := db.QueryRow(query, uid).Scan(&version.GCSafeSeq, &version.MaxSeq)
	if err != nil {
		if isNoRows(err) {
			return SyncVersion{}, nil
		}
		return SyncVersion{}, fmt.Errorf("get %s version: %w", spec.errorPrefix, err)
	}
	return version, nil
}

func advanceGCSafeSeq(tx *sql.Tx, uid, seq int64, spec userSequenceSpec) error {
	if seq <= 0 {
		return nil
	}
	query := fmt.Sprintf(
		"INSERT INTO %s (uid, gc_safe_seq, max_seq) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET gc_safe_seq = MAX(%s.gc_safe_seq, excluded.gc_safe_seq), max_seq = MAX(%s.max_seq, excluded.max_seq)",
		spec.versionTable, spec.versionTable, spec.versionTable,
	)
	_, err := tx.Exec(query, uid, seq, seq)
	if err != nil {
		return fmt.Errorf("advance %s gc safe seq: %w", spec.errorPrefix, err)
	}
	return nil
}

func purgeUserSeqRows(db *sql.DB, uid int64, spec userSeqPurgeSpec, args ...any) (int64, error) {
	var deleted int64
	err := withTx(db, func(tx *sql.Tx) error {
		queryArgs := append([]any{uid}, args...)
		var maxDeletedSeq int64
		selectSQL := fmt.Sprintf("SELECT COALESCE(MAX(seq), 0) FROM %s WHERE uid = ? AND %s", spec.table, spec.predicate)
		if err := tx.QueryRow(selectSQL, queryArgs...).Scan(&maxDeletedSeq); err != nil {
			return err
		}
		if maxDeletedSeq == 0 {
			return nil
		}

		deleteSQL := fmt.Sprintf("DELETE FROM %s WHERE uid = ? AND %s", spec.table, spec.predicate)
		r, err := tx.Exec(deleteSQL, queryArgs...)
		if err != nil {
			return err
		}
		deleted, _ = r.RowsAffected()
		return advanceGCSafeSeq(tx, uid, maxDeletedSeq, spec.versionSpec)
	})
	if err != nil {
		return 0, fmt.Errorf("%s: %w", spec.errorPrefix, err)
	}
	return deleted, nil
}

func bumpContactSeq(tx *sql.Tx, uid int64) (int64, error) {
	return bumpVersionSeq(tx, uid, contactSeqSpec)
}

// bumpMessageSeq 推进 messages_version.max_seq。messages_version 没有 gc_safe_seq，
// 因为消息和会话不做全量同步，不需要安全水线。
func bumpMessageSeq(tx *sql.Tx, uid int64) (int64, error) {
	if _, err := tx.Exec(
		"INSERT INTO messages_version (uid, max_seq) VALUES (?, 1) ON CONFLICT(uid) DO UPDATE SET max_seq = max_seq + 1",
		uid,
	); err != nil {
		return 0, fmt.Errorf("bump message seq: %w", err)
	}
	var seq int64
	if err := tx.QueryRow("SELECT max_seq FROM messages_version WHERE uid = ?", uid).Scan(&seq); err != nil {
		return 0, fmt.Errorf("read message seq: %w", err)
	}
	return seq, nil
}

// getMessageMaxSeq 读取 messages_version.max_seq，无记录返回 0。
func getMessageMaxSeq(db *sql.DB, uid int64) (int64, error) {
	var maxSeq int64
	err := db.QueryRow("SELECT max_seq FROM messages_version WHERE uid = ?", uid).Scan(&maxSeq)
	if err != nil {
		if isNoRows(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("get message max seq: %w", err)
	}
	return maxSeq, nil
}

func bumpBlocklistSeq(tx *sql.Tx, uid int64) (int64, error) {
	return bumpVersionSeq(tx, uid, blocklistSeqSpec)
}

func bumpMutelistSeq(tx *sql.Tx, uid int64) (int64, error) {
	return bumpVersionSeq(tx, uid, mutelistSeqSpec)
}

func scanRows[T any](rows interface {
	Next() bool
	Scan(dest ...interface{}) error
	Err() error
}, scanOne func(rowScanner) (T, error)) ([]T, error) {
	var result []T
	for rows.Next() {
		item, err := scanOne(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func queryRows[T any](db *sql.DB, context, query string, scanOne func(rowScanner) (T, error), args ...interface{}) ([]T, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", context, err)
	}
	defer rows.Close()
	result, err := scanRows(rows, scanOne)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", context, err)
	}
	return result, nil
}

// placeholders returns "?,?,?" with n question marks.
func placeholders(n int) string {
	return strings.Repeat("?,", n)[:n*2-1]
}

// int64sToAny converts []int64 to []any for use in Query args.
func int64sToAny(ids []int64) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}
