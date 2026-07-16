package ws

import (
	"testing"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/config"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/online"
	"yimsg/server/internal/plugin"
	"yimsg/server/internal/service"
	"yimsg/server/internal/shard"
	"yimsg/server/internal/taskqueue"

	"google.golang.org/protobuf/proto"
)

func testState(t *testing.T) *service.AppState {
	t.Helper()
	db, err := shard.OpenMemory(2, dal.Schemas())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{
		Server:   config.ServerConfig{Host: "127.0.0.1", Port: 0, MachineID: 1},
		Database: config.DatabaseConfig{DataDir: "", ShardCount: 2},
		Session:  config.SessionConfig{TTLSeconds: 604800, TokenBytes: 16},
		Message:  config.MessageConfig{RecallWindowSeconds: 120},
		GC: config.GCConfig{
			MessageMaxCount:            5000,
			SessionCleanupIntervalSecs: 3600,
			ContactGCIntervalSecs:      86400,
			MessageGCIntervalSecs:      3600,
			UserGCIntervalSecs:         86400,
		},
		Frontend: config.FrontendConfig{StaticDir: ""},
		Media: config.MediaConfig{
			UploadDir:      t.TempDir(),
			MaxAvatarBytes: 5242880,
			MaxImageBytes:  10485760,
			MaxFileBytes:   104857600,
		},
	}
	state := service.NewAppState(db, cfg, plugin.NewRegistry())
	// dispatch 层测试用同步任务队列：群 fanout 在 dispatch 内联执行完成。
	tasks, err := taskqueue.Open("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tasks.Close() })
	state.UseTaskQueue(tasks)
	tasks.SetSync()
	return state
}

// actionFrame 把请求消息编码为一个 action frame，供 DispatchActionFrame 测试使用。
func actionFrame(t *testing.T, typeID pb.Type, requestID uint64, msg proto.Message) Frame {
	t.Helper()
	body, err := EncodeProtoBody(FrameCodecProtobuf, msg)
	if err != nil {
		t.Fatalf("encode body: %v", err)
	}
	return Frame{Codec: FrameCodecProtobuf, Endian: FrameEndianBig, RequestID: requestID, Type: uint16(typeID), Body: body}
}

// dispatchAction 走完整的 DispatchActionFrame 路径并返回结果。
func dispatchAction(t *testing.T, s *service.AppState, info *service.BaseInfo, typeID pb.Type, msg proto.Message) *DispatchFrameResult {
	t.Helper()
	result, err := DispatchActionFrame(s, info, actionFrame(t, typeID, info.RequestID, msg))
	if err != nil {
		t.Fatalf("dispatch %v: %v", typeID, err)
	}
	return result
}

func registerForDispatch(t *testing.T, s *service.AppState, username string) {
	t.Helper()
	result := dispatchAction(t, s, &service.BaseInfo{UID: 0, RequestID: 1}, pb.Type_TYPE_ACTION_REGISTER, &pb.RegisterRequest{
		Username: username, Password: "pass", Nickname: username,
	})
	resp := result.Response.(*pb.RegisterResponse)
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("register failed: %s", resp.GetBase().GetMsg())
	}
}

func TestDispatchRegisterAndLoginUseProtoMessages(t *testing.T) {
	s := testState(t)

	registerForDispatch(t, s, "alice")
	result := dispatchAction(t, s, &service.BaseInfo{UID: 0, RequestID: 2}, pb.Type_TYPE_ACTION_LOGIN, &pb.LoginRequest{
		Username: "alice", Password: "pass",
	})
	if result.Type != pb.Type_TYPE_ACTION_LOGIN {
		t.Fatalf("result type = %v", result.Type)
	}
	resp := result.Response.(*pb.LoginResponse)
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("login failed: %s", resp.GetBase().GetMsg())
	}
	if resp.GetUid() <= 0 || resp.GetToken() == "" {
		t.Fatalf("login response = %+v", resp)
	}
	if resp.GetClientConfig().GetBatchMaxLimit() != config.DefaultClientBatchMaxLimit {
		t.Fatalf("batch max limit = %d", resp.GetClientConfig().GetBatchMaxLimit())
	}
	// 响应 frame 必须可被重新解码为同一 type。
	frame, err := DecodeFrame(result.ResponseFrame)
	if err != nil || frame.Type != uint16(pb.Type_TYPE_ACTION_LOGIN) {
		t.Fatalf("response frame decode = %+v err=%v", frame, err)
	}
}

