package ws

import (
	"fmt"
	"yimsg/internal/appmsg"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/proto"
)

func EncodeProtoBody(codec FrameCodec, msg proto.Message) ([]byte, error) {
	if codec != FrameCodecProtobuf {
		return nil, fmt.Errorf("unsupported codec: %q", byte(codec))
	}
	return proto.Marshal(msg)
}

func EncodeNotificationBody(codec FrameCodec, n *appmsg.Notification) (uint16, []byte, error) {
	msg := notificationToProto(n)
	typeID, ok := notificationTypeOf(msg)
	if !ok {
		return 0, nil, fmt.Errorf("unknown notification type: %s", n.Type)
	}
	body, err := EncodeProtoBody(codec, msg)
	return typeID, body, err
}

func DecodeNotificationBody(codec FrameCodec, typeID uint16, body []byte) (*appmsg.Notification, error) {
	msg, ok := NewNotificationMessageByType(typeID)
	if !ok {
		return nil, fmt.Errorf("missing notification message for type: %d", typeID)
	}
	if err := decodeBody(codec, msg, body); err != nil {
		return nil, err
	}
	return notificationFromProto(typeID, msg), nil
}

func decodeBody(codec FrameCodec, msg proto.Message, body []byte) error {
	if codec != FrameCodecProtobuf {
		return fmt.Errorf("unsupported codec: %q", byte(codec))
	}
	return proto.Unmarshal(body, msg)
}

func notificationToProto(n *appmsg.Notification) proto.Message {
	switch n.Type {
	case appmsg.NotificationNameMessagesReceived:
		return &pb.MessagesReceivedNotification{Target: appTargetToProto(n.Target), MsgId: n.MsgID}
	case appmsg.NotificationNameConversationsClearunread:
		return &pb.ConversationsClearunreadNotification{Target: appTargetToProto(n.Target)}
	case appmsg.NotificationNameConversationsDelete:
		return &pb.ConversationsDeleteNotification{Target: appTargetToProto(n.Target)}
	case appmsg.NotificationNameMessagesDelete:
		return &pb.MessagesDeleteNotification{Target: appTargetToProto(n.Target), MsgId: n.MsgID}
	case appmsg.NotificationNameContactsUpdated:
		return &pb.ContactsUpdatedNotification{}
	case appmsg.NotificationNameSessionKicked:
		return &pb.SessionKickedNotification{}
	case appmsg.NotificationNameBlocklistUpdated:
		return &pb.BlocklistUpdatedNotification{}
	case appmsg.NotificationNameMutelistUpdated:
		return &pb.MutelistUpdatedNotification{}
	case appmsg.NotificationNameOrgUpdated:
		return &pb.OrgUpdatedNotification{OrgId: n.OrgID}
	default:
		return &pb.SessionKickedNotification{}
	}
}

func appTargetToProto(target *appmsg.ConversationTarget) *pb.ConversationTarget {
	if target == nil {
		return nil
	}
	if target.GroupID != nil {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: int64(*target.GroupID)}}
	}
	if target.UID != nil {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: int64(*target.UID)}}
	}
	return nil
}

func appTargetFromProto(target *pb.ConversationTarget) *appmsg.ConversationTarget {
	if target == nil {
		return nil
	}
	converted := appmsg.NewConversationTarget(target.GetUid(), target.GetGroupId())
	return &converted
}

func notificationFromProto(typeID uint16, msg proto.Message) *appmsg.Notification {
	switch pb.Type(typeID) {
	case pb.Type_TYPE_NOTIFY_MESSAGES_RECEIVED:
		typed := msg.(*pb.MessagesReceivedNotification)
		return &appmsg.Notification{Type: appmsg.NotificationNameMessagesReceived, Target: appTargetFromProto(typed.GetTarget()), MsgID: typed.GetMsgId()}
	case pb.Type_TYPE_NOTIFY_CONVERSATIONS_CLEARUNREAD:
		typed := msg.(*pb.ConversationsClearunreadNotification)
		return &appmsg.Notification{Type: appmsg.NotificationNameConversationsClearunread, Target: appTargetFromProto(typed.GetTarget())}
	case pb.Type_TYPE_NOTIFY_CONVERSATIONS_DELETE:
		typed := msg.(*pb.ConversationsDeleteNotification)
		return &appmsg.Notification{Type: appmsg.NotificationNameConversationsDelete, Target: appTargetFromProto(typed.GetTarget())}
	case pb.Type_TYPE_NOTIFY_MESSAGES_DELETE:
		typed := msg.(*pb.MessagesDeleteNotification)
		return &appmsg.Notification{Type: appmsg.NotificationNameMessagesDelete, Target: appTargetFromProto(typed.GetTarget()), MsgID: typed.GetMsgId()}
	case pb.Type_TYPE_NOTIFY_CONTACTS_UPDATED:
		return &appmsg.Notification{Type: appmsg.NotificationNameContactsUpdated}
	case pb.Type_TYPE_NOTIFY_SESSION_KICKED:
		return &appmsg.Notification{Type: appmsg.NotificationNameSessionKicked}
	case pb.Type_TYPE_NOTIFY_BLOCKLIST_UPDATED:
		return &appmsg.Notification{Type: appmsg.NotificationNameBlocklistUpdated}
	case pb.Type_TYPE_NOTIFY_MUTELIST_UPDATED:
		return &appmsg.Notification{Type: appmsg.NotificationNameMutelistUpdated}
	case pb.Type_TYPE_NOTIFY_ORG_UPDATED:
		typed := msg.(*pb.OrgUpdatedNotification)
		return &appmsg.Notification{Type: appmsg.NotificationNameOrgUpdated, OrgID: typed.GetOrgId()}
	default:
		return &appmsg.Notification{}
	}
}
