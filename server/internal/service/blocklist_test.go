package service

import (
	"testing"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/dal"
)

func TestBlockSyncAndDelete(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	blocklistResp := blockUserService(s, "r1", uidA, uidB)
	if !isOK(blocklistResp) || blocklistResp.GetSeq() <= 0 {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}
	firstSeq := blocklistResp.GetSeq()

	resp := listBlocklistService(s, "r2", uidA, dal.BlocklistFilter{}, "", 200)
	if !isOK(resp) {
		t.Fatalf("get_blocklist failed: %s", errMsg(resp))
	}
	if len(resp.GetUsers()) != 1 || resp.GetUsers()[0].GetUid() != uidB || resp.GetUsers()[0].GetStatus() != pb.BlocklistStatus(dal.BlocklistActive) {
		t.Fatalf("unexpected blocklist list: %+v", resp.GetUsers())
	}
	syncResp := syncBlocklistService(s, "r3", uidA, 0, 200, false)
	if !isOK(syncResp) || len(syncResp.GetUsers()) != 1 || syncResp.GetUsers()[0].GetSeq() != firstSeq {
		t.Fatalf("unexpected sync_blocklist response: %+v", syncResp)
	}

	deleteResp := unblockUserService(s, "r4", uidA, uidB)
	if !isOK(deleteResp) || deleteResp.GetSeq() <= firstSeq {
		t.Fatalf("unblock_user failed: %+v", deleteResp)
	}

	resp = listBlocklistService(s, "r5", uidA, dal.BlocklistFilter{}, "", 200)
	if !isOK(resp) {
		t.Fatalf("get_blocklist after delete failed: %s", errMsg(resp))
	}
	if len(resp.GetUsers()) != 0 {
		t.Fatalf("get_blocklist after delete = %+v, want empty", resp.GetUsers())
	}

	syncResp = syncBlocklistService(s, "r6", uidA, firstSeq, 200, false)
	if !isOK(syncResp) || len(syncResp.GetUsers()) != 1 || syncResp.GetUsers()[0].GetStatus() != pb.BlocklistStatus(dal.BlocklistDeleted) {
		t.Fatalf("unexpected delete sync response: %+v", syncResp)
	}
}

func TestBlockSyncSeqTooOldAfterGC(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	blocklistResp := blockUserService(s, "r1", uidA, uidB)
	if !isOK(blocklistResp) {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}
	if resp := unblockUserService(s, "r2", uidA, uidB); !isOK(resp) {
		t.Fatalf("unblock_user failed: %+v", resp)
	}
	if _, err := s.BlocklistStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge blocklist: %v", err)
	}

	resp := syncBlocklistService(s, "r3", uidA, blocklistResp.GetSeq(), 200, false)
	if isOK(resp) || errMsg(resp) != "seq_too_old" || resp.GetBase().GetCode() != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Fatalf("sync_blocklist after gc = %+v, want seq_too_old", resp)
	}
	freshResp := syncBlocklistService(s, "r4", uidA, 0, 200, false)
	if isOK(freshResp) || freshResp.GetBase().GetCode() != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Fatalf("fresh sync_blocklist after gc = %+v, want seq_too_old", freshResp)
	}
	rebuildResp := syncBlocklistService(s, "r5", uidA, 0, 200, true)
	if !isOK(rebuildResp) || len(rebuildResp.GetUsers()) != 0 {
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
		if resp := blockUserService(s, "r", uidA, target); !isOK(resp) {
			t.Fatalf("block_user %d failed: %+v", target, resp)
		}
	}

	// 第一页：limit=2，3 条里取前 2 条，has_more=true，cursor_seq=本页最大 seq。
	page1 := syncBlocklistService(s, "p1", uidA, 0, 2, false)
	if !isOK(page1) || len(page1.GetUsers()) != 2 {
		t.Fatalf("first page = %+v, want 2 users", page1)
	}
	if !page1.GetHasMore() {
		t.Fatalf("first page has_more = %v, want true", page1.GetHasMore())
	}
	if page1.GetCursorSeq() != page1.GetUsers()[1].GetSeq() {
		t.Fatalf("first page cursor_seq = %v, want %d", page1.GetCursorSeq(), page1.GetUsers()[1].GetSeq())
	}

	// 第二页：从 cursor_seq 继续，取到最后 1 条，has_more=false。
	page2 := syncBlocklistService(s, "p2", uidA, page1.GetCursorSeq(), 2, false)
	if !isOK(page2) || len(page2.GetUsers()) != 1 {
		t.Fatalf("second page = %+v, want 1 user", page2)
	}
	if page2.GetHasMore() {
		t.Fatalf("second page has_more = %v, want false", page2.GetHasMore())
	}
	if page2.GetCursorSeq() != page2.GetUsers()[0].GetSeq() {
		t.Fatalf("second page cursor_seq = %v, want %d", page2.GetCursorSeq(), page2.GetUsers()[0].GetSeq())
	}

	// 第三页：空批，has_more=false，cursor_seq=0（客户端保持原 last_seq）。
	page3 := syncBlocklistService(s, "p3", uidA, page2.GetCursorSeq(), 2, false)
	if !isOK(page3) || len(page3.GetUsers()) != 0 {
		t.Fatalf("third page = %+v, want empty", page3)
	}
	if page3.GetHasMore() {
		t.Fatalf("third page has_more = %v, want false", page3.GetHasMore())
	}
	if page3.GetCursorSeq() != 0 {
		t.Fatalf("third page cursor_seq = %v, want 0", page3.GetCursorSeq())
	}
}

