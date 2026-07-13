package e2e

import (
	"fmt"
	"strings"
	"testing"
	"time"
	"yimsg/internal/appmsg"
	"yimsg/internal/msgid"
	"yimsg/internal/protocol/pb"
)

func TestSendDM(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := a.sendText(userTarget(b.uid), "hello Bob")
	if resp.GetMsgId() == "" {
		t.Fatal("send_message should return msg_id")
	}
	if resp.GetSeq() == 0 {
		t.Fatal("send_message should return seq")
	}

	// B should receive messages:received notification
	notif := b.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "messages:received"
	})
	if notifUID(notif) != a.uid {
		t.Fatalf("notification from_uid=%d, want %d", notifUID(notif), a.uid)
	}
}

func TestSendDMQuote(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgquote"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgquote"), "pass1234", "Bob")
	makeFriends(t, a, b)

	orig := a.sendText(userTarget(b.uid), "hello")

	resp := a.sendMsg(userTarget(b.uid), pb.MessageType_MESSAGE_TYPE_QUOTE, &pb.MessageBody{Kind: &pb.MessageBody_Quote{Quote: &pb.QuoteBody{
		QuoteMsgId: orig.GetMsgId(), QuotePreview: "hello", Text: &pb.TextBody{Text: "reply"},
	}}})
	if resp.GetMsgId() == "" {
		t.Fatal("send quote message should return msg_id")
	}

	msgs := sendOK(a, "get_messages", &pb.GetMessagesRequest{Target: userTarget(b.uid)}, &pb.GetMessagesResponse{})
	// 展示序旧→新：引用消息是最新一条，取末尾。
	quote := msgs.GetMessages()[len(msgs.GetMessages())-1]
	qb := quote.GetBody().GetQuote()
	if qb == nil || qb.GetText().GetText() != "reply" {
		t.Fatalf("quote body not stored correctly: %+v", quote)
	}
}

func TestSendDMMarkdown(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgmd"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgmd"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := a.sendMsg(userTarget(b.uid), pb.MessageType_MESSAGE_TYPE_MARKDOWN, markdownBody("# Title"))
	if resp.GetMsgId() == "" {
		t.Fatal("send markdown message should return msg_id")
	}
	msgs := sendOK(a, "get_messages", &pb.GetMessagesRequest{Target: userTarget(b.uid)}, &pb.GetMessagesResponse{})
	md := msgs.GetMessages()[0].GetBody().GetMarkdown()
	if md == nil || md.GetMarkdown() != "# Title" {
		t.Fatalf("markdown body not stored correctly: %+v", msgs.GetMessages()[0])
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
	sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_FORWARD,
		Body: &pb.MessageBody{Kind: &pb.MessageBody_Forward{Forward: &pb.ForwardBody{MsgIds: ids, Title: "x"}}},
	}, &pb.SendMessageResponse{})
}

func TestSendMsgTypeBodyMismatch(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgmismatch"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgmismatch"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// msg_type=IMAGE(2) 但 body 是 text → 必须返回 INVALID_ARGUMENT。
	sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_IMAGE, Body: textBody("not an image"),
	}, &pb.SendMessageResponse{})
}

func TestSendEmptyBody(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msgempty"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msgempty"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// 缺失 body → INVALID_ARGUMENT。
	sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT,
	}, &pb.SendMessageResponse{})
}

func TestSendDMTextTooLong(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msglen"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msglen"), "pass1234", "Bob")
	makeFriends(t, a, b)

	sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody(strings.Repeat("x", 4097)),
	}, &pb.SendMessageResponse{})
}

func TestSendDMToSelf(t *testing.T) {
	a := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")

	resp := sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(a.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("note to self"),
	}, &pb.SendMessageResponse{})
	if resp.GetBase().GetMsg() != "不能给自己发送消息" {
		t.Fatalf("send_message to self error=%q, want 不能给自己发送消息", resp.GetBase().GetMsg())
	}
}

