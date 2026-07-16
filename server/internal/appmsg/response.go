package appmsg

import (
	"yimsg/server/internal/dal"
)

// Response is the unified server response envelope：业务方法构造它之后，
// server/internal/service/protobuf_methods.go 的 toXxxResponse 会把它转成真正上线
// 的 pb.XxxResponse 类型发出去。这个结构体只是进程内的构造中转，不经过任何
// 序列化，线上协议是 protocol/yimsg.proto 定义的二进制 protobuf 帧。
type Response struct {
	RequestID uint64
	OK        bool
	Error     string
	ErrorCode string

	// Flattened data fields — only the relevant ones are set per response type.

	// RegisterResult
	UID *int64

	// LoginResult / AuthResult
	Token        string
	ClientConfig *ClientConfig

	// Profile
	Profile *dal.User

	// Contacts
	Contacts []Contact
	Users    []dal.BlocklistEntry
	Mutelist []MutelistEntry

	// ContactWrite
	Seq *int64

	// MessageSent
	MsgID *string
	// Seq is shared with ContactWrite

	// MessageSync / ConversationMessages
	Messages []Message

	// ConversationList
	Conversations []ConversationEntry
	Total         *int64
	UnreadCount   *int64
	HasMore       *bool
	CursorSeq     *int64

	// 展示通道统一分页信息（get_* 列表使用；sync_* 仍用 has_more + cursor_seq）。
	Page *PageInfo

	// GroupCreated
	GroupIDResp *int64

	// GroupMembers
	Members []GroupMember

	// Batch
	Profiles []dal.User
	Groups   []dal.GroupInfo

	// Org（组织/tag 展示资料字典 + tags 展开与同步 + 管理面）
	Orgs         []OrgInfo
	TagInfos     []TagInfo
	Tags         []Tag
	OrgTagID     *int64
	OrgAdminUIDs []int64
	OrgIDResp    *int64

	// Upload
	URL  string
	Size *int64
}

// PageInfo 是展示通道统一分页响应片段，桥接到 pb.PageInfo。
// 游标对客户端不透明；total<0 表示未知/未统计。
type PageInfo struct {
	StartCursor     string
	EndCursor       string
	HasMoreBackward bool
	HasMoreForward  bool
	Total           int64
}

func Int64Ptr(v int64) *int64 {
	return &v
}

func BoolPtr(v bool) *bool {
	return &v
}

// ClientConfig contains client-side configuration returned on login/authenticate.
type ClientConfig struct {
	CacheTTLSeconds     int64
	CacheMaxEntries     int
	RecallWindowSeconds int64
	BatchMaxLimit       int64
}

// ConversationTarget represents a normalized direct or group conversation target.
// OrgID 仅通讯录条目（ContactTarget 语义）使用；会话目标永远不携带 OrgID。
type ConversationTarget struct {
	UID     *int64
	GroupID *int64
	OrgID   *int64
}

func NewConversationTarget(uid, groupID int64) ConversationTarget {
	if groupID > 0 {
		return ConversationTarget{GroupID: Int64Ptr(groupID)}
	}
	if uid > 0 {
		return ConversationTarget{UID: Int64Ptr(uid)}
	}
	return ConversationTarget{}
}

// NewContactTarget 构造通讯录条目目标：friend / group / org 三者互斥。
func NewContactTarget(uid, groupID, orgID int64) ConversationTarget {
	if orgID > 0 {
		return ConversationTarget{OrgID: Int64Ptr(orgID)}
	}
	return NewConversationTarget(uid, groupID)
}

// Contact represents a normalized contact relationship.
type Contact struct {
	Target     ConversationTarget
	Status     uint8
	Seq        int64
	RemarkName string
	SortKey    string
	SearchText string
}

// MutelistEntry represents a normalized conversation mute setting.
type MutelistEntry struct {
	Target    ConversationTarget
	Status    uint8
	Seq       int64
	UpdatedAt int64
}

// Message represents a normalized message response.
// Body 是原始 protobuf 编码的 MessageBody 字节，原样透传给
// server/internal/service/protobuf_methods.go 的 messageToProto，不做任何 JSON 中转。
type Message struct {
	Seq      int64
	MsgID    string
	FromUID  int64
	Target   ConversationTarget
	MsgType  int8
	Body     []byte
	SendTime int64
	Status   uint8
}

