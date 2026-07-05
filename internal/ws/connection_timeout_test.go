package ws

import (
	"github.com/gorilla/websocket"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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

	writeReq := func(action string, requestID uint64, payload map[string]any) {
		t.Helper()
		typeID, ok := ActionType(action)
		if !ok {
			t.Fatalf("unknown action: %s", action)
		}
		if payload == nil {
			payload = map[string]any{}
		}
		body, err := EncodeRequestBody(FrameCodecProtobuf, typeID, payload)
		if err != nil {
			t.Fatalf("encode ws req %s: %v", action, err)
		}
		data, err := EncodeFrame(FrameCodecProtobuf, requestID, typeID, body)
		if err != nil {
			t.Fatalf("encode ws frame %s: %v", action, err)
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatalf("write ws req %s: %v", action, err)
		}
	}
	readResp := func() struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	} {
		t.Helper()
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read ws resp: %v", err)
		}
		frame, err := DecodeFrame(msg)
		if err != nil {
			t.Fatalf("decode ws frame: %v", err)
		}
		payload, err := DecodeResponseBody(frame.Codec, frame.Type, frame.RequestID, frame.Body)
		if err != nil {
			t.Fatalf("decode ws resp body: %v", err)
		}
		var resp struct {
			OK    bool   `json:"ok"`
			Error string `json:"error,omitempty"`
		}
		resp.OK, _ = payload["ok"].(bool)
		resp.Error, _ = payload["error"].(string)
		return resp
	}

	writeReq("register", 1, map[string]any{
		"username": "alice",
		"password": "pass",
		"nickname": "Alice",
	})
	if resp := readResp(); !resp.OK {
		t.Fatalf("register failed: %s", resp.Error)
	}

	writeReq("login", 2, map[string]any{
		"username": "alice",
		"password": "pass",
	})
	loginResp := readResp()
	if !loginResp.OK {
		t.Fatalf("login failed: %s", loginResp.Error)
	}

	time.Sleep(2 * unauthenticatedTimeout)

	conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	writeReq("get_user_infos", 3, nil)
	if resp := readResp(); !resp.OK {
		t.Fatalf("get_user_infos after auth failed: %s", resp.Error)
	}
}
