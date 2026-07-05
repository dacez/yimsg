package e2e

import "testing"

func TestBlockFlowAndSync(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("block"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("block"), "pass1234", "Bob")
	makeFriends(t, a, b)

	blocklistResp := a.sendOK(wsRequest{
		"action": "block_user",
		"uid":    b.uid,
	})
	if blocklistResp.Seq == nil || *blocklistResp.Seq <= 0 {
		t.Fatal("block_user should return seq")
	}
	a.waitNotif(func(n notification) bool { return n.Type == "blocklist:updated" })

	listResp := a.sendOK(wsRequest{"action": "get_blocklist", "uid": b.uid})
	if len(listResp.Users) != 1 || listResp.Users[0].UID != b.uid {
		t.Fatalf("get_blocklist mismatch: %+v", listResp.Users)
	}
	batchListResp := a.sendOK(wsRequest{"action": "get_blocklist", "uids": []string{b.uid, "999999999"}})
	if len(batchListResp.Users) != 1 || batchListResp.Users[0].UID != b.uid {
		t.Fatalf("get_blocklist batch mismatch: users=%+v", batchListResp.Users)
	}

	syncResp := a.sendOK(wsRequest{
		"action":   "sync_blocklist",
		"last_seq": 0,
	})
	if len(syncResp.Users) != 1 || syncResp.Users[0].Status != 1 {
		t.Fatalf("sync_blocklist should return active row, got: %+v", syncResp.Users)
	}

	sendResp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "blocklist",
	})
	if sendResp.OK {
		t.Fatal("blocklist DM should fail")
	}
	if sendResp.Error != "对方暂不接受私聊" {
		t.Fatalf("blocked DM error=%q, want 对方暂不接受私聊", sendResp.Error)
	}

	a.sendOK(wsRequest{
		"action": "unblock_user",
		"uid":    b.uid,
	})
	a.waitNotif(func(n notification) bool { return n.Type == "blocklist:updated" })

	afterList := a.sendOK(wsRequest{"action": "get_blocklist"})
	if len(afterList.Users) != 0 {
		t.Fatalf("get_blocklist after delete should be empty, got: %+v", afterList.Users)
	}

	afterSync := a.sendOK(wsRequest{
		"action":   "sync_blocklist",
		"last_seq": *blocklistResp.Seq,
	})
	if len(afterSync.Users) != 1 || afterSync.Users[0].UID != b.uid || afterSync.Users[0].Status != 0xff {
		t.Fatalf("sync_blocklist after delete should return tombstone, got: %+v", afterSync.Users)
	}

	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "allowed again",
	})
}

func TestMuteConversationFlowAndSync(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("mutelist"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("mutelist"), "pass1234", "Bob")

	muteResp := a.sendOK(wsRequest{
		"action": "mute_conversation",
		"to_uid": b.uid,
	})
	if muteResp.Seq == nil || *muteResp.Seq <= 0 {
		t.Fatal("update_conversation_mute should return seq")
	}
	a.waitNotif(func(n notification) bool { return n.Type == "mutelist:updated" })

	listResp := a.sendOK(wsRequest{"action": "get_mutelist", "to_uid": b.uid})
	if len(listResp.Mutelist) != 1 || listResp.Mutelist[0].ToUID != b.uid || listResp.Mutelist[0].Status != 1 {
		t.Fatalf("get_conversation_mutes mismatch: %+v", listResp.Mutelist)
	}
	batchListResp := a.sendOK(wsRequest{"action": "get_mutelist", "to_uids": []string{b.uid, "999999999"}})
	if len(batchListResp.Mutelist) != 1 || batchListResp.Mutelist[0].ToUID != b.uid {
		t.Fatalf("get_mutelist batch mismatch: mutes=%+v", batchListResp.Mutelist)
	}

	syncResp := a.sendOK(wsRequest{
		"action":   "sync_mutelist",
		"last_seq": 0,
	})
	if len(syncResp.Mutelist) != 1 || syncResp.Mutelist[0].Status != 1 {
		t.Fatalf("sync_conversation_mutes should return active row, got: %+v", syncResp.Mutelist)
	}

	unmuteResp := a.sendOK(wsRequest{
		"action": "unmute_conversation",
		"to_uid": b.uid,
	})
	if unmuteResp.Seq == nil || *unmuteResp.Seq <= *muteResp.Seq {
		t.Fatal("unmute should return a newer seq")
	}
	a.waitNotif(func(n notification) bool { return n.Type == "mutelist:updated" })

	afterList := a.sendOK(wsRequest{"action": "get_mutelist", "to_uid": b.uid})
	if len(afterList.Mutelist) != 0 {
		t.Fatalf("get_conversation_mutes after unmute should be empty, got: %+v", afterList.Mutelist)
	}

	afterSync := a.sendOK(wsRequest{
		"action":   "sync_mutelist",
		"last_seq": *muteResp.Seq,
	})
	if len(afterSync.Mutelist) != 1 || afterSync.Mutelist[0].ToUID != b.uid || afterSync.Mutelist[0].Status != statusDeleted {
		t.Fatalf("sync_conversation_mutes after unmute should return deleted tombstone, got: %+v", afterSync.Mutelist)
	}
}
