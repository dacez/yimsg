package e2e

import (
	"strings"
	"testing"
	"yimsg/internal/appmsg"
	"yimsg/internal/msgid"
	"yimsg/internal/protocol/pb"
)

// recallReq 通过 send_message + MESSAGE_TYPE_RECALL + RecallBody 表达撤回。
func recallReq(toUID int64, msgID string) *pb.SendMessageRequest {
	return &pb.SendMessageRequest{
		MsgId:   msgid.Generate(),
		Target:  userTarget(toUID),
		MsgType: pb.MessageType_MESSAGE_TYPE_RECALL,
		Body:    &pb.MessageBody{Kind: &pb.MessageBody_Recall{Recall: &pb.RecallBody{MsgId: msgID}}},
	}
}

func TestRecallDM(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("recall"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("recall"), "pass1234", "Bob")
	makeFriends(t, a, b)

	sendResp := a.sendText(userTarget(b.uid), "hello before recall")
	if sendResp.GetMsgId() == "" || sendResp.GetSeq() == 0 {
		t.Fatalf("send_message should return msg_id/seq, got %+v", sendResp)
	}
	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "messages:received" })

	beforeRecall := sendOK(b, "get_messages", &pb.GetMessagesRequest{Target: userTarget(a.uid)}, &pb.GetMessagesResponse{})
	if len(beforeRecall.GetMessages()) != 1 {
		t.Fatalf("recipient should see one message before recall, got %+v", beforeRecall.GetMessages())
	}
	recipientOriginalSeq := beforeRecall.GetMessages()[0].GetSeq()

	recallResp := sendOK(a, "send_message", recallReq(b.uid, sendResp.GetMsgId()), &pb.SendMessageResponse{})
	if recallResp.GetMsgId() == sendResp.GetMsgId() {
		t.Fatalf("recall event should use a new msg_id, got %q", recallResp.GetMsgId())
	}
	if recallResp.GetSeq() <= sendResp.GetSeq() {
		t.Fatalf("recall seq should advance, got %+v", recallResp.GetSeq())
	}

	b.waitNotif(func(n *appmsg.Notification) bool { return n.Type == "messages:received" })

	// 展示序旧→新（ascTop）：[0]=被覆盖的原消息占位（seq 更小），[1]=撤回事件（新 msg_id）。
	senderMessages := sendOK(a, "get_messages", &pb.GetMessagesRequest{Target: userTarget(b.uid)}, &pb.GetMessagesResponse{})
	if len(senderMessages.GetMessages()) != 2 {
		t.Fatalf("sender get_messages should return placeholder + recall event, got %+v", senderMessages.GetMessages())
	}
	assertRecallPlaceholder(t, "sender placeholder", senderMessages.GetMessages()[0], sendResp.GetMsgId(), "你撤回了一条消息")
	assertRecallEvent(t, "sender event", senderMessages.GetMessages()[1], sendResp.GetMsgId(), "你撤回了一条消息")

	recipientMessages := sendOK(b, "get_messages", &pb.GetMessagesRequest{Target: userTarget(a.uid)}, &pb.GetMessagesResponse{})
	if len(recipientMessages.GetMessages()) != 2 {
		t.Fatalf("recipient get_messages should return placeholder + recall event, got %+v", recipientMessages.GetMessages())
	}
	assertRecallPlaceholder(t, "recipient placeholder", recipientMessages.GetMessages()[0], sendResp.GetMsgId(), "对方撤回了一条消息")
	assertRecallEvent(t, "recipient event", recipientMessages.GetMessages()[1], sendResp.GetMsgId(), "对方撤回了一条消息")

	// 原消息正文已被服务端脱敏，撤回后不可再读到（占位在 Messages[0]）。
	if strings.Contains(bodyText(recipientMessages.GetMessages()[0]), "hello before recall") {
		t.Fatalf("original content should be redacted after recall")
	}

	// 同步：原消息被覆盖（seq 不变）不再下发，只下发新的撤回事件消息。
	syncResp := sendOK(b, "sync_messages", &pb.SyncMessagesRequest{LastSeq: recipientOriginalSeq}, &pb.SyncMessagesResponse{})
	if len(syncResp.GetMessages()) != 1 {
		t.Fatalf("sync_messages after recall should return only recall event, got %+v", syncResp.GetMessages())
	}
	assertRecallEvent(t, "sync event", syncResp.GetMessages()[0], sendResp.GetMsgId(), "对方撤回了一条消息")
	if syncResp.GetMessages()[0].GetMsgId() == sendResp.GetMsgId() {
		t.Fatalf("sync recall event should use a new msg_id, got %+v", syncResp.GetMessages()[0])
	}
}

