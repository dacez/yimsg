package store

import (
	"path/filepath"
	"testing"

	"yimsg/protocol/generated/go/pb"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func textMsg(seq, fromUID, toUID, groupID int64, msgID, text string) *pb.Message {
	target := &pb.ConversationTarget{}
	if groupID > 0 {
		target.Kind = &pb.ConversationTarget_GroupId{GroupId: groupID}
	} else {
		target.Kind = &pb.ConversationTarget_Uid{Uid: toUID}
	}
	return &pb.Message{
		Seq:      seq,
		MsgId:    msgID,
		FromUid:  fromUID,
		Target:   target,
		MsgType:  pb.MessageType_MESSAGE_TYPE_TEXT,
		Body:     &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}},
		SendTime: seq * 1000,
		Status:   pb.MessageStatus_MESSAGE_STATUS_ACTIVE,
	}
}

// TestHistoryWithUserResolvesPeerFromBothDirections 验证会话对方推导：myUID=100，
// 一条是我发给 200 的（from=100,target.uid=200），一条是 200 发给我的（from=200,target.uid=100）。
// 两条都应归入 "我和 200 的会话"。
func TestHistoryWithUserResolvesPeerFromBothDirections(t *testing.T) {
	s := openTestStore(t)
	const myUID, peerUID = int64(100), int64(200)

	msgs := []*pb.Message{
		textMsg(1, myUID, peerUID, 0, "m1aaaaaaaaaaaaaaaaaaaa", "hi from me"),
		textMsg(2, peerUID, myUID, 0, "m2aaaaaaaaaaaaaaaaaaaa", "hi from peer"),
	}
	n, err := s.SaveMessages(myUID, msgs)
	if err != nil {
		t.Fatalf("save messages: %v", err)
	}
	if n != 2 {
		t.Fatalf("saved = %d, want 2", n)
	}

	got, err := s.HistoryWithUser(peerUID, 0, 10)
	if err != nil {
		t.Fatalf("history with user: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(history) = %d, want 2", len(got))
	}
	if got[0].Seq != 1 || got[1].Seq != 2 {
		t.Fatalf("history not in seq order: %+v", got)
	}
	if got[0].Body.GetText().GetText() != "hi from me" || got[1].Body.GetText().GetText() != "hi from peer" {
		t.Fatalf("unexpected bodies: %+v", got)
	}

	// 不相关的第三方不应出现。
	empty, err := s.HistoryWithUser(300, 0, 10)
	if err != nil {
		t.Fatalf("history with unrelated user: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected no history with unrelated uid, got %+v", empty)
	}
}

func TestHistoryWithGroup(t *testing.T) {
	s := openTestStore(t)
	const myUID, groupID = int64(100), int64(555)

	msgs := []*pb.Message{
		textMsg(1, 200, 0, groupID, "g1aaaaaaaaaaaaaaaaaaaa", "group hi"),
		textMsg(2, myUID, 0, groupID, "g2aaaaaaaaaaaaaaaaaaaa", "group reply"),
	}
	if _, err := s.SaveMessages(myUID, msgs); err != nil {
		t.Fatalf("save messages: %v", err)
	}

	got, err := s.HistoryWithGroup(groupID, 0, 10)
	if err != nil {
		t.Fatalf("history with group: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(history) = %d, want 2", len(got))
	}
}

func TestAICursorPersistence(t *testing.T) {
	s := openTestStore(t)
	seq, err := s.AICursor()
	if err != nil {
		t.Fatalf("ai cursor: %v", err)
	}
	if seq != 0 {
		t.Fatalf("initial ai cursor = %d, want 0", seq)
	}
	if err := s.SetAICursor(42); err != nil {
		t.Fatalf("set ai cursor: %v", err)
	}
	seq, err = s.AICursor()
	if err != nil {
		t.Fatalf("ai cursor: %v", err)
	}
	if seq != 42 {
		t.Fatalf("ai cursor = %d, want 42", seq)
	}
	if err := s.SetAICursor(100); err != nil {
		t.Fatalf("set ai cursor again: %v", err)
	}
	seq, _ = s.AICursor()
	if seq != 100 {
		t.Fatalf("ai cursor after update = %d, want 100", seq)
	}
}