func TestDispatchAuthenticateAndLogoutUseProtoMessages(t *testing.T) {
	s := testState(t)

	registerForDispatch(t, s, "alice")
	login := dispatchAction(t, s, &service.BaseInfo{UID: 0, RequestID: 2}, pb.Type_TYPE_ACTION_LOGIN, &pb.LoginRequest{
		Username: "alice", Password: "pass",
	})
	token := login.Response.(*pb.LoginResponse).GetToken()

	auth := dispatchAction(t, s, &service.BaseInfo{UID: 0, RequestID: 3}, pb.Type_TYPE_ACTION_AUTHENTICATE, &pb.AuthenticateRequest{
		Token: token,
	})
	authResp := auth.Response.(*pb.AuthenticateResponse)
	if authResp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK || authResp.GetUid() <= 0 {
		t.Fatalf("authenticate result = %+v", authResp)
	}

	// logout 未携带 token 时回退使用 BaseInfo.Token（由连接态填入）。
	logout := dispatchAction(t, s, &service.BaseInfo{UID: authResp.GetUid(), RequestID: 4, Token: token}, pb.Type_TYPE_ACTION_LOGOUT, &pb.LogoutRequest{})
	if logout.Response.(*pb.LogoutResponse).GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("logout result = %+v", logout.Response)
	}
}

func TestDispatchGetContactsReturnsCursorFields(t *testing.T) {
	s := testState(t)
	registerForDispatch(t, s, "alice")
	registerForDispatch(t, s, "bob")

	alice := s.Login(&service.BaseInfo{RequestID: 10}, &pb.LoginRequest{Username: "alice", Password: "pass"}).GetUid()
	bob := s.Login(&service.BaseInfo{RequestID: 11}, &pb.LoginRequest{Username: "bob", Password: "pass"}).GetUid()
	s.AddFriend(&service.BaseInfo{UID: alice, RequestID: 12}, &pb.AddFriendRequest{FriendUid: bob})
	s.AcceptFriend(&service.BaseInfo{UID: bob, RequestID: 13}, &pb.AcceptFriendRequest{FriendUid: alice})

	result := dispatchAction(t, s, &service.BaseInfo{UID: alice, RequestID: 14}, pb.Type_TYPE_ACTION_GET_CONTACTS, &pb.GetContactsRequest{Page: &pb.PageQuery{Limit: 200}})
	resp := result.Response.(*pb.GetContactsResponse)
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_OK {
		t.Fatalf("get_contacts failed: %s", resp.GetBase().GetMsg())
	}
	if len(resp.GetContacts()) != 1 {
		t.Fatalf("contacts = %d, want 1", len(resp.GetContacts()))
	}
	if resp.GetPage().GetHasMoreForward() {
		t.Fatalf("has_more_forward = true, want false")
	}
}

func TestDispatchUnknownTypeHasStableErrorCode(t *testing.T) {
	s := testState(t)
	result := dispatchAction(t, s, &service.BaseInfo{UID: 0, RequestID: 1}, pb.Type(999), &pb.PingRequest{})
	resp := result.Response.(*pb.PingResponse)
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_UNKNOWN_ACTION {
		t.Fatalf("code = %v", resp.GetBase().GetCode())
	}
	if result.Request != nil {
		t.Fatalf("unknown type should not decode a request")
	}
}

func TestDispatchInvalidProtobufBody(t *testing.T) {
	s := testState(t)
	frame := Frame{
		Codec:     FrameCodecProtobuf,
		Endian:    FrameEndianBig,
		RequestID: 1,
		Type:      uint16(pb.Type_TYPE_ACTION_LOGIN),
		Body:      []byte{0xff, 0xff, 0xff, 0xff},
	}
	result, err := DispatchActionFrame(s, &service.BaseInfo{RequestID: 1}, frame)
	if err != nil {
		t.Fatalf("dispatch err: %v", err)
	}
	resp := result.Response.(*pb.LoginResponse)
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_INVALID_PROTOBUF {
		t.Fatalf("code = %v, want INVALID_PROTOBUF", resp.GetBase().GetCode())
	}
}

