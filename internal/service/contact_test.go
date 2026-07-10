package service

import (
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
)

func TestAddFriendBilateral(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := addFriendService(s, "r1", uidA, uidB, "Bobby")
	if !resp.OK {
		t.Fatalf("add_friend failed: %s", resp.Error)
	}

	// 申请方（alice）自身记录是 PENDING_OUTGOING，被申请方（bob）自身记录是 PENDING_INCOMING。
	storeA := s.ContactStore(uidA)
	cA, _ := storeA.Get(uidA, uidB)
	if cA == nil || cA.Status != dal.ContactPendingOutgoing {
		t.Errorf("alice's contact status = %v, want pending_outgoing(%d)", cA, dal.ContactPendingOutgoing)
	}
	if cA.SortKey != "bobby" {
		t.Errorf("alice sort_key = %q, want bobby", cA.SortKey)
	}
	if cA.SearchText != "Bobby Bob" {
		t.Errorf("alice search_text = %q, want \"Bobby Bob\"", cA.SearchText)
	}

	storeB := s.ContactStore(uidB)
	cB, _ := storeB.Get(uidB, uidA)
	if cB == nil || cB.Status != dal.ContactPendingIncoming {
		t.Errorf("bob's contact status = %v, want pending_incoming(%d)", cB, dal.ContactPendingIncoming)
	}
	if cB.SortKey != "alice" || cB.SearchText != "Alice" {
		t.Errorf("bob projection = sort:%q search:%q, want alice/Alice", cB.SortKey, cB.SearchText)
	}
}

func TestAddFriendNotifies(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	// Register bob for notifications
	conn := s.Online().Register(uidB, "")
	defer s.Online().Unregister(uidB, conn)

	addFriendService(s, "r1", uidA, uidB, "")

	select {
	case msg := <-conn.Ch:
		if msg == nil {
			t.Error("notification should not be empty")
		}
	default:
		t.Error("bob should receive a contacts:updated notification")
	}
}

func TestAcceptFriendBilateral(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	addFriendService(s, "r1", uidA, uidB, "")
	resp := acceptFriendService(s, "r2", uidB, uidA)
	if !resp.OK {
		t.Fatalf("accept_friend failed: %s", resp.Error)
	}

	// Both should be friends
	storeA := s.ContactStore(uidA)
	cA, _ := storeA.Get(uidA, uidB)
	if cA == nil || cA.Status != dal.ContactFriend {
		t.Errorf("alice status = %v, want friend(%d)", cA, dal.ContactFriend)
	}

	storeB := s.ContactStore(uidB)
	cB, _ := storeB.Get(uidB, uidA)
	if cB == nil || cB.Status != dal.ContactFriend {
		t.Errorf("bob status = %v, want friend(%d)", cB, dal.ContactFriend)
	}
}

func TestAcceptFriendNoPending(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	resp := acceptFriendService(s, "r1", uidA, uidB)
	if resp.OK {
		t.Error("accept without pending should fail")
	}
	if resp.Error != "no pending request" {
		t.Errorf("got error %q", resp.Error)
	}
}

func TestRejectFriendBilateral(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	addFriendService(s, "r1", uidA, uidB, "")
	resp := rejectFriendService(s, "r2", uidB, uidA)
	if !resp.OK {
		t.Fatalf("reject_friend failed: %s", resp.Error)
	}

	// Bob's side should be deleted
	storeB := s.ContactStore(uidB)
	cB, _ := storeB.Get(uidB, uidA)
	if cB == nil || cB.Status != dal.ContactDeleted {
		t.Errorf("bob status = %v, want deleted(%d)", cB, dal.ContactDeleted)
	}
}

func TestDeleteFriendUnilateral(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	resp := deleteFriendService(s, "r1", uidA, uidB)
	if !resp.OK || resp.Seq == nil {
		t.Fatalf("delete_friend failed: %+v", resp)
	}

	// Alice's side deleted
	storeA := s.ContactStore(uidA)
	cA, _ := storeA.Get(uidA, uidB)
	if cA == nil || cA.Status != dal.ContactDeleted {
		t.Errorf("alice contact should be soft-deleted, got %v", cA)
	}

	// Bob's side should remain as friend (unilateral delete)
	storeB := s.ContactStore(uidB)
	cB, _ := storeB.Get(uidB, uidA)
	if cB == nil || cB.Status != dal.ContactFriend {
		t.Errorf("bob contact should remain friend, got %v", cB)
	}
}

