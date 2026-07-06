package appmsg

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Response is the unified server response envelope.
//
// 插件自定义返回值放在 Data（json.RawMessage），序列化时会被展平到顶层对象，
// 与核心字段合并，保持前端/测试读到的是扁平 JSON 格式。
type Response struct {
	RequestID uint64 `json:"request_id"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`

	// 插件自定义返回值（MarshalJSON 时展平到顶层）
	Data json.RawMessage `json:"-"`

	// Flattened data fields — only the relevant ones are set per response type.
	// Omitted fields are not included in JSON output.

	// RegisterResult
	UID *JSONInt64 `json:"uid,omitempty"`

	// LoginResult / AuthResult
	Token        string        `json:"token,omitempty"`
	ClientConfig *ClientConfig `json:"client_config,omitempty"`

	// Profile
	Profile *dal.User `json:"profile,omitempty"`

	// Contacts
	Contacts []Contact            `json:"contacts,omitempty"`
	Users    []dal.BlocklistEntry `json:"users,omitempty"`
	Mutelist []MutelistEntry      `json:"mutes,omitempty"`

	// ContactWrite
	Seq *int64 `json:"seq,omitempty"`

	// MessageSent
	MsgID *string `json:"msg_id,omitempty"`
	// Seq is shared with ContactWrite

	// MessageSync / ConversationMessages
	Messages []Message `json:"messages,omitempty"`

	// ConversationList
	Conversations []ConversationEntry `json:"conversations,omitempty"`
	Total         *int64              `json:"total,omitempty"`
	UnreadCount   *int64              `json:"unread_count,omitempty"`
	HasMore       *bool               `json:"has_more,omitempty"`
	CursorSeq     *int64              `json:"cursor_seq,omitempty"`

	// 展示通道统一分页信息（get_* 列表使用；sync_* 仍用 has_more + cursor_seq）。
	Page *PageInfo `json:"page,omitempty"`

	// GroupCreated
	GroupIDResp *JSONInt64 `json:"group_id,omitempty"`

	// GroupMembers
	Members []GroupMember `json:"members,omitempty"`

	// Batch
	Profiles []dal.User      `json:"profiles,omitempty"`
	Groups   []dal.GroupInfo `json:"groups,omitempty"`

	// Org（组织/tag 展示资料字典 + tags 展开与同步）
	Orgs     []OrgInfo `json:"orgs,omitempty"`
	TagInfos []TagInfo `json:"tag_infos,omitempty"`
	Tags     []Tag     `json:"tags,omitempty"`

	// Upload
	URL  string `json:"url,omitempty"`
	Size *int64 `json:"size,omitempty"`
}

// MarshalJSON 把 Data 字段合并到响应顶层，使得插件返回值与核心字段一样扁平。
func (r *Response) MarshalJSON() ([]byte, error) {
	type alias Response
	base, err := json.Marshal((*alias)(r))
	if err != nil {
		return nil, err
	}
	return mergeJSONObjects(base, r.Data), nil
}

// mergeJSONObjects 把两个 JSON 对象合并为一个。若 extra 为空或非对象，直接返回 base。
func mergeJSONObjects(base, extra []byte) []byte {
	if len(extra) == 0 {
		return base
	}
	var extraMap map[string]json.RawMessage
	if err := json.Unmarshal(extra, &extraMap); err != nil || len(extraMap) == 0 {
		return base
	}
	var baseMap map[string]json.RawMessage
	if err := json.Unmarshal(base, &baseMap); err != nil {
		return base
	}
	for k, v := range extraMap {
		if _, exists := baseMap[k]; !exists {
			baseMap[k] = v
		}
	}
	merged, err := json.Marshal(baseMap)
	if err != nil {
		return base
	}
	return merged
}

// PageInfo 是展示通道统一分页响应片段，桥接到 pb.PageInfo。
// 游标对客户端不透明；total<0 表示未知/未统计。
type PageInfo struct {
	StartCursor     string `json:"start_cursor"`
	EndCursor       string `json:"end_cursor"`
	HasMoreBackward bool   `json:"has_more_backward"`
	HasMoreForward  bool   `json:"has_more_forward"`
	Total           int64  `json:"total"`
}

// JSONInt64 serializes int64 as a JSON string to avoid precision loss.
type JSONInt64 int64

func (j JSONInt64) MarshalJSON() ([]byte, error) {
	return json.Marshal(fmt.Sprintf("%d", int64(j)))
}

func (j *JSONInt64) UnmarshalJSON(data []byte) error {
	var value any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&value); err != nil {
		return err
	}
	var parsed int64
	switch v := value.(type) {
	case string:
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return err
		}
		parsed = n
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return err
		}
		parsed = n
	}
	*j = JSONInt64(parsed)
	return nil
}

func NewJSONInt64(v int64) *JSONInt64 {
	j := JSONInt64(v)
	return &j
}

func Int64Ptr(v int64) *int64 {
	return &v
}

func BoolPtr(v bool) *bool {
	return &v
}

// ClientConfig contains client-side configuration returned on login/authenticate.
type ClientConfig struct {
	CacheTTLSeconds     int64 `json:"cache_ttl_seconds"`
	CacheMaxEntries     int   `json:"cache_max_entries"`
	RecallWindowSeconds int64 `json:"recall_window_seconds"`
	BatchMaxLimit       int64 `json:"batch_max_limit"`
}

