package e2e

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSendDM(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "hello Bob",
	})
	if resp.MsgID == "" {
		t.Fatal("send_message should return msg_id")
	}
	if resp.Seq == nil {
		t.Fatal("send_message should return seq")
	}

	// B should receive messages:received notification
	notif := b.waitNotif(func(n notification) bool {
		return n.Type == "messages:received"
	})
	if notif.FromUID != a.uid {
		t.Fatalf("notification from_uid=%s, want %s", notif.FromUID, a.uid)
	}
}

func TestSendDMQuote(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgquote"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgquote"), "pass1234", "Bob")
	makeFriends(t, a, b)

	orig := a.sendOK(wsRequest{"action": "send_message", "to_uid": b.uid, "msg_type": 1, "content": "hello"})

	resp := a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 6, // MESSAGE_TYPE_QUOTE
		"body": map[string]any{"quote": map[string]any{
			"quote_msg_id":  orig.MsgID,
			"quote_preview": "hello",
			"text":          map[string]any{"text": "reply"},
		}},
	})
	if resp.MsgID == "" {
		t.Fatal("send quote message should return msg_id")
	}

	msgs := a.sendOK(wsRequest{"action": "get_messages", "to_uid": b.uid})
	// 展示序旧→新：引用消息是最新一条，取末尾。
	quote := msgs.Messages[len(msgs.Messages)-1]
	if quote.Body.Quote == nil || quote.Body.Quote.Text.Text != "reply" {
		t.Fatalf("quote body not stored correctly: %+v", quote)
	}
}

func TestSendDMMarkdown(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgmd"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgmd"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 8, // MESSAGE_TYPE_MARKDOWN
		"body":     map[string]any{"markdown": map[string]any{"markdown": "# Title"}},
	})
	if resp.MsgID == "" {
		t.Fatal("send markdown message should return msg_id")
	}
	msgs := a.sendOK(wsRequest{"action": "get_messages", "to_uid": b.uid})
	if msgs.Messages[0].Body.Markdown == nil || msgs.Messages[0].Body.Markdown.Markdown != "# Title" {
		t.Fatalf("markdown body not stored correctly: %+v", msgs.Messages[0])
	}
}

func TestSendDMForwardExceedsLimit(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgfwdlimit"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgfwdlimit"), "pass1234", "Bob")
	makeFriends(t, a, b)

	ids := make([]string, 0, 21)
	for i := 0; i < 21; i++ {
		ids = append(ids, fmt.Sprintf("%d", i+1))
	}
	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 7, // MESSAGE_TYPE_FORWARD
		"body":     map[string]any{"forward": map[string]any{"msg_ids": ids, "title": "x"}},
	})
	if resp.OK {
		t.Fatal("forward items exceed limit should fail")
	}
}

func TestSendMsgTypeBodyMismatch(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgmismatch"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgmismatch"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// msg_type=IMAGE(2) 但 body 是 text → 必须返回 INVALID_ARGUMENT。
	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 2,
		"body":     map[string]any{"text": map[string]any{"text": "not an image"}},
	})
	if resp.OK {
		t.Fatal("msg_type/body.kind mismatch should fail")
	}
}

func TestSendEmptyBody(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgempty"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgempty"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// 缺失 body → INVALID_ARGUMENT。
	resp := a.send(wsRequest{"action": "send_message", "to_uid": b.uid, "msg_type": 1})
	if resp.OK {
		t.Fatal("missing body should fail")
	}
}

func TestSendDMTextTooLong(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msglen"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msglen"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  strings.Repeat("x", 4097),
	})
	if resp.OK {
		t.Fatal("send_message with too long content should fail")
	}
}

func TestSendDMToSelf(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")

	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   a.uid,
		"msg_type": 1,
		"content":  "note to self",
	})
	if resp.OK {
		t.Fatal("send_message to self should fail")
	}
	if resp.Error != "不能给自己发送消息" {
		t.Fatalf("send_message to self error=%q, want 不能给自己发送消息", resp.Error)
	}
}

// TestSendToNonFriendSucceeds 验证私聊不再要求好友关系：可以向陌生人发起临时会话。
func TestSendToNonFriendSucceeds(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")

	resp := a.send(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "hi stranger",
	})
	if !resp.OK {
		t.Fatalf("send_message to non-friend should succeed as temporary session, got error: %s", resp.Error)
	}
}

func TestSyncMessages(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// Send 3 DMs from A to B
	for i := 0; i < 3; i++ {
		a.sendOK(wsRequest{
			"action":   "send_message",
			"to_uid":   b.uid,
			"msg_type": 1,
			"content":  fmt.Sprintf("msg_%d", i),
		})
	}

	time.Sleep(200 * time.Millisecond)

	// B syncs all messages
	resp := b.sendOK(wsRequest{
		"action":   "sync_messages",
		"last_seq": 0,
	})
	if len(resp.Messages) < 3 {
		t.Fatalf("expected at least 3 messages, got %d", len(resp.Messages))
	}

	// Verify messages are from A
	for _, m := range resp.Messages {
		if m.FromUID != a.uid {
			t.Errorf("message from_uid=%s, want %s", m.FromUID, a.uid)
		}
	}
}

