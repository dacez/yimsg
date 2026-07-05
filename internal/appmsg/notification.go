package appmsg

// Notification represents a typed push message sent to clients via WebSocket.
//
// 核心通知链路只在进程内传递结构体，出站时直接编码为 protobuf frame，
// 不再经过 JSON 序列化 / 反序列化中转。
type Notification struct {
	Type   string
	Target *ConversationTarget
	MsgID  string // 触发本次通知的消息 id；通知合并时取最新一条
	OrgID  int64  // org:updated 专用：发生变化的组织 ID
}

// NewMessageNotif creates a messages:received notification.
// msgID 为触发本次通知的消息 id；通知合并时取最新一条。
func NewMessageNotif(uid, groupID int64, msgID string) *Notification {
	target := NewConversationTarget(uid, groupID)
	return &Notification{Type: NotificationNameMessagesReceived, Target: &target, MsgID: msgID}
}

// ContactsUpdatedNotif creates a contacts:updated notification.
func ContactsUpdatedNotif() *Notification {
	return &Notification{Type: NotificationNameContactsUpdated}
}

// SessionKickedNotif creates a session:kicked notification.
func SessionKickedNotif() *Notification {
	return &Notification{Type: NotificationNameSessionKicked}
}

// ConversationsClearunreadNotif creates a conversations:clearunread notification.
// 仅提示某会话未读被清除，接收端只清未读红点、不触发拉取。
func ConversationsClearunreadNotif(uid, groupID int64) *Notification {
	target := NewConversationTarget(uid, groupID)
	return &Notification{Type: NotificationNameConversationsClearunread, Target: &target}
}

// ConversationsDeleteNotif creates a conversations:delete notification.
// 提示某会话被删除，接收端命中数据窗口则就地删除、不触发拉取。
func ConversationsDeleteNotif(uid, groupID int64) *Notification {
	target := NewConversationTarget(uid, groupID)
	return &Notification{Type: NotificationNameConversationsDelete, Target: &target}
}

// MessagesDeleteNotif creates a messages:delete notification.
// 提示某消息被删除，接收端命中数据窗口则就地删除、不触发拉取。
func MessagesDeleteNotif(uid, groupID int64, msgID string) *Notification {
	target := NewConversationTarget(uid, groupID)
	return &Notification{Type: NotificationNameMessagesDelete, Target: &target, MsgID: msgID}
}

// BlocklistUpdatedNotif creates a blocklist:updated notification.
func BlocklistUpdatedNotif() *Notification {
	return &Notification{Type: NotificationNameBlocklistUpdated}
}

// MutelistUpdatedNotif creates a mutelist:updated notification.
func MutelistUpdatedNotif() *Notification {
	return &Notification{Type: NotificationNameMutelistUpdated}
}

// OrgUpdatedNotif creates an org:updated notification.
// 轻通知只带 org_id，禁止携带增量数据；客户端收到后按 sync_org_tags 增量追平。
func OrgUpdatedNotif(orgID int64) func() *Notification {
	return func() *Notification {
		return &Notification{Type: NotificationNameOrgUpdated, OrgID: orgID}
	}
}
