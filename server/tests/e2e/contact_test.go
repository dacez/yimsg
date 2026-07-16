package e2e

import (
	"testing"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
)

func TestAddFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	resp := sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	if resp.GetSeq() == 0 {
		t.Fatal("add_friend should return seq")
	}

	// B should receive a contacts:updated notification
	b.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "contacts:updated"
	})
}

func TestAddFriendSelf(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")

	sendErr(a, "add_friend", &pb.AddFriendRequest{FriendUid: a.uid}, &pb.AddFriendResponse{})
}

func TestAddFriendDuplicate(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})

	// Adding the same friend again uses upsert; the server allows it
	// (re-sets status to pending). Verify it succeeds.
	resp := sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	if resp.GetSeq() == 0 {
		t.Fatal("duplicate add_friend should still return seq")
	}
}

func TestAcceptFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	// Drain the contacts:updated notification on B from add_friend
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// A should get contacts:updated notification from accept
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// Verify both sides are FRIEND (status=1)
	aContacts := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	found := false
	for _, c := range aContacts.GetContacts() {
		if c.GetTarget().GetUid() == b.uid && c.GetStatus() == pb.ContactStatus_CONTACT_STATUS_FRIEND {
			found = true
		}
	}
	if !found {
		t.Fatalf("A should see B as FRIEND, contacts: %+v", aContacts.GetContacts())
	}

	bContacts := sendOK(b, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	found = false
	for _, c := range bContacts.GetContacts() {
		if c.GetTarget().GetUid() == a.uid && c.GetStatus() == pb.ContactStatus_CONTACT_STATUS_FRIEND {
			found = true
		}
	}
	if !found {
		t.Fatalf("B should see A as FRIEND, contacts: %+v", bContacts.GetContacts())
	}
}

// TestAcceptFriendRejectsRequester 覆盖好友请求方向 bug 的回归：申请方 A 不能对自己
// 发出的请求调用 accept_friend/reject_friend，只有接收方 B 才能处理这条请求。
func TestAcceptFriendRejectsRequester(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// A（申请方）自己接受自己发出的请求应该失败。
	resp := sendErr(a, "accept_friend", &pb.AcceptFriendRequest{FriendUid: b.uid}, &pb.AcceptFriendResponse{})
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_CONFLICT {
		t.Fatalf("A accepting own request: error_code = %v, want ERROR_CONFLICT", resp.GetBase().GetCode())
	}

	// A（申请方）自己拒绝自己发出的请求同样应该失败。
	resp2 := sendErr(a, "reject_friend", &pb.RejectFriendRequest{FriendUid: b.uid}, &pb.RejectFriendResponse{})
	if resp2.GetBase().GetCode() != pb.ErrorCode_ERROR_CONFLICT {
		t.Fatalf("A rejecting own request: error_code = %v, want ERROR_CONFLICT", resp2.GetBase().GetCode())
	}

	// 关系应该仍然是 PENDING，双方都还不是好友。
	aContacts := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	for _, c := range aContacts.GetContacts() {
		if c.GetTarget().GetUid() == b.uid && c.GetStatus() == pb.ContactStatus_CONTACT_STATUS_FRIEND {
			t.Fatalf("A should not become FRIEND with B via self-accept, got: %+v", c)
		}
	}

	// B（接收方）才能正常接受，验证 bug 修复没有破坏正常流程。
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	aContacts = sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	found := false
	for _, c := range aContacts.GetContacts() {
		if c.GetTarget().GetUid() == b.uid && c.GetStatus() == pb.ContactStatus_CONTACT_STATUS_FRIEND {
			found = true
		}
	}
	if !found {
		t.Fatalf("A should see B as FRIEND after B's legitimate accept, contacts: %+v", aContacts.GetContacts())
	}
}

func TestRejectFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	sendOK(b, "reject_friend", &pb.RejectFriendRequest{FriendUid: a.uid}, &pb.RejectFriendResponse{})

	// A should get contacts:updated notification from reject
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// Both sides should be DELETED (status=1), so get_contacts excludes them
	aContacts := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	for _, c := range aContacts.GetContacts() {
		if c.GetTarget().GetUid() == b.uid {
			t.Fatalf("A should not see B in get_contacts after reject, got: %+v", c)
		}
	}

	bContacts := sendOK(b, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	for _, c := range bContacts.GetContacts() {
		if c.GetTarget().GetUid() == a.uid {
			t.Fatalf("B should not see A in get_contacts after reject, got: %+v", c)
		}
	}
}

func TestDeleteFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	// Become friends first
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// A deletes B (unilateral, only caller side)
	sendOK(a, "delete_friend", &pb.DeleteFriendRequest{FriendUid: b.uid}, &pb.DeleteFriendResponse{})

	// A should no longer see B
	aContacts := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	for _, c := range aContacts.GetContacts() {
		if c.GetTarget().GetUid() == b.uid {
			t.Fatalf("A should not see B after delete, got: %+v", c)
		}
	}

	// B should still see A (unilateral delete).
	bContacts := sendOK(b, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	found := false
	for _, c := range bContacts.GetContacts() {
		if c.GetTarget().GetUid() == a.uid {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("B should still see A after A's unilateral delete")
	}
}

func TestUpdateRemark(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	// Become friends
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// Update remark
	sendOK(a, "update_remark", &pb.UpdateRemarkRequest{Target: userContactTarget(b.uid), RemarkName: "Bobby"}, &pb.UpdateRemarkResponse{})

	// Verify remark in get_contacts
	resp := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	found := false
	for _, c := range resp.GetContacts() {
		if c.GetTarget().GetUid() == b.uid {
			if c.GetRemarkName() != "Bobby" {
				t.Fatalf("expected remark_name=Bobby, got %q", c.GetRemarkName())
			}
			found = true
		}
	}
	if !found {
		t.Fatal("B not found in A's contacts after update_remark")
	}
}

func TestListContacts(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")

	// Create a friend (FRIEND status) and a pending request
	b := dial(t)
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")
	c := dial(t)
	c.registerAndLogin(uniqueName("ct"), "pass1234", "Carol")

	// A adds B, B accepts => FRIEND
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// A adds C => PENDING
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: c.uid}, &pb.AddFriendResponse{})

	resp := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	if len(resp.GetContacts()) < 2 {
		t.Fatalf("expected at least 2 contacts (friend + pending), got %d", len(resp.GetContacts()))
	}

	var hasFriend, hasPending bool
	for _, ct := range resp.GetContacts() {
		if ct.GetTarget().GetUid() == b.uid && ct.GetStatus() == pb.ContactStatus_CONTACT_STATUS_FRIEND {
			hasFriend = true
		}
		if ct.GetTarget().GetUid() == c.uid && ct.GetStatus() == pb.ContactStatus_CONTACT_STATUS_PENDING_OUTGOING {
			hasPending = true
		}
	}
	if !hasFriend {
		t.Error("expected B as FRIEND in list")
	}
	if !hasPending {
		t.Error("expected C as PENDING in list")
	}
}

func TestListContactsPagination(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")

	// Register 5 friends and make them all FRIEND
	friends := make([]*client, 5)
	for i := 0; i < 5; i++ {
		f := dial(t)
		f.registerAndLogin(uniqueName("ct"), "pass1234", "Friend")
		sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: f.uid}, &pb.AddFriendResponse{})
		f.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
		sendOK(f, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
		a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
		friends[i] = f
	}

	// 展示通道 keyset 分页：首页 limit=2（向下/FORWARD），后续用上一页 end_cursor 续翻。
	resp1 := sendOK(a, "get_contacts", &pb.GetContactsRequest{Page: &pb.PageQuery{Limit: 2}}, &pb.GetContactsResponse{})
	if len(resp1.GetContacts()) != 2 {
		t.Fatalf("expected 2 contacts with limit=2, got %d", len(resp1.GetContacts()))
	}

	resp2 := sendOK(a, "get_contacts", &pb.GetContactsRequest{Page: &pb.PageQuery{Limit: 2, Cursor: resp1.GetPage().GetEndCursor()}}, &pb.GetContactsResponse{})
	if len(resp2.GetContacts()) != 2 {
		t.Fatalf("expected 2 contacts with limit=2 page2, got %d", len(resp2.GetContacts()))
	}

	resp3 := sendOK(a, "get_contacts", &pb.GetContactsRequest{Page: &pb.PageQuery{Limit: 2, Cursor: resp2.GetPage().GetEndCursor()}}, &pb.GetContactsResponse{})
	if len(resp3.GetContacts()) != 1 {
		t.Fatalf("expected 1 contact with limit=2 page3, got %d", len(resp3.GetContacts()))
	}

	// Ensure no overlap between pages
	seen := make(map[int64]bool)
	for _, c := range resp1.GetContacts() {
		seen[c.GetTarget().GetUid()] = true
	}
	for _, c := range resp2.GetContacts() {
		if seen[c.GetTarget().GetUid()] {
			t.Fatalf("duplicate contact %d across pages", c.GetTarget().GetUid())
		}
		seen[c.GetTarget().GetUid()] = true
	}
	for _, c := range resp3.GetContacts() {
		if seen[c.GetTarget().GetUid()] {
			t.Fatalf("duplicate contact %d across pages", c.GetTarget().GetUid())
		}
	}
}

func TestSyncContacts(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	// Add friend
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// Full sync (last_seq=0) should return all contacts
	resp := sendOK(a, "sync_contacts", &pb.SyncContactsRequest{LastSeq: 0}, &pb.SyncContactsResponse{})
	if len(resp.GetContacts()) == 0 {
		t.Fatal("sync_contacts with last_seq=0 should return contacts")
	}
	// 单页可一次同步完：has_more=false，cursor_seq=本批最大 seq。
	if resp.GetHasMore() {
		t.Fatalf("sync_contacts has_more = %v, want false", resp.GetHasMore())
	}

	// Find max seq from returned contacts
	var maxSeq int64
	for _, c := range resp.GetContacts() {
		if c.GetSeq() > maxSeq {
			maxSeq = c.GetSeq()
		}
	}
	if resp.GetCursorSeq() != maxSeq {
		t.Fatalf("sync_contacts cursor_seq = %v, want %d", resp.GetCursorSeq(), maxSeq)
	}

	// Sync with maxSeq should return empty (no changes)
	resp2 := sendOK(a, "sync_contacts", &pb.SyncContactsRequest{LastSeq: maxSeq}, &pb.SyncContactsResponse{})
	if len(resp2.GetContacts()) != 0 {
		t.Fatalf("sync_contacts with last_seq=max_seq should return 0 contacts, got %d", len(resp2.GetContacts()))
	}
	// 空批：has_more=false，cursor_seq=0，客户端保持原 last_seq。
	if resp2.GetHasMore() {
		t.Fatalf("empty sync_contacts has_more = %v, want false", resp2.GetHasMore())
	}
	if resp2.GetCursorSeq() != 0 {
		t.Fatalf("empty sync_contacts cursor_seq = %v, want 0", resp2.GetCursorSeq())
	}
}