func TestUpdateRemarkService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	resp := updateRemarkService(s, "r1", uidA, uidB, 0, "BobbyBoy")
	if !resp.OK {
		t.Fatalf("update_remark failed: %s", resp.Error)
	}

	storeA := s.ContactStore(uidA)
	c, _ := storeA.Get(uidA, uidB)
	if c == nil || c.RemarkName != "BobbyBoy" {
		t.Errorf("remark should be BobbyBoy, got %v", c)
	}
	if c.SortKey != "bobbyboy" {
		t.Errorf("sort_key should be bobbyboy, got %v", c)
	}
	if c.SearchText != "BobbyBoy Bob" {
		t.Errorf("search_text should be \"BobbyBoy Bob\", got %v", c)
	}
}

func TestListContacts(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	resp := listContactsService(s, "r1", uidA, dal.ContactListFilter{}, "", 200)
	if !resp.OK {
		t.Fatalf("get_contacts failed: %s", resp.Error)
	}
	if len(resp.Contacts) != 1 {
		t.Errorf("contacts = %d, want 1", len(resp.Contacts))
	}
	if resp.Page == nil || resp.Page.HasMoreForward {
		t.Fatalf("has_more_forward = %v, want false", resp.Page)
	}
	if resp.Contacts[0].RemarkName != "" {
		t.Errorf("remark_name = %q, want empty", resp.Contacts[0].RemarkName)
	}
}

func TestListContactsNormalizedTarget(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	resp := listContactsService(s, "r1", uidA, dal.ContactListFilter{}, "", 200)
	if !resp.OK {
		t.Fatalf("get_contacts failed: %s", resp.Error)
	}
	found := false
	for _, c := range resp.Contacts {
		if targetUID(c.Target) == uidB {
			found = true
		}
	}
	if !found {
		t.Error("bob should be in contacts")
	}
}

func TestListContactsExcludesDeleted(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	deleteFriendService(s, "r1", uidA, uidB)

	resp := listContactsService(s, "r2", uidA, dal.ContactListFilter{}, "", 200)
	if !resp.OK {
		t.Fatalf("get_contacts failed: %s", resp.Error)
	}
	if len(resp.Contacts) != 0 {
		t.Errorf("contacts = %d, want 0 (deleted should be excluded)", len(resp.Contacts))
	}
}

func TestContactSyncSeqTooOldAfterGCRejectsZeroWithoutRebuild(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	if resp := deleteFriendService(s, "r1", uidA, uidB); !resp.OK {
		t.Fatalf("delete_friend failed: %+v", resp)
	}
	if _, err := s.ContactStore(uidA).Purge(uidA); err != nil {
		t.Fatalf("purge contacts: %v", err)
	}

	freshResp := syncContactsService(s, "r2", uidA, 0, 200, false)
	if freshResp.OK || freshResp.ErrorCode != appmsg.ErrorCodeSeqTooOld {
		t.Fatalf("fresh sync_contacts after gc = %+v, want seq_too_old", freshResp)
	}
	rebuildResp := syncContactsService(s, "r3", uidA, 0, 200, true)
	if !rebuildResp.OK || len(rebuildResp.Contacts) != 0 {
		t.Fatalf("rebuild sync_contacts after gc = %+v, want empty current snapshot", rebuildResp)
	}
}

func TestListContactsPagination(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	makeFriends(t, s, uidA, uidB)
	makeFriends(t, s, uidA, uidC)

	// First page：keyset 游标，向下(FORWARD)翻。
	resp := listContactsService(s, "r1", uidA, dal.ContactListFilter{}, "", 1)
	if len(resp.Contacts) != 1 {
		t.Fatalf("page1 = %d, want 1", len(resp.Contacts))
	}
	if resp.Page == nil || !resp.Page.HasMoreForward {
		t.Fatalf("page1 has_more_forward = %v, want true", resp.Page)
	}
	// Second page：用上一页 end_cursor 续翻。
	resp2 := listContactsService(s, "r2", uidA, dal.ContactListFilter{}, resp.Page.EndCursor, 1)
	if len(resp2.Contacts) != 1 {
		t.Fatalf("page2 = %d, want 1", len(resp2.Contacts))
	}
	if resp2.Page == nil || resp2.Page.HasMoreForward {
		t.Fatalf("page2 has_more_forward = %v, want false", resp2.Page)
	}
	// Different contacts
	if targetUID(resp.Contacts[0].Target) == targetUID(resp2.Contacts[0].Target) {
		t.Error("pages should return different contacts")
	}
}