func TestSyncMessagesPageBoundaries(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgsync"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgsync"), "pass1234", "Bob")
	makeFriends(t, a, b)

	for i := 1; i <= 5; i++ {
		a.sendOK(wsRequest{
			"action":   "send_message",
			"to_uid":   b.uid,
			"msg_type": 1,
			"content":  fmt.Sprintf("sync_boundary_%d", i),
		})
	}
	time.Sleep(200 * time.Millisecond)

	firstPage := b.sendOK(wsRequest{
		"action":   "sync_messages",
		"last_seq": 0,
		"limit":    2,
	})
	if len(firstPage.Messages) != 2 {
		t.Fatalf("first sync page got %d messages, want 2: %+v", len(firstPage.Messages), firstPage.Messages)
	}
	if firstPage.Messages[0].Seq != 1 || firstPage.Messages[1].Seq != 2 {
		t.Fatalf("first sync page seq = %d,%d; want 1,2", firstPage.Messages[0].Seq, firstPage.Messages[1].Seq)
	}
	// 还有更多：has_more=true，cursor_seq=本页最大 seq=2。
	if !hasMoreVal(firstPage.HasMore) {
		t.Fatalf("first sync page has_more = %v, want true", firstPage.HasMore)
	}
	if cursorSeqVal(firstPage.CursorSeq) != 2 {
		t.Fatalf("first sync page cursor_seq = %v, want 2", firstPage.CursorSeq)
	}

	secondPage := b.sendOK(wsRequest{
		"action":   "sync_messages",
		"last_seq": cursorSeqVal(firstPage.CursorSeq),
		"limit":    2,
	})
	if len(secondPage.Messages) != 2 {
		t.Fatalf("second sync page got %d messages, want 2: %+v", len(secondPage.Messages), secondPage.Messages)
	}
	if secondPage.Messages[0].Seq != 3 || secondPage.Messages[1].Seq != 4 {
		t.Fatalf("second sync page seq = %d,%d; want 3,4", secondPage.Messages[0].Seq, secondPage.Messages[1].Seq)
	}
	if !hasMoreVal(secondPage.HasMore) {
		t.Fatalf("second sync page has_more = %v, want true", secondPage.HasMore)
	}
	if cursorSeqVal(secondPage.CursorSeq) != 4 {
		t.Fatalf("second sync page cursor_seq = %v, want 4", secondPage.CursorSeq)
	}

	tailPage := b.sendOK(wsRequest{
		"action":   "sync_messages",
		"last_seq": cursorSeqVal(secondPage.CursorSeq),
		"limit":    2,
	})
	if len(tailPage.Messages) != 1 || tailPage.Messages[0].Seq != 5 {
		t.Fatalf("tail sync page = %+v, want only seq 5", tailPage.Messages)
	}
	// 最后一页：has_more=false，cursor_seq=5。
	if hasMoreVal(tailPage.HasMore) {
		t.Fatalf("tail sync page has_more = %v, want false", tailPage.HasMore)
	}
	if cursorSeqVal(tailPage.CursorSeq) != 5 {
		t.Fatalf("tail sync page cursor_seq = %v, want 5", tailPage.CursorSeq)
	}

	emptyPage := b.sendOK(wsRequest{
		"action":   "sync_messages",
		"last_seq": cursorSeqVal(tailPage.CursorSeq),
		"limit":    2,
	})
	if len(emptyPage.Messages) != 0 {
		t.Fatalf("empty sync page got %+v, want no messages", emptyPage.Messages)
	}
	// 空批：has_more=false，cursor_seq=0。
	if hasMoreVal(emptyPage.HasMore) {
		t.Fatalf("empty sync page has_more = %v, want false", emptyPage.HasMore)
	}
	if cursorSeqVal(emptyPage.CursorSeq) != 0 {
		t.Fatalf("empty sync page cursor_seq = %v, want 0", emptyPage.CursorSeq)
	}
}

func TestListConversations(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)
	makeFriends(t, a, b)
	makeFriends(t, a, b)

	// Exchange a DM
	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "hello",
	})

	time.Sleep(200 * time.Millisecond)

	// A should have a conversation with B
	aResp := a.sendOK(wsRequest{"action": "get_conversations"})
	foundA := false
	for _, conv := range aResp.Conversations {
		if conv.FriendUID == b.uid {
			foundA = true
		}
	}
	if !foundA {
		t.Fatalf("A should see conversation with B, got: %+v", aResp.Conversations)
	}

	// B should have a conversation with A
	bResp := b.sendOK(wsRequest{"action": "get_conversations"})
	foundB := false
	for _, conv := range bResp.Conversations {
		if conv.FriendUID == a.uid {
			foundB = true
		}
	}
	if !foundB {
		t.Fatalf("B should see conversation with A, got: %+v", bResp.Conversations)
	}
}

