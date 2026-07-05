package dal

import (
	"testing"

	"yimsg/internal/msgid"
)

func TestUpsertAndListConversations(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	// Insert 3 conversations for user 1
	if err := store.Upsert(1, 2, 0, 10, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert DM: %v", err)
	}
	if err := store.Upsert(1, 3, 0, 20, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert DM2: %v", err)
	}
	if err := store.Upsert(1, 0, 100, 15, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert group: %v", err)
	}

	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(convs) != 3 {
		t.Fatalf("got %d conversations, want 3", len(convs))
	}
	if convs[0].Seq != 20 || convs[1].Seq != 15 || convs[2].Seq != 10 {
		t.Errorf("wrong order: %d, %d, %d", convs[0].Seq, convs[1].Seq, convs[2].Seq)
	}

	// List with cursor
	convs, err = store.List(1, 20, 0, 10)
	if err != nil {
		t.Fatalf("list with cursor: %v", err)
	}
	if len(convs) != 2 {
		t.Fatalf("got %d, want 2", len(convs))
	}

	// List with limit
	convs, err = store.List(1, 0, 0, 2)
	if err != nil {
		t.Fatalf("list with limit: %v", err)
	}
	if len(convs) != 2 {
		t.Fatalf("got %d, want 2", len(convs))
	}
}

func TestListConversationCursorPage(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	for i := int64(1); i <= 5; i++ {
		if err := store.Upsert(1, 100+i, 0, i*10, msgid.Generate(), ConversationUnreadKeep); err != nil {
			t.Fatalf("upsert %d: %v", i, err)
		}
	}

	total, err := store.Count(1)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if total != 5 {
		t.Fatalf("count = %d, want 5", total)
	}

	convs, err := store.List(1, 50, 0, 2)
	if err != nil {
		t.Fatalf("list page: %v", err)
	}
	if len(convs) != 2 {
		t.Fatalf("got %d conversations, want 2", len(convs))
	}
	if convs[0].Seq != 40 || convs[1].Seq != 30 {
		t.Fatalf("unexpected page order: %+v", convs)
	}
}

