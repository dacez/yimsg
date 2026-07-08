package service

import (
	"fmt"
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
)

func TestSendDM(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	req := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hello"}
	result := sendMessageService(s, "r1", uidA, req)
	if !result.Response.OK {
		t.Fatalf("send_message failed: %s", result.Response.Error)
	}
	if result.Response.MsgID == nil {
		t.Error("msg_id should not be nil")
	}
	if result.Response.Seq == nil || *result.Response.Seq <= 0 {
		t.Error("sender seq should be positive")
	}

	// Both inboxes should have the message
	senderStore := s.MessageStore(uidA)
	senderMsgs, _ := senderStore.ListByConversation(uidA, uidB, 0, 0, 100)
	if len(senderMsgs) == 0 {
		t.Error("sender inbox should have message")
	}

	rcptStore := s.MessageStore(uidB)
	rcptMsgs, _ := rcptStore.ListByConversation(uidB, uidA, 0, 0, 100)
	if len(rcptMsgs) == 0 {
		t.Error("recipient inbox should have message")
	}
}

// TestGetConversationsByTargets 验证 get_conversations 的 targets 定向读取：
// 只返回请求目标中仍活跃的会话，缺失/已删除目标不返回。
func TestGetConversationsByTargets(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	makeFriends(t, s, uidA, uidB)
	makeFriends(t, s, uidA, uidC)
	sendMessageService(s, "1", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hi b"})
	sendMessageService(s, "2", uidA, &appmsg.Request{ToUID: i64json(uidC), MsgType: dal.MsgText, Content: "hi c"})

	// 请求 B 与不存在的群 999 → 只返回 B。
	resp := getConversationsByTargetsService(s, uidA, testTarget(uidB, 0), testTarget(0, 999))
	if !resp.OK {
		t.Fatalf("get by targets failed: %s", resp.Error)
	}
	if len(resp.Conversations) != 1 || targetUID(resp.Conversations[0].Target) != uidB {
		t.Fatalf("targets result = %+v, want only B", resp.Conversations)
	}

	// 删除会话后定向拉取返回空（客户端据此从数据窗口移除）。
	deleteConversationService(s, "del", uidA, uidB, 0)
	resp = getConversationsByTargetsService(s, uidA, testTarget(uidB, 0))
	if !resp.OK || len(resp.Conversations) != 0 {
		t.Fatalf("deleted conversation should not be returned: %+v", resp.Conversations)
	}
}

func TestDeleteMessageWritesTombstoneAndNotifiesSelf(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendResp := sendMessageService(s, "send", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hello"})
	if !sendResp.Response.OK || sendResp.Response.MsgID == nil || sendResp.Response.Seq == nil {
		t.Fatalf("send failed: %+v", sendResp.Response)
	}
	msgID := *sendResp.Response.MsgID
	oldSeq := *sendResp.Response.Seq

	conn := s.Online().Register(uidA, "")
	defer s.Online().Unregister(uidA, conn)

	deleteResp := deleteMessageService(s, "delete", uidA, &appmsg.Request{MsgID: msgID})
	if !deleteResp.OK || deleteResp.Seq == nil {
		t.Fatalf("delete_message failed: %+v", deleteResp)
	}
	if *deleteResp.Seq <= oldSeq {
		t.Fatalf("delete seq = %d, want > %d", *deleteResp.Seq, oldSeq)
	}

	visible, err := s.MessageStore(uidA).ListByConversation(uidA, uidB, 0, 0, 100)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(visible) != 0 {
		t.Fatalf("deleted message should be hidden: %+v", visible)
	}

	synced, err := s.MessageStore(uidA).Sync(uidA, oldSeq, 100)
	if err != nil {
		t.Fatalf("sync messages: %v", err)
	}
	if len(synced) != 1 || synced[0].MsgID != msgID || synced[0].Status != dal.MessageDeleted {
		t.Fatalf("message tombstone sync = %+v", synced)
	}

	select {
	case msg := <-conn.Ch:
		if msg == nil {
			t.Error("notification should not be empty")
		}
	default:
		t.Error("caller devices should receive messages:delete notification")
	}
}

func TestDeleteConversationWritesTombstoneAndNotifiesSelf(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendResp := sendMessageService(s, "send", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hello"})
	if !sendResp.Response.OK || sendResp.Response.Seq == nil {
		t.Fatalf("send failed: %+v", sendResp.Response)
	}
	oldSeq := *sendResp.Response.Seq

	conn := s.Online().Register(uidA, "")
	defer s.Online().Unregister(uidA, conn)

	deleteResp := deleteConversationService(s, "delete-conv", uidA, uidB, 0)
	if !deleteResp.OK || deleteResp.Seq == nil {
		t.Fatalf("delete_conversation failed: %+v", deleteResp)
	}
	if *deleteResp.Seq <= oldSeq {
		t.Fatalf("delete conversation seq = %d, want > %d", *deleteResp.Seq, oldSeq)
	}

	convs, err := s.ConversationStore(uidA).List(uidA, 0, 0, 100)
	if err != nil {
		t.Fatalf("list conversations: %v", err)
	}
	if len(convs) != 0 {
		t.Fatalf("deleted conversation should be hidden: %+v", convs)
	}

	synced, err := s.ConversationStore(uidA).Sync(uidA, oldSeq, 100)
	if err != nil {
		t.Fatalf("sync conversations: %v", err)
	}
	if len(synced) != 1 || synced[0].ToUID != uidB || synced[0].Status != dal.ConversationDeleted {
		t.Fatalf("conversation tombstone sync = %+v", synced)
	}

	select {
	case msg := <-conn.Ch:
		if msg == nil {
			t.Error("notification should not be empty")
		}
	default:
		t.Error("caller devices should receive conversations:delete notification")
	}
}

func TestSendDMNotifiesReceiver(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	conn := s.Online().Register(uidB, "")
	defer s.Online().Unregister(uidB, conn)

	req := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hi"}
	sendMessageService(s, "r1", uidA, req)

	select {
	case msg := <-conn.Ch:
		if msg == nil {
			t.Error("notification should not be empty")
		}
	default:
		t.Error("bob should receive messages:received notification")
	}
}

func TestSendGroupMessageFanout(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB, uidC})
	groupID := int64(*groupResp.GroupIDResp)

	req := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group msg"}
	result := sendMessageService(s, "r2", uidA, req)
	if !result.Response.OK {
		t.Fatalf("send group msg failed: %s", result.Response.Error)
	}

	// Execute fanout synchronously for testing
	drainTasks(s)

	// All members should have the message
	for _, uid := range []int64{uidA, uidB, uidC} {
		store := s.MessageStore(uid)
		msgs, _ := store.ListByConversation(uid, 0, groupID, 0, 100)
		found := false
		for _, m := range msgs {
			if dalText(m) == "group msg" {
				found = true
			}
		}
		if !found {
			t.Errorf("uid %d inbox should have group message", uid)
		}
	}
}

func TestOwnDMDoesNotClearExistingUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	for i := 0; i < 2; i++ {
		sendMessageService(s, "bob-send", uidB, &appmsg.Request{ToUID: i64json(uidA), MsgType: dal.MsgText, Content: fmt.Sprintf("from-bob-%d", i)})
	}
	sendMessageService(s, "alice-reply", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "reply"})

	resp := getUnreadCountService(s, "unread", uidA)
	if !resp.OK || resp.UnreadCount == nil {
		t.Fatalf("GetUnreadCount failed: %+v", resp)
	}
	if *resp.UnreadCount != 2 {
		t.Fatalf("unread count after own DM = %d, want 2", *resp.UnreadCount)
	}
}