func TestUnreadCountInConversationPage(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "unread test",
	})

	time.Sleep(200 * time.Millisecond)

	// Sender (A) should have no unread count.
	aCountResp := a.sendOK(wsRequest{"action": "get_unread_count"})
	if aCountResp.UnreadCount != 0 {
		t.Errorf("sender unread_count = %d, want 0", aCountResp.UnreadCount)
	}

	// Receiver (B) should have unread count both globally and in the page item.
	bCountResp := b.sendOK(wsRequest{"action": "get_unread_count"})
	if bCountResp.UnreadCount <= 0 {
		t.Errorf("receiver unread_count = %d, want >0", bCountResp.UnreadCount)
	}
	bResp := b.sendOK(wsRequest{"action": "get_conversations"})
	foundUnread := false
	for _, conv := range bResp.Conversations {
		if conv.FriendUID == a.uid {
			if conv.UnreadCount <= 0 {
				t.Errorf("receiver conversation unread_count = %d, want >0", conv.UnreadCount)
			}
			foundUnread = true
		}
	}
	if !foundUnread {
		t.Fatal("B should have conversation with A carrying unread_count")
	}
}

func TestListConversationMessages(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// Send a few messages
	for i := 0; i < 3; i++ {
		a.sendOK(wsRequest{
			"action":   "send_message",
			"to_uid":   b.uid,
			"msg_type": 1,
			"content":  fmt.Sprintf("conv_msg_%d", i),
		})
	}

	time.Sleep(200 * time.Millisecond)

	// B reads conversation messages with A
	resp := b.sendOK(wsRequest{
		"action": "get_messages",
		"to_uid": a.uid,
	})
	if len(resp.Messages) < 3 {
		t.Fatalf("expected at least 3 conversation messages, got %d", len(resp.Messages))
	}
}

func TestListConversationMessagesPagination(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// Send 30 messages
	for i := 0; i < 30; i++ {
		a.sendOK(wsRequest{
			"action":   "send_message",
			"to_uid":   b.uid,
			"msg_type": 1,
			"content":  fmt.Sprintf("page_msg_%d", i),
		})
	}

	time.Sleep(200 * time.Millisecond)

	// 首页取最新一页：空游标 + BACKWARD（消息展示序旧→新，列表尾为最新）。
	resp1 := b.sendOK(wsRequest{
		"action": "get_messages",
		"to_uid": a.uid,
		"page":   wsRequest{"limit": 10, "direction": "PAGE_DIRECTION_BACKWARD"},
	})
	if len(resp1.Messages) != 10 {
		t.Fatalf("expected 10 messages in first page, got %d", len(resp1.Messages))
	}

	// 次页取更旧：继续 BACKWARD，用上一页 start_cursor。
	resp2 := b.sendOK(wsRequest{
		"action": "get_messages",
		"to_uid": a.uid,
		"page":   wsRequest{"limit": 10, "cursor": pageOf(&resp1).StartCursor, "direction": "PAGE_DIRECTION_BACKWARD"},
	})
	if len(resp2.Messages) != 10 {
		t.Fatalf("expected 10 messages in second page, got %d", len(resp2.Messages))
	}

	// Ensure no overlap
	seen := make(map[string]bool)
	for _, m := range resp1.Messages {
		seen[m.MsgID] = true
	}
	for _, m := range resp2.Messages {
		if seen[m.MsgID] {
			t.Fatalf("duplicate message %s across pages", m.MsgID)
		}
	}
}

func TestClearUnread(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "read me",
	})

	time.Sleep(200 * time.Millisecond)

	// Verify B has unread>0 before clear_unread.
	bUnread := b.sendOK(wsRequest{"action": "get_unread_count"})
	if bUnread.UnreadCount <= 0 {
		t.Fatal("B should have unread>0 before clear_unread")
	}

	// Open second device for B to check conversations:clearunread notification
	b2 := dial(t)
	b2.authenticate(b.token)

	// B marks read
	b.sendOK(wsRequest{
		"action": "clear_unread",
		"to_uid": a.uid,
	})

	// Other device (b2) should get conversations:clearunread notification
	b2.waitNotif(func(n notification) bool {
		return n.Type == "conversations:clearunread"
	})

	// Verify unread is now 0.
	bUnread2 := b.sendOK(wsRequest{"action": "get_unread_count"})
	if bUnread2.UnreadCount != 0 {
		t.Errorf("B unread_count = %d after clear_unread, want 0", bUnread2.UnreadCount)
	}
}
