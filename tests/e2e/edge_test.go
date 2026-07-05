package e2e

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestConcurrentRegistration verifies that 10 goroutines registering different
// usernames simultaneously all succeed without errors.
func TestConcurrentRegistration(t *testing.T) {
	var wg sync.WaitGroup
	errs := make(chan error, 10)

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			c := dial(t)
			username := uniqueName(fmt.Sprintf("concreg%d", idx))
			resp := c.send(wsRequest{
				"action":   "register",
				"username": username,
				"password": "pass1234",
				"nickname": fmt.Sprintf("User%d", idx),
			})
			if !resp.OK {
				errs <- fmt.Errorf("goroutine %d: register failed: %s", idx, resp.Error)
			}
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Error(err)
	}
}

// TestConcurrentMessaging verifies that A and B can send messages to each other
// concurrently (10 each) and all 20 messages arrive.
func TestConcurrentMessaging(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("concmsg"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("concmsg"), "pass1234", "Bob")

	// Become friends
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	time.Sleep(300 * time.Millisecond)

	var wg sync.WaitGroup
	errs := make(chan error, 20)

	// A sends 10 messages to B
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ac := dial(t)
			ac.authenticate(a.token)
			resp := ac.send(wsRequest{
				"action":   "send_message",
				"to_uid":   b.uid,
				"msg_type": 1,
				"content":  fmt.Sprintf("from_a_%d", idx),
			})
			if !resp.OK {
				errs <- fmt.Errorf("A->B msg %d failed: %s", idx, resp.Error)
			}
		}(i)
	}

	// B sends 10 messages to A
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			bc := dial(t)
			bc.authenticate(b.token)
			resp := bc.send(wsRequest{
				"action":   "send_message",
				"to_uid":   a.uid,
				"msg_type": 1,
				"content":  fmt.Sprintf("from_b_%d", idx),
			})
			if !resp.OK {
				errs <- fmt.Errorf("B->A msg %d failed: %s", idx, resp.Error)
			}
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Error(err)
	}

	// Give fanout time to complete
	time.Sleep(500 * time.Millisecond)

	// B syncs messages — should have 10 from A
	respB := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	fromA := 0
	for _, m := range respB.Messages {
		if m.FromUID == a.uid {
			fromA++
		}
	}
	if fromA < 10 {
		t.Errorf("B should have at least 10 messages from A, got %d", fromA)
	}

	// A syncs messages — should have 10 from B
	respA := a.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	fromB := 0
	for _, m := range respA.Messages {
		if m.FromUID == b.uid {
			fromB++
		}
	}
	if fromB < 10 {
		t.Errorf("A should have at least 10 messages from B, got %d", fromB)
	}
}

// TestLargeMessage verifies that a 4096-char message can be sent and retrieved.
func TestLargeMessage(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("large"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("large"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// 最大 4096 字符内容
	largeContent := strings.Repeat("A", 4096)

	resp := a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  largeContent,
	})
	if resp.MsgID == "" {
		t.Fatal("send_message should return msg_id")
	}

	// Wait for fanout
	time.Sleep(300 * time.Millisecond)

	// B syncs and verifies content
	syncResp := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	found := false
	for _, m := range syncResp.Messages {
		if m.MsgID == resp.MsgID {
			if m.text() != largeContent {
				t.Errorf("content length = %d, want %d", len(m.text()), len(largeContent))
			}
			found = true
			break
		}
	}
	if !found {
		t.Error("large message not found in B's sync results")
	}
}

// TestSpecialCharacters verifies that messages with Unicode, emoji, Chinese,
// newlines, and HTML tags are preserved exactly.
func TestSpecialCharacters(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("special"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("special"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	specialContent := "Hello 🌍🎉! 你好世界\n<b>bold</b> & \"quotes\" 'apos'\ttab"

	resp := a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  specialContent,
	})

	time.Sleep(300 * time.Millisecond)

	syncResp := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	found := false
	for _, m := range syncResp.Messages {
		if m.MsgID == resp.MsgID {
			if m.text() != specialContent {
				t.Errorf("content = %q, want %q", m.text(), specialContent)
			}
			found = true
			break
		}
	}
	if !found {
		t.Error("special character message not found in B's sync results")
	}
}

