package e2e

import (
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/msgid"
	"yimsg/internal/protocol/pb"
)

func TestBlockFlowAndSync(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("block"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("block"), "pass1234", "Bob")
	makeFriends(t, a, b)

	blocklistResp := sendOK(a, "block_user", &pb.BlockUserRequest{Uid: b.uid}, &pb.BlockUserResponse{})
	if blocklistResp.GetSeq() <= 0 {
		t.Fatal("block_user should return seq")
	}
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "blocklist:updated" })

	listResp := sendOK(a, "get_blocklist", &pb.GetBlocklistRequest{Uids: []int64{b.uid}}, &pb.GetBlocklistResponse{})
	if len(listResp.GetUsers()) != 1 || listResp.GetUsers()[0].GetUid() != b.uid {
		t.Fatalf("get_blocklist mismatch: %+v", listResp.GetUsers())
	}
	batchListResp := sendOK(a, "get_blocklist", &pb.GetBlocklistRequest{Uids: []int64{b.uid, 999999999}}, &pb.GetBlocklistResponse{})
	if len(batchListResp.GetUsers()) != 1 || batchListResp.GetUsers()[0].GetUid() != b.uid {
		t.Fatalf("get_blocklist batch mismatch: users=%+v", batchListResp.GetUsers())
	}

	syncResp := sendOK(a, "sync_blocklist", &pb.SyncBlocklistRequest{LastSeq: 0}, &pb.SyncBlocklistResponse{})
	if len(syncResp.GetUsers()) != 1 || syncResp.GetUsers()[0].GetStatus() != pb.BlocklistStatus_BLOCKLIST_STATUS_ACTIVE {
		t.Fatalf("sync_blocklist should return active row, got: %+v", syncResp.GetUsers())
	}

	sendResp := sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("blocklist"),
	}, &pb.SendMessageResponse{})
	if sendResp.GetBase().GetMsg() != "对方暂不接受私聊" {
		t.Fatalf("blocked DM error=%q, want 对方暂不接受私聊", sendResp.GetBase().GetMsg())
	}

	sendOK(a, "unblock_user", &pb.UnblockUserRequest{Uid: b.uid}, &pb.UnblockUserResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "blocklist:updated" })

	afterList := sendOK(a, "get_blocklist", &pb.GetBlocklistRequest{}, &pb.GetBlocklistResponse{})
	if len(afterList.GetUsers()) != 0 {
		t.Fatalf("get_blocklist after delete should be empty, got: %+v", afterList.GetUsers())
	}

	afterSync := sendOK(a, "sync_blocklist", &pb.SyncBlocklistRequest{LastSeq: blocklistResp.GetSeq()}, &pb.SyncBlocklistResponse{})
	if len(afterSync.GetUsers()) != 1 || afterSync.GetUsers()[0].GetUid() != b.uid || afterSync.GetUsers()[0].GetStatus() != pb.BlocklistStatus_BLOCKLIST_STATUS_DELETED {
		t.Fatalf("sync_blocklist after delete should return tombstone, got: %+v", afterSync.GetUsers())
	}

	a.sendText(userTarget(b.uid), "allowed again")
}

func TestMuteConversationFlowAndSync(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("mutelist"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("mutelist"), "pass1234", "Bob")

	muteResp := sendOK(a, "mute_conversation", &pb.MuteConversationRequest{Target: userTarget(b.uid)}, &pb.MuteConversationResponse{})
	if muteResp.GetSeq() <= 0 {
		t.Fatal("update_conversation_mute should return seq")
	}
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "mutelist:updated" })

	listResp := sendOK(a, "get_mutelist", &pb.GetMutelistRequest{Targets: []*pb.ConversationTarget{userTarget(b.uid)}}, &pb.GetMutelistResponse{})
	if len(listResp.GetMutes()) != 1 || listResp.GetMutes()[0].GetTarget().GetUid() != b.uid || listResp.GetMutes()[0].GetStatus() != pb.MutelistStatus_MUTELIST_STATUS_ACTIVE {
		t.Fatalf("get_conversation_mutes mismatch: %+v", listResp.GetMutes())
	}
	batchListResp := sendOK(a, "get_mutelist", &pb.GetMutelistRequest{Targets: []*pb.ConversationTarget{userTarget(b.uid), userTarget(999999999)}}, &pb.GetMutelistResponse{})
	if len(batchListResp.GetMutes()) != 1 || batchListResp.GetMutes()[0].GetTarget().GetUid() != b.uid {
		t.Fatalf("get_mutelist batch mismatch: mutes=%+v", batchListResp.GetMutes())
	}

	syncResp := sendOK(a, "sync_mutelist", &pb.SyncMutelistRequest{LastSeq: 0}, &pb.SyncMutelistResponse{})
	if len(syncResp.GetMutes()) != 1 || syncResp.GetMutes()[0].GetStatus() != pb.MutelistStatus_MUTELIST_STATUS_ACTIVE {
		t.Fatalf("sync_conversation_mutes should return active row, got: %+v", syncResp.GetMutes())
	}

	unmuteResp := sendOK(a, "unmute_conversation", &pb.UnmuteConversationRequest{Target: userTarget(b.uid)}, &pb.UnmuteConversationResponse{})
	if unmuteResp.GetSeq() <= muteResp.GetSeq() {
		t.Fatal("unmute should return a newer seq")
	}
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "mutelist:updated" })

	afterList := sendOK(a, "get_mutelist", &pb.GetMutelistRequest{Targets: []*pb.ConversationTarget{userTarget(b.uid)}}, &pb.GetMutelistResponse{})
	if len(afterList.GetMutes()) != 0 {
		t.Fatalf("get_conversation_mutes after unmute should be empty, got: %+v", afterList.GetMutes())
	}

	afterSync := sendOK(a, "sync_mutelist", &pb.SyncMutelistRequest{LastSeq: muteResp.GetSeq()}, &pb.SyncMutelistResponse{})
	if len(afterSync.GetMutes()) != 1 || afterSync.GetMutes()[0].GetTarget().GetUid() != b.uid || afterSync.GetMutes()[0].GetStatus() != pb.MutelistStatus_MUTELIST_STATUS_DELETED {
		t.Fatalf("sync_conversation_mutes after unmute should return deleted tombstone, got: %+v", afterSync.GetMutes())
	}
}
