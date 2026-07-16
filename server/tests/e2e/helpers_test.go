package e2e

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/msgid"
	wsproto "yimsg/server/internal/ws"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
)

// ---------------------------------------------------------------------------
// client — WebSocket test client with notification buffering.
//
// 请求 / 响应全部直接用 protocol/generated/go/pb 生成的强类型收发，不经过任何
// JSON 中转；服务端通知解码同样是纯 proto（见 wsproto.DecodeNotificationBody）。
// ---------------------------------------------------------------------------

var reqCounter atomic.Int64

const (
	defaultResponseTimeout = 10 * time.Second
	defaultNotifTimeout    = 8 * time.Second
)

// baseMsg 是所有 pb.XxxResponse 结构性满足的接口：每个生成的响应类型都有
// GetBase() *pb.BaseResponse 方法，send/sendOK/sendErr 用它统一判定成败。
type baseMsg interface {
	proto.Message
	GetBase() *pb.BaseResponse
}

type client struct {
	t     *testing.T
	conn  *websocket.Conn
	uid   int64
	token string

	mu      sync.Mutex
	notifs  []*appmsg.Notification
	notifC  chan struct{}
	pending map[uint64]chan []byte
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
		pending: make(map[uint64]chan []byte),
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
			c.mu.Lock()
			c.notifs = append(c.notifs, notif)
			c.mu.Unlock()
			select {
			case c.notifC <- struct{}{}:
			default:
			}
		} else if frame.RequestID != 0 {
			c.mu.Lock()
			ch, ok := c.pending[frame.RequestID]
			c.mu.Unlock()
			if ok {
				ch <- frame.Body
			}
		}
	}
}

// send 编码 req 为 action 对应的 protobuf frame、发送并等待响应，解码进 resp。
func send[Resp baseMsg](c *client, action string, req proto.Message, resp Resp) Resp {
	c.t.Helper()
	typeID, ok := wsproto.ActionType(action)
	if !ok {
		c.t.Fatalf("unknown action: %s", action)
	}
	idNum := uint64(reqCounter.Add(1))

	ch := make(chan []byte, 1)
	c.mu.Lock()
	c.pending[idNum] = ch
	c.mu.Unlock()

	body, err := proto.Marshal(req)
	if err != nil {
		c.t.Fatalf("marshal request %s: %v", action, err)
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
		delete(c.pending, idNum)
		c.mu.Unlock()
		if err := proto.Unmarshal(raw, resp); err != nil {
			c.t.Fatalf("unmarshal response %s: %v", action, err)
		}
		return resp
	case <-time.After(defaultResponseTimeout):
		c.t.Fatalf("timeout waiting for response to %s", action)
		return resp
	}
}

// sendOK 发送请求并断言 BaseResponse.code == ERROR_OK。
func sendOK[Resp baseMsg](c *client, action string, req proto.Message, resp Resp) Resp {
	c.t.Helper()
	out := send(c, action, req, resp)
	if out.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
		c.t.Fatalf("expected ok=true for %s, got error: %s", action, out.GetBase().GetMsg())
	}
	return out
}

// sendErr 发送请求并断言 BaseResponse.code != ERROR_OK。
func sendErr[Resp baseMsg](c *client, action string, req proto.Message, resp Resp) Resp {
	c.t.Helper()
	out := send(c, action, req, resp)
	if out.GetBase().GetCode() == pb.ErrorCode_ERROR_OK {
		c.t.Fatalf("expected ok=false for %s, got ok=true", action)
	}
	return out
}

// waitNotif waits for a notification matching the filter.
func (c *client) waitNotif(filter func(*appmsg.Notification) bool, timeout ...time.Duration) *appmsg.Notification {
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
			return nil
		}
	}
}

