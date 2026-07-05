package ws

import (
	"testing"
	"yimsg/internal/appmsg"
)

func TestProtobufNotificationKeepsJSONInt64Fields(t *testing.T) {
	typeID, body, err := EncodeNotificationBody(FrameCodecProtobuf, &appmsg.Notification{
		Type:   appmsg.NotificationNameMessagesReceived,
		Target: &appmsg.ConversationTarget{GroupID: appmsg.NewJSONInt64(12345)},
	})
	if err != nil {
		t.Fatalf("encode notification: %v", err)
	}
	notif, err := DecodeNotificationBody(FrameCodecProtobuf, typeID, body)
	if err != nil {
		t.Fatalf("decode notification: %v", err)
	}
	if notif.Type != appmsg.NotificationNameMessagesReceived || notif.Target == nil || notif.Target.GroupID == nil || int64(*notif.Target.GroupID) != 12345 {
		t.Fatalf("notification = %+v", notif)
	}
}