func TestUpsertIdempotent(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	if err := store.Upsert(1, 2, 0, 10, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if err := store.Upsert(1, 2, 0, 20, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(convs) != 1 {
		t.Fatalf("got %d, want 1", len(convs))
	}
	if convs[0].Seq != 20 {
		t.Errorf("seq = %d, want 20", convs[0].Seq)
	}
}

func TestUpsertOlderSeqIgnored(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	if err := store.Upsert(1, 2, 0, 20, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if err := store.Upsert(1, 2, 0, 10, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if convs[0].Seq != 20 {
		t.Errorf("seq = %d, want 20", convs[0].Seq)
	}
}

func TestUpsertUnreadModes(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	if err := store.Upsert(1, 2, 0, 10, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	total, err := store.TotalUnreadCount(1)
	if err != nil || total != 1 {
		t.Fatalf("TotalUnreadCount after increment = %d, err=%v", total, err)
	}

	if err := store.Upsert(1, 2, 0, 20, msgid.Generate(), ConversationUnreadKeep); err != nil {
		t.Fatalf("keep upsert: %v", err)
	}
	total, err = store.TotalUnreadCount(1)
	if err != nil || total != 1 {
		t.Fatalf("TotalUnreadCount after keep = %d, err=%v", total, err)
	}

	if err := store.Upsert(1, 2, 0, 30, msgid.Generate(), ConversationUnreadReset); err != nil {
		t.Fatalf("reset upsert: %v", err)
	}
	total, err = store.TotalUnreadCount(1)
	if err != nil || total != 0 {
		t.Fatalf("TotalUnreadCount after reset = %d, err=%v", total, err)
	}
}

func TestConversationPurgeUsesSeqWindowForActiveRows(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])
	messageStore := NewMessageStore(db.UIDShards.AllShards()[0])

	for i := int64(1); i <= 5; i++ {
		mid := msgid.Generate()
		seq, err := messageStore.Insert(1, mid, 1, 100+i, 0, 1, []byte("hi"), "hi", 2000+i)
		if err != nil {
			t.Fatalf("insert message %d: %v", i, err)
		}
		if seq != i {
			t.Fatalf("message seq = %d, want %d", seq, i)
		}
		if err := store.Upsert(1, 100+i, 0, seq, mid, ConversationUnreadKeep); err != nil {
			t.Fatalf("upsert %d: %v", i, err)
		}
	}

	deleted, err := store.Purge(1, 3)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("deleted = %d, want 2", deleted)
	}

	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(convs) != 3 {
		t.Fatalf("remaining = %d, want 3", len(convs))
	}
	if convs[0].Seq != 5 || convs[2].Seq != 3 {
		t.Fatalf("unexpected remaining seqs: %+v", convs)
	}

	synced, err := store.Sync(1, 1, 10)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(synced) != 3 || synced[0].Seq != 3 || synced[2].Seq != 5 {
		t.Fatalf("sync should return only retained rows after gap: %+v", synced)
	}
}

func TestGetByTargets(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	if err := store.Upsert(1, 2, 0, 10, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert dm: %v", err)
	}
	if err := store.Upsert(1, 0, 100, 20, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert group: %v", err)
	}
	if err := store.Upsert(1, 3, 0, 30, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert dm2: %v", err)
	}

	// 命中 DM(2) 与 群(100)，外加一个不存在的 DM(9) → 只返回存在的两个。
	got, err := store.GetByTargets(1, []int64{2, 0, 9}, []int64{0, 100, 0})
	if err != nil {
		t.Fatalf("get by targets: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d conversations, want 2: %+v", len(got), got)
	}

	// 已删除（tombstone）的会话不返回。
	if _, _, err := store.Delete(1, 2, 0); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, err = store.GetByTargets(1, []int64{2}, []int64{0})
	if err != nil {
		t.Fatalf("get by targets after delete: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("deleted conversation should not be returned: %+v", got)
	}
}

func TestClearUnreadKeepsSeq(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	if err := store.Upsert(1, 2, 0, 10, msgid.Generate(), ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := store.ClearUnread(1, 2, 0); err != nil {
		t.Fatalf("clear unread: %v", err)
	}

	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(convs) != 1 {
		t.Fatalf("got %d, want 1", len(convs))
	}
	// clearunread 只清未读、不动 seq（不重排）。
	if convs[0].Seq != 10 || convs[0].UnreadCount != 0 {
		t.Fatalf("after mark read seq=%d unread=%d, want seq=10 unread=0", convs[0].Seq, convs[0].UnreadCount)
	}
}

// TestClearUnreadPurgedConversationNotRecreated 验证：会话行被 GC 后，clearunread
// 不重建会话（即使消息仍在）——红点由前端事件就地清除，后台等下一条消息再重建追平。
func TestClearUnreadPurgedConversationNotRecreated(t *testing.T) {
	db := setupDB(t)
	shard := db.UIDShards.AllShards()[0]
	messageStore := NewMessageStore(shard)
	store := NewConversationStore(shard)

	mid := msgid.Generate()
	seq, err := messageStore.Insert(1, mid, 2, 1, 0, MsgText, []byte("hi"), "hi", 1000)
	if err != nil {
		t.Fatalf("insert message: %v", err)
	}
	if err := store.Upsert(1, 2, 0, seq, mid, ConversationUnreadIncrement); err != nil {
		t.Fatalf("upsert conversation: %v", err)
	}

	// 模拟会话行被 GC：直接删除会话行（消息仍在）。
	if _, err := shard.Writer.Exec("DELETE FROM conversations WHERE uid = 1"); err != nil {
		t.Fatalf("simulate gc: %v", err)
	}

	if err := store.ClearUnread(1, 2, 0); err != nil {
		t.Fatalf("clear unread: %v", err)
	}

	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(convs) != 0 {
		t.Fatalf("clearunread should not re-create purged conversation: %+v", convs)
	}
}

// TestClearUnreadMissingConversationNoMessageNoop 验证：会话与消息都不存在时，
// clearunread 不创建任何行（红点本就无来源）。
func TestClearUnreadMissingConversationNoMessageNoop(t *testing.T) {
	db := setupDB(t)
	store := NewConversationStore(db.UIDShards.AllShards()[0])

	if err := store.ClearUnread(1, 2, 0); err != nil {
		t.Fatalf("clear unread: %v", err)
	}
	convs, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(convs) != 0 {
		t.Fatalf("got %d conversations, want 0", len(convs))
	}
}

func TestConversationDeleteUsesMessagesVersionSeq(t *testing.T) {
	db := setupDB(t)
	shard := db.UIDShards.AllShards()[0]
	messageStore := NewMessageStore(shard)
	store := NewConversationStore(shard)

	mid := msgid.Generate()
	msgSeq, err := messageStore.Insert(1, mid, 1, 2, 0, MsgText, []byte("hello"), "hello", 1000)
	if err != nil {
		t.Fatalf("insert message: %v", err)
	}
	if err := store.Upsert(1, 2, 0, msgSeq, mid, ConversationUnreadKeep); err != nil {
		t.Fatalf("upsert conversation: %v", err)
	}

	deleteSeq, ok, err := store.Delete(1, 2, 0)
	if err != nil || !ok {
		t.Fatalf("delete conversation = %d/%v, err=%v", deleteSeq, ok, err)
	}
	if deleteSeq != msgSeq+1 {
		t.Fatalf("conversation delete seq = %d, want %d", deleteSeq, msgSeq+1)
	}
	maxSeq, err := messageStore.MaxSeq(1)
	if err != nil {
		t.Fatalf("message max seq: %v", err)
	}
	if maxSeq != deleteSeq {
		t.Fatalf("messages_version max seq = %d, want %d", maxSeq, deleteSeq)
	}

	active, err := store.List(1, 0, 0, 10)
	if err != nil {
		t.Fatalf("list active: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("deleted conversation should be hidden: %+v", active)
	}

	changes, err := store.Sync(1, msgSeq, 10)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(changes) != 1 || changes[0].Seq != deleteSeq || changes[0].Status != ConversationDeleted {
		t.Fatalf("conversation tombstone sync = %+v", changes)
	}
}
