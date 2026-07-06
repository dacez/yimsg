package e2e

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"yimsg/internal/msgid"
	wsproto "yimsg/internal/ws"

	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// JSON types — mirrors server protocol
// ---------------------------------------------------------------------------

type wsRequest map[string]any

type wsResponse struct {
	RequestID string `json:"request_id"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`

	UID   string `json:"uid,omitempty"`
	Token string `json:"token,omitempty"`

	ClientConfig *struct {
		CacheTTLSeconds     int64 `json:"cache_ttl_seconds"`
		CacheMaxEntries     int   `json:"cache_max_entries"`
		RecallWindowSeconds int64 `json:"recall_window_seconds"`
	} `json:"client_config,omitempty"`

	Profile  *userInfo  `json:"profile,omitempty"`
	Profiles []userInfo `json:"profiles,omitempty"`

	Contacts []contact       `json:"contacts,omitempty"`
	Users    []blockUser     `json:"users,omitempty"`
	Mutelist []mutelistEntry `json:"mutes,omitempty"`
	Seq      *int64          `json:"seq,omitempty"`
	Total    int64           `json:"total,omitempty"`

	MsgID   string `json:"msg_id,omitempty"`
	MediaID string `json:"media_id,omitempty"`

	Messages []message `json:"messages,omitempty"`

	Conversations []conversation `json:"conversations,omitempty"`
	UnreadCount   int64          `json:"unread_count,omitempty"`

	// has_more / cursor_seq 为 proto3 标量：false / 0 在 wire 上不出现，解码后为 nil，
	// 调用方用 hasMoreVal / cursorSeqVal 归一化（nil 视为 false / 0）。sync_* 用这两个字段。
	HasMore   *bool  `json:"has_more,omitempty"`
	CursorSeq *int64 `json:"cursor_seq,omitempty"`

	// Page 是展示通道（get_*）统一分页信息；游标不透明，由测试原样透传。
	Page *pageInfo `json:"page,omitempty"`

	GroupID string        `json:"group_id,omitempty"`
	Groups  []groupInfo   `json:"groups,omitempty"`
	Members []groupMember `json:"members,omitempty"`

	URL  string `json:"url,omitempty"`
	Size *int64 `json:"size,omitempty"`

	// 组织域：展示资料字典（org/tag）/ tags（组织关系表）展开与同步。
	// get_tag_infos 与 get_tags/sync_tags 的响应字段在 wire 上都叫 "tags"，
	// 用同一个 tagJSON（两种形状的并集）承接，靠调用方读取各自用到的子集字段。
	Orgs []orgInfoJSON `json:"orgs,omitempty"`
	Tags []tagJSON     `json:"tags,omitempty"`
}

// 组织域响应条目。int64 ID 在 wire→JSON 映射中输出为字符串；proto3 零值字段缺省。
type orgInfoJSON struct {
	OrgID  string `json:"org_id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"`
}

