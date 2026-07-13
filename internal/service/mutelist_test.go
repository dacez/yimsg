package service

import (
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"
)

func TestMuteSync(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	updateResp := muteConversationService(s, "r1", uidA, uidB, 0, true)
	muted, ok := updateResp.(*pb.MuteConversationResponse)
	if !ok || !isOK(muted) || muted.GetSeq() <= 0 {
		t.Fatalf("update_conversation_mute failed: %+v", updateResp)
	}
	firstSeq := muted.GetSeq()

	resp := listMutelistService(s, "r2", uidA, dal.MutelistFilter{}, "", 200)
	mutelist := resp.GetMutes()
	if !isOK(resp) || len(mutelist) != 1 || mutelist[0].GetStatus() != pb.MutelistStatus(dal.MutelistActive) || mutelist[0].GetTarget().GetUid() != uidB {
		t.Fatalf("unexpected get_conversation_mutes response: %+v", resp)
	}

	syncResp := syncMutelistService(s, "r3", uidA, 0, 200, false)
	syncMutelist := syncResp.GetMutes()
	if !isOK(syncResp) || len(syncMutelist) != 1 || syncMutelist[0].GetSeq() != firstSeq {
		t.Fatalf("unexpected sync_conversation_mutes response: %+v", syncResp)
	}

	updateResp2 := muteConversationService(s, "r4", uidA, uidB, 0, false)
	unmuted, ok := updateResp2.(*pb.UnmuteConversationResponse)
	if !ok || !isOK(unmuted) || unmuted.GetSeq() <= firstSeq {
		t.Fatalf("update_conversation_mute false failed: %+v", updateResp2)
	}

	resp = listMutelistService(s, "r5", uidA, dal.MutelistFilter{}, "", 200)
	if !isOK(resp) || len(resp.GetMutes()) != 0 {
		t.Fatalf("get_conversation_mutes after unmute = %+v", resp)
	}

	syncResp = syncMutelistService(s, "r6", uidA, firstSeq, 200, false)
	syncMutelist = syncResp.GetMutes()
	if !isOK(syncResp) || len(syncMutelist) != 1 || syncMutelist[0].GetStatus() != pb.MutelistStatus(dal.MutelistDeleted) {
		t.Fatalf("unexpected incremental mutelist sync after unmute: %+v", syncResp)
	}
}

func TestMuteSyncSeqTooOldAfterGC(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	muteResp := muteConversationService(s, "r1", uidA, uidB, 0, true)
	muted, ok := muteResp.(*pb.MuteConversationResponse)
	if !ok || !isOK(muted) {
		t.Fatalf("mute_conversation failed: %+v", muteResp)
	}
	if resp := muteConversationService(s, "r2", uidA, uidB, 0, false); !isOK(resp) {
		t.Fatalf("unmute failed: %+v", resp)
	}
	if _, err := s.MutelistStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge mutelist: %v", err)
	}

	resp := syncMutelistService(s, "r3", uidA, muted.GetSeq(), 200, false)
	if isOK(resp) || errMsg(resp) != "seq_too_old" || resp.GetBase().GetCode() != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Fatalf("sync_mutelist after gc = %+v, want seq_too_old", resp)
	}
	freshResp := syncMutelistService(s, "r4", uidA, 0, 200, false)
	if isOK(freshResp) || freshResp.GetBase().GetCode() != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Fatalf("fresh sync_mutelist after gc = %+v, want seq_too_old", freshResp)
	}
	rebuildResp := syncMutelistService(s, "r5", uidA, 0, 200, true)
	if !isOK(rebuildResp) || len(rebuildResp.GetMutes()) != 0 {
		t.Fatalf("rebuild sync_mutelist after gc = %+v, want empty current snapshot", rebuildResp)
	}
}

func TestListMutelistFilter(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := listMutelistService(s, "r1", uidA, dal.MutelistFilter{ToUID: uidB}, "", 200)
	if !isOK(resp) || len(resp.GetMutes()) != 0 {
		t.Fatalf("get_mutelist before mutelist = %+v", resp)
	}

	updateResp := muteConversationService(s, "r2", uidA, uidB, 0, true)
	if !isOK(updateResp) {
		t.Fatalf("update_conversation_mute failed: %+v", updateResp)
	}

	resp = listMutelistService(s, "r3", uidA, dal.MutelistFilter{ToUIDs: []int64{uidB}}, "", 200)
	mutelist := resp.GetMutes()
	if !isOK(resp) || len(mutelist) != 1 || mutelist[0].GetTarget().GetUid() != uidB {
		t.Fatalf("get_mutelist after mutelist = %+v", resp)
	}
}

func TestMutedDMDoesNotIncreaseUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	if resp := muteConversationService(s, "mutelist", uidA, uidB, 0, true); !isOK(resp) {
		t.Fatalf("update_conversation_mute failed: %+v", resp)
	}
	result := sendMessageService(s, "send", uidB, &appmsg.Request{ToUID: uidA, MsgType: dal.MsgText, Content: "hi"})
	if !isOK(result.Response) {
		t.Fatalf("send_message failed: %+v", result.Response)
	}

	resp := getUnreadCountService(s, "unread", uidA)
	if !isOK(resp) {
		t.Fatalf("GetUnreadCount failed: %+v", resp)
	}
	if resp.GetUnreadCount() != 0 {
		t.Fatalf("muted DM unread count = %d, want 0", resp.GetUnreadCount())
	}
}

func TestMutedGroupDoesNotIncreaseUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	groupResp := createGroupService(s, "create", uidB, "G", []int64{uidA, uidB})
	if !isOK(groupResp) {
		t.Fatalf("create_group failed: %+v", groupResp)
	}
	groupID := groupResp.GetGroupId()
	drainTasks(s) // 建群系统消息异步投递，先落地再静音 / 清未读
	if resp := muteConversationService(s, "mutelist", uidA, 0, groupID, true); !isOK(resp) {
		t.Fatalf("update_conversation_mute failed: %+v", resp)
	}
	if resp := clearUnreadService(s, "read", uidA, 0, groupID); !isOK(resp) {
		t.Fatalf("clear_unread failed: %+v", resp)
	}

	result := sendMessageService(s, "send", uidB, &appmsg.Request{GroupID: groupID, MsgType: dal.MsgText, Content: "group hi"})
	if !isOK(result.Response) {
		t.Fatalf("send_message failed: %+v", result.Response)
	}
	drainTasks(s)

	resp := getUnreadCountService(s, "unread", uidA)
	if !isOK(resp) {
		t.Fatalf("GetUnreadCount failed: %+v", resp)
	}
	if resp.GetUnreadCount() != 0 {
		t.Fatalf("muted group unread count = %d, want 0", resp.GetUnreadCount())
	}
}
