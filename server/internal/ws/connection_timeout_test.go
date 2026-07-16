package ws

import (
	"github.com/gorilla/websocket"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"yimsg/protocol/generated/go/pb"

	"google.golang.org/protobuf/proto"
)

// baseResponseMessage 是所有 pb.XxxResponse 结构性满足的接口，用于泛化读取
// BaseResponse.code / msg，无需为每个 action 单独写解码逻辑。
type baseResponseMessage interface {
	proto.Message
	GetBase() *pb.BaseResponse
}

func TestUnauthenticatedConnectionTimesOut(t *testing.T) {
	oldTimeout := unauthenticatedTimeout
	unauthenticatedTimeout = 50 * time.Millisecond
	t.Cleanup(func() { unauthenticatedTimeout = oldTimeout })

	s := testState(t)
	server := httptest.NewServer(HandleWS(s))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("expected unauthenticated connection to be closed by server")
	}
}

func TestAuthenticatedConnectionClearsUnauthenticatedTimeout(t *testing.T) {
	oldTimeout := unauthenticatedTimeout
	unauthenticatedTimeout = 50 * time.Millisecond
	t.Cleanup(func() { unauthenticatedTimeout = oldTimeout })

	s := testState(t)
	server := httptest.NewServer(HandleWS(s))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()

	writeReq := func(typeID pb.Type, requestID uint64, req proto.Message) {
		t.Helper()
		body, err := EncodeProtoBody(FrameCodecProtobuf, req)
		if err != nil {
			t.Fatalf("encode ws req %v: %v", typeID, err)
		}
		data, err := EncodeFrame(FrameCodecProtobuf, requestID, uint16(typeID), body)
		if err != nil {
			t.Fatalf("encode ws frame %v: %v", typeID, err)
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatalf("write ws req %v: %v", typeID, err)
		}
	}
	readResp := func(typeID pb.Type) *pb.BaseResponse {
		t.Helper()
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read ws resp: %v", err)
		}
		frame, err := DecodeFrame(msg)
		if err != nil {
			t.Fatalf("decode ws frame: %v", err)
		}
		resp, ok := NewResponseMessageByType(frame.Type)
		if !ok {
			t.Fatalf("missing response message for type: %d", frame.Type)
		}
		if err := proto.Unmarshal(frame.Body, resp); err != nil {
			t.Fatalf("unmarshal ws resp body: %v", err)
		}
		typed, ok := resp.(baseResponseMessage)
		if !ok {
			t.Fatalf("response type %T has no BaseResponse", resp)
		}
		return typed.GetBase()
	}

	writeReq(pb.Type_TYPE_ACTION_REGISTER, 1, &pb.RegisterRequest{Username: "alice", Password: "pass", Nickname: "Alice"})
	if base := readResp(pb.Type_TYPE_ACTION_REGISTER); base.GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("register failed: %s", base.GetMsg())
	}

	writeReq(pb.Type_TYPE_ACTION_LOGIN, 2, &pb.LoginRequest{Username: "alice", Password: "pass"})
	if base := readResp(pb.Type_TYPE_ACTION_LOGIN); base.GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("login failed: %s", base.GetMsg())
	}

	time.Sleep(2 * unauthenticatedTimeout)

	conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	writeReq(pb.Type_TYPE_ACTION_GET_USER_INFOS, 3, &pb.GetUserInfosRequest{})
	if base := readResp(pb.Type_TYPE_ACTION_GET_USER_INFOS); base.GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("get_user_infos after auth failed: %s", base.GetMsg())
	}
}
