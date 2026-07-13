package e2e

import (
	"testing"
	"time"
	"yimsg/internal/appmsg"
	"yimsg/internal/msgid"
	"yimsg/internal/protocol/pb"
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
	first := sendOK(a, "send_message", &pb.SendMessageRequest{
		MsgId: id, Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("idem dm"),
	}, &pb.SendMessageResponse{})
	if first.GetMsgId() != id || first.GetSeq() == 0 {
		t.Fatalf("首次发送应返回相同 msg_id 与 seq, got %+v", first)
	}

	second := sendOK(a, "send_message", &pb.SendMessageRequest{
		MsgId: id, Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("idem dm again"),
	}, &pb.SendMessageResponse{})
	// 幂等命中时服务端不再插入新行，回传相同 msg_id 与已有 seq。
	if second.GetMsgId() != id {
		t.Fatalf("重复发送 msg_id=%q, want %q", second.GetMsgId(), id)
	}
	if second.GetSeq() != first.GetSeq() {
		t.Fatalf("幂等重复发送应返回已有 seq=%d, got %v", first.GetSeq(), second.GetSeq())
	}

	// 发送方收件箱应只保留一条该 msg_id 的消息，且 seq 与首次一致。
	msgs := sendOK(a, "get_messages", &pb.GetMessagesRequest{Target: userTarget(b.uid)}, &pb.GetMessagesResponse{})
	count := 0
	for _, m := range msgs.GetMessages() {
		if m.GetMsgId() == id {
			count++
			if m.GetSeq() != first.GetSeq() {
				t.Fatalf("幂等后存储的 seq=%d, want %d", m.GetSeq(), first.GetSeq())
			}
		}
	}
	if count != 1 {
		t.Fatalf("幂等后应只存在 1 条消息, got %d: %+v", count, msgs.GetMessages())
	}
}

// TestSendMessageGroupIdempotent 验证群聊同一 msg_id 重复发送同样幂等。
func TestSendMessageGroupIdempotent(t *testing.T) {
	clients := setupGroupUsers(t, 3)
	owner, m1, m2 := clients[0], clients[1], clients[2]

	groupResp := sendOK(owner, "create_group", &pb.CreateGroupRequest{
		Name: "IdemGroup", MemberUids: []int64{owner.uid, m1.uid, m2.uid},
	}, &pb.CreateGroupResponse{})
	if groupResp.GetGroupId() <= 0 {
		t.Fatal("create_group should return group_id")
	}
	// 等待建群系统消息扇出完成。
	time.Sleep(500 * time.Millisecond)
	owner.drainNotifs(func(n *appmsg.Notification) bool { return true })

	id := msgid.Generate()
	first := sendOK(owner, "send_message", &pb.SendMessageRequest{
		MsgId: id, Target: groupTarget(groupResp.GetGroupId()), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("idem group"),
	}, &pb.SendMessageResponse{})
	if first.GetMsgId() != id || first.GetSeq() == 0 {
		t.Fatalf("首次群发应返回相同 msg_id 与 seq, got %+v", first)
	}

	second := sendOK(owner, "send_message", &pb.SendMessageRequest{
		MsgId: id, Target: groupTarget(groupResp.GetGroupId()), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("idem group again"),
	}, &pb.SendMessageResponse{})
	// 幂等命中时服务端不再插入新行，回传相同 msg_id 与已有 seq。
	if second.GetMsgId() != id {
		t.Fatalf("群聊重复发送 msg_id=%q, want %q", second.GetMsgId(), id)
	}
	if second.GetSeq() != first.GetSeq() {
		t.Fatalf("群聊幂等重复发送应返回已有 seq=%d, got %v", first.GetSeq(), second.GetSeq())
	}

	// 等待可能的扇出后，发送方收件箱应只保留一条该 msg_id 的消息，且 seq 与首次一致。
	time.Sleep(500 * time.Millisecond)
	msgs := sendOK(owner, "get_messages", &pb.GetMessagesRequest{Target: groupTarget(groupResp.GetGroupId())}, &pb.GetMessagesResponse{})
	count := 0
	for _, m := range msgs.GetMessages() {
		if m.GetMsgId() == id {
			count++
			if m.GetSeq() != first.GetSeq() {
				t.Fatalf("群聊幂等后存储的 seq=%d, want %d", m.GetSeq(), first.GetSeq())
			}
		}
	}
	if count != 1 {
		t.Fatalf("群聊幂等后应只存在 1 条消息, got %d: %+v", count, msgs.GetMessages())
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
	resp := sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: "", Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("missing id"),
	}, &pb.SendMessageResponse{})
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_INVALID_ARGUMENT {
		t.Fatalf("缺失 msg_id error_code=%v, want ERROR_INVALID_ARGUMENT", resp.GetBase().GetCode())
	}
}

// TestSendMessageInvalidMsgID 验证非法 msg_id 被服务端拒绝。
func TestSendMessageInvalidMsgID(t *testing.T) {
	a := dial(t)
	b := dial(t)
	a.registerAndLogin(uniqueName("idem"), "pass1234", "Alice")
	b.registerAndLogin(uniqueName("idem"), "pass1234", "Bob")
	makeFriends(t, a, b)

	resp := sendErr(a, "send_message", &pb.SendMessageRequest{
		MsgId: "bad", Target: userTarget(b.uid), MsgType: pb.MessageType_MESSAGE_TYPE_TEXT, Body: textBody("invalid id"),
	}, &pb.SendMessageResponse{})
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_INVALID_ARGUMENT {
		t.Fatalf("非法 msg_id error_code=%v, want ERROR_INVALID_ARGUMENT", resp.GetBase().GetCode())
	}
}
