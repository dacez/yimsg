package e2e

import (
	"testing"
	"time"
	"yimsg/internal/appmsg"
	"yimsg/internal/protocol/pb"
)

// TestNewMessageDMNotification verifies that when A sends a DM to B,
// B receives a messages:received notification with from_uid = A's UID.
func TestNewMessageDMNotification(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	// A and B become friends
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// A sends DM to B
	a.sendText(userTarget(b.uid), "hello bob")

	// B should receive messages:received notification
	n := b.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifUID(n) == a.uid
	})
	if notifUID(n) != a.uid {
		t.Errorf("from_uid = %d, want %d", notifUID(n), a.uid)
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
	resp := sendOK(a, "create_group", &pb.CreateGroupRequest{Name: "TestGroup", MemberUids: []int64{b.uid, c.uid}}, &pb.CreateGroupResponse{})
	groupID := resp.GetGroupId()
	if groupID <= 0 {
		t.Fatal("create_group should return group_id")
	}

	// A sends group message
	a.sendText(groupTarget(groupID), "hello group")

	// B receives messages:received with group_id
	nb := b.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	})
	if notifGroupID(nb) != groupID {
		t.Errorf("B notification group_id = %d, want %d", notifGroupID(nb), groupID)
	}

	// C receives messages:received with group_id
	nc := c.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifGroupID(n) == groupID
	})
	if notifGroupID(nc) != groupID {
		t.Errorf("C notification group_id = %d, want %d", notifGroupID(nc), groupID)
	}
}

// TestContactsUpdatedOnAddFriend verifies that when A adds B as friend,
// B receives a contacts:updated notification.
func TestContactsUpdatedOnAddFriend(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})

	n := b.waitNotif(func(n *appmsg.Notification) bool {
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

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	// Drain B's notification from the add
	b.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "contacts:updated"
	})

	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// A should get contacts:updated on accept
	a.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "contacts:updated"
	})

	// B (the accepter) should also get contacts:updated
	b.waitNotif(func(n *appmsg.Notification) bool {
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

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b1.uid}, &pb.AddFriendResponse{})
	// Drain add notifications on both B devices
	b1.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	b2.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// B1 accepts
	sendOK(b1, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// A should get contacts:updated
	a.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// B1 (accepter) should get contacts:updated
	b1.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// B2 (other device) should also get contacts:updated
	b2.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
}

