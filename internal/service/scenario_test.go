package service

import (
	"fmt"
	"sync"
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/msgid"
)

// TestDMFullFlow tests the complete DM lifecycle: register → login → send → sync → conversations.
func TestDMFullFlow(t *testing.T) {
	s := testState(t)
	uidA, tokenA := registerAndLogin(t, s, "alice", "pass", "Alice")
	uidB, _ := registerAndLogin(t, s, "bob", "pass", "Bob")
	makeFriends(t, s, uidA, uidB)

	// Send DM
	req := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hello bob"}
	result := sendMessageService(s, "r1", uidA, req)
	if !result.Response.OK {
		t.Fatalf("send DM failed: %s", result.Response.Error)
	}
	msgID := *result.Response.MsgID
	if err := msgid.Validate(msgID); err != nil {
		t.Errorf("msg_id should be a valid msgid, got %q: %v", msgID, err)
	}

	// Read sender's messages
	resp := listByConversationService(s, "r2", uidA, &appmsg.Request{ToUID: i64json(uidB), Limit: 100})
	if len(resp.Messages) == 0 {
		t.Error("sender should have messages")
	}

	// Read receiver's messages
	resp = listByConversationService(s, "r3", uidB, &appmsg.Request{ToUID: i64json(uidA), Limit: 100})
	if len(resp.Messages) == 0 {
		t.Error("receiver should have messages")
	}

	// List conversations
	convResp := listConversationsService(s, "r4", uidA, "", 200)
	if len(convResp.Conversations) == 0 {
		t.Error("should have conversations")
	}

	// Auth token still works
	authResp := authenticateTokenService(s, "r5", tokenA)
	if !authResp.OK {
		t.Error("token should still work")
	}
}

// TestGroupChatFullFlow tests: create group → send message → fanout → sync all members.
func TestGroupChatFullFlow(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)
	uidC := registerUser(t, s, "carol", "p", "Carol")

	// Create group
	groupResp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB, uidC})
	groupID := int64(*groupResp.GroupIDResp)

	// Send group message
	req := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "hi all"}
	result := sendMessageService(s, "r2", uidA, req)
	if !result.Response.OK {
		t.Fatalf("send failed: %s", result.Response.Error)
	}
	drainTasks(s)

	// All members should have the message
	for _, uid := range []int64{uidA, uidB, uidC} {
		store := s.MessageStore(uid)
		msgs, _ := store.ListByConversation(uid, 0, groupID, 0, 100)
		found := false
		for _, m := range msgs {
			if dalText(m) == "hi all" {
				found = true
			}
		}
		if !found {
			t.Errorf("uid %d should have the group message", uid)
		}
	}

	// Group detail
	detail := getGroupInfosService(s, "r3", uidA, []int64{groupID})
	if len(detail.Groups) != 1 {
		t.Fatal("groups should have 1 entry")
	}
	members := getGroupMembersService(s, "r4", groupID, "", 200)
	if len(members.Members) != 3 {
		t.Errorf("members = %d, want 3", len(members.Members))
	}
}

// TestContactLifecycle tests: add → accept → list → update remark → list → delete → list.
func TestContactLifecycle(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	// List: empty
	resp := listContactsService(s, "r1", uidA, dal.ContactListFilter{}, "", 200)
	if len(resp.Contacts) != 0 {
		t.Error("should start empty")
	}

	// Add friend
	addFriendService(s, "r2", uidA, uidB, "")
	acceptFriendService(s, "r3", uidB, uidA)

	// List: should have Bob
	resp = listContactsService(s, "r4", uidA, dal.ContactListFilter{}, "", 200)
	if len(resp.Contacts) != 1 {
		t.Fatalf("contacts = %d, want 1", len(resp.Contacts))
	}

	// Update remark
	updateRemarkService(s, "r5", uidA, uidB, 0, "Bobby")

	// List: remark should be updated
	resp = listContactsService(s, "r6", uidA, dal.ContactListFilter{}, "", 200)
	if resp.Contacts[0].RemarkName != "Bobby" {
		t.Errorf("remark = %q, want Bobby", resp.Contacts[0].RemarkName)
	}

	// Delete contact
	deleteFriendService(s, "r7", uidA, uidB)

	// List: should be empty again
	resp = listContactsService(s, "r8", uidA, dal.ContactListFilter{}, "", 200)
	if len(resp.Contacts) != 0 {
		t.Errorf("contacts = %d, want 0 after delete", len(resp.Contacts))
	}
}