// TestEmptyMessage tests sending a message with empty content.
func TestEmptyMessage(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("empty"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("empty"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// Send message with empty content — server may accept or reject
	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "",
	})
	// Just verify we get a definitive response (ok or error), no crash
	if resp.OK {
		t.Log("server accepted empty message")
	} else {
		t.Logf("server rejected empty message: %s", resp.Error)
	}
}

// TestReconnectAndSync verifies that a user can disconnect, reconnect with
// a token, and sync messages received while offline.
func TestReconnectAndSync(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("recon"), "pass1234", "Alice")

	b := dial(t)
	b.registerAndLogin(uniqueName("recon"), "pass1234", "Bob")
	bToken := b.token

	// Become friends
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// B receives a message and notes the seq
	a.sendOK(wsRequest{
		"action": "send_message", "to_uid": b.uid,
		"msg_type": 1, "content": "before disconnect",
	})
	time.Sleep(300 * time.Millisecond)

	syncResp := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	if len(syncResp.Messages) == 0 {
		t.Fatal("expected at least 1 message before disconnect")
	}
	lastSeq := syncResp.Messages[len(syncResp.Messages)-1].Seq

	// B disconnects
	b.conn.Close()

	// A sends more messages while B is offline
	a.sendOK(wsRequest{
		"action": "send_message", "to_uid": b.uid,
		"msg_type": 1, "content": "while offline 1",
	})
	a.sendOK(wsRequest{
		"action": "send_message", "to_uid": b.uid,
		"msg_type": 1, "content": "while offline 2",
	})

	time.Sleep(300 * time.Millisecond)

	// B reconnects with token
	b2 := dial(t)
	b2.authenticate(bToken)

	// B syncs from last known seq
	syncResp2 := b2.sendOK(wsRequest{"action": "sync_messages", "last_seq": lastSeq})
	if len(syncResp2.Messages) < 2 {
		t.Errorf("expected at least 2 new messages after reconnect, got %d", len(syncResp2.Messages))
	}
}

// TestMaxSeqMonotonicity verifies that sending 5 messages results in
// strictly increasing seq values.
func TestMaxSeqMonotonicity(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("mono"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("mono"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	for i := 0; i < 5; i++ {
		a.sendOK(wsRequest{
			"action": "send_message", "to_uid": b.uid,
			"msg_type": 1, "content": fmt.Sprintf("msg_%d", i),
		})
	}

	time.Sleep(300 * time.Millisecond)

	syncResp := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	if len(syncResp.Messages) < 5 {
		t.Fatalf("expected at least 5 messages, got %d", len(syncResp.Messages))
	}

	var prevSeq int64
	for i, m := range syncResp.Messages {
		if m.Seq <= prevSeq {
			t.Errorf("seq not increasing at index %d: %d <= %d", i, m.Seq, prevSeq)
		}
		prevSeq = m.Seq
	}
}

// TestConversationOrdering verifies that get_conversations returns
// conversations ordered by most recent activity first.
func TestConversationOrdering(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("order"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("order"), "pass1234", "Bob")
	c := dial(t)
	c.registerAndLogin(uniqueName("order"), "pass1234", "Charlie")

	// A befriends B and C
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})
	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": c.uid})
	c.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	// A messages B first, then C
	a.sendOK(wsRequest{
		"action": "send_message", "to_uid": b.uid,
		"msg_type": 1, "content": "hi bob",
	})
	time.Sleep(100 * time.Millisecond)
	a.sendOK(wsRequest{
		"action": "send_message", "to_uid": c.uid,
		"msg_type": 1, "content": "hi charlie",
	})

	time.Sleep(300 * time.Millisecond)

	resp := a.sendOK(wsRequest{"action": "get_conversations"})
	if len(resp.Conversations) < 2 {
		t.Fatalf("expected at least 2 conversations, got %d", len(resp.Conversations))
	}

	// Most recent (C) should come first
	if resp.Conversations[0].FriendUID != c.uid {
		t.Errorf("first conversation friend_uid = %q, want %q (most recent)", resp.Conversations[0].FriendUID, c.uid)
	}
	if resp.Conversations[1].FriendUID != b.uid {
		t.Errorf("second conversation friend_uid = %q, want %q", resp.Conversations[1].FriendUID, b.uid)
	}
}

