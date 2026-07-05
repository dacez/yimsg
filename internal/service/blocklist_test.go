package service

import (
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
)

func TestBlockSyncAndDelete(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	blocklistResp := blockUserService(s, "r1", uidA, uidB)
	if !blocklistResp.OK || blocklistResp.Seq == nil || *blocklistResp.Seq <= 0 {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}
	firstSeq := *blocklistResp.Seq

	resp := listBlocklistService(s, "r2", uidA, dal.BlocklistFilter{}, "", 200)
	if !resp.OK {
		t.Fatalf("get_blocklist failed: %s", resp.Error)
	}
	if len(resp.Users) != 1 || resp.Users[0].BlockUID != uidB || resp.Users[0].Status != dal.BlocklistActive {
		t.Fatalf("unexpected blocklist list: %+v", resp.Users)
	}
	syncResp := syncBlocklistService(s, "r3", uidA, 0, 200, false)
	if !syncResp.OK || len(syncResp.Users) != 1 || syncResp.Users[0].Seq != firstSeq {
		t.Fatalf("unexpected sync_blocklist response: %+v", syncResp)
	}

	deleteResp := unblockUserService(s, "r4", uidA, uidB)
	if !deleteResp.OK || deleteResp.Seq == nil || *deleteResp.Seq <= firstSeq {
		t.Fatalf("unblock_user failed: %+v", deleteResp)
	}

	resp = listBlocklistService(s, "r5", uidA, dal.BlocklistFilter{}, "", 200)
	if !resp.OK {
		t.Fatalf("get_blocklist after delete failed: %s", resp.Error)
	}
	if len(resp.Users) != 0 {
		t.Fatalf("get_blocklist after delete = %+v, want empty", resp.Users)
	}

	syncResp = syncBlocklistService(s, "r6", uidA, firstSeq, 200, false)
	if !syncResp.OK || len(syncResp.Users) != 1 || syncResp.Users[0].Status != dal.BlocklistDeleted {
		t.Fatalf("unexpected delete sync response: %+v", syncResp)
	}
}

func TestBlockSyncSeqTooOldAfterGC(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	blocklistResp := blockUserService(s, "r1", uidA, uidB)
	if !blocklistResp.OK || blocklistResp.Seq == nil {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}
	if resp := unblockUserService(s, "r2", uidA, uidB); !resp.OK {
		t.Fatalf("unblock_user failed: %+v", resp)
	}
	if _, err := s.BlocklistStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge blocklist: %v", err)
	}

	resp := syncBlocklistService(s, "r3", uidA, *blocklistResp.Seq, 200, false)
	if resp.OK || resp.Error != "seq_too_old" || resp.ErrorCode != appmsg.ErrorCodeSeqTooOld {
		t.Fatalf("sync_blocklist after gc = %+v, want seq_too_old", resp)
	}
	freshResp := syncBlocklistService(s, "r4", uidA, 0, 200, false)
	if freshResp.OK || freshResp.ErrorCode != appmsg.ErrorCodeSeqTooOld {
		t.Fatalf("fresh sync_blocklist after gc = %+v, want seq_too_old", freshResp)
	}
	rebuildResp := syncBlocklistService(s, "r5", uidA, 0, 200, true)
	if !rebuildResp.OK || len(rebuildResp.Users) != 0 {
		t.Fatalf("rebuild sync_blocklist after gc = %+v, want empty current snapshot", rebuildResp)
	}
}

func TestSyncBlocklistHasMoreAndCursorSeq(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	uidD := registerUser(t, s, "dave", "p", "Dave")

	for _, target := range []int64{uidB, uidC, uidD} {
		if resp := blockUserService(s, "r", uidA, target); !resp.OK {
			t.Fatalf("block_user %d failed: %+v", target, resp)
		}
	}

	// 第一页：limit=2，3 条里取前 2 条，has_more=true，cursor_seq=本页最大 seq。
	page1 := syncBlocklistService(s, "p1", uidA, 0, 2, false)
	if !page1.OK || len(page1.Users) != 2 {
		t.Fatalf("first page = %+v, want 2 users", page1)
	}
	if page1.HasMore == nil || !*page1.HasMore {
		t.Fatalf("first page has_more = %v, want true", page1.HasMore)
	}
	if page1.CursorSeq == nil || *page1.CursorSeq != page1.Users[1].Seq {
		t.Fatalf("first page cursor_seq = %v, want %d", page1.CursorSeq, page1.Users[1].Seq)
	}

	// 第二页：从 cursor_seq 继续，取到最后 1 条，has_more=false。
	page2 := syncBlocklistService(s, "p2", uidA, *page1.CursorSeq, 2, false)
	if !page2.OK || len(page2.Users) != 1 {
		t.Fatalf("second page = %+v, want 1 user", page2)
	}
	if page2.HasMore == nil || *page2.HasMore {
		t.Fatalf("second page has_more = %v, want false", page2.HasMore)
	}
	if page2.CursorSeq == nil || *page2.CursorSeq != page2.Users[0].Seq {
		t.Fatalf("second page cursor_seq = %v, want %d", page2.CursorSeq, page2.Users[0].Seq)
	}

	// 第三页：空批，has_more=false，cursor_seq=0（客户端保持原 last_seq）。
	page3 := syncBlocklistService(s, "p3", uidA, *page2.CursorSeq, 2, false)
	if !page3.OK || len(page3.Users) != 0 {
		t.Fatalf("third page = %+v, want empty", page3)
	}
	if page3.HasMore == nil || *page3.HasMore {
		t.Fatalf("third page has_more = %v, want false", page3.HasMore)
	}
	if page3.CursorSeq == nil || *page3.CursorSeq != 0 {
		t.Fatalf("third page cursor_seq = %v, want 0", page3.CursorSeq)
	}
}