func MessageFromDAL(m dal.Message) Message {
	return Message{
		Seq:      m.Seq,
		MsgID:    m.MsgID,
		FromUID:  m.FromUID,
		Target:   NewConversationTarget(m.ToUID, m.GroupID),
		MsgType:  m.MsgType,
		Body:     m.Body,
		SendTime: m.SendTime,
		Status:   m.Status,
	}
}

func MessagesFromDAL(messages []dal.Message) []Message {
	result := make([]Message, len(messages))
	for i, message := range messages {
		result[i] = MessageFromDAL(message)
	}
	return result
}

// ConversationEntry represents a conversation in the list.
type ConversationEntry struct {
	Target      ConversationTarget
	LastSeq     int64
	LastMsg     *Message
	UnreadCount int64
	Status      uint8
}

// GroupMember represents a group member entry.
type GroupMember struct {
	UID      int64
	Role     int8
	JoinedAt int64
}

// OrgInfo 是组织展示资料字典：仅名字/头像，不参与同步（与 GroupInfo 同构）。
type OrgInfo struct {
	OrgID  int64
	Name   string
	Avatar string
}

// TagInfo 是 tag（部门/横向分组）展示资料字典：仅名字/头像，不参与同步。
type TagInfo struct {
	TagID  int64
	Name   string
	Avatar string
}

// Tag 是 tags（组织关系表）条目：在线展开与同步共用，唯一的同步域。
type Tag struct {
	TagID     int64
	ChildID   int64
	ChildType uint8
	Title     string
	Rank      int64
	SortKey   string
	Status    uint8
	Seq       int64
}

// OK responses

func OKEmpty(requestID uint64) *Response {
	return &Response{RequestID: requestID, OK: true}
}

func OKRegister(requestID uint64, uid int64) *Response {
	return &Response{RequestID: requestID, OK: true, UID: Int64Ptr(uid)}
}

func OKLogin(requestID uint64, token string, uid int64, cc *ClientConfig) *Response {
	return &Response{
		RequestID: requestID, OK: true,
		Token: token, UID: Int64Ptr(uid), ClientConfig: cc,
	}
}

func OKAuth(requestID uint64, uid int64, cc *ClientConfig) *Response {
	return &Response{
		RequestID: requestID, OK: true,
		UID: Int64Ptr(uid), ClientConfig: cc,
	}
}

func OKListContacts(requestID uint64, contacts []Contact) *Response {
	if contacts == nil {
		contacts = []Contact{}
	}
	return &Response{RequestID: requestID, OK: true, Contacts: contacts}
}

func OKContactWrite(requestID uint64, seq int64) *Response {
	return &Response{RequestID: requestID, OK: true, Seq: Int64Ptr(seq)}
}

func OKMessageSent(requestID uint64, msgID string, seq int64) *Response {
	return &Response{RequestID: requestID, OK: true, MsgID: &msgID, Seq: Int64Ptr(seq)}
}

func OKConversationList(requestID uint64, conversations []ConversationEntry) *Response {
	if conversations == nil {
		conversations = []ConversationEntry{}
	}
	return &Response{RequestID: requestID, OK: true, Conversations: conversations}
}

func OKUnreadCount(requestID uint64, count int64) *Response {
	return &Response{RequestID: requestID, OK: true, UnreadCount: Int64Ptr(count)}
}

func OKConversationMessages(requestID uint64, messages []dal.Message) *Response {
	return &Response{RequestID: requestID, OK: true, Messages: MessagesFromDAL(messages)}
}

func OKGroupCreated(requestID uint64, groupID int64) *Response {
	return &Response{RequestID: requestID, OK: true, GroupIDResp: Int64Ptr(groupID)}
}

func OKGroupMembers(requestID uint64, members []GroupMember) *Response {
	if members == nil {
		members = []GroupMember{}
	}
	return &Response{RequestID: requestID, OK: true, Members: members}
}

func OKContactCount(requestID uint64, total int64) *Response {
	return &Response{RequestID: requestID, OK: true, Total: Int64Ptr(total)}
}