// TestSendToNonFriendSucceeds 验证私聊不再要求好友关系：可以向陌生人发起临时会话。
func TestSendToNonFriendSucceeds(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")

	resp := send(a, "send_message", &pb.SendMessageRequest{
		MsgId: msgid.Generate(), Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("hi stranger"),
	}, &pb.SendMessageResponse{})
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("send_message to non-friend should succeed as temporary session, got error: %s", resp.GetBase().GetMsg())
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
		a.sendText(userTarget(b.uid), fmt.Sprintf("msg_%d", i))
	}

	time.Sleep(200 * time.Millisecond)

	// B syncs all messages
	resp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0}, &pb.SyncMessagesResponse{})
	if len(resp.GetMessages()) < 3 {
		t.Fatalf("expected at least 3 messages, got %d", len(resp.GetMessages()))
	}

	// Verify messages are from A
	for _, m := range resp.GetMessages() {
		if m.GetFromUid() != a.uid {
			t.Errorf("message from_uid=%d, want %d", m.GetFromUid(), a.uid)
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
		a.sendText(userTarget(b.uid), fmt.Sprintf("sync_boundary_%d", i))
	}
	time.Sleep(200 * time.Millisecond)

	firstPage := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: 0, Limit: 2}, &pb.SyncMessagesResponse{})
	if len(firstPage.GetMessages()) != 2 {
		t.Fatalf("first sync page got %d messages, want 2: %+v", len(firstPage.GetMessages()), firstPage.GetMessages())
	}
	if firstPage.GetMessages()[0].GetSeq() != 1 || firstPage.GetMessages()[1].GetSeq() != 2 {
		t.Fatalf("first sync page seq = %d,%d; want 1,2", firstPage.GetMessages()[0].GetSeq(), firstPage.GetMessages()[1].GetSeq())
	}
	// 还有更多：has_more=true，cursor_seq=本页最大 seq=2。
	if !firstPage.GetHasMore() {
		t.Fatalf("first sync page has_more = %v, want true", firstPage.GetHasMore())
	}
	if firstPage.GetCursorSeq() != 2 {
		t.Fatalf("first sync page cursor_seq = %v, want 2", firstPage.GetCursorSeq())
	}

	secondPage := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: firstPage.GetCursorSeq(), Limit: 2}, &pb.SyncMessagesResponse{})
	if len(secondPage.GetMessages()) != 2 {
		t.Fatalf("second sync page got %d messages, want 2: %+v", len(secondPage.GetMessages()), secondPage.GetMessages())
	}
	if secondPage.GetMessages()[0].GetSeq() != 3 || secondPage.GetMessages()[1].GetSeq() != 4 {
		t.Fatalf("second sync page seq = %d,%d; want 3,4", secondPage.GetMessages()[0].GetSeq(), secondPage.GetMessages()[1].GetSeq())
	}
	if !secondPage.GetHasMore() {
		t.Fatalf("second sync page has_more = %v, want true", secondPage.GetHasMore())
	}
	if secondPage.GetCursorSeq() != 4 {
		t.Fatalf("second sync page cursor_seq = %v, want 4", secondPage.GetCursorSeq())
	}

	tailPage := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: secondPage.GetCursorSeq(), Limit: 2}, &pb.SyncMessagesResponse{})
	if len(tailPage.GetMessages()) != 1 || tailPage.GetMessages()[0].GetSeq() != 5 {
		t.Fatalf("tail sync page = %+v, want only seq 5", tailPage.GetMessages())
	}
	// 最后一页：has_more=false，cursor_seq=5。
	if tailPage.GetHasMore() {
		t.Fatalf("tail sync page has_more = %v, want false", tailPage.GetHasMore())
	}
	if tailPage.GetCursorSeq() != 5 {
		t.Fatalf("tail sync page cursor_seq = %v, want 5", tailPage.GetCursorSeq())
	}

	emptyPage := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: tailPage.GetCursorSeq(), Limit: 2}, &pb.SyncMessagesResponse{})
	if len(emptyPage.GetMessages()) != 0 {
		t.Fatalf("empty sync page got %+v, want no messages", emptyPage.GetMessages())
	}
	// 空批：has_more=false，cursor_seq=0。
	if emptyPage.GetHasMore() {
		t.Fatalf("empty sync page has_more = %v, want false", emptyPage.GetHasMore())
	}
	if emptyPage.GetCursorSeq() != 0 {
		t.Fatalf("empty sync page cursor_seq = %v, want 0", emptyPage.GetCursorSeq())
	}
}

func TestListConversations(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// Exchange a DM
	a.sendText(userTarget(b.uid), "hello")

	time.Sleep(200 * time.Millisecond)

	// A should have a conversation with B
	aResp := sendOK(a, "get_conversations", &pb.GetConversationsRequest{}, &pb.GetConversationsResponse{})
	foundA := false
	for _, conv := range aResp.GetConversations() {
		if conv.GetTarget().GetUid() == b.uid {
			foundA = true
		}
	}
	if !foundA {
		t.Fatalf("A should see conversation with B, got: %+v", aResp.GetConversations())
	}

	// B should have a conversation with A
	bResp := sendOK(b, "get_conversations", &pb.GetConversationsRequest{}, &pb.GetConversationsResponse{})
	foundB := false
	for _, conv := range bResp.GetConversations() {
		if conv.GetTarget().GetUid() == a.uid {
			foundB = true
		}
	}
	if !foundB {
		t.Fatalf("B should see conversation with A, got: %+v", bResp.GetConversations())
	}
}

