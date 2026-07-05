package e2e

import (
	"testing"
	"time"
	"yimsg/internal/msgid"
)

// TestSendMessageDMIdempotent 验证单聊同一 msg_id 重复发送时服务端幂等：
// 不重复插入，第二次返回与第一次相同的 seq 与 msg_id。
func TestSendMessageDMIdempotent(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("idem"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("idem"), "pass1234", "Bob")
	makeFriends(t, a, b)

	id := msgid.Generate()
	first := a.sendOK(wsRequest{
		"action": "send_message", "to_uid": b.uid, "msg_type": 1,
		"content": "idem dm", "msg_id": id,
	})
	if first.MsgID != id || first.Seq == nil {
		t.Fatalf("首次发送应返回相同 msg_id 与 seq, got %+v", first)
	}

	second := a.sendOK(wsRequest{
		"action": "send_message", "to_uid": b.uid, "msg_type": 1,
		"content": "idem dm again", "msg_id": id,
	})
	// 幂等命中时服务端不再插入新行，回传相同 msg_id 与已有 seq。
	if second.MsgID != id {
		t.Fatalf("重复发送 msg_id=%q, want %q", second.MsgID, id)
	}
	if second.Seq == nil || *second.Seq != *first.Seq {
		t.Fatalf("幂等重复发送应返回已有 seq=%d, got %v", *first.Seq, second.Seq)
	}

	// 发送方收件箱应只保留一条该 msg_id 的消息，且 seq 与首次一致。
	msgs := a.sendOK(wsRequest{"action": "get_messages", "to_uid": b.uid})
	count := 0
	for _, m := range msgs.Messages {
		if m.MsgID == id {
			count++
			if m.Seq != *first.Seq {
				t.Fatalf("幂等后存储的 seq=%d, want %d", m.Seq, *first.Seq)
			}
		}
	}
	if count != 1 {
		t.Fatalf("幂等后应只存在 1 条消息, got %d: %+v", count, msgs.Messages)
	}
}

// TestSendMessageGroupIdempotent 验证群聊同一 msg_id 重复发送同样幂等。
func TestSendMessageGroupIdempotent(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	groupResp := owner.sendOK(wsRequest{
		"action":      "create_group",
		"name":        "IdemGroup",
		"member_uids": []string{owner.uid, m1.uid, m2.uid},
	})
	if groupResp.GroupID == "" {
		t.Fatal("create_group should return group_id")
	}
	// 等待建群系统消息扇出完成。
	time.Sleep(500 * time.Millisecond)
	owner.drainNotifs(func(n notification) bool { return true })

	id := msgid.Generate()
	first := owner.sendOK(wsRequest{
		"action": "send_message", "group_id": groupResp.GroupID, "msg_type": 1,
		"content": "idem group", "msg_id": id,
	})
	if first.MsgID != id || first.Seq == nil {
		t.Fatalf("首次群发应返回相同 msg_id 与 seq, got %+v", first)
	}

	second := owner.sendOK(wsRequest{
		"action": "send_message", "group_id": groupResp.GroupID, "msg_type": 1,
		"content": "idem group again", "msg_id": id,
	})
	// 幂等命中时服务端不再插入新行，回传相同 msg_id 与已有 seq。
	if second.MsgID != id {
		t.Fatalf("群聊重复发送 msg_id=%q, want %q", second.MsgID, id)
	}
	if second.Seq == nil || *second.Seq != *first.Seq {
		t.Fatalf("群聊幂等重复发送应返回已有 seq=%d, got %v", *first.Seq, second.Seq)
	}

	// 等待可能的扇出后，发送方收件箱应只保留一条该 msg_id 的消息，且 seq 与首次一致。
	time.Sleep(500 * time.Millisecond)
	msgs := owner.sendOK(wsRequest{"action": "get_messages", "group_id": groupResp.GroupID})
	count := 0
	for _, m := range msgs.Messages {
		if m.MsgID == id {
			count++
			if m.Seq != *first.Seq {
				t.Fatalf("群聊幂等后存储的 seq=%d, want %d", m.Seq, *first.Seq)
			}
		}
	}
	if count != 1 {
		t.Fatalf("群聊幂等后应只存在 1 条消息, got %d: %+v", count, msgs.Messages)
	}
}

// TestSendMessageMissingMsgID 验证缺失 msg_id（空串）被服务端以 INVALID_ARGUMENT 拒绝。
func TestSendMessageMissingMsgID(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("idem"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("idem"), "pass1234", "Bob")
	makeFriends(t, a, b)

	// 显式设置空 msg_id，绕过自动注入，触发服务端校验失败。
	resp := a.send(wsRequest{
		"action": "send_message", "to_uid": b.uid, "msg_type": 1,
		"content": "missing id", "msg_id": "",
	})
	if resp.OK {
		t.Fatal("缺失 msg_id 的 send_message 应被拒绝")
	}
	if resp.ErrorCode != "INVALID_ARGUMENT" {
		t.Fatalf("缺失 msg_id error_code=%q, want INVALID_ARGUMENT", resp.ErrorCode)
	}
}

// TestSendMessageInvalidMsgID 验证非法 msg_id 被服务端拒绝。
func TestSendMessageInvalidMsgID(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("idem"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("idem"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := a.send(wsRequest{
		"action": "send_message", "to_uid": b.uid, "msg_type": 1,
		"content": "invalid id", "msg_id": "bad",
	})
	if resp.OK {
		t.Fatal("非法 msg_id 的 send_message 应被拒绝")
	}
	if resp.ErrorCode != "INVALID_ARGUMENT" {
		t.Fatalf("非法 msg_id error_code=%q, want INVALID_ARGUMENT", resp.ErrorCode)
	}
}