// TestConcurrentDM tests concurrent DM sends from multiple goroutines.
func TestConcurrentDM(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	const count = 20
	var wg sync.WaitGroup
	errors := make(chan string, count)

	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := &appmsg.Request{
				ToUID:   i64json(uidB),
				MsgType: dal.MsgText,
				Content: fmt.Sprintf("msg-%d", idx),
			}
			result := sendMessageService(s, fmt.Sprintf("r%d", idx), uidA, req)
			if !result.Response.OK {
				errors <- result.Response.Error
			}
		}(i)
	}
	wg.Wait()
	close(errors)

	for e := range errors {
		t.Errorf("concurrent send error: %s", e)
	}

	// Sender should have all messages
	store := s.MessageStore(uidA)
	msgs, _ := store.ListByConversation(uidA, uidB, 0, 0, 100)
	if len(msgs) != count {
		t.Errorf("sender has %d messages, want %d", len(msgs), count)
	}
}

// TestConcurrentGroupFanout tests concurrent group message fanout.
func TestConcurrentGroupFanout(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	groupID := int64(*groupResp.GroupIDResp)

	const count = 10
	var wg sync.WaitGroup

	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := &appmsg.Request{
				GroupID: i64json(groupID),
				MsgType: dal.MsgText,
				Content: fmt.Sprintf("gmsg-%d", idx),
			}
			sendMessageService(s, fmt.Sprintf("r%d", idx), uidA, req)
			drainTasks(s)
		}(i)
	}
	wg.Wait()

	// All members should have all group messages (+ system messages from creation)
	for _, uid := range []int64{uidB, uidC} {
		store := s.MessageStore(uid)
		msgs, _ := store.ListByConversation(uid, 0, groupID, 0, 200)
		groupMsgCount := 0
		for _, m := range msgs {
			if m.MsgType == dal.MsgText && m.GroupID > 0 {
				groupMsgCount++
			}
		}
		if groupMsgCount != count {
			t.Errorf("uid %d has %d group text messages, want %d", uid, groupMsgCount, count)
		}
	}
}

// TestConcurrentRegisterSameName tests concurrent registration of the same username.
func TestConcurrentRegisterSameName(t *testing.T) {
	s := testState(t)

	const count = 10
	var wg sync.WaitGroup
	successes := make(chan bool, count)

	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			resp := registerService(s, fmt.Sprintf("r%d", idx), "contested", "pass", "Name")
			successes <- resp.OK
		}(i)
	}
	wg.Wait()
	close(successes)

	okCount := 0
	for ok := range successes {
		if ok {
			okCount++
		}
	}
	if okCount != 1 {
		t.Errorf("exactly 1 register should succeed, got %d", okCount)
	}
}

// TestSessionLifecycle tests: login → authenticate → logout → authenticate fails.
func TestSessionLifecycle(t *testing.T) {
	s := testState(t)
	_, token := registerAndLogin(t, s, "alice", "pass", "Alice")

	// Authenticate works
	resp := authenticateTokenService(s, "r1", token)
	if !resp.OK {
		t.Fatal("auth should work")
	}

	// Logout
	logoutService(s, "r2", token)

	// Authenticate fails
	resp = authenticateTokenService(s, "r3", token)
	if resp.OK {
		t.Error("auth should fail after logout")
	}

	// Re-login creates new session
	_, newToken := loginUser(t, s, "alice", "pass")
	resp = authenticateTokenService(s, "r4", newToken)
	if !resp.OK {
		t.Error("new token should work")
	}
}

// TestMessageGCVerification tests message GC preserves recent messages.
func TestMessageGCVerification(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	// Send 10 messages
	for i := 0; i < 10; i++ {
		req := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: fmt.Sprintf("msg-%d", i)}
		sendMessageService(s, "r", uidA, req)
	}

	// GC with maxCount=5
	store := s.MessageStore(uidA)
	deleted, err := store.Purge(uidA, 5)
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if deleted != 5 {
		t.Errorf("deleted = %d, want 5", deleted)
	}

	// Should have 5 remaining
	msgs, _ := store.ListByConversation(uidA, uidB, 0, 0, 100)
	if len(msgs) != 5 {
		t.Errorf("remaining = %d, want 5", len(msgs))
	}
}