// drainNotifs returns all buffered notifications matching filter.
func (c *client) drainNotifs(filter func(*appmsg.Notification) bool) []*appmsg.Notification {
	c.mu.Lock()
	defer c.mu.Unlock()
	var matched, remaining []*appmsg.Notification
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

// notifUID / notifGroupID 读取通知 target 的 uid / group_id（appmsg.ConversationTarget
// 是普通 Go 结构体、字段是可空指针，不是 pb 生成类型，没有 GetXxx() 方法，因此提供这两个
// nil-safe 辅助函数）。
func notifUID(n *appmsg.Notification) int64 {
	if n == nil || n.Target == nil || n.Target.UID == nil {
		return 0
	}
	return *n.Target.UID
}

func notifGroupID(n *appmsg.Notification) int64 {
	if n == nil || n.Target == nil || n.Target.GroupID == nil {
		return 0
	}
	return *n.Target.GroupID
}

// ---------------------------------------------------------------------------
// High-level helpers — auth
// ---------------------------------------------------------------------------

func (c *client) register(username, password, nickname string) *pb.RegisterResponse {
	return sendOK(c, "register", &pb.RegisterRequest{Username: username, Password: password, Nickname: nickname}, &pb.RegisterResponse{})
}

func (c *client) login(username, password string) *pb.LoginResponse {
	resp := sendOK(c, "login", &pb.LoginRequest{Username: username, Password: password}, &pb.LoginResponse{})
	c.uid = resp.GetUid()
	c.token = resp.GetToken()
	return resp
}

func (c *client) authenticate(token string) *pb.AuthenticateResponse {
	resp := sendOK(c, "authenticate", &pb.AuthenticateRequest{Token: token}, &pb.AuthenticateResponse{})
	c.uid = resp.GetUid()
	c.token = token
	return resp
}

func (c *client) logout() *pb.LogoutResponse {
	return sendOK(c, "logout", &pb.LogoutRequest{Token: c.token}, &pb.LogoutResponse{})
}

func (c *client) registerAndLogin(username, password, nickname string) *pb.LoginResponse {
	c.register(username, password, nickname)
	return c.login(username, password)
}

// ---------------------------------------------------------------------------
// High-level helpers — message send convenience
// ---------------------------------------------------------------------------

func userTarget(uid int64) *pb.ConversationTarget {
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: uid}}
}

func groupTarget(groupID int64) *pb.ConversationTarget {
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: groupID}}
}

func userContactTarget(uid int64) *pb.ContactTarget {
	return &pb.ContactTarget{Kind: &pb.ContactTarget_Uid{Uid: uid}}
}

func groupContactTarget(groupID int64) *pb.ContactTarget {
	return &pb.ContactTarget{Kind: &pb.ContactTarget_GroupId{GroupId: groupID}}
}

func orgContactTarget(orgID int64) *pb.ContactTarget {
	return &pb.ContactTarget{Kind: &pb.ContactTarget_OrgId{OrgId: orgID}}
}

func textBody(text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}}
}

func markdownBody(text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_Markdown{Markdown: &pb.MarkdownBody{Markdown: text}}}
}

// bodyText 从 pb.Message.Body 读出可读文本，供断言使用。
func bodyText(m *pb.Message) string {
	switch b := m.GetBody().GetKind().(type) {
	case *pb.MessageBody_Text:
		return b.Text.GetText()
	case *pb.MessageBody_Markdown:
		return b.Markdown.GetMarkdown()
	case *pb.MessageBody_System:
		return b.System.GetText()
	case *pb.MessageBody_Quote:
		return b.Quote.GetText().GetText()
	case *pb.MessageBody_Recall:
		return b.Recall.GetText()
	default:
		return ""
	}
}

// sendMsg 发送一条消息（自动生成 msg_id），断言成功并返回响应。
func (c *client) sendMsg(target *pb.ConversationTarget, msgType pb.MessageType, body *pb.MessageBody) *pb.SendMessageResponse {
	c.t.Helper()
	return sendOK(c, "send_message", &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: target, MsgType: msgType, Body: body}, &pb.SendMessageResponse{})
}

// sendText 是 sendMsg 的文本消息快捷方式。
func (c *client) sendText(target *pb.ConversationTarget, text string) *pb.SendMessageResponse {
	c.t.Helper()
	return c.sendMsg(target, pb.MessageType_MESSAGE_TYPE_TEXT, textBody(text))
}

// ---------------------------------------------------------------------------
// HTTP upload helper — /api/upload 是 HTTP REST 接口（不是 WS 二进制协议），
// 响应本身就是 JSON，这是接口设计本身如此，不是协议 JSON 化。
// ---------------------------------------------------------------------------

type uploadResponse struct {
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	MediaID   string `json:"media_id,omitempty"`
	URL       string `json:"url,omitempty"`
	Size      int64  `json:"size,omitempty"`
}

// mediaID 把上传响应里的十进制字符串 media_id 解析为 int64，供构造
// pb.ImageBody / pb.FileBody 使用（wire 上 media_id 是 int64，HTTP 上传响应
// 按惯例用十进制字符串承载，避免大整数精度问题）。
func (r uploadResponse) mediaID(t *testing.T) int64 {
	t.Helper()
	id, err := strconv.ParseInt(r.MediaID, 10, 64)
	if err != nil {
		t.Fatalf("parse media_id %q: %v", r.MediaID, err)
	}
	return id
}

func uploadFile(t *testing.T, token, category, filename string, content []byte) uploadResponse {
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
	var result uploadResponse
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
