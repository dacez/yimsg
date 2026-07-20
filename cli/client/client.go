// Package client 是 yimsg-cli 的 WebSocket 客户端：每次调用建立一条短连接，
// 完成一到多个请求-响应后由调用方关闭。不处理服务端 notification——CLI 是
// 一次性命令行工具，不维护常驻会话，同步靠显式调用 sync_messages 追平。
package client

import (
	"crypto/tls"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"yimsg/cli/wire"
	"yimsg/protocol/generated/go/pb"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
)

// DefaultTimeout 是单次请求的默认超时时间。
const DefaultTimeout = 15 * time.Second

// APIError 是服务端返回的业务错误（BaseResponse.code != ERROR_OK）。
type APIError struct {
	Code pb.ErrorCode
	Msg  string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Msg)
}

// Client 是一条 WebSocket 连接上的请求-响应收发器。
type Client struct {
	conn    *websocket.Conn
	reqID   atomic.Uint64
	mu      sync.Mutex
	pending map[uint64]chan []byte
	closed  chan struct{}
}

// Dial 连接到 serverURL（ws:// 或 wss://）。insecureSkipVerify 仅用于自签名证书的私有部署。
func Dial(serverURL string, insecureSkipVerify bool) (*Client, error) {
	dialer := websocket.Dialer{HandshakeTimeout: DefaultTimeout}
	if insecureSkipVerify {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	conn, _, err := dialer.Dial(serverURL, nil)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", serverURL, err)
	}
	c := &Client{
		conn:    conn,
		pending: make(map[uint64]chan []byte),
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func (c *Client) readLoop() {
	defer close(c.closed)
	for {
		messageType, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		frame, err := wire.DecodeFrame(raw)
		if err != nil {
			continue
		}
		if frame.RequestID == wire.NotificationRequestID {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[frame.RequestID]
		if ok {
			delete(c.pending, frame.RequestID)
		}
		c.mu.Unlock()
		if ok {
			ch <- frame.Body
		}
	}
}

// Close 关闭底层连接。
func (c *Client) Close() error {
	return c.conn.Close()
}

// baseResponse 是所有 pb.XxxResponse 结构性满足的接口。
type baseResponse interface {
	proto.Message
	GetBase() *pb.BaseResponse
}

// call 编码 req 为对应 type 的 protobuf frame、发送并等待响应，解码进 resp。
// 服务端返回非 ERROR_OK 时返回 *APIError，resp 中仍带有解码后的完整响应体。
func call[Resp baseResponse](c *Client, typeID uint16, req proto.Message, resp Resp, timeout time.Duration) (Resp, error) {
	body, err := proto.Marshal(req)
	if err != nil {
		return resp, fmt.Errorf("marshal request type=%d: %w", typeID, err)
	}
	id := c.reqID.Add(1)
	ch := make(chan []byte, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	frame, err := wire.EncodeFrame(wire.FrameCodecProtobuf, id, typeID, body)
	if err != nil {
		return resp, fmt.Errorf("encode frame type=%d: %w", typeID, err)
	}
	if err := c.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		return resp, fmt.Errorf("write frame type=%d: %w", typeID, err)
	}

	select {
	case raw := <-ch:
		if err := proto.Unmarshal(raw, resp); err != nil {
			return resp, fmt.Errorf("unmarshal response type=%d: %w", typeID, err)
		}
		if base := resp.GetBase(); base != nil && base.GetCode() != pb.ErrorCode_ERROR_OK {
			return resp, &APIError{Code: base.GetCode(), Msg: base.GetMsg()}
		}
		return resp, nil
	case <-time.After(timeout):
		return resp, fmt.Errorf("timeout waiting response type=%d", typeID)
	case <-c.closed:
		return resp, fmt.Errorf("connection closed while waiting response type=%d", typeID)
	}
}

// Login 用户名密码登录，成功后返回 uid、token 与 client_config。
func (c *Client) Login(username, password string) (*pb.LoginResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_LOGIN), &pb.LoginRequest{Username: username, Password: password}, &pb.LoginResponse{}, DefaultTimeout)
}

// Authenticate 用已保存的 token 恢复会话。
func (c *Client) Authenticate(token string) (*pb.AuthenticateResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_AUTHENTICATE), &pb.AuthenticateRequest{Token: token}, &pb.AuthenticateResponse{}, DefaultTimeout)
}

// SendMessage 发送单聊或群聊消息；msg_id 必须由调用方按 cli/msgid 生成。
func (c *Client) SendMessage(req *pb.SendMessageRequest) (*pb.SendMessageResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_SEND_MESSAGE), req, &pb.SendMessageResponse{}, DefaultTimeout)
}

// SyncMessages 增量同步消息，游标为账号级 seq，与会话无关。
func (c *Client) SyncMessages(req *pb.SyncMessagesRequest) (*pb.SyncMessagesResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_SYNC_MESSAGES), req, &pb.SyncMessagesResponse{}, DefaultTimeout)
}

// GetContacts 分页读取通讯录（好友 / 收藏群）。
func (c *Client) GetContacts(req *pb.GetContactsRequest) (*pb.GetContactsResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_GET_CONTACTS), req, &pb.GetContactsResponse{}, DefaultTimeout)
}

// GetUserInfos 批量读取用户展示资料。
func (c *Client) GetUserInfos(req *pb.GetUserInfosRequest) (*pb.GetUserInfosResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_GET_USER_INFOS), req, &pb.GetUserInfosResponse{}, DefaultTimeout)
}

// GetGroupInfos 批量读取群展示资料。
func (c *Client) GetGroupInfos(req *pb.GetGroupInfosRequest) (*pb.GetGroupInfosResponse, error) {
	return call(c, uint16(pb.Type_TYPE_ACTION_GET_GROUP_INFOS), req, &pb.GetGroupInfosResponse{}, DefaultTimeout)
}