func TestPendingExcludesSelfByDefault(t *testing.T) {
	s := openTestStore(t)
	const myUID, peerUID = int64(100), int64(200)

	msgs := []*pb.Message{
		textMsg(1, myUID, peerUID, 0, "p1aaaaaaaaaaaaaaaaaaaa", "sent by me"),
		textMsg(2, peerUID, myUID, 0, "p2aaaaaaaaaaaaaaaaaaaa", "sent by peer"),
	}
	if _, err := s.SaveMessages(myUID, msgs); err != nil {
		t.Fatalf("save messages: %v", err)
	}

	incoming, err := s.Pending(myUID, 0, 10, false)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(incoming) != 1 || incoming[0].MsgID != "p2aaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("pending (exclude self) = %+v, want only peer message", incoming)
	}

	all, err := s.Pending(myUID, 0, 10, true)
	if err != nil {
		t.Fatalf("pending include self: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("pending (include self) = %+v, want 2", all)
	}

	afterFirst, err := s.Pending(myUID, 1, 10, true)
	if err != nil {
		t.Fatalf("pending after seq 1: %v", err)
	}
	if len(afterFirst) != 1 || afterFirst[0].Seq != 2 {
		t.Fatalf("pending after seq=1 = %+v, want only seq=2", afterFirst)
	}
}

func TestSaveMessagesIsIdempotent(t *testing.T) {
	s := openTestStore(t)
	const myUID, peerUID = int64(100), int64(200)
	msg := textMsg(1, myUID, peerUID, 0, "idaaaaaaaaaaaaaaaaaaaa", "hello")

	if _, err := s.SaveMessages(myUID, []*pb.Message{msg}); err != nil {
		t.Fatalf("save 1st: %v", err)
	}
	if _, err := s.SaveMessages(myUID, []*pb.Message{msg}); err != nil {
		t.Fatalf("save 2nd: %v", err)
	}

	got, err := s.HistoryWithUser(peerUID, 0, 10)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(history) = %d, want 1 (idempotent upsert by seq)", len(got))
	}
}

func TestLastSyncedSeqPersistence(t *testing.T) {
	s := openTestStore(t)
	seq, err := s.LastSyncedSeq()
	if err != nil || seq != 0 {
		t.Fatalf("initial last synced seq = %d, err=%v", seq, err)
	}
	if err := s.SetLastSyncedSeq(77); err != nil {
		t.Fatalf("set last synced seq: %v", err)
	}
	seq, err = s.LastSyncedSeq()
	if err != nil || seq != 77 {
		t.Fatalf("last synced seq = %d, err=%v, want 77", seq, err)
	}
}

func TestUserCacheRoundTrip(t *testing.T) {
	s := openTestStore(t)

	if _, ok, err := s.LookupUsername(100); err != nil || ok {
		t.Fatalf("lookup username before cache: ok=%v err=%v, want ok=false", ok, err)
	}
	if _, ok, err := s.LookupUID("alice"); err != nil || ok {
		t.Fatalf("lookup uid before cache: ok=%v err=%v, want ok=false", ok, err)
	}

	if err := s.CacheUser(100, "alice"); err != nil {
		t.Fatalf("cache user: %v", err)
	}

	name, ok, err := s.LookupUsername(100)
	if err != nil || !ok || name != "alice" {
		t.Fatalf("lookup username = %q ok=%v err=%v, want alice/true", name, ok, err)
	}
	uid, ok, err := s.LookupUID("alice")
	if err != nil || !ok || uid != 100 {
		t.Fatalf("lookup uid = %d ok=%v err=%v, want 100/true", uid, ok, err)
	}

	// 同一 uid 改名后应覆盖旧记录，而不是报唯一约束冲突。
	if err := s.CacheUser(100, "alice2"); err != nil {
		t.Fatalf("re-cache user with new name: %v", err)
	}
	name, ok, err = s.LookupUsername(100)
	if err != nil || !ok || name != "alice2" {
		t.Fatalf("lookup username after rename = %q ok=%v err=%v, want alice2/true", name, ok, err)
	}
}