func TestOwnGroupMessageDoesNotClearExistingUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	uidD := registerUser(t, s, "dave", "p", "Dave")

	groupResp := createGroupService(s, "create", uidA, "G", []int64{uidA, uidB, uidC, uidD})
	groupID := int64(*groupResp.GroupIDResp)
	drainTasks(s) // 建群系统消息异步投递，先落地再清未读
	clearUnreadService(s, "read-created", uidA, 0, groupID)
	sendGroup := func(label string, fromUID int64, content string) {
		t.Helper()
		result := sendMessageService(s, label, fromUID, &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: content})
		if !result.Response.OK {
			t.Fatalf("send group %s failed: %s", content, result.Response.Error)
		}
		drainTasks(s)
	}

	sendGroup("a1", uidA, "a1")
	sendGroup("b1", uidB, "b1")
	sendGroup("c1", uidC, "c1")
	sendGroup("d1", uidD, "d1")
	sendGroup("a2", uidA, "a2")
	sendGroup("b2", uidB, "b2")
	sendGroup("c2", uidC, "c2")
	sendGroup("d2", uidD, "d2")

	resp := getUnreadCountService(s, "unread", uidA)
	if !resp.OK || resp.UnreadCount == nil {
		t.Fatalf("GetUnreadCount failed: %+v", resp)
	}
	if *resp.UnreadCount != 6 {
		t.Fatalf("unread count after own group messages = %d, want 6", *resp.UnreadCount)
	}
}

