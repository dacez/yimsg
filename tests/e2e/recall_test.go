package e2e

import (
	"strings"
	"testing"
)

// recallReq 通过 send_message + MESSAGE_TYPE_RECALL + RecallBody 表达撤回。
func recallReq(toUID, msgID string) wsRequest {
	return wsRequest{
		"action":   "send_message",
		"to_uid":   toUID,
		"msg_type": 5, // MESSAGE_TYPE_RECALL
		"body":     map[string]any{"recall": map[string]any{"msg_id": msgID}},
	}
}

func TestRecallDM(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("recall"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("recall"), "pass1234", "Bob")
	makeFriends(t, a, b)

	sendResp := a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 1,
		"content":  "hello before recall",
	})
	if sendResp.MsgID == "" || sendResp.Seq == nil {
		t.Fatalf("send_message should return msg_id/seq, got %+v", sendResp)
	}
	b.waitNotif(func(n notification) bool { return n.Type == "messages:received" })

	beforeRecall := b.sendOK(wsRequest{"action": "get_messages", "to_uid": a.uid})
	if len(beforeRecall.Messages) != 1 {
		t.Fatalf("recipient should see one message before recall, got %+v", beforeRecall.Messages)
	}
	recipientOriginalSeq := beforeRecall.Messages[0].Seq

	recallResp := a.sendOK(recallReq(b.uid, sendResp.MsgID))
	if recallResp.MsgID != sendResp.MsgID {
		t.Fatalf("recall msg_id=%q, want %q", recallResp.MsgID, sendResp.MsgID)
	}
	if recallResp.Seq == nil || *recallResp.Seq <= *sendResp.Seq {
		t.Fatalf("recall seq should advance, got %+v", recallResp.Seq)
	}

	b.waitNotif(func(n notification) bool { return n.Type == "messages:received" })

	// 展示序旧→新（ascTop）：[0]=被覆盖的原消息占位（seq 更小），[1]=撤回事件（新 msg_id）。
	senderMessages := a.sendOK(wsRequest{"action": "get_messages", "to_uid": b.uid})
	if len(senderMessages.Messages) != 2 {
		t.Fatalf("sender get_messages should return placeholder + recall event, got %+v", senderMessages.Messages)
	}
	assertRecallPlaceholder(t, "sender placeholder", senderMessages.Messages[0], sendResp.MsgID, "你撤回了一条消息")
	assertRecallEvent(t, "sender event", senderMessages.Messages[1], sendResp.MsgID, "你撤回了一条消息")

	recipientMessages := b.sendOK(wsRequest{"action": "get_messages", "to_uid": a.uid})
	if len(recipientMessages.Messages) != 2 {
		t.Fatalf("recipient get_messages should return placeholder + recall event, got %+v", recipientMessages.Messages)
	}
	assertRecallPlaceholder(t, "recipient placeholder", recipientMessages.Messages[0], sendResp.MsgID, "对方撤回了一条消息")
	assertRecallEvent(t, "recipient event", recipientMessages.Messages[1], sendResp.MsgID, "对方撤回了一条消息")

	// 原消息正文已被服务端脱敏，撤回后不可再读到（占位在 Messages[0]）。
	if strings.Contains(recipientMessages.Messages[0].text(), "hello before recall") {
		t.Fatalf("original content should be redacted after recall")
	}

	// 同步：原消息被覆盖（seq 不变）不再下发，只下发新的撤回事件消息。
	syncResp := b.sendOK(wsRequest{"action": "sync_messages", "last_seq": recipientOriginalSeq})
	if len(syncResp.Messages) != 1 {
		t.Fatalf("sync_messages after recall should return only recall event, got %+v", syncResp.Messages)
	}
	assertRecallEvent(t, "sync event", syncResp.Messages[0], sendResp.MsgID, "对方撤回了一条消息")
	if syncResp.Messages[0].MsgID == sendResp.MsgID {
		t.Fatalf("sync recall event should use a new msg_id, got %+v", syncResp.Messages[0])
	}
}

// TestRecallServerOverridesClientFields 验证服务端忽略并覆盖客户端传入的 operator_uid/recall_time/text。
func TestRecallServerOverridesClientFields(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("recall"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("recall"), "pass1234", "Bob")
	makeFriends(t, a, b)

	sendResp := a.sendOK(wsRequest{"action": "send_message", "to_uid": b.uid, "msg_type": 1, "content": "x"})

	a.sendOK(wsRequest{
		"action":   "send_message",
		"to_uid":   b.uid,
		"msg_type": 5,
		"body": map[string]any{"recall": map[string]any{
			"msg_id":       sendResp.MsgID,
			"operator_uid": "999999",
			"recall_time":  "1",
			"text":         "client-supplied-should-be-ignored",
		}},
	})

	msgs := a.sendOK(wsRequest{"action": "get_messages", "to_uid": b.uid})
	// 展示序旧→新：撤回事件是最新一条，取末尾。
	ev := msgs.Messages[len(msgs.Messages)-1]
	if ev.Body.Recall == nil {
		t.Fatalf("expected recall body, got %+v", ev)
	}
	if ev.Body.Recall.OperatorUID != a.uid {
		t.Fatalf("operator_uid = %q, want server-set %q", ev.Body.Recall.OperatorUID, a.uid)
	}
	if ev.Body.Recall.RecallTime <= 1 {
		t.Fatalf("recall_time should be server-set to current time, got %d", ev.Body.Recall.RecallTime)
	}
	if strings.Contains(ev.Body.Recall.Text, "client-supplied") {
		t.Fatalf("text should be server-set, got %q", ev.Body.Recall.Text)
	}
}

func assertRecallEvent(t *testing.T, label string, m message, targetMsgID, wantText string) {
	t.Helper()
	if m.MsgType != 5 || m.Body.Recall == nil {
		t.Fatalf("%s: expected recall message, got %+v", label, m)
	}
	if m.Body.Recall.MsgID != targetMsgID {
		t.Fatalf("%s: recall.msg_id=%q, want %q", label, m.Body.Recall.MsgID, targetMsgID)
	}
	if m.MsgID == targetMsgID {
		t.Fatalf("%s: event should use a new msg_id, got original %q", label, m.MsgID)
	}
	if !strings.Contains(m.Body.Recall.Text, wantText) {
		t.Fatalf("%s: text=%q, want contains %q", label, m.Body.Recall.Text, wantText)
	}
}

func assertRecallPlaceholder(t *testing.T, label string, m message, targetMsgID, wantText string) {
	t.Helper()
	if m.MsgType != 5 || m.Body.Recall == nil {
		t.Fatalf("%s: expected recall placeholder, got %+v", label, m)
	}
	if m.MsgID != targetMsgID || m.Body.Recall.MsgID != targetMsgID {
		t.Fatalf("%s: placeholder should overwrite original msg_id %q, got own=%q recall=%q", label, targetMsgID, m.MsgID, m.Body.Recall.MsgID)
	}
	if !strings.Contains(m.Body.Recall.Text, wantText) {
		t.Fatalf("%s: text=%q, want contains %q", label, m.Body.Recall.Text, wantText)
	}
}
