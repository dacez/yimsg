package dal

import (
	"database/sql"
	"fmt"
	"strings"

	"yimsg/internal/shard"
)

// ConversationStore provides conversation summary operations (materialized view of last message + unread count).
type ConversationStore struct{ db *shard.DB }

// NewConversationStore creates a ConversationStore backed by the given shard.
func NewConversationStore(db *shard.DB) *ConversationStore { return &ConversationStore{db: db} }

// Upsert inserts or updates a conversation record.
// Only updates if the new message seq is greater than the existing one.
func (s *ConversationStore) Upsert(uid, toUID, groupID, lastMsgSeq int64, msgID string, unreadMode ConversationUnreadMode) error {
	var unreadInsert any
	var unreadExpr string
	switch unreadMode {
	case ConversationUnreadReset:
		unreadInsert = 0
		unreadExpr = "0"
	case ConversationUnreadIncrement:
		unreadInsert = 1
		unreadExpr = "conversations.unread_count + 1"
	default:
		unreadInsert = 0
		unreadExpr = "conversations.unread_count"
	}
	_, err := s.db.Writer.Exec(
		fmt.Sprintf(`INSERT INTO conversations (uid, to_uid, group_id, seq, last_msg_id, unread_count, status)
 VALUES (?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(uid, to_uid, group_id) DO UPDATE SET
	     seq = excluded.seq,
	     last_msg_id  = excluded.last_msg_id,
	     unread_count = %s,
	     status       = excluded.status
 WHERE excluded.seq > conversations.seq`, unreadExpr),
		uid, toUID, groupID, lastMsgSeq, msgID, unreadInsert, ConversationActive,
	)
	if err != nil {
		return fmt.Errorf("upsert conversation: %w", err)
	}
	return nil
}

// ClearUnread clears unread_count for a conversation without bumping seq（不重排）。
// 会话行已缺失（多为已被 GC）时不重建：红点由 conversations:clearunread 事件在前端
// 数据窗口内就地清除，后台会话表等下一条消息到来时自然重建追平。
func (s *ConversationStore) ClearUnread(uid, toUID, groupID int64) error {
	_, err := s.db.Writer.Exec(
		"UPDATE conversations SET unread_count = 0 WHERE uid = ? AND to_uid = ? AND group_id = ? AND status = ?",
		uid, toUID, groupID, ConversationActive,
	)
	if err != nil {
		return fmt.Errorf("clear unread: %w", err)
	}
	return nil
}

// Delete soft-deletes a conversation using a fresh messages_version seq.
func (s *ConversationStore) Delete(uid, toUID, groupID int64) (int64, bool, error) {
	var deleteSeq int64
	var found bool
	err := withTx(s.db.Writer, func(tx *sql.Tx) error {
		var currentStatus uint8
		err := tx.QueryRow(
			"SELECT status FROM conversations WHERE uid = ? AND to_uid = ? AND group_id = ?",
			uid, toUID, groupID,
		).Scan(&currentStatus)
		if err != nil {
			if isNoRows(err) {
				return nil
			}
			return err
		}
		if currentStatus == ConversationDeleted {
			return nil
		}
		found = true
		deleteSeq, err = bumpMessageSeq(tx, uid)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			`UPDATE conversations SET status = ?, unread_count = 0, seq = ?
 WHERE uid = ? AND to_uid = ? AND group_id = ?`,
			ConversationDeleted, deleteSeq, uid, toUID, groupID,
		)
		return err
	})
	if err != nil {
		return 0, false, fmt.Errorf("delete conversation: %w", err)
	}
	return deleteSeq, found, nil
}

func scanConversation(row rowScanner) (Conversation, error) {
	var c Conversation
	err := row.Scan(&c.ToUID, &c.GroupID, &c.Seq, &c.LastMsgID, &c.UnreadCount, &c.Status)
	return c, err
}

const convSelectFields = `to_uid, group_id, seq, last_msg_id, unread_count, status`