func TestSendGroupMessageNonMember(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*groupResp.GroupIDResp)

	req := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "hi"}
	result := sendMessageService(s, "r2", uidC, req)
	if result.Response.OK {
		t.Error("non-member should not be able to send")
	}
	if result.Response.Error != "非群员" {
		t.Errorf("got error %q", result.Response.Error)
	}
}

// TestSendDMWithoutFriendSucceeds 验证私聊不再要求好友关系：陌生人之间可以发起临时会话。
func TestSendDMWithoutFriendSucceeds(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	req := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hi"}
	result := sendMessageService(s, "r1", uidA, req)
	if !result.Response.OK {
		t.Fatalf("non-friend dm should succeed as temporary session, got error: %s", result.Response.Error)
	}
}

// TestSendDMToSelfRejected 验证不能给自己发送私聊消息。
func TestSendDMToSelfRejected(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")

	req := &appmsg.Request{ToUID: i64json(uidA), MsgType: dal.MsgText, Content: "note to self"}
	result := sendMessageService(s, "r1", uidA, req)
	if result.Response.OK {
		t.Fatal("send dm to self should fail")
	}
	if result.Response.Error != "不能给自己发送消息" {
		t.Fatalf("error = %q, want 不能给自己发送消息", result.Response.Error)
	}
}

func TestSendGroupMessageNotifiesOthers(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*groupResp.GroupIDResp)

	connB := s.Online().Register(uidB, "")
	defer s.Online().Unregister(uidB, connB)

	// Drain any existing notifications from group creation
	for len(connB.Ch) > 0 {
		<-connB.Ch
	}

	req := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "msg"}
	sendMessageService(s, "r2", uidA, req)
	drainTasks(s)

	select {
	case msg := <-connB.Ch:
		if msg == nil {
			t.Error("notification should not be empty")
		}
	default:
		t.Error("bob should receive messages:received notification for group")
	}
}

func TestListConversationsMixed(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	makeFriends(t, s, uidA, uidB)
	makeFriends(t, s, uidA, uidC)

	// DM from A→B
	req := &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "dm"}
	sendMessageService(s, "r1", uidA, req)

	// Group message
	groupResp := createGroupService(s, "r2", uidA, "G", []int64{uidA, uidB, uidC})
	groupID := int64(*groupResp.GroupIDResp)
	gReq := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group"}
	sendMessageService(s, "r3", uidA, gReq)
	drainTasks(s)

	resp := listConversationsService(s, "r4", uidA, "", 200)
	if !resp.OK {
		t.Fatalf("get_conversations failed: %s", resp.Error)
	}
	if len(resp.Conversations) < 2 {
		t.Errorf("expected at least 2 conversations, got %d", len(resp.Conversations))
	}

	hasDM := false
	hasGroup := false
	for _, c := range resp.Conversations {
		if targetGroupID(c.Target) == 0 && targetUID(c.Target) == uidB {
			hasDM = true
		}
		if targetGroupID(c.Target) == groupID {
			hasGroup = true
		}
	}
	if !hasDM {
		t.Error("should have DM conversation with bob")
	}
	if !hasGroup {
		t.Error("should have group conversation")
	}
}

func TestListByConversationDMService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	makeFriends(t, s, uidA, uidB)
	makeFriends(t, s, uidA, uidC)

	// DM to bob
	sendMessageService(s, "r1", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "to bob"})
	// DM to carol
	sendMessageService(s, "r2", uidA, &appmsg.Request{ToUID: i64json(uidC), MsgType: dal.MsgText, Content: "to carol"})

	// Read only bob conversation
	listReq := &appmsg.Request{ToUID: i64json(uidB)}
	resp := listByConversationService(s, "r3", uidA, listReq)
	if !resp.OK {
		t.Fatalf("read failed: %s", resp.Error)
	}
	for _, m := range resp.Messages {
		if bodyText(m) == "to carol" {
			t.Error("should not include carol's messages")
		}
	}
}

