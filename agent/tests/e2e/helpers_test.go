package e2e

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"yimsg/cli/msgid"
	"yimsg/cli/wire"
	"yimsg/protocol/generated/go/pb"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
)

// ---------------------------------------------------------------------------
// rawClient 是仅供测试搭建初始数据、驱动人类账号收发消息用的最小 WebSocket
// 客户端，写法与 cli/tests/e2e、server/tests/e2e 的同名 helper 一致：直接用
// protocol/generated/go/pb 强类型收发，不经过任何中转，独立于 agent 自身实现。
// ---------------------------------------------------------------------------

var rawReqID atomic.Uint64

type rawClient struct {
	t    *testing.T
	conn *websocket.Conn
}

type baseMsg interface {
	proto.Message
	GetBase() *pb.BaseResponse
}

func dialRaw(t *testing.T) *rawClient {
	t.Helper()
	dialer := websocket.Dialer{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &rawClient{t: t, conn: conn}
	t.Cleanup(func() { conn.Close() })
	return c
}

func rawSendOK[Resp baseMsg](c *rawClient, typeID uint16, req proto.Message, resp Resp) Resp {
	c.t.Helper()
	body, err := proto.Marshal(req)
	if err != nil {
		c.t.Fatalf("marshal request type=%d: %v", typeID, err)
	}
	id := rawReqID.Add(1)
	frame, err := wire.EncodeFrame(wire.FrameCodecProtobuf, id, typeID, body)
	if err != nil {
		c.t.Fatalf("encode frame: %v", err)
	}
	if err := c.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		c.t.Fatalf("write: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		c.conn.SetReadDeadline(deadline)
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			c.t.Fatalf("read: %v", err)
		}
		f, err := wire.DecodeFrame(raw)
		if err != nil || f.RequestID != id {
			continue
		}
		if err := proto.Unmarshal(f.Body, resp); err != nil {
			c.t.Fatalf("unmarshal response: %v", err)
		}
		if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
			c.t.Fatalf("action type=%d failed: %s %s", typeID, resp.GetBase().GetCode(), resp.GetBase().GetMsg())
		}
		return resp
	}
}

func (c *rawClient) register(username, password string) int64 {
	c.t.Helper()
	resp := rawSendOK(c, uint16(pb.Type_TYPE_ACTION_REGISTER), &pb.RegisterRequest{Username: username, Password: password, Nickname: username}, &pb.RegisterResponse{})
	return resp.GetUid()
}

func (c *rawClient) login(username, password string) {
	c.t.Helper()
	rawSendOK(c, uint16(pb.Type_TYPE_ACTION_LOGIN), &pb.LoginRequest{Username: username, Password: password}, &pb.LoginResponse{})
}

func (c *rawClient) addFriend(friendUID int64) {
	c.t.Helper()
	rawSendOK(c, uint16(pb.Type_TYPE_ACTION_ADD_FRIEND), &pb.AddFriendRequest{FriendUid: friendUID}, &pb.AddFriendResponse{})
}

func (c *rawClient) acceptFriend(friendUID int64) {
	c.t.Helper()
	rawSendOK(c, uint16(pb.Type_TYPE_ACTION_ACCEPT_FRIEND), &pb.AcceptFriendRequest{FriendUid: friendUID}, &pb.AcceptFriendResponse{})
}

func (c *rawClient) sendTextTo(toUID int64, text string) {
	c.t.Helper()
	req := &pb.SendMessageRequest{
		Target:  &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: toUID}},
		MsgType: pb.MessageType_MESSAGE_TYPE_TEXT,
		Body:    &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}},
		MsgId:   msgid.Generate(),
	}
	rawSendOK(c, uint16(pb.Type_TYPE_ACTION_SEND_MESSAGE), req, &pb.SendMessageResponse{})
}

// waitForTextFrom 反复调用 sync_messages，直到收到一条来自 fromUID、内容为
// wantText 的文本消息，或者超时。用于校验 agent 是否已经把回复真正发回来了。
func (c *rawClient) waitForTextFrom(fromUID int64, wantText string, timeout time.Duration) bool {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	lastSeq := int64(0)
	for time.Now().Before(deadline) {
		resp := rawSendOK(c, uint16(pb.Type_TYPE_ACTION_SYNC_MESSAGES), &pb.SyncMessagesRequest{LastSeq: lastSeq, Limit: 50}, &pb.SyncMessagesResponse{})
		for _, m := range resp.GetMessages() {
			if m.GetFromUid() != fromUID {
				continue
			}
			text := m.GetBody().GetText().GetText()
			if text == wantText {
				return true
			}
		}
		if resp.GetCursorSeq() > lastSeq {
			lastSeq = resp.GetCursorSeq()
		}
		if resp.GetHasMore() {
			continue
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

// setupFriendPair 注册两个账号并互加好友，返回 (uidA, uidB)。
func setupFriendPair(t *testing.T) (uidA, uidB int64, userA, userB, passA, passB string) {
	t.Helper()
	userA, passA = uniqueName("alice"), "pass-alice-1"
	userB, passB = uniqueName("bot"), "pass-bot-1"

	regA := dialRaw(t)
	uidA = regA.register(userA, passA)
	regB := dialRaw(t)
	uidB = regB.register(userB, passB)

	friendA := dialRaw(t)
	friendA.login(userA, passA)
	friendA.addFriend(uidB)

	friendB := dialRaw(t)
	friendB.login(userB, passB)
	friendB.acceptFriend(uidA)

	return uidA, uidB, userA, userB, passA, passB
}

// ---------------------------------------------------------------------------
// 模拟 DeepSeek 接口：按请求是否携带 tools 区分"决策/步骤阶段"与"记忆回填
// 阶段"，返回固定文本，让整条链路可以在没有真实 DeepSeek key 的情况下端到端跑通。
// ---------------------------------------------------------------------------

const (
	fakeDirectAnswerText = "自动回复：已收到，这是测试回答"
	fakeMemorySummary    = "记忆摘要：测试对话"
)

type chatRequestBody struct {
	Tools []json.RawMessage `json:"tools"`
}

func startFakeDeepSeek(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := jsonDecodeBody(r)
		content := fakeMemorySummary
		if len(body.Tools) > 0 {
			content = fakeDirectAnswerText
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"role": "assistant", "content": content}, "finish_reason": "stop"},
			},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func jsonDecodeBody(r *http.Request) (chatRequestBody, error) {
	var body chatRequestBody
	err := json.NewDecoder(r.Body).Decode(&body)
	return body, err
}

// ---------------------------------------------------------------------------
// runAgent 以子进程方式启动 yimsg-agent 二进制并在测试结束时结束它，标准输出/
// 错误汇总到一个带锁的 buffer，测试失败时打印出来辅助排查。
// ---------------------------------------------------------------------------

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func runAgent(t *testing.T, args ...string) *syncBuffer {
	t.Helper()
	cmd := exec.Command(agentBinary, args...)
	out := &syncBuffer{}
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Start(); err != nil {
		t.Fatalf("start yimsg-agent: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
		if t.Failed() {
			t.Logf("yimsg-agent output:\n%s", out.String())
		}
	})
	return out
}
