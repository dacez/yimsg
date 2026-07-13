package service

import (
	"strings"
	"testing"

	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/proto"
)

// classifyRecallMsg 把响应 Message.body（已是强类型 *pb.MessageBody）重新编码为
// DAL 存储用的 proto bytes，复用 classifyRecallMessage 的分类逻辑，不涉及任何 JSON。
func classifyRecallMsg(msg *pb.Message) recallKind {
	raw, _ := proto.Marshal(msg.GetBody())
	return classifyRecallMessage(dal.Message{MsgType: int8(msg.GetMsgType()), MsgID: msg.GetMsgId(), Body: raw})
}

func TestRecallDMUpdatesHistoryAndKeepsUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendResp := sendMessageService(s, "r1", uidA, &appmsg.Request{ToUID: uidB, MsgType: dal.MsgText, Content: "hello"})
	if !isOK(sendResp.Response) || sendResp.Response.GetMsgId() == "" {
		t.Fatalf("send_message failed: %+v", sendResp.Response)
	}
	msgID := sendResp.Response.GetMsgId()

	beforeUnread := getUnreadCountService(s, "r2", uidB)
	if !isOK(beforeUnread) || beforeUnread.GetUnreadCount() != 1 {
		t.Fatalf("unexpected unread before recall: %+v", beforeUnread)
	}

	recallResp := recallMessageService(s, "r3", uidA, &appmsg.Request{MsgID: msgID, ToUID: uidB})
	if !isOK(recallResp.Response) || recallResp.Response.GetSeq() <= 0 {
		t.Fatalf("recall_message failed: %+v", recallResp.Response)
	}

	// 展示序为旧→新（ascTop）：占位（原消息原地替换，seq 更小）在前，撤回事件在后。
	senderResp := listByConversationService(s, "r4", uidA, &appmsg.Request{ToUID: uidB})
	senderMsgs := senderResp.GetMessages()
	if !isOK(senderResp) || len(senderMsgs) != 2 || classifyRecallMsg(senderMsgs[0]) != recallKindPlaceholder || classifyRecallMsg(senderMsgs[1]) != recallKindEvent || !strings.Contains(bodyText(senderMsgs[0]), "你撤回了一条消息") {
		t.Fatalf("unexpected sender read after recall: %+v", senderResp)
	}
	recipientResp := listByConversationService(s, "r5", uidB, &appmsg.Request{ToUID: uidA})
	recipientMsgs := recipientResp.GetMessages()
	if !isOK(recipientResp) || len(recipientMsgs) != 2 || classifyRecallMsg(recipientMsgs[0]) != recallKindPlaceholder || classifyRecallMsg(recipientMsgs[1]) != recallKindEvent || !strings.Contains(bodyText(recipientMsgs[0]), "对方撤回了一条消息") {
		t.Fatalf("unexpected recipient read after recall: %+v", recipientResp)
	}

	syncB := syncMessagesService(s, "r6", uidB, 0, 100)
	syncBMsgs := syncB.GetMessages()
	if !isOK(syncB) || len(syncBMsgs) != 2 {
		t.Fatalf("sync_messages after recall = %+v", syncB)
	}
	if classifyRecallMsg(syncBMsgs[0]) != recallKindPlaceholder || classifyRecallMsg(syncBMsgs[1]) != recallKindEvent {
		t.Fatalf("sync_messages should return placeholder + event, got %+v", syncBMsgs)
	}

	afterUnread := getUnreadCountService(s, "r7", uidB)
	if !isOK(afterUnread) || afterUnread.GetUnreadCount() != 1 {
		t.Fatalf("unexpected unread after recall: %+v", afterUnread)
	}
}

func TestRecallGroupBeforeFanoutReturnsAsyncTaskAndConvergesToFinalState(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	if !isOK(groupResp) {
		t.Fatalf("create_group failed: %s", errMsg(groupResp))
	}
	groupID := groupResp.GetGroupId()

	sendResp := sendMessageService(s, "r2", uidA, &appmsg.Request{GroupID: groupID, MsgType: dal.MsgText, Content: "group msg"})
	if !isOK(sendResp.Response) || sendResp.Response.GetMsgId() == "" {
		t.Fatalf("send group message failed: %+v", sendResp.Response)
	}
	msgID := sendResp.Response.GetMsgId()

	recallResp := recallMessageService(s, "r3", uidA, &appmsg.Request{MsgID: msgID, GroupID: groupID})
	if !isOK(recallResp.Response) {
		t.Fatalf("recall group message failed: %+v", recallResp)
	}

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r4-pre", uid, &appmsg.Request{GroupID: groupID})
		if !isOK(resp) {
			t.Fatalf("uid=%d unexpected pre-fanout get_messages: %+v", uid, resp)
		}
		for _, msg := range resp.GetMessages() {
			if msg.GetMsgId() == msgID || strings.Contains(bodyText(msg), "撤回了一条消息") {
				t.Fatalf("uid=%d should not be updated before async recall fanout, got %+v", uid, resp.GetMessages())
			}
		}
	}

	drainTasks(s)

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r4", uid, &appmsg.Request{GroupID: groupID})
		if !isOK(resp) || len(resp.GetMessages()) == 0 {
			t.Fatalf("uid=%d unexpected get_messages: %+v", uid, resp)
		}
		foundPlaceholder := false
		for _, msg := range resp.GetMessages() {
			if strings.Contains(bodyText(msg), "group msg") {
				t.Fatalf("uid=%d should not receive original group content after recall", uid)
			}
			if strings.Contains(bodyText(msg), "撤回了一条消息") {
				foundPlaceholder = true
			}
		}
		if !foundPlaceholder {
			t.Fatalf("uid=%d should receive placeholder content, got %+v", uid, resp.GetMessages())
		}

		syncResp := syncMessagesService(s, "r5", uid, 0, 100)
		if !isOK(syncResp) || len(syncResp.GetMessages()) < 3 {
			t.Fatalf("uid=%d unexpected sync_messages after recall: %+v", uid, syncResp)
		}
		foundSyncPlaceholder := false
		foundSyncEvent := false
		for _, msg := range syncResp.GetMessages() {
			switch classifyRecallMsg(msg) {
			case recallKindPlaceholder:
				foundSyncPlaceholder = true
			case recallKindEvent:
				foundSyncEvent = true
			}
		}
		if !foundSyncPlaceholder || !foundSyncEvent {
			t.Fatalf("uid=%d expected placeholder + event in sync_messages, got %+v", uid, syncResp.GetMessages())
		}
	}
}