func TestListByConversationAfterSeqService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	for i := 1; i <= 5; i++ {
		sendMessageService(s, "send", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: fmt.Sprintf("msg-%d", i)})
	}

	resp := listByConversationService(s, "list", uidA, &appmsg.Request{ToUID: i64json(uidB), AfterSeq: 2, Limit: 2})
	if !resp.OK {
		t.Fatalf("read failed: %s", resp.Error)
	}
	if len(resp.Messages) != 2 {
		t.Fatalf("got %d messages, want 2", len(resp.Messages))
	}
	// 展示序为旧→新（ascTop）：after_seq=2、limit=2 取最近两条更新消息 seq 3、4，升序返回。
	if resp.Messages[0].Seq != 3 || resp.Messages[1].Seq != 4 {
		t.Fatalf("unexpected after_seq page: %+v", resp.Messages)
	}
}

func TestSyncConversationsAllowsGapsAfterConversationGC(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")
	uidD := registerUser(t, s, "dave", "p", "Dave")
	makeFriends(t, s, uidA, uidB)
	makeFriends(t, s, uidA, uidC)
	makeFriends(t, s, uidA, uidD)

	for _, uid := range []int64{uidB, uidC, uidD} {
		result := sendMessageService(s, "send", uidA, &appmsg.Request{ToUID: i64json(uid), MsgType: dal.MsgText, Content: "hello"})
		if !result.Response.OK {
			t.Fatalf("send_message uid=%d failed: %+v", uid, result.Response)
		}
	}

	store := s.ConversationStore(uidA)
	convs, err := store.List(uidA, 0, 0, 100)
	if err != nil {
		t.Fatalf("list conversations: %v", err)
	}
	if len(convs) != 3 {
		t.Fatalf("conversations = %d, want 3", len(convs))
	}
	oldest := convs[len(convs)-1]
	if deleted, err := store.Purge(uidA, 1); err != nil {
		t.Fatalf("purge conversations: %v", err)
	} else if deleted != 2 {
		t.Fatalf("purged conversations = %d, want 2", deleted)
	}

	resp := syncConversationsService(s, "sync-old", uidA, oldest.Seq, 100)
	if !resp.OK || len(resp.Conversations) != 1 {
		t.Fatalf("SyncConversations after GC = %+v, want only retained conversations", resp)
	}
	if resp.Conversations[0].LastSeq <= oldest.Seq {
		t.Fatalf("SyncConversations returned purged seq range: %+v", resp.Conversations)
	}
	freshResp := syncConversationsService(s, "sync-fresh", uidA, 0, 100)
	if !freshResp.OK || len(freshResp.Conversations) != 1 {
		t.Fatalf("fresh SyncConversations = %+v, want retained active conversations", freshResp)
	}
}

func TestListByConversationGroupService(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB})
	groupID := int64(*groupResp.GroupIDResp)

	req := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group msg"}
	sendMessageService(s, "r2", uidA, req)
	drainTasks(s)

	listReq := &appmsg.Request{GroupID: i64json(groupID)}
	resp := listByConversationService(s, "r3", uidA, listReq)
	if !resp.OK {
		t.Fatalf("read failed: %s", resp.Error)
	}
	found := false
	for _, m := range resp.Messages {
		if bodyText(m) == "group msg" {
			found = true
		}
	}
	if !found {
		t.Error("should include group message")
	}
}

func TestListConversationsDMNormalizedTarget(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendMessageService(s, "r1", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hi"})

	resp := listConversationsService(s, "r2", uidA, "", 200)
	if !resp.OK {
		t.Fatalf("list failed: %s", resp.Error)
	}
	found := false
	for _, c := range resp.Conversations {
		if targetUID(c.Target) == uidB {
			found = true
		}
	}
	if !found {
		t.Error("DM conversation with bob not found")
	}
}

func TestListConversationsGroupNormalizedTarget(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")

	groupResp := createGroupService(s, "r1", uidA, "TestGroup", []int64{uidA, uidB})
	groupID := int64(*groupResp.GroupIDResp)

	req := &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "msg"}
	sendMessageService(s, "r2", uidA, req)
	drainTasks(s)

	resp := listConversationsService(s, "r3", uidA, "", 200)
	if !resp.OK {
		t.Fatalf("list failed: %s", resp.Error)
	}
	found := false
	for _, c := range resp.Conversations {
		if targetGroupID(c.Target) == groupID {
			found = true
		}
	}
	if !found {
		t.Error("group conversation not found")
	}
}