// List returns active conversations ordered by seq with cursor-based pagination.
func (s *ConversationStore) List(uid, beforeSeq, afterSeq, limit int64) ([]Conversation, error) {
	if afterSeq > 0 {
		return queryRows(s.db.Reader, "list newer conversations",
			`SELECT `+convSelectFields+`
 FROM conversations WHERE uid = ? AND status = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
			scanConversation, uid, ConversationActive, afterSeq, limit,
		)
	}
	if beforeSeq > 0 {
		return queryRows(s.db.Reader, "list older conversations",
			`SELECT `+convSelectFields+`
 FROM conversations WHERE uid = ? AND status = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
			scanConversation, uid, ConversationActive, beforeSeq, limit,
		)
	}
	return queryRows(s.db.Reader, "list conversations",
		`SELECT `+convSelectFields+`
 FROM conversations WHERE uid = ? AND status = ? ORDER BY seq DESC LIMIT ?`,
		scanConversation, uid, ConversationActive, limit,
	)
}

// GetByTargets returns active conversations matching the given (toUID, groupID) target pairs.
// 缺失（已删除 / 已 GC）目标不返回；toUIDs 与 groupIDs 按下标一一对应。
func (s *ConversationStore) GetByTargets(uid int64, toUIDs, groupIDs []int64) ([]Conversation, error) {
	if len(toUIDs) == 0 || len(toUIDs) != len(groupIDs) {
		return nil, nil
	}
	conds := make([]string, len(toUIDs))
	args := make([]any, 0, 2+len(toUIDs)*2)
	args = append(args, uid, ConversationActive)
	for i := range toUIDs {
		conds[i] = "(to_uid = ? AND group_id = ?)"
		args = append(args, toUIDs[i], groupIDs[i])
	}
	return queryRows(s.db.Reader, "get conversations by targets",
		`SELECT `+convSelectFields+`
 FROM conversations WHERE uid = ? AND status = ? AND (`+strings.Join(conds, " OR ")+`)`,
		scanConversation, args...,
	)
}

// Sync returns conversation changes with seq > afterSeq.
func (s *ConversationStore) Sync(uid, afterSeq, limit int64) ([]Conversation, error) {
	return queryRows(s.db.Reader, "sync conversations",
		`SELECT `+convSelectFields+`
 FROM conversations WHERE uid = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		scanConversation, uid, afterSeq, limit,
	)
}

// Count returns the number of active conversations for a user.
func (s *ConversationStore) Count(uid int64) (int64, error) {
	var total int64
	if err := s.db.Reader.QueryRow(
		`SELECT COUNT(*) FROM conversations WHERE uid = ? AND status = ?`,
		uid, ConversationActive,
	).Scan(&total); err != nil {
		return 0, fmt.Errorf("count conversations: %w", err)
	}
	return total, nil
}

// TotalUnreadCount returns the sum of unread_count across active conversations for a user.
func (s *ConversationStore) TotalUnreadCount(uid int64) (int64, error) {
	var total int64
	if err := s.db.Reader.QueryRow(
		`SELECT COALESCE(SUM(unread_count), 0) FROM conversations WHERE uid = ? AND status = ?`,
		uid, ConversationActive,
	).Scan(&total); err != nil {
		return 0, fmt.Errorf("sum unread conversations: %w", err)
	}
	return total, nil
}

// Purge removes conversations whose seq is older than messages_version.max_seq-retainSeqWindow.
func (s *ConversationStore) Purge(uid int64, retainSeqWindow int64) (int64, error) {
	maxSeq, err := getMessageMaxSeq(s.db.Reader, uid)
	if err != nil {
		return 0, fmt.Errorf("get conversation version: %w", err)
	}
	cutoff := maxSeq - retainSeqWindow
	if cutoff <= 0 {
		return 0, nil
	}
	r, err := s.db.Writer.Exec("DELETE FROM conversations WHERE uid = ? AND seq <= ?", uid, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge conversations: %w", err)
	}
	n, _ := r.RowsAffected()
	return n, nil
}

// ListPurgeable returns up to limit UIDs whose message seq window exceeds retained conversation seqs.
func (s *ConversationStore) ListPurgeable(retainSeqWindow, limit, afterUID int64) ([]int64, error) {
	query := `SELECT uid FROM conversations
 WHERE uid > ?
 GROUP BY uid
 HAVING MIN(seq) <= COALESCE((SELECT max_seq FROM messages_version WHERE messages_version.uid = conversations.uid), 0) - ?
 LIMIT ?`
	rows, err := s.db.Reader.Query(query, afterUID, retainSeqWindow, limit)
	if err != nil {
		return nil, fmt.Errorf("list purgeable conversations: %w", err)
	}
	defer rows.Close()
	return scanInt64Rows(rows)
}