func TestRecallGroupAfterFanoutReturnsAsyncTaskAndConvergesToFinalState(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice2", "p", "Alice")
	uidB := registerUser(t, s, "bob2", "p", "Bob")
	uidC := registerUser(t, s, "carol2", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	if !isOK(groupResp) {
		t.Fatalf("create_group failed: %s", errMsg(groupResp))
	}
	groupID := groupResp.GetGroupId()

	sendResp := sendMessageService(s, "r2", uidA, &appmsg.Request{GroupID: groupID, MsgType: dal.MsgText, Content: "group msg"})
	if !isOK(sendResp.Response) || sendResp.Response.GetMsgId() == "" {
		t.Fatalf("send group message failed: %+v", sendResp.Response)
	}
	msgID := sendResp.Response.GetMsgId()
	drainTasks(s)

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r3-pre", uid, &appmsg.Request{GroupID: groupID})
		if !isOK(resp) {
			t.Fatalf("uid=%d should see original group message before recall fanout, got %+v", uid, resp)
		}
		foundOriginal := false
		for _, msg := range resp.GetMessages() {
			if msg.GetMsgId() == msgID && strings.Contains(bodyText(msg), "group msg") {
				foundOriginal = true
				break
			}
		}
		if !foundOriginal {
			t.Fatalf("uid=%d should see original group message before recall fanout, got %+v", uid, resp)
		}
	}

	recallResp := recallMessageService(s, "r3", uidA, &appmsg.Request{MsgID: msgID, GroupID: groupID})
	if !isOK(recallResp.Response) {
		t.Fatalf("recall group message failed: %+v", recallResp)
	}

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r4-mid", uid, &appmsg.Request{GroupID: groupID})
		if !isOK(resp) {
			t.Fatalf("uid=%d should keep original message before async recall fanout, got %+v", uid, resp)
		}
		foundOriginal := false
		for _, msg := range resp.GetMessages() {
			if msg.GetMsgId() == msgID && strings.Contains(bodyText(msg), "group msg") {
				foundOriginal = true
			}
			if msg.GetMsgId() == msgID && strings.Contains(bodyText(msg), "撤回了一条消息") {
				t.Fatalf("uid=%d should not see placeholder before async recall fanout, got %+v", uid, resp.GetMessages())
			}
		}
		if !foundOriginal {
			t.Fatalf("uid=%d should keep original message before async recall fanout, got %+v", uid, resp)
		}
	}

	drainTasks(s)

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r5", uid, &appmsg.Request{GroupID: groupID})
		msgs := resp.GetMessages()
		if !isOK(resp) || len(msgs) == 0 {
			t.Fatalf("uid=%d unexpected get_messages after recall fanout: %+v", uid, resp)
		}
		// 展示序为旧→新（ascTop）：撤回占位是最新一条，取末尾元素断言。
		last := msgs[len(msgs)-1]
		if strings.Contains(bodyText(last), "group msg") || !strings.Contains(bodyText(last), "撤回了一条消息") {
			t.Fatalf("uid=%d should converge to placeholder after recall fanout, got %+v", uid, msgs)
		}
	}
}

func TestRecallMessageRejectsNonSender(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendResp := sendMessageService(s, "r1", uidA, &appmsg.Request{ToUID: uidB, MsgType: dal.MsgText, Content: "hello"})
	if !isOK(sendResp.Response) || sendResp.Response.GetMsgId() == "" {
		t.Fatalf("send_message failed: %+v", sendResp.Response)
	}

	recallResp := recallMessageService(s, "r2", uidB, &appmsg.Request{MsgID: sendResp.Response.GetMsgId(), ToUID: uidA})
	if isOK(recallResp.Response) || errMsg(recallResp.Response) != "message_not_found" {
		t.Fatalf("non-sender recall should fail, got %+v", recallResp.Response)
	}
}
