package service

import (
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
)

func TestMuteSync(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	updateResp := muteConversationService(s, "r1", uidA, uidB, 0, true)
	if !updateResp.OK || updateResp.Seq == nil || *updateResp.Seq <= 0 {
		t.Fatalf("update_conversation_mute failed: %+v", updateResp)
	}
	firstSeq := *updateResp.Seq

	resp := listMutelistService(s, "r2", uidA, dal.MutelistFilter{}, "", 200)
	if !resp.OK || len(resp.Mutelist) != 1 || resp.Mutelist[0].Status != dal.MutelistActive || targetUID(resp.Mutelist[0].Target) != uidB {
		t.Fatalf("unexpected get_conversation_mutes response: %+v", resp)
	}

	syncResp := syncMutelistService(s, "r3", uidA, 0, 200, false)
	if !syncResp.OK || len(syncResp.Mutelist) != 1 || syncResp.Mutelist[0].Seq != firstSeq {
		t.Fatalf("unexpected sync_conversation_mutes response: %+v", syncResp)
	}

	updateResp = muteConversationService(s, "r4", uidA, uidB, 0, false)
	if !updateResp.OK || updateResp.Seq == nil || *updateResp.Seq <= firstSeq {
		t.Fatalf("update_conversation_mute false failed: %+v", updateResp)
	}

	resp = listMutelistService(s, "r5", uidA, dal.MutelistFilter{}, "", 200)
	if !resp.OK || len(resp.Mutelist) != 0 {
		t.Fatalf("get_conversation_mutes after unmute = %+v", resp)
	}

	syncResp = syncMutelistService(s, "r6", uidA, firstSeq, 200, false)
	if !syncResp.OK || len(syncResp.Mutelist) != 1 || syncResp.Mutelist[0].Status != dal.MutelistDeleted {
		t.Fatalf("unexpected incremental mutelist sync after unmute: %+v", syncResp)
	}
}

func TestMuteSyncSeqTooOldAfterGC(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	muteResp := muteConversationService(s, "r1", uidA, uidB, 0, true)
	if !muteResp.OK || muteResp.Seq == nil {
		t.Fatalf("mute_conversation failed: %+v", muteResp)
	}
	if resp := muteConversationService(s, "r2", uidA, uidB, 0, false); !resp.OK {
		t.Fatalf("unmute failed: %+v", resp)
	}
	if _, err := s.MutelistStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge mutelist: %v", err)
	}

	resp := syncMutelistService(s, "r3", uidA, *muteResp.Seq, 200, false)
	if resp.OK || resp.Error != "seq_too_old" || resp.ErrorCode != appmsg.ErrorCodeSeqTooOld {
		t.Fatalf("sync_mutelist after gc = %+v, want seq_too_old", resp)
	}
	freshResp := syncMutelistService(s, "r4", uidA, 0, 200, false)
	if freshResp.OK || freshResp.ErrorCode != appmsg.ErrorCodeSeqTooOld {
		t.Fatalf("fresh sync_mutelist after gc = %+v, want seq_too_old", freshResp)
	}
	rebuildResp := syncMutelistService(s, "r5", uidA, 0, 200, true)
	if !rebuildResp.OK || len(rebuildResp.Mutelist) != 0 {
		t.Fatalf("rebuild sync_mutelist after gc = %+v, want empty current snapshot", rebuildResp)
	}
}

func TestListMutelistFilter(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := listMutelistService(s, "r1", uidA, dal.MutelistFilter{ToUID: uidB}, "", 200)
	if !resp.OK || len(resp.Mutelist) != 0 {
		t.Fatalf("get_mutelist before mutelist = %+v", resp)
	}

	updateResp := muteConversationService(s, "r2", uidA, uidB, 0, true)
	if !updateResp.OK {
		t.Fatalf("update_conversation_mute failed: %+v", updateResp)
	}

	resp = listMutelistService(s, "r3", uidA, dal.MutelistFilter{ToUIDs: []int64{uidB}}, "", 200)
	if !resp.OK || len(resp.Mutelist) != 1 || targetUID(resp.Mutelist[0].Target) != uidB {
		t.Fatalf("get_mutelist after mutelist = %+v", resp)
	}
}

func TestMutedDMDoesNotIncreaseUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	if resp := muteConversationService(s, "mutelist", uidA, uidB, 0, true); !resp.OK {
		t.Fatalf("update_conversation_mute failed: %+v", resp)
	}
	result := sendMessageService(s, "send", uidB, &appmsg.Request{ToUID: i64json(uidA), MsgType: dal.MsgText, Content: "hi"})
	if !result.Response.OK {
		t.Fatalf("send_message failed: %+v", result.Response)
	}

	resp := getUnreadCountService(s, "unread", uidA)
	if !resp.OK || resp.UnreadCount == nil {
		t.Fatalf("GetUnreadCount failed: %+v", resp)
	}
	if *resp.UnreadCount != 0 {
		t.Fatalf("muted DM unread count = %d, want 0", *resp.UnreadCount)
	}
}

func TestMutedGroupDoesNotIncreaseUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	groupResp := createGroupService(s, "create", uidB, "G", []int64{uidA, uidB})
	if !groupResp.OK {
		t.Fatalf("create_group failed: %+v", groupResp)
	}
	groupID := int64(*groupResp.GroupIDResp)
	drainTasks(s) // 建群系统消息异步投递，先落地再静音 / 清未读
	if resp := muteConversationService(s, "mutelist", uidA, 0, groupID, true); !resp.OK {
		t.Fatalf("update_conversation_mute failed: %+v", resp)
	}
	if resp := clearUnreadService(s, "read", uidA, 0, groupID); !resp.OK {
		t.Fatalf("clear_unread failed: %+v", resp)
	}

	result := sendMessageService(s, "send", uidB, &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group hi"})
	if !result.Response.OK {
		t.Fatalf("send_message failed: %+v", result.Response)
	}
	drainTasks(s)

	resp := getUnreadCountService(s, "unread", uidA)
	if !resp.OK || resp.UnreadCount == nil {
		t.Fatalf("GetUnreadCount failed: %+v", resp)
	}
	if *resp.UnreadCount != 0 {
		t.Fatalf("muted group unread count = %d, want 0", *resp.UnreadCount)
	}
}