func TestDispatchRejectsNotificationRequestID(t *testing.T) {
	s := testState(t)
	frame := actionFrame(t, pb.Type_TYPE_ACTION_PING, NotificationRequestID, &pb.PingRequest{})
	if _, err := DispatchActionFrame(s, &service.BaseInfo{}, frame); err == nil {
		t.Fatal("request_id=0 frame should be rejected by action dispatch")
	}
}

func TestDispatchFrameTooLarge(t *testing.T) {
	// 构造一个超过整包上限的响应，验证 encodeDispatchResult 回退到 ERROR_FRAME_TOO_LARGE。
	huge := &pb.SearchUserResponse{
		Base:    &pb.BaseResponse{Code: pb.ErrorCode_ERROR_OK},
		Profile: &pb.UserInfo{Nickname: string(make([]byte, MaxFramePacketSize+1024))},
	}
	frame := Frame{Codec: FrameCodecProtobuf, Endian: FrameEndianBig, RequestID: 7, Type: uint16(pb.Type_TYPE_ACTION_SEARCH_USER)}
	result, err := encodeDispatchResult(frame, pb.Type_TYPE_ACTION_SEARCH_USER, &pb.SearchUserRequest{}, huge)
	if err != nil {
		t.Fatalf("encodeDispatchResult err: %v", err)
	}
	resp := result.Response.(*pb.SearchUserResponse)
	if resp.GetBase().GetCode() != pb.ErrorCode_ERROR_FRAME_TOO_LARGE {
		t.Fatalf("code = %v, want FRAME_TOO_LARGE", resp.GetBase().GetCode())
	}
}

func TestApplySetAuthRegistersConnectionBeforeResponseSend(t *testing.T) {
	s := testState(t)
	conn := &connState{}

	registeredConn := applySetAuth(s, conn, 1001, "tok1001")
	t.Cleanup(func() {
		s.Online().Unregister(conn.uid, registeredConn)
	})

	notif := appmsg.ContactsUpdatedNotif()
	s.Online().Notify(1001, notif)

	select {
	case got := <-registeredConn.Ch:
		if got != notif {
			t.Fatalf("notification = %#v, want %#v", got, notif)
		}
	default:
		t.Fatal("expected authenticated connection to be registered before response send")
	}
}

func TestClearAuthStateResetsConnectionAndUnregistersOnlineEntry(t *testing.T) {
	s := testState(t)
	conn := &connState{}

	registeredConn := applySetAuth(s, conn, 1001, "tok1001")
	clearAuthState(s, conn)

	if conn.uid != 0 || conn.token != "" || len(conn.conns) != 0 {
		t.Fatalf("conn = %+v", conn)
	}

	notif := appmsg.ContactsUpdatedNotif()
	s.Online().Notify(1001, notif)

	select {
	case got, ok := <-registeredConn.Ch:
		if ok {
			t.Fatalf("unexpected notification after unregister: %#v", got)
		}
	default:
		t.Fatal("expected online channel to be closed after unregister")
	}
}

func TestTypeRequiresAuth(t *testing.T) {
	if typeRequiresAuth(uint16(pb.Type_TYPE_ACTION_LOGIN)) {
		t.Fatal("login should not require auth")
	}
	if !typeRequiresAuth(uint16(pb.Type_TYPE_ACTION_SEND_MESSAGE)) {
		t.Fatal("send_message should require auth")
	}
}

func TestApplySetAuthReplacesPreviousOnlineEntries(t *testing.T) {
	s := testState(t)
	conn := &connState{}
	first := applySetAuth(s, conn, 1001, "tok1")
	second := applySetAuth(s, conn, 1002, "tok2")
	t.Cleanup(func() {
		s.Online().Unregister(conn.uid, second)
	})

	if conn.uid != 1002 || conn.token != "tok2" || len(conn.conns) != 1 {
		t.Fatalf("conn = %+v", conn)
	}
	if !channelClosed(first) {
		t.Fatal("old online entry should be closed")
	}
}

func channelClosed(c *online.Conn) bool {
	select {
	case _, ok := <-c.Ch:
		return !ok
	default:
		return false
	}
}
