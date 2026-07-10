package e2e

import (
	"testing"
)

func TestAddFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	resp := a.sendOK(wsRequest{
		"action":     "add_friend",
		"friend_uid": b.uid,
	})
	if resp.Seq == nil {
		t.Fatal("add_friend should return seq")
	}

	// B should receive a contacts:updated notification
	b.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})
}

func TestAddFriendSelf(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")

	a.sendErr(wsRequest{
		"action":     "add_friend",
		"friend_uid": a.uid,
	})
}

func TestAddFriendDuplicate(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	a.sendOK(wsRequest{
		"action":     "add_friend",
		"friend_uid": b.uid,
	})

	// Adding the same friend again uses upsert; the server allows it
	// (re-sets status to pending). Verify it succeeds.
	resp := a.sendOK(wsRequest{
		"action":     "add_friend",
		"friend_uid": b.uid,
	})
	if resp.Seq == nil {
		t.Fatal("duplicate add_friend should still return seq")
	}
}

func TestAcceptFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	a.sendOK(wsRequest{
		"action":     "add_friend",
		"friend_uid": b.uid,
	})
	// Drain the contacts:updated notification on B from add_friend
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	b.sendOK(wsRequest{
		"action":     "accept_friend",
		"friend_uid": a.uid,
	})

	// A should get contacts:updated notification from accept
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// Verify both sides are FRIEND (status=1)
	aContacts := a.sendOK(wsRequest{"action": "get_contacts"})
	found := false
	for _, c := range aContacts.Contacts {
		if c.FriendUID == b.uid && c.Status == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("A should see B as FRIEND, contacts: %+v", aContacts.Contacts)
	}

	bContacts := b.sendOK(wsRequest{"action": "get_contacts"})
	found = false
	for _, c := range bContacts.Contacts {
		if c.FriendUID == a.uid && c.Status == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("B should see A as FRIEND, contacts: %+v", bContacts.Contacts)
	}
}

// TestAcceptFriendRejectsRequester 覆盖好友请求方向 bug 的回归：申请方 A 不能对自己
// 发出的请求调用 accept_friend/reject_friend，只有接收方 B 才能处理这条请求。
func TestAcceptFriendRejectsRequester(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	a.sendOK(wsRequest{
		"action":     "add_friend",
		"friend_uid": b.uid,
	})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// A（申请方）自己接受自己发出的请求应该失败。
	resp := a.sendErr(wsRequest{
		"action":     "accept_friend",
		"friend_uid": b.uid,
	})
	if resp.ErrorCode != "CONFLICT" {
		t.Fatalf("A accepting own request: error_code = %q, want CONFLICT", resp.ErrorCode)
	}

	// A（申请方）自己拒绝自己发出的请求同样应该失败。
	resp = a.sendErr(wsRequest{
		"action":     "reject_friend",
		"friend_uid": b.uid,
	})
	if resp.ErrorCode != "CONFLICT" {
		t.Fatalf("A rejecting own request: error_code = %q, want CONFLICT", resp.ErrorCode)
	}

	// 关系应该仍然是 PENDING，双方都还不是好友。
	aContacts := a.sendOK(wsRequest{"action": "get_contacts"})
	for _, c := range aContacts.Contacts {
		if c.FriendUID == b.uid && c.Status == 1 {
			t.Fatalf("A should not become FRIEND with B via self-accept, got: %+v", c)
		}
	}

	// B（接收方）才能正常接受，验证 bug 修复没有破坏正常流程。
	b.sendOK(wsRequest{
		"action":     "accept_friend",
		"friend_uid": a.uid,
	})
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	aContacts = a.sendOK(wsRequest{"action": "get_contacts"})
	found := false
	for _, c := range aContacts.Contacts {
		if c.FriendUID == b.uid && c.Status == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("A should see B as FRIEND after B's legitimate accept, contacts: %+v", aContacts.Contacts)
	}
}