func TestBlockSyncRebuildAllowsPagingBelowGCSafeSeq(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	firstResp := blockUserService(s, "r1", uidA, uidB)
	if !isOK(firstResp) {
		t.Fatalf("block_user first failed: %+v", firstResp)
	}
	staleSeq := firstResp.GetSeq()
	if resp := blockUserService(s, "r2", uidA, uidC); !isOK(resp) {
		t.Fatalf("block_user second failed: %+v", resp)
	}
	if resp := unblockUserService(s, "r3", uidA, uidC); !isOK(resp) {
		t.Fatalf("unblock_user failed: %+v", resp)
	}
	if _, err := s.BlocklistStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge blocklist: %v", err)
	}

	if resp := syncBlocklistService(s, "r4", uidA, staleSeq, 1, false); isOK(resp) || resp.GetBase().GetCode() != pb.ErrorCode_ERROR_SEQ_TOO_OLD {
		t.Fatalf("sync_blocklist without rebuild = %+v, want SEQ_TOO_OLD", resp)
	}

	firstPage := syncBlocklistService(s, "r5", uidA, 0, 1, true)
	if !isOK(firstPage) || len(firstPage.GetUsers()) != 1 || firstPage.GetUsers()[0].GetUid() != uidB {
		t.Fatalf("rebuild first page = %+v, want active old row", firstPage)
	}
	secondPage := syncBlocklistService(s, "r6", uidA, firstPage.GetUsers()[0].GetSeq(), 1, true)
	if !isOK(secondPage) {
		t.Fatalf("rebuild second page should not be too_old: %+v", secondPage)
	}
}

func TestListBlocklistFilter(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := listBlocklistService(s, "r1", uidA, dal.BlocklistFilter{UIDs: []int64{uidB}}, "", 200)
	if !isOK(resp) || len(resp.GetUsers()) != 0 {
		t.Fatalf("get_blocklist before blocklist = %+v", resp)
	}

	if blocklistResp := blockUserService(s, "r2", uidA, uidB); !isOK(blocklistResp) {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}

	resp = listBlocklistService(s, "r3", uidA, dal.BlocklistFilter{UIDs: []int64{uidB}}, "", 200)
	if !isOK(resp) || len(resp.GetUsers()) != 1 || resp.GetUsers()[0].GetUid() != uidB {
		t.Fatalf("get_blocklist after blocklist = %+v", resp)
	}
}

func TestSearchUserHiddenByBlock(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	if resp := searchUserService(s, "r1", uidB, "alice"); !isOK(resp) || resp.GetProfile() == nil {
		t.Fatalf("search_user before blocklist = %+v", resp)
	}
	if blocklistResp := blockUserService(s, "r2", uidA, uidB); !isOK(blocklistResp) {
		t.Fatalf("block_user failed: %+v", blocklistResp)
	}
	if resp := searchUserService(s, "r3", uidB, "alice"); !isOK(resp) || resp.GetProfile() != nil {
		t.Fatalf("search_user should hide blocklist source from target user: %+v", resp)
	}
	if resp := searchUserService(s, "r4", uidA, "bob"); !isOK(resp) || resp.GetProfile() != nil {
		t.Fatalf("search_user should hide blocklist target from source user: %+v", resp)
	}
}

func TestBlockPreventsFriendDMButNotGroupMessage(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	blocklistResp := blockUserService(s, "r1", uidA, uidB)
	if !isOK(blocklistResp) {
		t.Fatalf("block_user failed: %s", errMsg(blocklistResp))
	}

	if resp := addFriendService(s, "r2", uidB, uidA, ""); isOK(resp) || errMsg(resp) != "当前无法发起该操作" {
		t.Fatalf("add_friend while blocked = %+v", resp)
	}
	if resp := addFriendService(s, "r3", uidA, uidB, ""); isOK(resp) || errMsg(resp) != "当前无法发起该操作" {
		t.Fatalf("self add_friend while blocking = %+v", resp)
	}

	dmReq := &appmsg.Request{ToUID: uidB, MsgType: dal.MsgText, Content: "hi"}
	if result := sendMessageService(s, "r4", uidA, dmReq); isOK(result.Response) || errMsg(result.Response) != "对方暂不接受私聊" {
		t.Fatalf("send dm while blocking = %+v", result.Response)
	}
	dmReq = &appmsg.Request{ToUID: uidA, MsgType: dal.MsgText, Content: "hi"}
	if result := sendMessageService(s, "r5", uidB, dmReq); isOK(result.Response) || errMsg(result.Response) != "对方暂不接受私聊" {
		t.Fatalf("send dm while blocked = %+v", result.Response)
	}

	groupResp := createGroupService(s, "r8", uidA, "G", []int64{uidA, uidB})
	if !isOK(groupResp) {
		t.Fatalf("create_group failed: %s", errMsg(groupResp))
	}
	groupID := groupResp.GetGroupId()
	groupMsg := &appmsg.Request{GroupID: groupID, MsgType: dal.MsgText, Content: "group still works"}
	sendResp := sendMessageService(s, "r9", uidB, groupMsg)
	if !isOK(sendResp.Response) {
		t.Fatalf("send group message while blocked failed: %s", errMsg(sendResp.Response))
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
