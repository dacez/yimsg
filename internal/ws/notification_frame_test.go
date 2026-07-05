package ws

import (
	"testing"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/proto"
)

func TestNewMessagesReceivedNotificationFrame(t *testing.T) {
	for _, endian := range []FrameEndian{FrameEndianBig, FrameEndianLittle} {
		n := &pb.MessagesReceivedNotification{Target: &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: 42}}}
		data, err := NewMessagesReceivedNotificationFrame(FrameCodecProtobuf, endian, n)
		if err != nil {
			t.Fatalf("endian %d: %v", endian, err)
		}
		frame, err := DecodeFrame(data)
		if err != nil {
			t.Fatalf("decode endian %d: %v", endian, err)
		}
		if frame.RequestID != NotificationRequestID {
			t.Fatalf("request_id = %d, want %d", frame.RequestID, NotificationRequestID)
		}
		if frame.Type != uint16(pb.Type_TYPE_NOTIFY_MESSAGES_RECEIVED) {
			t.Fatalf("type = %d", frame.Type)
		}
		var decoded pb.MessagesReceivedNotification
		if err := proto.Unmarshal(frame.Body, &decoded); err != nil {
			t.Fatalf("unmarshal body: %v", err)
		}
		if decoded.GetTarget().GetGroupId() != 42 {
			t.Fatalf("group_id = %d, want 42", decoded.GetTarget().GetGroupId())
		}
	}
}

func TestEncodeNotificationFrameDispatch(t *testing.T) {
	data, err := EncodeNotificationFrame(FrameCodecProtobuf, FrameEndianBig, &pb.ContactsUpdatedNotification{})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := DecodeFrame(data)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Type != uint16(pb.Type_TYPE_NOTIFY_CONTACTS_UPDATED) {
		t.Fatalf("type = %d", frame.Type)
	}
}

func TestEncodeNotificationFrameUnknownMessage(t *testing.T) {
	// 非通知消息必须返回错误，而不是静默编码。
	if _, err := EncodeNotificationFrame(FrameCodecProtobuf, FrameEndianBig, &pb.LoginResponse{}); err == nil {
		t.Fatal("expected error for non-notification message")
	}
}