// TestRecallServerOverridesClientFields 验证服务端忽略并覆盖客户端传入的 operator_uid/recall_time/text。
func TestRecallServerOverridesClientFields(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("recall"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("recall"), "pass1234", "Bob")
	makeFriends(t, a, b)

	sendResp := a.sendText(userTarget(b.uid), "x")

	sendOK(a, "send_message", &pb.SendMessageRequest{
		MsgId:   msgid.Generate(),
		Target:  userTarget(b.uid),
		MsgType: pb.MessageType_MESSAGE_TYPE_RECALL,
		Body: &pb.MessageBody{Kind: &pb.MessageBody_Recall{Recall: &pb.RecallBody{
			MsgId:       sendResp.GetMsgId(),
			OperatorUid: 999999,
			RecallTime:  1,
			Text:        "client-supplied-should-be-ignored",
		}}},
	}, &pb.SendMessageResponse{})

	msgs := sendOK(a, "get_messages", &pb.GetMessagesRequest{Target: userTarget(b.uid)}, &pb.GetMessagesResponse{})
	// 展示序旧→新：撤回事件是最新一条，取末尾。
	ev := msgs.GetMessages()[len(msgs.GetMessages())-1]
	recall := ev.GetBody().GetRecall()
	if recall == nil {
		t.Fatalf("expected recall body, got %+v", ev)
	}
	if recall.GetOperatorUid() != a.uid {
		t.Fatalf("operator_uid = %d, want server-set %d", recall.GetOperatorUid(), a.uid)
	}
	if recall.GetRecallTime() <= 1 {
		t.Fatalf("recall_time should be server-set to current time, got %d", recall.GetRecallTime())
	}
	if strings.Contains(recall.GetText(), "client-supplied") {
		t.Fatalf("text should be server-set, got %q", recall.GetText())
	}
}

func assertRecallEvent(t *testing.T, label string, m *pb.Message, targetMsgID, wantText string) {
	t.Helper()
	recall := m.GetBody().GetRecall()
	if m.GetMsgType() != pb.MessageType_MESSAGE_TYPE_RECALL || recall == nil {
		t.Fatalf("%s: expected recall message, got %+v", label, m)
	}
	if recall.GetMsgId() != targetMsgID {
		t.Fatalf("%s: recall.msg_id=%q, want %q", label, recall.GetMsgId(), targetMsgID)
	}
	if m.GetMsgId() == targetMsgID {
		t.Fatalf("%s: event should use a new msg_id, got original %q", label, m.GetMsgId())
	}
	if !strings.Contains(recall.GetText(), wantText) {
		t.Fatalf("%s: text=%q, want contains %q", label, recall.GetText(), wantText)
	}
}

func assertRecallPlaceholder(t *testing.T, label string, m *pb.Message, targetMsgID, wantText string) {
	t.Helper()
	recall := m.GetBody().GetRecall()
	if m.GetMsgType() != pb.MessageType_MESSAGE_TYPE_RECALL || recall == nil {
		t.Fatalf("%s: expected recall placeholder, got %+v", label, m)
	}
	if m.GetMsgId() != targetMsgID || recall.GetMsgId() != targetMsgID {
		t.Fatalf("%s: placeholder should overwrite original msg_id %q, got own=%q recall=%q", label, targetMsgID, m.GetMsgId(), recall.GetMsgId())
	}
	if !strings.Contains(recall.GetText(), wantText) {
		t.Fatalf("%s: text=%q, want contains %q", label, recall.GetText(), wantText)
	}
}