// tagJSON 是 get_tag_infos（TagInfo：tag_id/name/avatar）与
// get_tags/sync_tags（Tag：tag_id/child_id/...）两种响应形状的并集。
type tagJSON struct {
	TagID     string `json:"tag_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Avatar    string `json:"avatar,omitempty"`
	ChildID   string `json:"child_id,omitempty"`
	ChildType int    `json:"child_type,omitempty"`
	Title     string `json:"title,omitempty"`
	Rank      int64  `json:"rank,omitempty"`
	SortKey   string `json:"sort_key,omitempty"`
	Role      int    `json:"role,omitempty"`
	Status    int    `json:"status,omitempty"`
	Seq       int64  `json:"seq,omitempty"`
}

// hasMoreVal / cursorSeqVal 把可能缺省（proto3 false / 0 不上 wire）的指针归一化。
func hasMoreVal(p *bool) bool {
	return p != nil && *p
}

func cursorSeqVal(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// pageInfo 对应 PageInfo：展示通道统一分页响应片段。
type pageInfo struct {
	StartCursor     string `json:"start_cursor,omitempty"`
	EndCursor       string `json:"end_cursor,omitempty"`
	HasMoreBackward bool   `json:"has_more_backward,omitempty"`
	HasMoreForward  bool   `json:"has_more_forward,omitempty"`
	Total           int64  `json:"total,omitempty"`
}

// pageOf 返回响应的分页信息，缺省时给出零值，便于断言。
func pageOf(r *wsResponse) pageInfo {
	if r.Page == nil {
		return pageInfo{}
	}
	return *r.Page
}

type userInfo struct {
	UID       string `json:"uid"`
	Username  string `json:"username"`
	Nickname  string `json:"nickname"`
	Avatar    string `json:"avatar"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type contact struct {
	FriendUID  string `json:"friend_uid"`
	OrgID      string `json:"org_id"`
	Status     uint8  `json:"status"`
	Seq        int64  `json:"seq"`
	RemarkName string `json:"remark_name"`
}

type blockUser struct {
	UID       string `json:"uid"`
	Status    uint8  `json:"status"`
	Seq       int64  `json:"seq"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type mutelistEntry struct {
	ToUID     string `json:"to_uid"`
	GroupID   string `json:"group_id"`
	Status    uint8  `json:"status"`
	Seq       int64  `json:"seq"`
	UpdatedAt int64  `json:"updated_at"`
}

const statusDeleted uint8 = 0xff

// messageBody mirrors protobuf MessageBody (snake_case proto names).
type messageBody struct {
	Text *struct {
		Text string `json:"text"`
	} `json:"text"`
	Markdown *struct {
		Markdown string `json:"markdown"`
	} `json:"markdown"`
	System *struct {
		Text string `json:"text"`
	} `json:"system"`
	Image *struct {
		MediaID string `json:"media_id"`
		Caption string `json:"caption"`
		Mime    string `json:"mime"`
	} `json:"image"`
	File *struct {
		MediaID string `json:"media_id"`
		Name    string `json:"name"`
	} `json:"file"`
	Quote *struct {
		QuoteMsgID   string `json:"quote_msg_id"`
		QuotePreview string `json:"quote_preview"`
		Text         *struct {
			Text string `json:"text"`
		} `json:"text"`
	} `json:"quote"`
	Recall *struct {
		MsgID       string `json:"msg_id"`
		OperatorUID string `json:"operator_uid"`
		RecallTime  int64  `json:"recall_time"`
		Text        string `json:"text"`
	} `json:"recall"`
}

type message struct {
	Seq      int64       `json:"seq"`
	MsgID    string      `json:"msg_id"`
	FromUID  string      `json:"from_uid"`
	ToUID    string      `json:"to_uid"`
	GroupID  string      `json:"group_id"`
	MsgType  int8        `json:"msg_type"`
	Body     messageBody `json:"body"`
	SendTime int64       `json:"send_time"`
}

// text 返回消息正文中可读文本，用于断言。
func (m message) text() string {
	switch {
	case m.Body.Text != nil:
		return m.Body.Text.Text
	case m.Body.Markdown != nil:
		return m.Body.Markdown.Markdown
	case m.Body.System != nil:
		return m.Body.System.Text
	case m.Body.Quote != nil && m.Body.Quote.Text != nil:
		return m.Body.Quote.Text.Text
	case m.Body.Recall != nil:
		return m.Body.Recall.Text
	default:
		return ""
	}
}

type conversation struct {
	GroupID     string  `json:"group_id"`
	FriendUID   string  `json:"friend_uid"`
	LastSeq     int64   `json:"last_seq"`
	LastMsg     message `json:"last_msg"`
	UnreadCount int64   `json:"unread_count"`
}

type groupInfo struct {
	GroupID   string `json:"group_id"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	OwnerUID  string `json:"owner_uid"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type groupMember struct {
	UID      string `json:"uid"`
	Role     int8   `json:"role"`
	JoinedAt int64  `json:"joined_at"`
}

type notification struct {
	Type         string   `json:"type"`
	FromUID      string   `json:"from_uid,omitempty"`
	ToUID        string   `json:"to_uid,omitempty"`
	GroupID      string   `json:"group_id,omitempty"`
	Event        string   `json:"event,omitempty"`
	CreatedAt    *int64   `json:"created_at,omitempty"`
	UID          string   `json:"uid,omitempty"`
	IsGroup      *int8    `json:"is_group,omitempty"`
	Participants []string `json:"participants,omitempty"`
}

// ---------------------------------------------------------------------------
// client — WebSocket test client with notification buffering
// ---------------------------------------------------------------------------

var reqCounter atomic.Int64

const (
	defaultResponseTimeout = 10 * time.Second
	defaultNotifTimeout    = 8 * time.Second
)

type client struct {
	t     *testing.T
	conn  *websocket.Conn
	uid   string
	token string

	mu      sync.Mutex
	notifs  []notification
	notifC  chan struct{}
	pending map[string]chan json.RawMessage
}

func dial(t *testing.T) *client {
	t.Helper()
	dialer := websocket.Dialer{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &client{
		t:       t,
		conn:    conn,
		notifC:  make(chan struct{}, 256),
		pending: make(map[string]chan json.RawMessage),
	}
	go c.readLoop()
	t.Cleanup(func() { c.conn.Close() })
	return c
}

func (c *client) readLoop() {
	for {
		messageType, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		frame, err := wsproto.DecodeFrame(raw)
		if err != nil {
			continue
		}

		if frame.RequestID == wsproto.NotificationRequestID {
			notif, err := wsproto.DecodeNotificationBody(frame.Codec, frame.Type, frame.Body)
			if err != nil {
				continue
			}
			rawNotif, _ := json.Marshal(notif)
			var n notification
			json.Unmarshal(rawNotif, &n)
			c.mu.Lock()
			c.notifs = append(c.notifs, n)
			c.mu.Unlock()
			select {
			case c.notifC <- struct{}{}:
			default:
			}
		} else if frame.RequestID != 0 {
			payload, err := wsproto.DecodeResponseBody(frame.Codec, frame.Type, frame.RequestID, frame.Body)
			if err != nil {
				continue
			}
			rawResp, _ := json.Marshal(payload)
			requestID := fmt.Sprintf("%d", frame.RequestID)
			c.mu.Lock()
			ch, ok := c.pending[requestID]
			c.mu.Unlock()
			if ok {
				ch <- rawResp
			}
		}
	}
}

func normalizeTargetRequest(req wsRequest) wsRequest {
	action, _ := req["action"].(string)
	needsTarget := map[string]bool{
		"update_remark": true, "send_message": true, "get_messages": true,
		"clear_unread": true, "delete_conversation": true, "mute_conversation": true, "unmute_conversation": true,
	}
	if !needsTarget[action] {
		return req
	}
	out := wsRequest{}
	for key, value := range req {
		out[key] = value
	}
	if _, ok := out["target"]; ok {
		return out
	}
	if groupID, ok := out["group_id"]; ok && fmt.Sprint(groupID) != "" && fmt.Sprint(groupID) != "0" {
		out["target"] = map[string]any{"group_id": groupID}
	} else if uid, ok := out["to_uid"]; ok && fmt.Sprint(uid) != "" && fmt.Sprint(uid) != "0" {
		out["target"] = map[string]any{"uid": uid}
	} else if uid, ok := out["friend_uid"]; ok && fmt.Sprint(uid) != "" && fmt.Sprint(uid) != "0" {
		out["target"] = map[string]any{"uid": uid}
	}
	delete(out, "to_uid")
	delete(out, "friend_uid")
	delete(out, "group_id")
	return out
}

// normalizeSendBody 把测试里简写的 "content" 字符串转成强类型 body（text/markdown/system）。
// 结构化消息（图片/文件/引用/撤回）测试需直接传 "body"。
func normalizeSendBody(req wsRequest) wsRequest {
	if action, _ := req["action"].(string); action != "send_message" {
		return req
	}
	if _, ok := req["body"]; ok {
		return req
	}
	content, ok := req["content"].(string)
	if !ok {
		return req
	}
	out := wsRequest{}
	for k, v := range req {
		out[k] = v
	}
	delete(out, "content")
	switch fmt.Sprint(req["msg_type"]) {
	case "8":
		out["body"] = map[string]any{"markdown": map[string]any{"markdown": content}}
	case "3":
		out["body"] = map[string]any{"system": map[string]any{"text": content}}
	default:
		out["body"] = map[string]any{"text": map[string]any{"text": content}}
	}
	return out
}

// normalizeSendMsgID 为 send_message 注入客户端生成的 msg_id。
// 用户消息的 msg_id 必须由客户端提供，服务端只做校验/幂等/回传。
// 仅当请求未显式带 msg_id 字段时才自动生成；测试若要验证缺失/非法/幂等场景，
// 可显式设置 msg_id（含空串或非法值），此函数不会覆盖。
func normalizeSendMsgID(req wsRequest) wsRequest {
	if action, _ := req["action"].(string); action != "send_message" {
		return req
	}
	if _, ok := req["msg_id"]; ok {
		return req
	}
	out := wsRequest{}
	for k, v := range req {
		out[k] = v
	}
	out["msg_id"] = msgid.Generate()
	return out
}

func (c *client) send(req wsRequest) wsResponse {
	c.t.Helper()
	req = normalizeSendBody(req)
	req = normalizeSendMsgID(req)
	idNum := uint64(reqCounter.Add(1))
	id := fmt.Sprintf("%d", idNum)

	ch := make(chan json.RawMessage, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	action, _ := req["action"].(string)
	typeID, ok := wsproto.ActionType(action)
	if !ok {
		c.t.Fatalf("unknown action: %s", action)
	}
	body, err := wsproto.EncodeRequestBody(wsproto.FrameCodecProtobuf, typeID, normalizeTargetRequest(req))
	if err != nil {
		c.t.Fatalf("encode body %s: %v", action, err)
	}
	data, err := wsproto.EncodeFrame(wsproto.FrameCodecProtobuf, idNum, typeID, body)
	if err != nil {
		c.t.Fatalf("encode frame %s: %v", action, err)
	}
	if err := c.conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		c.t.Fatalf("write: %v", err)
	}

	select {
	case raw := <-ch:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		var resp wsResponse
		json.Unmarshal(raw, &resp)
		return resp
	case <-time.After(defaultResponseTimeout):
		c.t.Fatalf("timeout waiting for response to %s", req["action"])
		return wsResponse{}
	}
}

func (c *client) sendOK(req wsRequest) wsResponse {
	c.t.Helper()
	resp := c.send(req)
	if !resp.OK {
		c.t.Fatalf("expected ok=true for %v, got error: %s", req["action"], resp.Error)
	}
	return resp
}

func (c *client) sendErr(req wsRequest) wsResponse {
	c.t.Helper()
	resp := c.send(req)
	if resp.OK {
		c.t.Fatalf("expected ok=false for %v, got ok=true", req["action"])
	}
	return resp
}

// waitNotif waits for a notification matching the filter.
func (c *client) waitNotif(filter func(notification) bool, timeout ...time.Duration) notification {
	c.t.Helper()
	dur := defaultNotifTimeout
	if len(timeout) > 0 {
		dur = timeout[0]
	}
	deadline := time.After(dur)
	for {
		c.mu.Lock()
		for i, n := range c.notifs {
			if filter(n) {
				c.notifs = append(c.notifs[:i], c.notifs[i+1:]...)
				c.mu.Unlock()
				return n
			}
		}
		c.mu.Unlock()

		select {
		case <-c.notifC:
		case <-deadline:
			c.t.Fatalf("timeout waiting for notification")
			return notification{}
		}
	}
}

// drainNotifs returns all buffered notifications matching filter.
func (c *client) drainNotifs(filter func(notification) bool) []notification {
	c.mu.Lock()
	defer c.mu.Unlock()
	var matched, remaining []notification
	for _, n := range c.notifs {
		if filter(n) {
			matched = append(matched, n)
		} else {
			remaining = append(remaining, n)
		}
	}
	c.notifs = remaining
	return matched
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

func (c *client) register(username, password, nickname string) wsResponse {
	return c.sendOK(wsRequest{
		"action": "register", "username": username,
		"password": password, "nickname": nickname,
	})
}

func (c *client) login(username, password string) wsResponse {
	resp := c.sendOK(wsRequest{
		"action": "login", "username": username, "password": password,
	})
	c.uid = resp.UID
	c.token = resp.Token
	return resp
}

func (c *client) authenticate(token string) wsResponse {
	resp := c.sendOK(wsRequest{"action": "authenticate", "token": token})
	c.uid = resp.UID
	c.token = token
	return resp
}

func (c *client) logout() wsResponse {
	return c.sendOK(wsRequest{"action": "logout", "token": c.token})
}

func (c *client) registerAndLogin(username, password, nickname string) wsResponse {
	c.register(username, password, nickname)
	return c.login(username, password)
}

// ---------------------------------------------------------------------------
// HTTP upload helper
// ---------------------------------------------------------------------------

func uploadFile(t *testing.T, token, category, filename string, content []byte) wsResponse {
	t.Helper()
	httpClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("category", category)
	part, _ := w.CreateFormFile("file", filename)
	part.Write(content)
	w.Close()

	req, _ := http.NewRequest("POST", httpUploadURL, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result wsResponse
	json.Unmarshal(body, &result)
	return result
}

var nameCounter atomic.Int64

// uniqueName generates a unique name for test data.
// Format: "{runPrefix}_{prefix}_{counter}" (e.g. "e2e_1679012345_msg_1").
// All test data from the same run shares the same runPrefix, making it easy
// to identify which data belongs to which run in the database.
func uniqueName(prefix string) string {
	return fmt.Sprintf("%s_%s_%d", runPrefix, prefix, nameCounter.Add(1))
}

type conversationTargetJSON struct {
	UID     string `json:"uid"`
	GroupID string `json:"group_id"`
	OrgID   string `json:"org_id"`
}

func targetIDsForE2E(target conversationTargetJSON) (string, string) {
	return target.UID, target.GroupID
}

func (c *contact) UnmarshalJSON(data []byte) error {
	type alias contact
	var raw struct {
		alias
		Target conversationTargetJSON `json:"target"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*c = contact(raw.alias)
	uid, groupID := targetIDsForE2E(raw.Target)
	if c.OrgID == "" {
		c.OrgID = raw.Target.OrgID
	}
	if c.FriendUID == "" {
		c.FriendUID = uid
	}
	_ = groupID
	return nil
}

func (m *mutelistEntry) UnmarshalJSON(data []byte) error {
	type alias mutelistEntry
	var raw struct {
		alias
		Target conversationTargetJSON `json:"target"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*m = mutelistEntry(raw.alias)
	uid, groupID := targetIDsForE2E(raw.Target)
	if m.ToUID == "" {
		m.ToUID = uid
	}
	if m.GroupID == "" {
		m.GroupID = groupID
	}
	return nil
}

func (m *message) UnmarshalJSON(data []byte) error {
	type alias message
	var raw struct {
		alias
		Target conversationTargetJSON `json:"target"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*m = message(raw.alias)
	uid, groupID := targetIDsForE2E(raw.Target)
	if m.ToUID == "" {
		m.ToUID = uid
	}
	if m.GroupID == "" {
		m.GroupID = groupID
	}
	return nil
}

func (c *conversation) UnmarshalJSON(data []byte) error {
	type alias conversation
	var raw struct {
		alias
		Target conversationTargetJSON `json:"target"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*c = conversation(raw.alias)
	uid, groupID := targetIDsForE2E(raw.Target)
	if c.FriendUID == "" {
		c.FriendUID = uid
	}
	if c.GroupID == "" {
		c.GroupID = groupID
	}
	return nil
}

func (n *notification) UnmarshalJSON(data []byte) error {
	type alias notification
	var raw struct {
		alias
		Target conversationTargetJSON `json:"target"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*n = notification(raw.alias)
	uid, groupID := targetIDsForE2E(raw.Target)
	if n.FromUID == "" {
		n.FromUID = uid
	}
	if n.ToUID == "" {
		n.ToUID = uid
	}
	if n.GroupID == "" {
		n.GroupID = groupID
	}
	return nil
}
