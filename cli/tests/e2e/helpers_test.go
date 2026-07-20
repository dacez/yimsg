package e2e

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"yimsg/cli/wire"
	"yimsg/protocol/generated/go/pb"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
)

// ---------------------------------------------------------------------------
// rawClient 是仅供测试搭建初始数据（注册账号、加好友、建群）使用的最小 WebSocket
// 客户端，独立于 cli/client（cli/client 的公开方法严格对应 CLI 子命令实际用到的
// action，注册 / 加好友 / 建群不在其中）。写法与 server/tests/e2e/helpers_test.go
// 的 client 一致：直接用 protocol/generated/go/pb 强类型收发，不经过任何中转。
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

func (c *rawClient) createGroup(name string, memberUIDs ...int64) int64 {
	c.t.Helper()
	resp := rawSendOK(c, uint16(pb.Type_TYPE_ACTION_CREATE_GROUP), &pb.CreateGroupRequest{Name: name, MemberUids: memberUIDs}, &pb.CreateGroupResponse{})
	return resp.GetGroupId()
}

// setupFriendPair 注册两个账号并互加好友，返回 (uidA, uidB)。
func setupFriendPair(t *testing.T) (uidA, uidB int64, userA, userB, passA, passB string) {
	t.Helper()
	userA, passA = uniqueName("alice"), "pass-alice-1"
	userB, passB = uniqueName("bob"), "pass-bob-1"

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
// runCLI 以子进程方式驱动编译好的 yimsg-cli 二进制，返回解码后的 JSON 输出、
// 原始 stdout/stderr 与退出码，贴近 AI 调用方实际观察到的接口。
// ---------------------------------------------------------------------------

type cliResult struct {
	JSON     map[string]any
	Stdout   string
	Stderr   string
	ExitCode int
}

func runCLI(t *testing.T, args ...string) cliResult {
	t.Helper()
	return runCLIIn(t, "", args...)
}

// runCLIIn 与 runCLI 相同，但可以指定子进程的工作目录（workDir 为空则继承测试
// 进程自身的工作目录），用于验证 --dir 缺省时默认落在"当前目录"下的 cli_data。
func runCLIIn(t *testing.T, workDir string, args ...string) cliResult {
	t.Helper()
	cmd := exec.Command(cliBinary, args...)
	cmd.Dir = workDir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			t.Fatalf("run yimsg-cli %v: %v (stderr=%s)", args, err, stderr.String())
		}
	}

	var parsed map[string]any
	if stdout.Len() > 0 {
		if jsonErr := json.Unmarshal(stdout.Bytes(), &parsed); jsonErr != nil {
			t.Fatalf("parse yimsg-cli %v stdout as JSON: %v\nstdout=%s", args, jsonErr, stdout.String())
		}
	}
	return cliResult{JSON: parsed, Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: exitCode}
}

// runCLIOK 断言子进程成功退出且 JSON 输出 ok=true。
func runCLIOK(t *testing.T, args ...string) cliResult {
	t.Helper()
	r := runCLI(t, args...)
	if r.ExitCode != 0 || r.JSON["ok"] != true {
		t.Fatalf("yimsg-cli %v 期望成功，实际 exit=%d json=%v stderr=%s", args, r.ExitCode, r.JSON, r.Stderr)
	}
	return r
}

// runCLIErr 断言子进程以非 0 退出且 JSON 输出 ok=false。
func runCLIErr(t *testing.T, args ...string) cliResult {
	t.Helper()
	r := runCLI(t, args...)
	if r.ExitCode == 0 || r.JSON["ok"] != false {
		t.Fatalf("yimsg-cli %v 期望失败，实际 exit=%d json=%v", args, r.ExitCode, r.JSON)
	}
	return r
}

// runCLIInOK 是 runCLIIn 的成功断言版本。
func runCLIInOK(t *testing.T, workDir string, args ...string) cliResult {
	t.Helper()
	r := runCLIIn(t, workDir, args...)
	if r.ExitCode != 0 || r.JSON["ok"] != true {
		t.Fatalf("yimsg-cli %v (workDir=%s) 期望成功，实际 exit=%d json=%v stderr=%s", args, workDir, r.ExitCode, r.JSON, r.Stderr)
	}
	return r
}

func jsonNumber(t *testing.T, v any) int64 {
	t.Helper()
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("expected JSON number, got %T (%v)", v, v)
	}
	return int64(f)
}

func fmtUID(uid int64) string {
	return fmt.Sprintf("%d", uid)
}