func TestRejectFriend(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	a.sendOK(wsRequest{
		"action":     "add_friend",
		"friend_uid": b.uid,
	})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	b.sendOK(wsRequest{
		"action":     "reject_friend",
		"friend_uid": a.uid,
	})

	// A should get contacts:updated notification from reject
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// Both sides should be DELETED (status=1), so get_contacts excludes them
	aContacts := a.sendOK(wsRequest{"action": "get_contacts"})
	for _, c := range aContacts.Contacts {
		if c.FriendUID == b.uid {
			t.Fatalf("A should not see B in get_contacts after reject, got: %+v", c)
		}
	}

	bContacts := b.sendOK(wsRequest{"action": "get_contacts"})
	for _, c := range bContacts.Contacts {
		if c.FriendUID == a.uid {
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
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// A deletes B (unilateral, only caller side)
	a.sendOK(wsRequest{
		"action":     "delete_friend",
		"friend_uid": b.uid,
	})

	// A should no longer see B
	aContacts := a.sendOK(wsRequest{"action": "get_contacts"})
	for _, c := range aContacts.Contacts {
		if c.FriendUID == b.uid {
			t.Fatalf("A should not see B after delete, got: %+v", c)
		}
	}

	// B should still see A (unilateral delete).
	bContacts := b.sendOK(wsRequest{"action": "get_contacts"})
	found := false
	for _, c := range bContacts.Contacts {
		if c.FriendUID == a.uid {
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
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// Update remark
	a.sendOK(wsRequest{
		"action":      "update_remark",
		"friend_uid":  b.uid,
		"remark_name": "Bobby",
	})

	// Verify remark in get_contacts
	resp := a.sendOK(wsRequest{"action": "get_contacts"})
	found := false
	for _, c := range resp.Contacts {
		if c.FriendUID == b.uid {
			if c.RemarkName != "Bobby" {
				t.Fatalf("expected remark_name=Bobby, got %q", c.RemarkName)
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
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// A adds C => PENDING
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": c.uid})

	resp := a.sendOK(wsRequest{"action": "get_contacts"})
	if len(resp.Contacts) < 2 {
		t.Fatalf("expected at least 2 contacts (friend + pending), got %d", len(resp.Contacts))
	}

	var hasFriend, hasPending bool
	for _, ct := range resp.Contacts {
		if ct.FriendUID == b.uid && ct.Status == 1 {
			hasFriend = true
		}
		if ct.FriendUID == c.uid && ct.Status == 2 {
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
		a.sendOK(wsRequest{"action": "add_friend", "friend_uid": f.uid})
		f.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
		f.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
		a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
		friends[i] = f
	}

	// 展示通道 keyset 分页：首页 limit=2（向下/FORWARD），后续用上一页 end_cursor 续翻。
	resp1 := a.sendOK(wsRequest{"action": "get_contacts", "page": wsRequest{"limit": 2}})
	if len(resp1.Contacts) != 2 {
		t.Fatalf("expected 2 contacts with limit=2, got %d", len(resp1.Contacts))
	}

	resp2 := a.sendOK(wsRequest{"action": "get_contacts", "page": wsRequest{"limit": 2, "cursor": pageOf(&resp1).EndCursor}})
	if len(resp2.Contacts) != 2 {
		t.Fatalf("expected 2 contacts with limit=2 page2, got %d", len(resp2.Contacts))
	}

	resp3 := a.sendOK(wsRequest{"action": "get_contacts", "page": wsRequest{"limit": 2, "cursor": pageOf(&resp2).EndCursor}})
	if len(resp3.Contacts) != 1 {
		t.Fatalf("expected 1 contact with limit=2 page3, got %d", len(resp3.Contacts))
	}

	// Ensure no overlap between pages
	seen := make(map[string]bool)
	for _, c := range resp1.Contacts {
		seen[c.FriendUID] = true
	}
	for _, c := range resp2.Contacts {
		if seen[c.FriendUID] {
			t.Fatalf("duplicate contact %s across pages", c.FriendUID)
		}
		seen[c.FriendUID] = true
	}
	for _, c := range resp3.Contacts {
		if seen[c.FriendUID] {
			t.Fatalf("duplicate contact %s across pages", c.FriendUID)
		}
	}
}

func TestSyncContacts(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("ct"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("ct"), "pass1234", "Bob")

	// Add friend
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// Full sync (last_seq=0) should return all contacts
	resp := a.sendOK(wsRequest{"action": "sync_contacts", "last_seq": 0})
	if len(resp.Contacts) == 0 {
		t.Fatal("sync_contacts with last_seq=0 should return contacts")
	}
	// 单页可一次同步完：has_more=false，cursor_seq=本批最大 seq。
	if hasMoreVal(resp.HasMore) {
		t.Fatalf("sync_contacts has_more = %v, want false", resp.HasMore)
	}

	// Find max seq from returned contacts
	var maxSeq int64
	for _, c := range resp.Contacts {
		if c.Seq > maxSeq {
			maxSeq = c.Seq
		}
	}
	if cursorSeqVal(resp.CursorSeq) != maxSeq {
		t.Fatalf("sync_contacts cursor_seq = %v, want %d", resp.CursorSeq, maxSeq)
	}

	// Sync with maxSeq should return empty (no changes)
	resp2 := a.sendOK(wsRequest{"action": "sync_contacts", "last_seq": maxSeq})
	if len(resp2.Contacts) != 0 {
		t.Fatalf("sync_contacts with last_seq=max_seq should return 0 contacts, got %d", len(resp2.Contacts))
	}
	// 空批：has_more=false，cursor_seq=0，客户端保持原 last_seq。
	if hasMoreVal(resp2.HasMore) {
		t.Fatalf("empty sync_contacts has_more = %v, want false", resp2.HasMore)
	}
	if cursorSeqVal(resp2.CursorSeq) != 0 {
		t.Fatalf("empty sync_contacts cursor_seq = %v, want 0", resp2.CursorSeq)
	}
}