func TestUnreadCountInConversationPage(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	a.sendText(userTarget(b.uid), "unread test")

	time.Sleep(200 * time.Millisecond)

	// Sender (A) should have no unread count.
	aCountResp := sendOK(a, "get_unread_count", &pb.GetUnreadCountRequest{}, &pb.GetUnreadCountResponse{})
	if aCountResp.GetUnreadCount() != 0 {
		t.Errorf("sender unread_count = %d, want 0", aCountResp.GetUnreadCount())
	}

	// Receiver (B) should have unread count both globally and in the page item.
	bCountResp := sendOK(b, "get_unread_count", &pb.GetUnreadCountRequest{}, &pb.GetUnreadCountResponse{})
	if bCountResp.GetUnreadCount() <= 0 {
		t.Errorf("receiver unread_count = %d, want >0", bCountResp.GetUnreadCount())
	}
	bResp := sendOK(b, "get_conversations", &pb.GetConversationsRequest{}, &pb.GetConversationsResponse{})
	foundUnread := false
	for _, conv := range bResp.GetConversations() {
		if conv.GetTarget().GetUid() == a.uid {
			if conv.GetUnreadCount() <= 0 {
				t.Errorf("receiver conversation unread_count = %d, want >0", conv.GetUnreadCount())
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
		a.sendText(userTarget(b.uid), fmt.Sprintf("conv_msg_%d", i))
	}

	time.Sleep(200 * time.Millisecond)

	// B reads conversation messages with A
	resp := sendOK(b, "get_messages", &pb.GetMessagesRequest{Target: userTarget(a.uid)}, &pb.GetMessagesResponse{})
	if len(resp.GetMessages()) < 3 {
		t.Fatalf("expected at least 3 conversation messages, got %d", len(resp.GetMessages()))
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
		a.sendText(userTarget(b.uid), fmt.Sprintf("page_msg_%d", i))
	}

	time.Sleep(200 * time.Millisecond)

	// 首页取最新一页：空游标 + BACKWARD（消息展示序旧→新，列表尾为最新）。
	resp1 := sendOK(b, "get_messages", &pb.GetMessagesRequest{
		Target: userTarget(a.uid), Page: &pb.PageQuery{Limit: 10, Direction: pb.PageDirection_PAGE_DIRECTION_BACKWARD},
	}, &pb.GetMessagesResponse{})
	if len(resp1.GetMessages()) != 10 {
		t.Fatalf("expected 10 messages in first page, got %d", len(resp1.GetMessages()))
	}

	// 次页取更旧：继续 BACKWARD，用上一页 start_cursor。
	resp2 := sendOK(b, "get_messages", &pb.GetMessagesRequest{
		Target: userTarget(a.uid), Page: &pb.PageQuery{Limit: 10, Cursor: resp1.GetPage().GetStartCursor(), Direction: pb.PageDirection_PAGE_DIRECTION_BACKWARD},
	}, &pb.GetMessagesResponse{})
	if len(resp2.GetMessages()) != 10 {
		t.Fatalf("expected 10 messages in second page, got %d", len(resp2.GetMessages()))
	}

	// Ensure no overlap
	seen := make(map[string]bool)
	for _, m := range resp1.GetMessages() {
		seen[m.GetMsgId()] = true
	}
	for _, m := range resp2.GetMessages() {
		if seen[m.GetMsgId()] {
			t.Fatalf("duplicate message %s across pages", m.GetMsgId())
		}
	}
}

func TestClearUnread(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("msg"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("msg"), "pass1234", "Bob")
	makeFriends(t, a, b)

	a.sendText(userTarget(b.uid), "read me")

	time.Sleep(200 * time.Millisecond)

	// Verify B has unread>0 before clear_unread.
	bUnread := sendOK(b, "get_unread_count", &pb.GetUnreadCountRequest{}, &pb.GetUnreadCountResponse{})
	if bUnread.GetUnreadCount() <= 0 {
		t.Fatal("B should have unread>0 before clear_unread")
	}

	// Open second device for B to check conversations:clearunread notification
	b2 := dial(t)
	b2.authenticate(b.token)

	// B marks read
	sendOK(b, "clear_unread", &pb.ClearUnreadRequest{Target: userTarget(a.uid)}, &pb.ClearUnreadResponse{})

	// Other device (b2) should get conversations:clearunread notification
	b2.waitNotif(func(n *appmsg.Notification) bool {
		return n.Type == "conversations:clearunread"
	})

	// Verify unread is now 0.
	bUnread2 := sendOK(b, "get_unread_count", &pb.GetUnreadCountRequest{}, &pb.GetUnreadCountResponse{})
	if bUnread2.GetUnreadCount() != 0 {
		t.Errorf("B unread_count = %d after clear_unread, want 0", bUnread2.GetUnreadCount())
	}
}
