// Package appmsg defines the application-level WebSocket message types.
package appmsg

import "encoding/json"

// BaseRequest 是服务端框架填入的只读请求上下文。业务代码通过 Request.Base()
// 读取，不能从客户端 body 覆盖它。
type BaseRequest struct {
	UID       int64
	RequestID uint64
}

// Request is a raw incoming WebSocket request decoded from the protobuf source
// schema. Action and RequestID are derived from the binary frame header.
type Request struct {
	Action    string `json:"action"`
	RequestID uint64 `json:"request_id"`
	base      BaseRequest

	// Auth
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	Token    string `json:"token,omitempty"`

	// User
	UID         json.Number `json:"uid,omitempty"`
	Avatar      string      `json:"avatar,omitempty"`
	OldPassword string      `json:"old_password,omitempty"`
	NewPassword string      `json:"new_password,omitempty"`

	// Contact
	FriendUID  json.Number `json:"friend_uid,omitempty"`
	RemarkName string      `json:"remark_name,omitempty"`
	Status     *uint8      `json:"status,omitempty"`

	// Message
	ToUID   json.Number `json:"to_uid,omitempty"`
	GroupID json.Number `json:"group_id,omitempty"`
	MsgID   string      `json:"msg_id,omitempty"`
	MsgType int8        `json:"msg_type,omitempty"`
	Content string      `json:"content,omitempty"`
	Muted   bool        `json:"muted,omitempty"`

	// Sync / Pagination
	LastSeq   int64 `json:"last_seq,omitempty"`
	BeforeSeq int64 `json:"before_seq,omitempty"`
	AfterSeq  int64 `json:"after_seq,omitempty"`
	AroundSeq int64 `json:"around_seq,omitempty"`
	Limit     int64 `json:"limit,omitempty"`
	Offset    int64 `json:"offset,omitempty"`
	Rebuild   bool  `json:"rebuild,omitempty"`

	// Group
	Name       string        `json:"name,omitempty"`
	MemberUIDs []json.Number `json:"member_uids,omitempty"`

	// Batch
	GroupIDs []json.Number `json:"group_ids,omitempty"`
	UIDs     []json.Number `json:"uids,omitempty"` // get_user_infos
	ToUIDs   []json.Number `json:"to_uids,omitempty"`

	// Raw 原始 JSON 字节。由 WS 层在 Unmarshal 后回填，供插件 handler
	// 反序列化自己的参数结构体。核心 action 不使用此字段。
	Raw json.RawMessage `json:"-"`
}

// Base returns the framework-owned request context.
func (r *Request) Base() BaseRequest {
	return r.base
}

// SetBase 写入服务端框架拥有的请求上下文。
func (r *Request) SetBase(base BaseRequest) {
	r.base = base
}

// RequiresAuth returns true if the action requires an authenticated connection.
func (r *Request) RequiresAuth() bool {
	return CoreActionRequiresAuth(r.Action)
}

const defaultLimit int64 = 200

// EffectiveLimit returns the limit with a default of 200 and the caller-provided cap.
func (r *Request) EffectiveLimit(maxLimit int64) int64 {
	if maxLimit <= 0 {
		maxLimit = defaultLimit
	}
	if r.Limit <= 0 {
		if defaultLimit > maxLimit {
			return maxLimit
		}
		return defaultLimit
	}
	if r.Limit > maxLimit {
		return maxLimit
	}
	return r.Limit
}
