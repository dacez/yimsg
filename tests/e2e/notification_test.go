package e2e

import (
	"testing"
	"time"
)

// TestNewMessageDMNotification verifies that when A sends a DM to B,
// B receives a messages:received notification with from_uid = A's UID.
func TestNewMessageDMNotification(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	// A and B become friends
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// A sends DM to B
	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "hello bob",
	})

	// B should receive messages:received notification
	n := b.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.FromUID == a.uid
	})
	if n.FromUID != a.uid {
		t.Errorf("from_uid = %q, want %q", n.FromUID, a.uid)
	}
}

// TestNewMessageGroupNotification verifies that when A sends a group message,
// B and C both receive messages:received notifications with the group_id.
func TestNewMessageGroupNotification(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")
	c := dial(t)
	c.registerAndLogin(uniqueName("notif"), "pass1234", "Charlie")

	// Create group with A, B, C
	resp := a.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "TestGroup",
		"member_uids": []string{b.uid, c.uid},
	})
	groupID := resp.GroupID
	if groupID == "" {
		t.Fatal("create_group should return group_id")
	}

	// A sends group message
	a.sendOK(wsRequest{
		"action":   "send_message",
		"group_id": groupID,
		"msg_type": 1,
		"content":  "hello group",
	})

	// B receives messages:received with group_id
	nb := b.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	})
	if nb.GroupID != groupID {
		t.Errorf("B notification group_id = %q, want %q", nb.GroupID, groupID)
	}

	// C receives messages:received with group_id
	nc := c.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.GroupID == groupID
	})
	if nc.GroupID != groupID {
		t.Errorf("C notification group_id = %q, want %q", nc.GroupID, groupID)
	}
}

// TestContactsUpdatedOnAddFriend verifies that when A adds B as friend,
// B receives a contacts:updated notification.
func TestContactsUpdatedOnAddFriend(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})

	n := b.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})
	if n.Type != "contacts:updated" {
		t.Errorf("type = %q, want contacts:updated", n.Type)
	}
}

// TestContactsUpdatedOnAcceptFriend verifies that when B accepts A's request,
// BOTH A and B receive a contacts:updated notification.
func TestContactsUpdatedOnAcceptFriend(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	// Drain B's notification from the add
	b.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})

	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// A should get contacts:updated on accept
	a.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})

	// B (the accepter) should also get contacts:updated
	b.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})
}

// TestAcceptFriendMultiDevice verifies that when B accepts A's request on one
// device, B's other device also receives a contacts:updated notification.
func TestAcceptFriendMultiDevice(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")

	b1 := dial(t)
	b1.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")
	token := b1.token

	// B's second device
	b2 := dial(t)
	b2.authenticate(token)

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b1.uid})
	// Drain add notifications on both B devices
	b1.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
	b2.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// B1 accepts
	b1.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// A should get contacts:updated
	a.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// B1 (accepter) should get contacts:updated
	b1.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	// B2 (other device) should also get contacts:updated
	b2.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })
}

// TestAcceptFriendContactStatus verifies that after accept, get_contacts returns
// updated status (FRIEND=1) for both users, not PENDING(2).
func TestAcceptFriendContactStatus(t *testing.T) {
	const statusFriend uint8 = 1
	const statusPending uint8 = 2

	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	// Before accept: both should have PENDING status
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	respA := a.sendOK(wsRequest{"action": "get_contacts"})
	if len(respA.Contacts) != 1 || respA.Contacts[0].Status != statusPending {
		t.Errorf("before accept: A's contact status = %d, want %d (PENDING)", respA.Contacts[0].Status, statusPending)
	}

	// Accept
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// After accept: both should have FRIEND status
	respA = a.sendOK(wsRequest{"action": "get_contacts"})
	foundA := false
	for _, c := range respA.Contacts {
		if c.FriendUID == b.uid {
			if c.Status != statusFriend {
				t.Errorf("A's contact status = %d, want %d (FRIEND)", c.Status, statusFriend)
			}
			foundA = true
		}
	}
	if !foundA {
		t.Error("A's get_contacts did not include B")
	}

	respB := b.sendOK(wsRequest{"action": "get_contacts"})
	foundB := false
	for _, c := range respB.Contacts {
		if c.FriendUID == a.uid {
			if c.Status != statusFriend {
				t.Errorf("B's contact status = %d, want %d (FRIEND)", c.Status, statusFriend)
			}
			foundB = true
		}
	}
	if !foundB {
		t.Error("B's get_contacts did not include A")
	}
}