// ConversationTarget represents a normalized direct or group conversation target.
// OrgID 仅通讯录条目（ContactTarget 语义）使用；会话目标永远不携带 OrgID。
type ConversationTarget struct {
	UID     *JSONInt64 `json:"uid,omitempty"`
	GroupID *JSONInt64 `json:"group_id,omitempty"`
	OrgID   *JSONInt64 `json:"org_id,omitempty"`
}

func NewConversationTarget(uid, groupID int64) ConversationTarget {
	if groupID > 0 {
		return ConversationTarget{GroupID: NewJSONInt64(groupID)}
	}
	if uid > 0 {
		return ConversationTarget{UID: NewJSONInt64(uid)}
	}
	return ConversationTarget{}
}

// NewContactTarget 构造通讯录条目目标：friend / group / org 三者互斥。
func NewContactTarget(uid, groupID, orgID int64) ConversationTarget {
	if orgID > 0 {
		return ConversationTarget{OrgID: NewJSONInt64(orgID)}
	}
	return NewConversationTarget(uid, groupID)
}

// Contact represents a normalized contact relationship.
type Contact struct {
	Target     ConversationTarget `json:"target"`
	Status     uint8              `json:"status"`
	Seq        int64              `json:"seq"`
	RemarkName string             `json:"remark_name"`
	SortKey    string             `json:"sort_key"`
	SearchText string             `json:"search_text"`
}

// MutelistEntry represents a normalized conversation mute setting.
type MutelistEntry struct {
	Target    ConversationTarget `json:"target"`
	Status    uint8              `json:"status"`
	Seq       int64              `json:"seq"`
	UpdatedAt int64              `json:"updated_at,omitempty"`
}

// Message represents a normalized message response.
// Body 承载 protojson 形式的 MessageBody。
type Message struct {
	Seq      int64              `json:"seq"`
	MsgID    string             `json:"msg_id"`
	FromUID  JSONInt64          `json:"from_uid"`
	Target   ConversationTarget `json:"target"`
	MsgType  int8               `json:"msg_type"`
	Body     json.RawMessage    `json:"body"`
	SendTime int64              `json:"send_time"`
	Status   uint8              `json:"status"`
}

var messageBodyMarshal = protojson.MarshalOptions{}

func bodyToJSON(raw []byte) json.RawMessage {
	var body pb.MessageBody
	if len(raw) > 0 {
		if err := proto.Unmarshal(raw, &body); err != nil {
			return json.RawMessage("{}")
		}
	}
	data, err := messageBodyMarshal.Marshal(&body)
	if err != nil {
		return json.RawMessage("{}")
	}
	return json.RawMessage(data)
}

func MessageFromDAL(m dal.Message) Message {
	return Message{
		Seq:      m.Seq,
		MsgID:    m.MsgID,
		FromUID:  JSONInt64(m.FromUID),
		Target:   NewConversationTarget(m.ToUID, m.GroupID),
		MsgType:  m.MsgType,
		Body:     bodyToJSON(m.Body),
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
	Target      ConversationTarget `json:"target"`
	LastSeq     int64              `json:"last_seq"`
	LastMsg     *Message           `json:"last_msg"`
	UnreadCount int64              `json:"unread_count"`
	Status      uint8              `json:"status"`
}

// GroupMember represents a group member entry.
type GroupMember struct {
	UID      JSONInt64 `json:"uid"`
	Role     int8      `json:"role"`
	JoinedAt int64     `json:"joined_at"`
}

// OrgInfo 是组织展示资料字典：仅名字/头像，不参与同步（与 GroupInfo 同构）。
type OrgInfo struct {
	OrgID  JSONInt64 `json:"org_id"`
	Name   string    `json:"name"`
	Avatar string    `json:"avatar,omitempty"`
}

// TagInfo 是 tag（部门/横向分组）展示资料字典：仅名字/头像，不参与同步。
type TagInfo struct {
	TagID  JSONInt64 `json:"tag_id"`
	Name   string    `json:"name"`
	Avatar string    `json:"avatar,omitempty"`
}

// Tag 是 tags（组织关系表）条目：在线展开与同步共用，唯一的同步域。
type Tag struct {
	TagID     JSONInt64 `json:"tag_id"`
	ChildID   JSONInt64 `json:"child_id"`
	ChildType uint8     `json:"child_type"`
	Title     string    `json:"title,omitempty"`
	Rank      int64     `json:"rank"`
	SortKey   string    `json:"sort_key"`
	Role      uint8     `json:"role"`
	Status    uint8     `json:"status"`
	Seq       int64     `json:"seq"`
}

// OK responses

func OKEmpty(requestID uint64) *Response {
	return &Response{RequestID: requestID, OK: true}
}

func OKRegister(requestID uint64, uid int64) *Response {
	return &Response{RequestID: requestID, OK: true, UID: NewJSONInt64(uid)}
}

func OKLogin(requestID uint64, token string, uid int64, cc *ClientConfig) *Response {
	return &Response{
		RequestID: requestID, OK: true,
		Token: token, UID: NewJSONInt64(uid), ClientConfig: cc,
	}
}

func OKAuth(requestID uint64, uid int64, cc *ClientConfig) *Response {
	return &Response{
		RequestID: requestID, OK: true,
		UID: NewJSONInt64(uid), ClientConfig: cc,
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
	return &Response{RequestID: requestID, OK: true, GroupIDResp: NewJSONInt64(groupID)}
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
