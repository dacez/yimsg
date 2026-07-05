package service

import (
	"strings"
	"testing"

	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// appMsgBodyBytes 把响应 Message.body（protojson）还原为 protobuf bytes，供撤回分类复用 DAL 逻辑。
func appMsgBodyBytes(m appmsg.Message) []byte {
	var body pb.MessageBody
	if len(m.Body) > 0 {
		_ = protojson.Unmarshal(m.Body, &body)
	}
	raw, _ := proto.Marshal(&body)
	return raw
}

func classifyRecallAppMessage(msg appmsg.Message) recallKind {
	return classifyRecallMessage(dal.Message{MsgType: msg.MsgType, MsgID: msg.MsgID, Body: appMsgBodyBytes(msg)})
}

func TestRecallDMUpdatesHistoryAndKeepsUnread(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendResp := sendMessageService(s, "r1", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hello"})
	if !sendResp.Response.OK || sendResp.Response.MsgID == nil {
		t.Fatalf("send_message failed: %+v", sendResp.Response)
	}
	msgID := *sendResp.Response.MsgID

	beforeUnread := getUnreadCountService(s, "r2", uidB)
	if !beforeUnread.OK || beforeUnread.UnreadCount == nil || *beforeUnread.UnreadCount != 1 {
		t.Fatalf("unexpected unread before recall: %+v", beforeUnread)
	}

	recallResp := recallMessageService(s, "r3", uidA, &appmsg.Request{MsgID: msgID, ToUID: i64json(uidB)})
	if !recallResp.Response.OK || recallResp.Response.Seq == nil || *recallResp.Response.Seq <= 0 {
		t.Fatalf("recall_message failed: %+v", recallResp.Response)
	}

	// 展示序为旧→新（ascTop）：占位（原消息原地替换，seq 更小）在前，撤回事件在后。
	senderResp := listByConversationService(s, "r4", uidA, &appmsg.Request{ToUID: i64json(uidB)})
	if !senderResp.OK || len(senderResp.Messages) != 2 || classifyRecallAppMessage(senderResp.Messages[0]) != recallKindPlaceholder || classifyRecallAppMessage(senderResp.Messages[1]) != recallKindEvent || !strings.Contains(bodyText(senderResp.Messages[0]), "你撤回了一条消息") {
		t.Fatalf("unexpected sender read after recall: %+v", senderResp)
	}
	recipientResp := listByConversationService(s, "r5", uidB, &appmsg.Request{ToUID: i64json(uidA)})
	if !recipientResp.OK || len(recipientResp.Messages) != 2 || classifyRecallAppMessage(recipientResp.Messages[0]) != recallKindPlaceholder || classifyRecallAppMessage(recipientResp.Messages[1]) != recallKindEvent || !strings.Contains(bodyText(recipientResp.Messages[0]), "对方撤回了一条消息") {
		t.Fatalf("unexpected recipient read after recall: %+v", recipientResp)
	}

	syncB := syncMessagesService(s, "r6", uidB, 0, 100)
	if !syncB.OK || len(syncB.Messages) != 2 {
		t.Fatalf("sync_messages after recall = %+v", syncB)
	}
	if classifyRecallAppMessage(syncB.Messages[0]) != recallKindPlaceholder || classifyRecallAppMessage(syncB.Messages[1]) != recallKindEvent {
		t.Fatalf("sync_messages should return placeholder + event, got %+v", syncB.Messages)
	}

	afterUnread := getUnreadCountService(s, "r7", uidB)
	if !afterUnread.OK || afterUnread.UnreadCount == nil || *afterUnread.UnreadCount != 1 {
		t.Fatalf("unexpected unread after recall: %+v", afterUnread)
	}
}

func TestRecallGroupBeforeFanoutReturnsAsyncTaskAndConvergesToFinalState(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	uidC := registerUser(t, s, "carol", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	if !groupResp.OK {
		t.Fatalf("create_group failed: %s", groupResp.Error)
	}
	groupID := int64(*groupResp.GroupIDResp)

	sendResp := sendMessageService(s, "r2", uidA, &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group msg"})
	if !sendResp.Response.OK || sendResp.Response.MsgID == nil {
		t.Fatalf("send group message failed: %+v", sendResp.Response)
	}
	msgID := *sendResp.Response.MsgID

	recallResp := recallMessageService(s, "r3", uidA, &appmsg.Request{MsgID: msgID, GroupID: i64json(groupID)})
	if !recallResp.Response.OK {
		t.Fatalf("recall group message failed: %+v", recallResp)
	}

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r4-pre", uid, &appmsg.Request{GroupID: i64json(groupID)})
		if !resp.OK {
			t.Fatalf("uid=%d unexpected pre-fanout get_messages: %+v", uid, resp)
		}
		for _, msg := range resp.Messages {
			if msg.MsgID == msgID || strings.Contains(bodyText(msg), "撤回了一条消息") {
				t.Fatalf("uid=%d should not be updated before async recall fanout, got %+v", uid, resp.Messages)
			}
		}
	}

	drainTasks(s)

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r4", uid, &appmsg.Request{GroupID: i64json(groupID)})
		if !resp.OK || len(resp.Messages) == 0 {
			t.Fatalf("uid=%d unexpected get_messages: %+v", uid, resp)
		}
		foundPlaceholder := false
		for _, msg := range resp.Messages {
			if strings.Contains(bodyText(msg), "group msg") {
				t.Fatalf("uid=%d should not receive original group content after recall", uid)
			}
			if strings.Contains(bodyText(msg), "撤回了一条消息") {
				foundPlaceholder = true
			}
		}
		if !foundPlaceholder {
			t.Fatalf("uid=%d should receive placeholder content, got %+v", uid, resp.Messages)
		}

		syncResp := syncMessagesService(s, "r5", uid, 0, 100)
		if !syncResp.OK || len(syncResp.Messages) < 3 {
			t.Fatalf("uid=%d unexpected sync_messages after recall: %+v", uid, syncResp)
		}
		foundSyncPlaceholder := false
		foundSyncEvent := false
		for _, msg := range syncResp.Messages {
			switch classifyRecallAppMessage(msg) {
			case recallKindPlaceholder:
				foundSyncPlaceholder = true
			case recallKindEvent:
				foundSyncEvent = true
			}
		}
		if !foundSyncPlaceholder || !foundSyncEvent {
			t.Fatalf("uid=%d expected placeholder + event in sync_messages, got %+v", uid, syncResp.Messages)
		}
	}
}

func TestRecallGroupAfterFanoutReturnsAsyncTaskAndConvergesToFinalState(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice2", "p", "Alice")
	uidB := registerUser(t, s, "bob2", "p", "Bob")
	uidC := registerUser(t, s, "carol2", "p", "Carol")

	groupResp := createGroupService(s, "r1", uidA, "G", []int64{uidA, uidB, uidC})
	if !groupResp.OK {
		t.Fatalf("create_group failed: %s", groupResp.Error)
	}
	groupID := int64(*groupResp.GroupIDResp)

	sendResp := sendMessageService(s, "r2", uidA, &appmsg.Request{GroupID: i64json(groupID), MsgType: dal.MsgText, Content: "group msg"})
	if !sendResp.Response.OK || sendResp.Response.MsgID == nil {
		t.Fatalf("send group message failed: %+v", sendResp.Response)
	}
	msgID := *sendResp.Response.MsgID
	drainTasks(s)

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r3-pre", uid, &appmsg.Request{GroupID: i64json(groupID)})
		if !resp.OK {
			t.Fatalf("uid=%d should see original group message before recall fanout, got %+v", uid, resp)
		}
		foundOriginal := false
		for _, msg := range resp.Messages {
			if msg.MsgID == msgID && strings.Contains(bodyText(msg), "group msg") {
				foundOriginal = true
				break
			}
		}
		if !foundOriginal {
			t.Fatalf("uid=%d should see original group message before recall fanout, got %+v", uid, resp)
		}
	}

	recallResp := recallMessageService(s, "r3", uidA, &appmsg.Request{MsgID: msgID, GroupID: i64json(groupID)})
	if !recallResp.Response.OK {
		t.Fatalf("recall group message failed: %+v", recallResp)
	}

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r4-mid", uid, &appmsg.Request{GroupID: i64json(groupID)})
		if !resp.OK {
			t.Fatalf("uid=%d should keep original message before async recall fanout, got %+v", uid, resp)
		}
		foundOriginal := false
		for _, msg := range resp.Messages {
			if msg.MsgID == msgID && strings.Contains(bodyText(msg), "group msg") {
				foundOriginal = true
			}
			if msg.MsgID == msgID && strings.Contains(bodyText(msg), "撤回了一条消息") {
				t.Fatalf("uid=%d should not see placeholder before async recall fanout, got %+v", uid, resp.Messages)
			}
		}
		if !foundOriginal {
			t.Fatalf("uid=%d should keep original message before async recall fanout, got %+v", uid, resp)
		}
	}

	drainTasks(s)

	for _, uid := range []int64{uidB, uidC} {
		resp := listByConversationService(s, "r5", uid, &appmsg.Request{GroupID: i64json(groupID)})
		if !resp.OK || len(resp.Messages) == 0 {
			t.Fatalf("uid=%d unexpected get_messages after recall fanout: %+v", uid, resp)
		}
		// 展示序为旧→新（ascTop）：撤回占位是最新一条，取末尾元素断言。
		last := resp.Messages[len(resp.Messages)-1]
		if strings.Contains(bodyText(last), "group msg") || !strings.Contains(bodyText(last), "撤回了一条消息") {
			t.Fatalf("uid=%d should converge to placeholder after recall fanout, got %+v", uid, resp.Messages)
		}
	}
}

func TestRecallMessageRejectsNonSender(t *testing.T) {
	s := testState(t)
	uidA := registerUser(t, s, "alice", "p", "Alice")
	uidB := registerUser(t, s, "bob", "p", "Bob")
	makeFriends(t, s, uidA, uidB)

	sendResp := sendMessageService(s, "r1", uidA, &appmsg.Request{ToUID: i64json(uidB), MsgType: dal.MsgText, Content: "hello"})
	if !sendResp.Response.OK || sendResp.Response.MsgID == nil {
		t.Fatalf("send_message failed: %+v", sendResp.Response)
	}

	recallResp := recallMessageService(s, "r2", uidB, &appmsg.Request{MsgID: *sendResp.Response.MsgID, ToUID: i64json(uidA)})
	if recallResp.Response.OK || recallResp.Response.Error != "message_not_found" {
		t.Fatalf("non-sender recall should fail, got %+v", recallResp.Response)
	}
}
