// Package store 是 yimsg-cli 的本地同步库：每个账号目录下一个 SQLite 文件
// （见 cli/account），保存 sync_messages 拉取到的消息副本、增量同步游标与
// AI 已处理游标，供 history / pending 等命令离线查询，不需要每次都回源服务端。
//
// 会话归属推导（非显而易见，需特别说明）：服务端 Message.target 字段语义是
// "消息的收件人"（DM 时恒为 to_uid，无论这条消息存在发送者还是接收者自己的收件箱
// 副本里），因此同一个人视角下，判断"这条消息属于我跟谁的会话"不能直接读 target，
// 必须结合 from_uid：若 from_uid==我自己，会话对方是 target.uid；否则会话对方就是
// from_uid 本身。群消息没有这个问题，target.group_id 在所有副本里恒定。
package store

import (
	"database/sql"
	"fmt"

	"yimsg/protocol/generated/go/pb"

	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

// Store 是单个账号的本地同步库句柄。
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS messages (
	seq INTEGER PRIMARY KEY,
	msg_id TEXT NOT NULL UNIQUE,
	from_uid INTEGER NOT NULL,
	to_uid INTEGER NOT NULL DEFAULT 0,
	group_id INTEGER NOT NULL DEFAULT 0,
	peer_uid INTEGER NOT NULL DEFAULT 0,
	msg_type INTEGER NOT NULL,
	send_time INTEGER NOT NULL,
	status INTEGER NOT NULL,
	body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_peer_uid_seq ON messages(peer_uid, seq);
CREATE INDEX IF NOT EXISTS idx_messages_group_id_seq ON messages(group_id, seq);

CREATE TABLE IF NOT EXISTS sync_state (
	key TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);
`

const (
	keyLastSyncedSeq = "last_synced_seq"
	keyAICursorSeq   = "ai_cursor_seq"
)

// Open 打开（不存在则创建）path 处的本地同步库。研发阶段不做 schema 迁移：
// 版本不匹配时直接删除文件重新同步（见 CLAUDE.md 项目不变量）。
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("pragma %s: %w", pragma, err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close 关闭本地同步库。
func (s *Store) Close() error {
	return s.db.Close()
}

// SaveMessages 把一批增量消息写入本地库（按 seq 幂等 upsert），myUID 是本账号自身的
// uid，用于推导每条 DM 消息的会话对方（peer_uid）。返回新写入（或覆盖）的条数。
func (s *Store) SaveMessages(myUID int64, messages []*pb.Message) (int, error) {
	if len(messages) == 0 {
		return 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO messages (seq, msg_id, from_uid, to_uid, group_id, peer_uid, msg_type, send_time, status, body)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(seq) DO UPDATE SET
			msg_id=excluded.msg_id, from_uid=excluded.from_uid, to_uid=excluded.to_uid,
			group_id=excluded.group_id, peer_uid=excluded.peer_uid, msg_type=excluded.msg_type,
			send_time=excluded.send_time, status=excluded.status, body=excluded.body
	`)
	if err != nil {
		return 0, fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, m := range messages {
		toUID := m.GetTarget().GetUid()
		groupID := m.GetTarget().GetGroupId()
		peerUID := int64(0)
		if groupID == 0 {
			if m.GetFromUid() == myUID {
				peerUID = toUID
			} else {
				peerUID = m.GetFromUid()
			}
		}
		body, err := proto.Marshal(m.GetBody())
		if err != nil {
			return 0, fmt.Errorf("marshal body of msg_id=%s: %w", m.GetMsgId(), err)
		}
		if _, err := stmt.Exec(m.GetSeq(), m.GetMsgId(), m.GetFromUid(), toUID, groupID, peerUID,
			int32(m.GetMsgType()), m.GetSendTime(), int32(m.GetStatus()), body); err != nil {
			return 0, fmt.Errorf("insert msg_id=%s: %w", m.GetMsgId(), err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return len(messages), nil
}

// LastSyncedSeq 返回本地已追平的 sync_messages 游标，未同步过时为 0。
func (s *Store) LastSyncedSeq() (int64, error) {
	return s.getState(keyLastSyncedSeq)
}

// SetLastSyncedSeq 更新本地已追平的 sync_messages 游标。
func (s *Store) SetLastSyncedSeq(seq int64) error {
	return s.setState(keyLastSyncedSeq, seq)
}

// AICursor 返回 AI 上次处理到的最大 seq，未设置过时为 0。
func (s *Store) AICursor() (int64, error) {
	return s.getState(keyAICursorSeq)
}

// SetAICursor 记录 AI 已处理到的最大 seq，供下次调用从此继续。
func (s *Store) SetAICursor(seq int64) error {
	return s.setState(keyAICursorSeq, seq)
}

func (s *Store) getState(key string) (int64, error) {
	var value int64
	err := s.db.QueryRow("SELECT value FROM sync_state WHERE key = ?", key).Scan(&value)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read state %s: %w", key, err)
	}
	return value, nil
}

func (s *Store) setState(key string, value int64) error {
	_, err := s.db.Exec(`
		INSERT INTO sync_state (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value
	`, key, value)
	if err != nil {
		return fmt.Errorf("write state %s: %w", key, err)
	}
	return nil
}

// StoredMessage 是本地库读出的一条消息，Body 已解码为结构化 MessageBody。
type StoredMessage struct {
	Seq      int64
	MsgID    string
	FromUID  int64
	ToUID    int64
	GroupID  int64
	MsgType  pb.MessageType
	SendTime int64
	Status   int32
	Body     *pb.MessageBody
}

const messageColumns = "seq, msg_id, from_uid, to_uid, group_id, msg_type, send_time, status, body"

func scanMessages(rows *sql.Rows) ([]StoredMessage, error) {
	defer rows.Close()
	var result []StoredMessage
	for rows.Next() {
		var m StoredMessage
		var msgType, status int32
		var body []byte
		if err := rows.Scan(&m.Seq, &m.MsgID, &m.FromUID, &m.ToUID, &m.GroupID, &msgType, &m.SendTime, &status, &body); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		m.MsgType = pb.MessageType(msgType)
		m.Status = status
		var decoded pb.MessageBody
		if err := proto.Unmarshal(body, &decoded); err != nil {
			return nil, fmt.Errorf("unmarshal body of msg_id=%s: %w", m.MsgID, err)
		}
		m.Body = &decoded
		result = append(result, m)
	}
	return result, rows.Err()
}

// HistoryWithUser 从本地同步副本查询与 peerUID 的单聊记录，seq 严格大于 afterSeq，按 seq 升序，最多 limit 条。
func (s *Store) HistoryWithUser(peerUID int64, afterSeq int64, limit int) ([]StoredMessage, error) {
	rows, err := s.db.Query(
		`SELECT `+messageColumns+` FROM messages WHERE peer_uid = ? AND group_id = 0 AND seq > ? ORDER BY seq ASC LIMIT ?`,
		peerUID, afterSeq, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query history with user: %w", err)
	}
	return scanMessages(rows)
}

// HistoryWithGroup 从本地同步副本查询群 groupID 的聊天记录，seq 严格大于 afterSeq，按 seq 升序，最多 limit 条。
func (s *Store) HistoryWithGroup(groupID int64, afterSeq int64, limit int) ([]StoredMessage, error) {
	rows, err := s.db.Query(
		`SELECT `+messageColumns+` FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		groupID, afterSeq, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query history with group: %w", err)
	}
	return scanMessages(rows)
}

// Pending 返回 seq 严格大于 afterSeq 的全部会话消息，按 seq 升序，最多 limit 条；
// includeSelf 为 false 时排除本账号自己发出的消息，用于驱动"只看新收到的消息"的自动回复轮询。
func (s *Store) Pending(myUID int64, afterSeq int64, limit int, includeSelf bool) ([]StoredMessage, error) {
	query := `SELECT ` + messageColumns + ` FROM messages WHERE seq > ?`
	args := []any{afterSeq}
	if !includeSelf {
		query += ` AND from_uid != ?`
		args = append(args, myUID)
	}
	query += ` ORDER BY seq ASC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query pending: %w", err)
	}
	return scanMessages(rows)
}