// TestUnreadCountAccumulates verifies that sending 3 messages without
// clear_unread results in unread_count = 3.
func TestUnreadCountAccumulates(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("unread"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("unread"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	for i := 0; i < 3; i++ {
		a.sendOK(wsRequest{
			"action": "send_message", "to_uid": b.uid,
			"msg_type": 1, "content": fmt.Sprintf("unread_%d", i),
		})
	}

	time.Sleep(500 * time.Millisecond)

	resp := b.sendOK(wsRequest{"action": "get_unread_count"})
	if resp.UnreadCount != 3 {
		t.Fatalf("unread_count = %d, want 3", resp.UnreadCount)
	}

	convs := b.sendOK(wsRequest{"action": "get_conversations"})
	found := false
	for _, conv := range convs.Conversations {
		if conv.FriendUID == a.uid {
			found = true
			if conv.UnreadCount != 3 {
				t.Errorf("conversation unread_count = %d, want 3", conv.UnreadCount)
			}
			break
		}
	}
	if !found {
		t.Error("unread count for conversation with A not found")
	}
}

// TestClearUnreadClearsUnread verifies that after clear_unread, unread_count = 0.
func TestClearUnreadClearsUnread(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("markread"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("markread"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	for i := 0; i < 3; i++ {
		a.sendOK(wsRequest{
			"action": "send_message", "to_uid": b.uid,
			"msg_type": 1, "content": fmt.Sprintf("read_%d", i),
		})
	}

	time.Sleep(500 * time.Millisecond)

	// B marks read
	b.sendOK(wsRequest{"action": "clear_unread", "to_uid": a.uid})

	resp := b.sendOK(wsRequest{"action": "get_unread_count"})
	if resp.UnreadCount != 0 {
		t.Errorf("unread_count = %d after clear_unread, want 0", resp.UnreadCount)
	}
}

// TestSendMessageToNonexistentUser tests sending a DM to a non-existent UID.
func TestSendMessageToNonexistentUser(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("nouser"), "pass1234", "Alice")

	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   "999999999",
		"msg_type": 1,
		"content":  "hello nobody",
	})
	// Log behavior — server may or may not validate recipient existence
	if resp.OK {
		t.Log("server accepted message to nonexistent user (fanout write pattern)")
	} else {
		t.Logf("server rejected message to nonexistent user: %s", resp.Error)
	}
}

// TestRapidFireMessages sends 50 messages rapidly from A to B and verifies
// B can sync all 50.
func TestRapidFireMessages(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("rapid"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("rapid"), "pass1234", "Bob")

	a.sendOK(wsRequest{"action": "add_friend", "friend_uid": b.uid})
	b.sendOK(wsRequest{"action": "accept_friend", "friend_uid": a.uid})

	for i := 0; i < 50; i++ {
		a.sendOK(wsRequest{
			"action": "send_message", "to_uid": b.uid,
			"msg_type": 1, "content": fmt.Sprintf("rapid_%d", i),
		})
	}

	// Give fanout time to complete
	time.Sleep(1 * time.Second)

	syncResp := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": 0})
	count := 0
	for _, m := range syncResp.Messages {
		if m.FromUID == a.uid {
			count++
		}
	}
	if count < 50 {
		t.Errorf("expected at least 50 messages from A, got %d", count)
	}
}