// TestContactListOrderByRemarkName verifies that get_contacts returns contacts
// ordered by remark_name ASC (alphabetical).
func TestContactListOrderByRemarkName(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")
	c := dial(t)
	c.registerAndLogin(uniqueName("notif"), "pass1234", "Charlie")

	// A adds C first, then B. Both accept.
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": c.uid})
	c.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// Set explicit remarks so order depends on remark_name instead of insertion order.
	a.sendOK(wsRequest{"action": "update_remark", "friend_uid": c.uid, "remark_name": "Charlie"})
	a.sendOK(wsRequest{"action": "update_remark", "friend_uid": b.uid, "remark_name": "Bob"})

	// Despite C being added first, list should return Bob before Charlie (alphabetical)
	resp := a.sendOK(wsRequest{"action": "get_contacts"})
	if len(resp.Contacts) < 2 {
		t.Fatalf("expected at least 2 contacts, got %d", len(resp.Contacts))
	}
	if resp.Contacts[0].RemarkName != "Bob" {
		t.Errorf("first contact remark = %q, want Bob", resp.Contacts[0].RemarkName)
	}
	if resp.Contacts[1].RemarkName != "Charlie" {
		t.Errorf("second contact remark = %q, want Charlie", resp.Contacts[1].RemarkName)
	}
}

// TestContactsUpdatedOnRejectFriend verifies that when B rejects A's request,
// A receives a contacts:updated notification.
func TestContactsUpdatedOnRejectFriend(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	// Drain B's notification from add (only B is notified)
	b.waitNotif(func(n notification) bool { return n.Type == "contacts:updated" })

	b.sendOK(wsRequest{"action": "reject_friend", "friend_uid": a.uid})

	n := a.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})
	if n.Type != "contacts:updated" {
		t.Errorf("type = %q, want contacts:updated", n.Type)
	}
}

// TestContactsUpdatedOnDeleteFriend verifies that when A deletes B,
// A's other device receives a contacts:updated notification.
func TestContactsUpdatedOnDeleteFriend(t *testing.T) {
	// Setup: A has two connections
	a1 := dial(t)
	a1.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	token := a1.token

	a2 := dial(t)
	a2.authenticate(token)

	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	// Become friends
	a1.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a1.uid})

	// Drain all contacts:updated notifications from friend setup
	time.Sleep(300 * time.Millisecond)
	a1.drainNotifs(func(n notification) bool { return n.Type == "contacts:updated" })
	a2.drainNotifs(func(n notification) bool { return n.Type == "contacts:updated" })
	b.drainNotifs(func(n notification) bool { return n.Type == "contacts:updated" })

	// A1 deletes B
	a1.sendOK(wsRequest{"action": "delete_friend", "friend_uid": b.uid})

	// A2 (other device) should get contacts:updated
	n := a2.waitNotif(func(n notification) bool {
		return n.Type == "contacts:updated"
	})
	if n.Type != "contacts:updated" {
		t.Errorf("type = %q, want contacts:updated", n.Type)
	}
}

// TestReadClearedMultiDevice verifies that when user marks read on one device,
// the other device receives a conversations:clearunread notification.
func TestReadClearedMultiDevice(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")

	b1 := dial(t)
	b1.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")
	token := b1.token

	b2 := dial(t)
	b2.authenticate(token)

	// Become friends
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b1.uid})
	b1.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// A sends message to B
	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b1.uid,
		"msg_type": 1,
		"content":  "test read cleared",
	})

	// Wait for message notifications
	b1.waitNotif(func(n notification) bool { return n.Type == "messages:received" })
	b2.waitNotif(func(n notification) bool { return n.Type == "messages:received" })

	// B1 marks read
	b1.sendOK(wsRequest{"action": "clear_unread", "to_uid": a.uid})

	// B2 should get conversations:clearunread notification
	n := b2.waitNotif(func(n notification) bool {
		return n.Type == "conversations:clearunread"
	})
	if n.Type != "conversations:clearunread" {
		t.Errorf("type = %q, want conversations:clearunread", n.Type)
	}
}

// TestMultiDeviceNotification verifies that when a user is connected on
// 2 devices, both receive the same notification.
func TestMultiDeviceNotification(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")

	b1 := dial(t)
	b1.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")
	token := b1.token

	b2 := dial(t)
	b2.authenticate(token)

	// Become friends
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b1.uid})
	b1.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	time.Sleep(300 * time.Millisecond)
	b1.drainNotifs(func(n notification) bool { return true })
	b2.drainNotifs(func(n notification) bool { return true })

	// A sends DM to B
	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b1.uid,
		"msg_type": 1,
		"content":  "multi-device test",
	})

	// Both B1 and B2 should receive messages:received
	n1 := b1.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.FromUID == a.uid
	})
	n2 := b2.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.FromUID == a.uid
	})
	if n1.FromUID != a.uid {
		t.Errorf("b1 from_uid = %q, want %q", n1.FromUID, a.uid)
	}
	if n2.FromUID != a.uid {
		t.Errorf("b2 from_uid = %q, want %q", n2.FromUID, a.uid)
	}
}

// TestSenderReceivesNotification verifies that when A sends a DM to B,
// both A and B receive a messages:received notification (for multi-device sync).
func TestSenderReceivesNotification(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	// Become friends
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	time.Sleep(300 * time.Millisecond)
	a.drainNotifs(func(n notification) bool { return true })

	// A sends DM to B
	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "self notif test",
	})

	// B should get the notification
	b.waitNotif(func(n notification) bool {
		return n.Type == "messages:received" && n.FromUID == a.uid
	})

	// A should also get the notification (for multi-device sync)
	a.waitNotif(func(n notification) bool {
		return n.Type == "messages:received"
	})
}
