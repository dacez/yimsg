package dal

import (
	"testing"

	"yimsg/server/internal/msgid"
)

func TestInsertAndList(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	// Insert 3 messages for user 1 (DM from uid 2)
	for i := int64(1); i <= 3; i++ {
		seq, err := store.Insert(1, msgid.Generate(), 2, 1, 0, MsgText, []byte("hello"), "hello", 1000+i)
		if err != nil {
			t.Fatalf("InsertMessage %d: %v", i, err)
		}
		if seq != i {
			t.Errorf("msg %d: got seq %d, want %d", i, seq, i)
		}
	}

	// Read conversation messages (DM with uid 2)
	msgs, err := store.ListByConversation(1, 2, 0, 0, 100)
	if err != nil {
		t.Fatalf("ListByConversation: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}
	// Should be DESC order
	if msgs[0].Seq != 3 || msgs[2].Seq != 1 {
		t.Errorf("wrong order: seq[0]=%d, seq[2]=%d", msgs[0].Seq, msgs[2].Seq)
	}
}

func TestListAfterByConversation(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	for i := int64(1); i <= 5; i++ {
		if _, err := store.Insert(1, msgid.Generate(), 2, 1, 0, MsgText, []byte("msg"), "msg", 1000+i); err != nil {
			t.Fatalf("InsertMessage %d: %v", i, err)
		}
	}

	msgs, err := store.ListAfterByConversation(1, 2, 0, 2, 2)
	if err != nil {
		t.Fatalf("ListAfterByConversation: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if msgs[0].Seq != 4 || msgs[1].Seq != 3 {
		t.Fatalf("unexpected newer page order: %+v", msgs)
	}
}

func TestSyncMessagesCursorBoundaries(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	for i := int64(1); i <= 5; i++ {
		if _, err := store.Insert(1, msgid.Generate(), 2, 1, 0, MsgText, []byte("msg"), "msg", 1000+i); err != nil {
			t.Fatalf("InsertMessage %d: %v", i, err)
		}
	}

	tests := []struct {
		name    string
		lastSeq int64
		limit   int64
		wantSeq []int64
	}{
		{name: "first page exact limit", lastSeq: 0, limit: 2, wantSeq: []int64{1, 2}},
		{name: "middle page excludes cursor", lastSeq: 2, limit: 2, wantSeq: []int64{3, 4}},
		{name: "tail partial page", lastSeq: 4, limit: 2, wantSeq: []int64{5}},
		{name: "empty at max cursor", lastSeq: 5, limit: 2, wantSeq: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msgs, err := store.Sync(1, tt.lastSeq, tt.limit)
			if err != nil {
				t.Fatalf("Sync: %v", err)
			}
			if len(msgs) != len(tt.wantSeq) {
				t.Fatalf("got %d messages, want %d: %+v", len(msgs), len(tt.wantSeq), msgs)
			}
			for i, want := range tt.wantSeq {
				if msgs[i].Seq != want {
					t.Fatalf("seq[%d]=%d, want %d; messages=%+v", i, msgs[i].Seq, want, msgs)
				}
			}
		})
	}
}

func TestInsertDuplicate(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	dupID := msgid.Generate()
	seq1, err := store.Insert(1, dupID, 2, 1, 0, MsgText, []byte("hello"), "hello", 1000)
	if err != nil {
		t.Fatalf("InsertMessage: %v", err)
	}
	if seq1 != 1 {
		t.Errorf("first insert: got seq %d, want 1", seq1)
	}

	// Same uid+msgID → duplicate
	seq2, err := store.Insert(1, dupID, 2, 1, 0, MsgText, []byte("hello again"), "hello again", 2000)
	if err != nil {
		t.Fatalf("InsertMessage dup: %v", err)
	}
	if seq2 != 0 {
		t.Errorf("duplicate: got seq %d, want 0", seq2)
	}
}

func TestMessageGC(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	for i := int64(1); i <= 10; i++ {
		store.Insert(1, msgid.Generate(), 2, 1, 0, MsgText, []byte("msg"), "msg", 1000+i)
	}

	deleted, err := store.Purge(1, 5)
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if deleted != 5 {
		t.Errorf("deleted %d, want 5", deleted)
	}

	// Should have 5 remaining (seq 6-10)
	msgs, _ := store.ListByConversation(1, 2, 0, 0, 100)
	if len(msgs) != 5 {
		t.Errorf("remaining %d, want 5", len(msgs))
	}
	// DESC order: first should be seq 10
	if msgs[0].Seq != 10 {
		t.Errorf("first remaining seq %d, want 10", msgs[0].Seq)
	}

	maxSeq, err := store.MaxSeq(1)
	if err != nil {
		t.Fatalf("MaxSeq: %v", err)
	}
	if maxSeq != 10 {
		t.Fatalf("max_seq after message GC = %d, want 10", maxSeq)
	}

	seq, err := store.Insert(1, msgid.Generate(), 2, 1, 0, MsgText, []byte("after gc"), "after gc", 2000)
	if err != nil {
		t.Fatalf("Insert after GC: %v", err)
	}
	if seq != 11 {
		t.Fatalf("seq after GC = %d, want 11", seq)
	}
}

func TestDeleteMessageWritesTombstone(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	mid := msgid.Generate()
	seq, err := store.Insert(1, mid, 2, 1, 0, MsgText, []byte("hello"), "hello", 1000)
	if err != nil || seq != 1 {
		t.Fatalf("Insert = %d, err=%v", seq, err)
	}

	deleteSeq, ok, err := store.DeleteByMsgID(1, mid)
	if err != nil || !ok {
		t.Fatalf("DeleteByMsgID = %d/%v, err=%v", deleteSeq, ok, err)
	}
	if deleteSeq != 2 {
		t.Fatalf("delete seq = %d, want 2", deleteSeq)
	}

	visible, err := store.ListByConversation(1, 2, 0, 0, 100)
	if err != nil {
		t.Fatalf("ListByConversation: %v", err)
	}
	if len(visible) != 0 {
		t.Fatalf("deleted message should be hidden from pages: %+v", visible)
	}

	changes, err := store.Sync(1, seq, 10)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(changes) != 1 || changes[0].MsgID != mid || changes[0].Seq != deleteSeq || changes[0].Status != MessageDeleted {
		t.Fatalf("sync tombstone = %+v, want deleted msg %s at seq %d", changes, mid, deleteSeq)
	}
}

func TestGetAndUpdateByMsgID(t *testing.T) {
	db := setupDB(t)
	store := NewMessageStore(db.UIDShards.AllShards()[0])

	mid := msgid.Generate()
	seq, err := store.Insert(1, mid, 2, 1, 0, MsgText, []byte("hello"), "hello", 1000)
	if err != nil || seq != 1 {
		t.Fatalf("Insert = %d, err=%v", seq, err)
	}

	msg, err := store.GetByMsgID(1, mid)
	if err != nil || msg == nil || string(msg.Body) != "hello" {
		t.Fatalf("GetByMsgID = %+v, err=%v", msg, err)
	}

	ok, err := store.UpdateByMsgID(1, mid, MsgQuote, []byte("updated"), "updated")
	if err != nil || !ok {
		t.Fatalf("UpdateByMsgID = %v, err=%v", ok, err)
	}

	msg, err = store.GetByMsgID(1, mid)
	if err != nil || msg == nil || msg.MsgType != MsgQuote || string(msg.Body) != "updated" {
		t.Fatalf("GetByMsgID after update = %+v, err=%v", msg, err)
	}
}
