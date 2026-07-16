package e2e

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/msgid"
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
			resp := send(c, "register", &pb.RegisterRequest{
				Username: username, Password: "pass1234", Nickname: fmt.Sprintf("User%d", idx),
			}, &pb.RegisterResponse{})
			if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
				errs <- fmt.Errorf("goroutine %d: register failed: %s", idx, resp.GetBase().GetMsg())
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
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
			resp := send(ac, "send_message", &pb.SendMessageRequest{
				MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody(fmt.Sprintf("from_a_%d", idx)),
			}, &pb.SendMessageResponse{})
			if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
				errs <- fmt.Errorf("A->B msg %d failed: %s", idx, resp.GetBase().GetMsg())
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
			resp := send(bc, "send_message", &pb.SendMessageRequest{
				MsgId: msgid.Generate(), Target: userTarget(a.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody(fmt.Sprintf("from_b_%d", idx)),
			}, &pb.SendMessageResponse{})
			if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
				errs <- fmt.Errorf("B->A msg %d failed: %s", idx, resp.GetBase().GetMsg())
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
	respB := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	fromA := 0
	for _, m := range respB.GetMessages() {
		if m.GetFromUid() == a.uid {
			fromA++
		}
	}
	if fromA < 10 {
		t.Errorf("B should have at least 10 messages from A, got %d", fromA)
	}

	// A syncs messages — should have 10 from B
	respA := sendOK(a, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	fromB := 0
	for _, m := range respA.GetMessages() {
		if m.GetFromUid() == b.uid {
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

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// 最大 4096 字符内容
	largeContent := strings.Repeat("A", 4096)

	resp := a.sendText(userTarget(b.uid), largeContent)
	if resp.GetMsgId() == "" {
		t.Fatal("send_message should return msg_id")
	}

	// Wait for fanout
	time.Sleep(300 * time.Millisecond)

	// B syncs and verifies content
	syncResp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	found := false
	for _, m := range syncResp.GetMessages() {
		if m.GetMsgId() == resp.GetMsgId() {
			if bodyText(m) != largeContent {
				t.Errorf("content length = %d, want %d", len(bodyText(m)), len(largeContent))
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

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	specialContent := "Hello 🌍🎉! 你好世界\n<b>bold</b> & \"quotes\" 'apos'\ttab"

	resp := a.sendText(userTarget(b.uid), specialContent)

	time.Sleep(300 * time.Millisecond)

	syncResp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	found := false
	for _, m := range syncResp.GetMessages() {
		if m.GetMsgId() == resp.GetMsgId() {
			if bodyText(m) != specialContent {
				t.Errorf("content = %q, want %q", bodyText(m), specialContent)
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

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// Send message with empty content — server may accept or reject
	resp := send(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody(""),
	}, &pb.SendMessageResponse{})
	// Just verify we get a definitive response (ok or error), no crash
	if resp.GetBase().GetCode() == pb.ErrorCode_ERROR_OK {
		t.Log("server accepted empty message")
	} else {
		t.Logf("server rejected empty message: %s", resp.GetBase().GetMsg())
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// B receives a message and notes the seq
	a.sendText(userTarget(b.uid), "before disconnect")
	time.Sleep(300 * time.Millisecond)

	syncResp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	if len(syncResp.GetMessages()) == 0 {
		t.Fatal("expected at least 1 message before disconnect")
	}
	lastSeq := syncResp.GetMessages()[len(syncResp.GetMessages())-1].GetSeq()

	// B disconnects
	b.conn.Close()

	// A sends more messages while B is offline
	a.sendText(userTarget(b.uid), "while offline 1")
	a.sendText(userTarget(b.uid), "while offline 2")

	time.Sleep(300 * time.Millisecond)

	// B reconnects with token
	b2 := dial(t)
	b2.authenticate(bToken)

	// B syncs from last known seq
	syncResp2 := sendOK(b2, "sync_messages", &pb.SyncMessagesRequest{LastSeq: lastSeq}, &pb.SyncMessagesResponse{})
	if len(syncResp2.GetMessages()) < 2 {
		t.Errorf("expected at least 2 new messages after reconnect, got %d", len(syncResp2.GetMessages()))
	}
}

// TestMaxSeqMonotonicity verifies that sending 5 messages results in
// strictly increasing seq values.
func TestMaxSeqMonotonicity(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("mono"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("mono"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	for i := 0; i < 5; i++ {
		a.sendText(userTarget(b.uid), fmt.Sprintf("msg_%d", i))
	}

	time.Sleep(300 * time.Millisecond)

	syncResp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	if len(syncResp.GetMessages()) < 5 {
		t.Fatalf("expected at least 5 messages, got %d", len(syncResp.GetMessages()))
	}

	var prevSeq int64
	for i, m := range syncResp.GetMessages() {
		if m.GetSeq() <= prevSeq {
			t.Errorf("seq not increasing at index %d: %d <= %d", i, m.GetSeq(), prevSeq)
		}
		prevSeq = m.GetSeq()
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
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})
	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: c.uid}, &pb.AddFriendResponse{})
	sendOK(c, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	// A messages B first, then C
	a.sendText(userTarget(b.uid), "hi bob")
	time.Sleep(100 * time.Millisecond)
	a.sendText(userTarget(c.uid), "hi charlie")

	time.Sleep(300 * time.Millisecond)

	resp := sendOK(a, "get_conversations", &pb.GetConversationsRequest{}, &pb.GetConversationsResponse{})
	if len(resp.GetConversations()) < 2 {
		t.Fatalf("expected at least 2 conversations, got %d", len(resp.GetConversations()))
	}

	// Most recent (C) should come first
	if resp.GetConversations()[0].GetTarget().GetUid() != c.uid {
		t.Errorf("first conversation friend_uid = %d, want %d (most recent)", resp.GetConversations()[0].GetTarget().GetUid(), c.uid)
	}
	if resp.GetConversations()[1].GetTarget().GetUid() != b.uid {
		t.Errorf("second conversation friend_uid = %d, want %d", resp.GetConversations()[1].GetTarget().GetUid(), b.uid)
	}
}

// TestUnreadCountAccumulates verifies that sending 3 messages without
// clear_unread results in unread_count = 3.
func TestUnreadCountAccumulates(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("unread"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("unread"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	for i := 0; i < 3; i++ {
		a.sendText(userTarget(b.uid), fmt.Sprintf("unread_%d", i))
	}

	time.Sleep(500 * time.Millisecond)

	resp := sendOK(b, "get_unread_count", &pb.GetUnreadCountRequest{}, &pb.GetUnreadCountResponse{})
	if resp.GetUnreadCount() != 3 {
		t.Fatalf("unread_count = %d, want 3", resp.GetUnreadCount())
	}

	convs := sendOK(b, "get_conversations", &pb.GetConversationsRequest{}, &pb.GetConversationsResponse{})
	found := false
	for _, conv := range convs.GetConversations() {
		if conv.GetTarget().GetUid() == a.uid {
			found = true
			if conv.GetUnreadCount() != 3 {
				t.Errorf("conversation unread_count = %d, want 3", conv.GetUnreadCount())
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

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	for i := 0; i < 3; i++ {
		a.sendText(userTarget(b.uid), fmt.Sprintf("read_%d", i))
	}

	time.Sleep(500 * time.Millisecond)

	// B marks read
	sendOK(b, "clear_unread", &pb.ClearUnreadRequest{Target: userTarget(a.uid)}, &pb.ClearUnreadResponse{})

	resp := sendOK(b, "get_unread_count", &pb.GetUnreadCountRequest{}, &pb.GetUnreadCountResponse{})
	if resp.GetUnreadCount() != 0 {
		t.Errorf("unread_count = %d after clear_unread, want 0", resp.GetUnreadCount())
	}
}

// TestSendMessageToNonexistentUser tests sending a DM to a non-existent UID.
func TestSendMessageToNonexistentUser(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("nouser"), "pass1234", "Alice")

	resp := send(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(999999999), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("hello nobody"),
	}, &pb.SendMessageResponse{})
	// Log behavior — server may or may not validate recipient existence
	if resp.GetBase().GetCode() == pb.ErrorCode_ERROR_OK {
		t.Log("server accepted message to nonexistent user (fanout write pattern)")
	} else {
		t.Logf("server rejected message to nonexistent user: %s", resp.GetBase().GetMsg())
	}
}

// TestRapidFireMessages sends 50 messages rapidly from A to B and verifies
// B can sync all 50.
func TestRapidFireMessages(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("rapid"), "pass1234", "Alice")
	b := dial(t)
	b.registerAndLogin(uniqueName("rapid"), "pass1234", "Bob")

	sendOK(a, "add_friend", &pb.AddFriendRequest{FriendUid: b.uid}, &pb.AddFriendResponse{})
	sendOK(b, "accept_friend", &pb.AcceptFriendRequest{FriendUid: a.uid}, &pb.AcceptFriendResponse{})

	for i := 0; i < 50; i++ {
		a.sendText(userTarget(b.uid), fmt.Sprintf("rapid_%d", i))
	}

	// Give fanout time to complete
	time.Sleep(1 * time.Second)

	syncResp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	count := 0
	for _, m := range syncResp.GetMessages() {
		if m.GetFromUid() == a.uid {
			count++
		}
	}
	if count < 50 {
		t.Errorf("expected at least 50 messages from A, got %d", count)
	}
}
