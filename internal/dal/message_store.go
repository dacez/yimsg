package dal

import (
	"database/sql"
	"fmt"
	"strings"

	"yimsg/internal/shard"
)

// MessageStore provides message-related database operations (messages table per-user inbox).
type MessageStore struct{ db *shard.DB }

// NewMessageStore creates a MessageStore backed by the given shard.
func NewMessageStore(db *shard.DB) *MessageStore { return &MessageStore{db: db} }

const messageSelectFields = `seq, msg_id, from_uid, to_uid, group_id, msg_type, body, search_text, send_time, status`

// Insert inserts a message using messages_version seq assignment.
// body 是 protobuf 编码后的 MessageBody，不能为空 bytes。
// Returns the assigned seq, or 0 if the message was a duplicate (same uid+msg_id).
func (s *MessageStore) Insert(uid int64, msgID string, fromUID, toUID, groupID int64, msgType int8, body []byte, searchText string, sendTime int64) (int64, error) {
	if len(body) == 0 {
		return 0, fmt.Errorf("insert message: empty body")
	}
	var seq int64
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var existingSeq int64
		err := tx.QueryRow("SELECT seq FROM messages WHERE uid = ? AND msg_id = ?", uid, msgID).Scan(&existingSeq)
		if err == nil {
			return nil
		}
		if !isNoRows(err) {
			return err
		}

		seq, err = bumpMessageSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			`INSERT INTO messages (uid, seq, msg_id, from_uid, to_uid, group_id, msg_type, body, search_text, send_time, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uid, seq, msgID, fromUID, toUID, groupID, msgType, body, searchText, sendTime, MessageActive,
		)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("insert message: %w", err)
	}
	return seq, nil
}

// GetByMsgID returns one message by business msg_id, or nil if not found.
func (s *MessageStore) GetByMsgID(uid int64, msgID string) (*Message, error) {
	row := s.db.Reader.QueryRow(
		`SELECT `+messageSelectFields+`
		 FROM messages WHERE uid = ? AND msg_id = ? AND status != ?`,
		uid, msgID, MessageDeleted,
	)
	m, err := scanMessage(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get message by msg_id: %w", err)
	}
	return &m, nil
}

// ListByMsgIDs returns messages by business msg_ids within the user's inbox, newest first.
// Deleted messages and unknown ids are silently omitted.
func (s *MessageStore) ListByMsgIDs(uid int64, msgIDs []string) ([]Message, error) {
	if len(msgIDs) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(msgIDs))
	args := make([]any, 0, len(msgIDs)+2)
	args = append(args, uid)
	for i, id := range msgIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	args = append(args, MessageDeleted)
	rows, err := s.db.Reader.Query(
		`SELECT `+messageSelectFields+`
		 FROM messages WHERE uid = ? AND msg_id IN (`+strings.Join(placeholders, ",")+`) AND status != ?
		 ORDER BY seq DESC`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("list messages by msg_ids: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// GetBySeq returns one message by user seq, or nil if not found.
func (s *MessageStore) GetBySeq(uid, seq int64) (*Message, error) {
	row := s.db.Reader.QueryRow(
		`SELECT `+messageSelectFields+`
		 FROM messages WHERE uid = ? AND seq = ? AND status != ?`,
		uid, seq, MessageDeleted,
	)
	m, err := scanMessage(row)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get message by seq: %w", err)
	}
	return &m, nil
}

// MaxSeq returns the current max message seq for a user.
func (s *MessageStore) MaxSeq(uid int64) (int64, error) {
	return getMessageMaxSeq(s.db.Reader, uid)
}

// UpdateByMsgID updates the type/body/search_text of one message by business msg_id.
// 用于撤回时把原消息正文覆盖为撤回占位 body，做服务端脱敏。
func (s *MessageStore) UpdateByMsgID(uid int64, msgID string, msgType int8, body []byte, searchText string) (bool, error) {
	if len(body) == 0 {
		return false, fmt.Errorf("update message by msg_id: empty body")
	}
	r, err := s.db.Writer.Exec(
		"UPDATE messages SET msg_type = ?, body = ?, search_text = ? WHERE uid = ? AND msg_id = ? AND status != ?",
		msgType, body, searchText, uid, msgID, MessageDeleted,
	)
	if err != nil {
		return false, fmt.Errorf("update message by msg_id: %w", err)
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// DeleteByMsgID soft-deletes one message and moves it to a fresh messages_version seq.
func (s *MessageStore) DeleteByMsgID(uid int64, msgID string) (int64, bool, error) {
	var newSeq int64
	var found bool
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var currentStatus uint8
		err := tx.QueryRow("SELECT status FROM messages WHERE uid = ? AND msg_id = ?", uid, msgID).Scan(&currentStatus)
		if err != nil {
			if isNoRows(err) {
				return nil
			}
			return err
		}
		if currentStatus == MessageDeleted {
			return nil
		}
		found = true
		newSeq, err = bumpMessageSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			"UPDATE messages SET status = ?, seq = ? WHERE uid = ? AND msg_id = ?",
			MessageDeleted, newSeq, uid, msgID,
		)
		return err
	})
	if err != nil {
		return 0, false, fmt.Errorf("delete message by msg_id: %w", err)
	}
	return newSeq, found, nil
}

// Sync returns messages with seq > lastSeq across all conversations, ordered by seq ASC.
// This is the global incremental sync for catching up after reconnection.
func (s *MessageStore) Sync(uid, lastSeq, limit int64) ([]Message, error) {
	rows, err := s.db.Reader.Query(
		`SELECT `+messageSelectFields+`
		 FROM messages WHERE uid = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		uid, lastSeq, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("sync messages: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// ListByConversation returns messages for a specific conversation (DM or group).
func (s *MessageStore) ListByConversation(uid, toUID, groupID, beforeSeq, limit int64) ([]Message, error) {
	var rows *sql.Rows
	var err error

	if groupID > 0 {
		if beforeSeq > 0 {
			rows, err = s.db.Reader.Query(
				`SELECT `+messageSelectFields+`
				 FROM messages WHERE uid = ? AND group_id = ? AND status != ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
				uid, groupID, MessageDeleted, beforeSeq, limit,
			)
		} else {
			rows, err = s.db.Reader.Query(
				`SELECT `+messageSelectFields+`
				 FROM messages WHERE uid = ? AND group_id = ? AND status != ? ORDER BY seq DESC LIMIT ?`,
				uid, groupID, MessageDeleted, limit,
			)
		}
	} else {
		// DM: messages where (from_uid=me AND to_uid=them) OR (from_uid=them AND to_uid=me)
		if beforeSeq > 0 {
			rows, err = s.db.Reader.Query(
				`SELECT `+messageSelectFields+`
				 FROM messages WHERE uid = ? AND group_id = 0 AND status != ?
				   AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))
				   AND seq < ? ORDER BY seq DESC LIMIT ?`,
				uid, MessageDeleted, uid, toUID, toUID, uid, beforeSeq, limit,
			)
		} else {
			rows, err = s.db.Reader.Query(
				`SELECT `+messageSelectFields+`
				 FROM messages WHERE uid = ? AND group_id = 0 AND status != ?
				   AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))
				   ORDER BY seq DESC LIMIT ?`,
				uid, MessageDeleted, uid, toUID, toUID, uid, limit,
			)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("list conversation messages: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// ListAfterByConversation returns the next newer page after afterSeq.
// The selected page is closest to afterSeq and returned in DESC order, matching ListByConversation.
func (s *MessageStore) ListAfterByConversation(uid, toUID, groupID, afterSeq, limit int64) ([]Message, error) {
	var rows *sql.Rows
	var err error

	if groupID > 0 {
		rows, err = s.db.Reader.Query(
			`SELECT `+messageSelectFields+` FROM (
				SELECT `+messageSelectFields+`
				FROM messages WHERE uid = ? AND group_id = ? AND status != ? AND seq > ? ORDER BY seq ASC LIMIT ?
			) ORDER BY seq DESC`,
			uid, groupID, MessageDeleted, afterSeq, limit,
		)
	} else {
		rows, err = s.db.Reader.Query(
			`SELECT `+messageSelectFields+` FROM (
				SELECT `+messageSelectFields+`
				FROM messages WHERE uid = ? AND group_id = 0 AND status != ?
				  AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))
				  AND seq > ? ORDER BY seq ASC LIMIT ?
			) ORDER BY seq DESC`,
			uid, MessageDeleted, uid, toUID, toUID, uid, afterSeq, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("list newer conversation messages: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// ListAroundByConversation returns messages centered on aroundSeq.
// It reads half limit before (inclusive) and half limit after aroundSeq.
// Results are returned in DESC order (newest first), same as ListByConversation.
func (s *MessageStore) ListAroundByConversation(uid, toUID, groupID, aroundSeq, limit int64) ([]Message, error) {
	half := limit / 2
	if half < 1 {
		half = 25
	}

	var convFilter string
	var args []interface{}

	if groupID > 0 {
		convFilter = "uid = ? AND group_id = ?"
		args = []interface{}{uid, groupID}
	} else {
		convFilter = "uid = ? AND group_id = 0 AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))"
		args = []interface{}{uid, uid, toUID, toUID, uid}
	}

	// Union: messages with seq <= aroundSeq (DESC limit half) + messages with seq > aroundSeq (ASC limit half).
	// Each branch is wrapped in a subquery because SQLite disallows ORDER BY in compound SELECT branches.
	query := fmt.Sprintf(
		`SELECT `+messageSelectFields+` FROM (
			SELECT * FROM (
				SELECT `+messageSelectFields+`
				FROM messages WHERE %s AND status != ? AND seq <= ? ORDER BY seq DESC LIMIT ?
			)
			UNION ALL
			SELECT * FROM (
				SELECT `+messageSelectFields+`
				FROM messages WHERE %s AND status != ? AND seq > ? ORDER BY seq ASC LIMIT ?
			)
		) ORDER BY seq DESC`, convFilter, convFilter)

	// Args: first-half args + aroundSeq + half, second-half args + aroundSeq + half
	allArgs := make([]interface{}, 0, len(args)*2+4)
	allArgs = append(allArgs, args...)
	allArgs = append(allArgs, MessageDeleted, aroundSeq, half)
	allArgs = append(allArgs, args...)
	allArgs = append(allArgs, MessageDeleted, aroundSeq, half)

	rows, err := s.db.Reader.Query(query, allArgs...)
	if err != nil {
		return nil, fmt.Errorf("list conversation messages around: %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

// Purge removes messages whose seq is older than maxSeq-retainSeqWindow.
func (s *MessageStore) Purge(uid int64, retainSeqWindow int64) (int64, error) {
	maxSeq, err := s.MaxSeq(uid)
	if err != nil {
		return 0, err
	}
	cutoff := maxSeq - retainSeqWindow
	if cutoff <= 0 {
		return 0, nil
	}
	r, err := s.db.Writer.Exec("DELETE FROM messages WHERE uid = ? AND seq <= ?", uid, cutoff)
	if err != nil {
		return 0, fmt.Errorf("gc messages: %w", err)
	}
	n, _ := r.RowsAffected()
	return n, nil
}

// ListPurgeable returns up to limit UIDs whose message seq span exceeds retainSeqWindow.
func (s *MessageStore) ListPurgeable(retainSeqWindow, limit, afterUID int64) ([]int64, error) {
	rows, err := s.db.Reader.Query(
		"SELECT uid FROM messages WHERE uid > ? GROUP BY uid HAVING MAX(seq) - MIN(seq) > ? LIMIT ?",
		afterUID, retainSeqWindow, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list uids exceeding: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}

func scanMessages(rows *sql.Rows) ([]Message, error) {
	return scanRows(rows, scanMessage)
}

func scanMessage(row rowScanner) (Message, error) {
	var m Message
	err := row.Scan(&m.Seq, &m.MsgID, &m.FromUID, &m.ToUID, &m.GroupID, &m.MsgType, &m.Body, &m.SearchText, &m.SendTime, &m.Status)
	return m, err
}