func OKProfiles(requestID uint64, profiles []dal.User) *Response {
	if profiles == nil {
		profiles = []dal.User{}
	}
	return &Response{RequestID: requestID, OK: true, Profiles: profiles}
}

func OKGroupInfos(requestID uint64, groups []dal.GroupInfo) *Response {
	if groups == nil {
		groups = []dal.GroupInfo{}
	}
	return &Response{RequestID: requestID, OK: true, Groups: groups}
}

func OKSyncContacts(requestID uint64, contacts []Contact) *Response {
	if contacts == nil {
		contacts = []Contact{}
	}
	return &Response{RequestID: requestID, OK: true, Contacts: contacts}
}

func OKBlocklistUsers(requestID uint64, users []dal.BlocklistEntry) *Response {
	if users == nil {
		users = []dal.BlocklistEntry{}
	}
	return &Response{RequestID: requestID, OK: true, Users: users}
}

func mutelistFromDAL(mutes []dal.MutelistEntry) []MutelistEntry {
	result := make([]MutelistEntry, len(mutes))
	for i, mute := range mutes {
		result[i] = MutelistEntry{
			Target:    NewConversationTarget(mute.ToUID, mute.GroupID),
			Status:    mute.Status,
			Seq:       mute.Seq,
			UpdatedAt: mute.UpdatedAt,
		}
	}
	return result
}

func OKMutelist(requestID uint64, mutes []dal.MutelistEntry) *Response {
	return &Response{RequestID: requestID, OK: true, Mutelist: mutelistFromDAL(mutes)}
}

func OKOrgInfos(requestID uint64, orgs []OrgInfo) *Response {
	if orgs == nil {
		orgs = []OrgInfo{}
	}
	return &Response{RequestID: requestID, OK: true, Orgs: orgs}
}

func OKTagInfos(requestID uint64, tagInfos []TagInfo) *Response {
	if tagInfos == nil {
		tagInfos = []TagInfo{}
	}
	return &Response{RequestID: requestID, OK: true, TagInfos: tagInfos}
}

func OKGetTags(requestID uint64, tags []Tag) *Response {
	if tags == nil {
		tags = []Tag{}
	}
	return &Response{RequestID: requestID, OK: true, Tags: tags}
}

func OKSyncTags(requestID uint64, tags []Tag) *Response {
	if tags == nil {
		tags = []Tag{}
	}
	return &Response{RequestID: requestID, OK: true, Tags: tags}
}

func OKOrgTagCreated(requestID uint64, tagID int64) *Response {
	return &Response{RequestID: requestID, OK: true, OrgTagID: Int64Ptr(tagID)}
}

func OKOrgCreated(requestID uint64, orgID int64) *Response {
	return &Response{RequestID: requestID, OK: true, OrgIDResp: Int64Ptr(orgID)}
}

func OKOrgAdmins(requestID uint64, uids []int64) *Response {
	out := make([]int64, len(uids))
	copy(out, uids)
	return &Response{RequestID: requestID, OK: true, OrgAdminUIDs: out}
}

func OKSearch(requestID uint64, profile *dal.User) *Response {
	return &Response{RequestID: requestID, OK: true, Profile: profile}
}

// Error response

func ErrResponseCode(requestID uint64, errorCode, errMsg string) *Response {
	return &Response{RequestID: requestID, OK: false, ErrorCode: errorCode, Error: errMsg}
}

func ErrAuthFailed(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeAuthFailed, errMsg)
}

func ErrInvalidArgument(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeInvalidArgument, errMsg)
}

func ErrNotFound(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeNotFound, errMsg)
}

func ErrAlreadyExists(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeAlreadyExists, errMsg)
}

func ErrConflict(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeConflict, errMsg)
}

func ErrForbidden(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeForbidden, errMsg)
}

func ErrSeqTooOld(requestID uint64) *Response {
	return ErrResponseCode(requestID, ErrorCodeSeqTooOld, "seq_too_old")
}

func ErrInternal(requestID uint64, errMsg string) *Response {
	return ErrResponseCode(requestID, ErrorCodeInternal, errMsg)
}