// TestAcceptFriendContactStatus verifies that after accept, get_contacts returns
// updated status (FRIEND=1) for both users, not PENDING(2).
func TestAcceptFriendContactStatus(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	// Before accept: both should have PENDING status
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	respA := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	if len(respA.GetContacts()) != 1 || respA.GetContacts()[0].GetStatus() != pb.ContactStatus_CONTACT_STATUS_PENDING_OUTGOING {
		t.Errorf("before accept: A's contact status = %v, want PENDING_OUTGOING", respA.GetContacts()[0].GetStatus())
	}

	// Accept
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// After accept: both should have FRIEND status
	respA = sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	foundA := false
	for _, c := range respA.GetContacts() {
		if c.GetTarget().GetUid() == b.uid {
			if c.GetStatus() != pb.ContactStatus_CONTACT_STATUS_FRIEND {
				t.Errorf("A's contact status = %v, want FRIEND", c.GetStatus())
			}
			foundA = true
		}
	}
	if !foundA {
		t.Error("A's get_contacts did not include B")
	}

	respB := sendOK(b, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	foundB := false
	for _, c := range respB.GetContacts() {
		if c.GetTarget().GetUid() == a.uid {
			if c.GetStatus() != pb.ContactStatus_CONTACT_STATUS_FRIEND {
				t.Errorf("B's contact status = %v, want FRIEND", c.GetStatus())
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: c.uid}, &pb.AddFriendResponse{})
	sendOK(c, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// Set explicit remarks so order depends on remark_name instead of insertion order.
	sendOK(a, "update_remark", &pb.UpdateRemarkRequest{Target: userContactTarget(c.uid), RemarkName: "Charlie"}, &pb.UpdateRemarkResponse{})
	sendOK(a, "update_remark", &pb.UpdateRemarkRequest{Target: userContactTarget(b.uid), RemarkName: "Bob"}, &pb.UpdateRemarkResponse{})

	// Despite C being added first, list should return Bob before Charlie (alphabetical)
	resp := sendOK(a, "get_contacts", &pb.GetContactsRequest{}, &pb.GetContactsResponse{})
	if len(resp.GetContacts()) < 2 {
		t.Fatalf("expected at least 2 contacts, got %d", len(resp.GetContacts()))
	}
	if resp.GetContacts()[0].GetRemarkName() != "Bob" {
		t.Errorf("first contact remark = %q, want Bob", resp.GetContacts()[0].GetRemarkName())
	}
	if resp.GetContacts()[1].GetRemarkName() != "Charlie" {
		t.Errorf("second contact remark = %q, want Charlie", resp.GetContacts()[1].GetRemarkName())
	}
}

// TestContactsUpdatedOnRejectFriend verifies that when B rejects A's request,
// A receives a contacts:updated notification.
func TestContactsUpdatedOnRejectFriend(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("notif"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("notif"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	// Drain B's notification from add (only B is notified)
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	sendOK(b, "reject_friend", &pb.RejectFriendRequest{FriendUid: a.uid}, &pb.RejectFriendResponse{})

	n := a.waitNotif(func(n *appmsg.Notification) bool {
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
	sendOK(a1, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a1.uid}, &pb.AcceptFriendResponse{})

	// Drain all contacts:updated notifications from friend setup
	time.Sleep(300 * time.Millisecond)
	a1.drainNotifs(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	a2.drainNotifs(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })
	b.drainNotifs(func(n *appmsg.Notification) bool { return n.Type == "contacts:updated" })

	// A1 deletes B
	sendOK(a1, "delete_friend", &pb.DeleteFriendRequest{FriendUid: b.uid}, &pb.DeleteFriendResponse{})

	// A2 (other device) should get contacts:updated
	n := a2.waitNotif(func(n *appmsg.Notification) bool {
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b1.uid}, &pb.AddFriendResponse{})
	sendOK(b1, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// A sends message to B
	a.sendText(userTarget(b1.uid), "test read cleared")

	// Wait for message notifications
	b1.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "messages:received" })
	b2.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "messages:received" })

	// B1 marks read
	sendOK(b1, "clear_unread", &pb.ClearUnreadRequest{Target: userTarget(a.uid)}, &pb.ClearUnreadResponse{})

	// B2 should get conversations:clearunread notification
	n := b2.waitNotif(func(n *appmsg.Notification) bool {
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b1.uid}, &pb.AddFriendResponse{})
	sendOK(b1, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	time.Sleep(300 * time.Millisecond)
	b1.drainNotifs(func(n *appmsg.Notification) bool { return true })
	b2.drainNotifs(func(n *appmsg.Notification) bool { return true })

	// A sends DM to B
	a.sendText(userTarget(b1.uid), "multi-device test")

	// Both B1 and B2 should receive messages:received
	n1 := b1.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifUID(n) == a.uid
	})
	n2 := b2.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifUID(n) == a.uid
	})
	if notifUID(n1) != a.uid {
		t.Errorf("b1 from_uid = %d, want %d", notifUID(n1), a.uid)
	}
	if notifUID(n2) != a.uid {
		t.Errorf("b2 from_uid = %d, want %d", notifUID(n2), a.uid)
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	time.Sleep(300 * time.Millisecond)
	a.drainNotifs(func(n *appmsg.Notification) bool { return true })

	// A sends DM to B
	a.sendText(userTarget(b.uid), "self notif test")

	// B should get the notification
	b.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received" && notifUID(n) == a.uid
	})

	// A should also get the notification (for multi-device sync)
	a.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received"
	})
}
