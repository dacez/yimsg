package ws

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"yimsg/internal/appmsg"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

var protoJSONUnmarshal = protojson.UnmarshalOptions{
	DiscardUnknown: true,
}

func EncodeRequestBody(codec FrameCodec, typeID uint16, payload map[string]any) ([]byte, error) {
	msg, ok := NewRequestMessageByType(typeID)
	if !ok {
		return nil, fmt.Errorf("missing request message for type: %d", typeID)
	}
	clean := cleanPayload(payload)
	return encodeBody(codec, msg, clean)
}

func EncodeProtoBody(codec FrameCodec, msg proto.Message) ([]byte, error) {
	if codec != FrameCodecProtobuf {
		return nil, fmt.Errorf("unsupported codec: %q", byte(codec))
	}
	return proto.Marshal(msg)
}

func DecodeResponseBody(codec FrameCodec, typeID uint16, requestID uint64, body []byte) (map[string]any, error) {
	msg, ok := NewResponseMessageByType(typeID)
	if !ok {
		return nil, fmt.Errorf("missing response message for type: %d", typeID)
	}
	if err := decodeBody(codec, msg, body); err != nil {
		return nil, err
	}
	payload := protoMessageToMap(msg, true)
	base, _ := payload["base"].(map[string]any)
	code := int64FromAny(base["code"])
	msgText, _ := base["msg"].(string)
	delete(payload, "base")
	payload["request_id"] = strconv.FormatUint(requestID, 10)
	payload["ok"] = code == 0
	if code != 0 {
		payload["error"] = msgText
		payload["error_code"] = appmsg.ErrorCodeByNumber(code)
	}
	return payload, nil
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

func cleanPayload(payload map[string]any) map[string]any {
	clean := make(map[string]any, len(payload))
	for k, v := range payload {
		switch k {
		case "action", "request_id", "base":
			continue
		default:
			clean[k] = v
		}
	}
	return clean
}

func encodeBody(codec FrameCodec, msg proto.Message, payload map[string]any) ([]byte, error) {
	if codec != FrameCodecProtobuf {
		return nil, fmt.Errorf("unsupported codec: %q", byte(codec))
	}
	if err := mapToProtoMessage(payload, msg); err != nil {
		return nil, err
	}
	return proto.Marshal(msg)
}

func decodeBody(codec FrameCodec, msg proto.Message, body []byte) error {
	if codec != FrameCodecProtobuf {
		return fmt.Errorf("unsupported codec: %q", byte(codec))
	}
	return proto.Unmarshal(body, msg)
}

func mapToProtoMessage(payload map[string]any, msg proto.Message) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return protoJSONUnmarshal.Unmarshal(data, msg)
}

func protoMessageToMap(msg proto.Message, idsAsString bool) map[string]any {
	out := make(map[string]any)
	message := msg.ProtoReflect()
	message.Range(func(fd protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		name := string(fd.Name())
		out[name] = protoFieldToAny(string(message.Descriptor().Name()), fd, value, idsAsString)
		return true
	})
	return out
}

func protoFieldToAny(messageName string, fd protoreflect.FieldDescriptor, value protoreflect.Value, idsAsString bool) any {
	if fd.IsMap() {
		result := make(map[string]any)
		value.Map().Range(func(k protoreflect.MapKey, v protoreflect.Value) bool {
			result[k.String()] = protoScalarToAny(messageName, string(fd.MapValue().Name()), fd.MapValue(), v, idsAsString)
			return true
		})
		return result
	}
	if fd.IsList() {
		list := value.List()
		result := make([]any, 0, list.Len())
		for i := 0; i < list.Len(); i++ {
			result = append(result, protoScalarToAny(messageName, string(fd.Name()), fd, list.Get(i), idsAsString))
		}
		return result
	}
	return protoScalarToAny(messageName, string(fd.Name()), fd, value, idsAsString)
}

func protoScalarToAny(messageName, fieldName string, fd protoreflect.FieldDescriptor, value protoreflect.Value, idsAsString bool) any {
	switch fd.Kind() {
	case protoreflect.BoolKind:
		return value.Bool()
	case protoreflect.EnumKind:
		return int64(value.Enum())
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		return int64(value.Int())
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		return int64(value.Uint())
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		n := value.Int()
		if idsAsString && isStringIDField(messageName, fieldName) {
			return strconv.FormatInt(n, 10)
		}
		return n
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		n := value.Uint()
		if idsAsString && isStringIDField(messageName, fieldName) {
			return strconv.FormatUint(n, 10)
		}
		return n
	case protoreflect.StringKind:
		return value.String()
	case protoreflect.BytesKind:
		return value.Bytes()
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return protoMessageToMap(value.Message().Interface(), idsAsString)
	default:
		return nil
	}
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

func isStringIDField(messageName, fieldName string) bool {
	if messageName == "BaseResponse" && fieldName == "code" {
		return false
	}
	if messageName == "Message" && fieldName == "uid" {
		return false
	}
	return fieldName == "uid" ||
		strings.HasSuffix(fieldName, "_uid") ||
		strings.HasSuffix(fieldName, "_uids") ||
		strings.HasSuffix(fieldName, "_id") ||
		strings.HasSuffix(fieldName, "_ids")
}

func int64FromAny(value any) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case uint64:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	default:
		return 0
	}
}