func TestBlockSyncRebuildAllowsPagingBelowGCSafeSeq(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	firstResp := blockUserService(s, "r1", uidA, uidB)
	if !firstResp.OK || firstResp.Seq == nil {
		t.Fatalf("block_user first failed: %+v", firstResp)
	}
	staleSeq := *firstResp.Seq
	if resp := blockUserService(s, "r2", uidA, uidC); !resp.OK {
		t.Fatalf("block_user second failed: %+v", resp)
	}
	if resp := unblockUserService(s, "r3", uidA, uidC); !resp.OK {
		t.Fatalf("unblock_user failed: %+v", resp)
	}
	if _, err := s.BlocklistStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge blocklist: %v", err)
	}

	if resp := syncBlocklistService(s, "r4", uidA, staleSeq, 1, false); resp.OK || resp.ErrorCode != appmsg.ErrorCodeSeqTooOld {
		t.Fatalf("sync_blocklist without rebuild = %+v, want SEQ_TOO_OLD", resp)
	}

	firstPage := syncBlocklistService(s, "r5", uidA, 0, 1, true)
	if !firstPage.OK || len(firstPage.Users) != 1 || firstPage.Users[0].BlockUID != uidB {
		t.Fatalf("rebuild first page = %+v, want active old row", firstPage)
	}
	secondPage := syncBlocklistService(s, "r6", uidA, firstPage.Users[0].Seq, 1, true)
	if !secondPage.OK {
		t.Fatalf("rebuild second page should not be too_old: %+v", secondPage)
	}
}

func TestListBlocklistFilter(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := listBlocklistService(s, "r1", uidA, dal.BlocklistFilter{UIDs: []int64{uidB}}, "", 200)
	if !resp.OK || len(resp.Users) != 0 {
		t.Fatalf("get_blocklist before blocklist = %+v", resp)
	}

	if blocklistResp := blockUserService(s, "r2", uidA, uidB); !blocklistResp.OK {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}

	resp = listBlocklistService(s, "r3", uidA, dal.BlocklistFilter{UIDs: []int64{uidB}}, "", 200)
	if !resp.OK || len(resp.Users) != 1 || resp.Users[0].BlockUID != uidB {
		t.Fatalf("get_blocklist after blocklist = %+v", resp)
	}
}

func TestSearchUserHiddenByBlock(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	if resp := searchUserService(s, "r1", uidB, "alice"); !resp.OK || resp.Profile == nil {
		t.Fatalf("search_user before blocklist = %+v", resp)
	}
	if blocklistResp := blockUserService(s, "r2", uidA, uidB); !blocklistResp.OK {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}
	if resp := searchUserService(s, "r3", uidB, "alice"); !resp.OK || resp.Profile != nil {
		t.Fatalf("search_user should hide blocklist source from target user: %+v", resp)
	}
	if resp := searchUserService(s, "r4", uidA, "bob"); !resp.OK || resp.Profile != nil {
		t.Fatalf("search_user should hide blocklist target from source user: %+v", resp)
	}
}

func TestBlockPreventsFriendDMButNotGroupMessage(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	blocklistResp := blockUserService(s, "r1", uidA, uidB)
	if !blocklistResp.OK {
		t.Fatalf("block_user failed: %s", blocklistResp.Error)
	}

	if resp := addFriendService(s, "r2", uidB, uidA, ""); resp.OK || resp.Error != "当前无法发起该操作" {
		t.Fatalf("add_friend while blocked = %+v", resp)
	}
	if resp := addFriendService(s, "r3", uidA, uidB, ""); resp.OK || resp.Error != "当前无法发起该操作" {
		t.Fatalf("self add_friend while blocking = %+v", resp)
	}

	dmReq := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hi"}
	if result := sendMessageService(s, "r4", uidA, dmReq); result.Response.OK || result.Response.Error != "对方暂不接受私聊" {
		t.Fatalf("send dm while blocking = %+v", result.Response)
	}
	dmReq = &appmsg.Request{ToUID: i64json(uidA), MsgType: dal.MsgText, Content: "hi"}
	if result := sendMessageService(s, "r5", uidB, dmReq); result.Response.OK || result.Response.Error != "对方暂不接受私聊" {
		t.Fatalf("send dm while blocked = %+v", result.Response)
	}

	groupResp := createGroupService(s, "r8", uidA, "G", []int64{uidA, uidB})
	if !groupResp.OK {
		t.Fatalf("create_group failed: %s", groupResp.Error)
	}
	groupID := int64(*groupResp.GroupIDResp)
	groupMsg := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group still works"}
	sendResp := sendMessageService(s, "r9", uidB, groupMsg)
	if !sendResp.Response.OK {
		t.Fatalf("send group message while blocked failed: %s", sendResp.Response.Error)
	}
	drainTasks(s)

	msgs, err := s.MessageStore(uidA).ListByConversation(uidA, 0, groupID, 0, 100)
	if err != nil {
		t.Fatalf("list group messages: %v", err)
	}
	found := false
	for _, msg := range msgs {
		if dalText(msg) == "group still works" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("blocklist users in same group should still see group messages")
	}
}
