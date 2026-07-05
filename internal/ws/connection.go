// Package ws implements WebSocket connection handling and message dispatch.
package ws

import (
	"log"
	"net/http"
	"sync"
	"time"
	"yimsg/internal/appmsg"
	"yimsg/internal/online"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/service"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var unauthenticatedTimeout = 15 * time.Second

// connState tracks per-connection auth state.
type connState struct {
	uid    int64
	token  string
	codec  FrameCodec
	endian FrameEndian
	conns  []*online.Conn // online registry entries
}

func applySetAuth(state *service.AppState, conn *connState, uid int64, token string) *online.Conn {
	// Clear previous auth state to avoid leaking registry entries.
	if conn.uid != 0 {
		for _, c := range conn.conns {
			state.Online().Unregister(conn.uid, c)
		}
		conn.conns = nil
	}

	conn.uid = uid
	conn.token = token

	registeredConn := state.Online().Register(uid, token)
	conn.conns = append(conn.conns, registeredConn)
	return registeredConn
}

func clearAuthState(state *service.AppState, conn *connState) {
	for _, c := range conn.conns {
		state.Online().Unregister(conn.uid, c)
	}
	conn.uid = 0
	conn.token = ""
	conn.conns = nil
}

// HandleWS handles WebSocket upgrade and message loop.
func HandleWS(state *service.AppState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade err: %v", err)
			return
		}
		defer ws.Close()

		conn := &connState{codec: FrameCodecProtobuf, endian: FrameEndianBig}
		var writeMu sync.Mutex
		ws.SetReadDeadline(time.Now().Add(unauthenticatedTimeout))

		sendFrame := func(data []byte) {
			writeMu.Lock()
			defer writeMu.Unlock()
			ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
				log.Printf("ws write err: %v", err)
			}
		}
		sendResponse := func(frame Frame, resp proto.Message) {
			body, err := EncodeProtoBody(frame.Codec, resp)
			if err != nil {
				log.Printf("encode response body err: %v", err)
				return
			}
			data, err := EncodeFrameWithEndian(frame.Codec, frame.Endian, frame.RequestID, frame.Type, body)
			if err != nil {
				tooLarge := errorResponseByType(frame.Type, appmsg.ErrorCodeFrameTooLarge, "frame packet too large")
				body, err = EncodeProtoBody(frame.Codec, tooLarge)
				if err != nil {
					log.Printf("encode frame-too-large response err: %v", err)
					return
				}
				data, err = EncodeFrameWithEndian(frame.Codec, frame.Endian, frame.RequestID, frame.Type, body)
				if err != nil {
					log.Printf("encode response frame err: %v", err)
					return
				}
			}
			sendFrame(data)
		}
		sendNotification := func(notif *appmsg.Notification) {
			data, err := EncodeNotificationFrame(conn.codec, conn.endian, notificationToProto(notif))
			if err != nil {
				log.Printf("encode notification frame err: %v", err)
				return
			}
			sendFrame(data)
		}

		// Disconnect cleanup
		defer func() {
			if conn.uid != 0 {
				state.Plugins.HandleDisconnect(state, conn.uid)
				for _, c := range conn.conns {
					state.Online().Unregister(conn.uid, c)
				}
			}
		}()

		for {
			messageType, msgBytes, err := ws.ReadMessage()
			if err != nil {
				break
			}
			if messageType != websocket.BinaryMessage {
				break
			}

			frame, err := DecodeFrame(msgBytes)
			if err != nil {
				log.Printf("decode frame err: %v", err)
				break
			}
			if frame.RequestID == NotificationRequestID {
				continue
			}
			conn.codec = frame.Codec
			conn.endian = frame.Endian

			// Auth check by type；不依赖请求 body，未认证连接直接拒绝需要认证的 action。
			if typeRequiresAuth(frame.Type) && conn.uid == 0 {
				sendResponse(frame, errorResponseByType(frame.Type, appmsg.ErrorCodeAuthRequired, "not authenticated"))
				continue
			}

			// 协议 type -> request -> service -> response -> frame 全部由生成的 DispatchActionFrame 完成；
			// fanout（异步任务队列）/ 通知等业务副作用都在 service 内部处理，dispatch 不感知。
			info := &service.BaseInfo{UID: conn.uid, RequestID: frame.RequestID, Token: conn.token}
			result, err := DispatchActionFrame(state, info, frame)
			if err != nil {
				log.Printf("dispatch action frame err: %v", err)
				break
			}

			// 连接态绑定 / 清理由外层基于 DispatchFrameResult.Type / Request / Response 处理。
			switch result.Type {
			case pb.Type_TYPE_ACTION_LOGIN:
				if resp, ok := result.Response.(*pb.LoginResponse); ok && responseOK(resp.GetBase()) && resp.GetUid() != 0 {
					bindAuthAndDrain(ws, state, conn, resp.GetUid(), resp.GetToken(), result.ResponseFrame, sendFrame, sendNotification)
					continue
				}
			case pb.Type_TYPE_ACTION_AUTHENTICATE:
				if resp, ok := result.Response.(*pb.AuthenticateResponse); ok && responseOK(resp.GetBase()) && resp.GetUid() != 0 {
					token := conn.token
					if req, ok := result.Request.(*pb.AuthenticateRequest); ok {
						token = req.GetToken()
					}
					bindAuthAndDrain(ws, state, conn, resp.GetUid(), token, result.ResponseFrame, sendFrame, sendNotification)
					continue
				}
			case pb.Type_TYPE_ACTION_LOGOUT:
				sendFrame(result.ResponseFrame)
				clearAuthState(state, conn)
				ws.SetReadDeadline(time.Now().Add(unauthenticatedTimeout))
				continue
			}

			sendFrame(result.ResponseFrame)
			if conn.uid == 0 {
				ws.SetReadDeadline(time.Now().Add(unauthenticatedTimeout))
			}
		}
	}
}

// bindAuthAndDrain 在 login / authenticate 成功后绑定连接认证态，
// 先注册在线连接（保证认证后立即下发的通知被缓冲），再发送认证响应，
// 最后启动 goroutine 把在线注册缓冲的通知写回 socket。
func bindAuthAndDrain(ws *websocket.Conn, state *service.AppState, conn *connState, uid int64, token string, responseFrame []byte, sendFrame func([]byte), sendNotification func(*appmsg.Notification)) {
	ws.SetReadDeadline(time.Time{})
	authConn := applySetAuth(state, conn, uid, token)
	sendFrame(responseFrame)
	go func() {
		for msg := range authConn.Ch {
			sendNotification(msg)
		}
	}()
}

func typeRequiresAuth(typeID uint16) bool {
	switch pb.Type(typeID) {
	case pb.Type_TYPE_ACTION_REGISTER, pb.Type_TYPE_ACTION_LOGIN, pb.Type_TYPE_ACTION_AUTHENTICATE:
		return false
	default:
		return true
	}
}

func responseOK(base *pb.BaseResponse) bool {
	return base != nil && base.Code == pb.ErrorCode_ERROR_OK
}

func errorResponseByType(typeID uint16, errorCodeStr, msg string) proto.Message {
	message, ok := NewResponseMessageByType(typeID)
	if !ok {
		message = &pb.PingResponse{}
	}
	code := appmsg.ErrorCodeToPb(errorCodeStr)
	setProtoBaseResponse(message, code, msg)
	return message
}

// setProtoBaseResponse 通过 protobuf 反射设置响应消息的 base 字段。
func setProtoBaseResponse(msg proto.Message, code pb.ErrorCode, msgText string) {
	m := msg.ProtoReflect()
	fd := m.Descriptor().Fields().ByName("base")
	if fd == nil {
		return
	}
	base := &pb.BaseResponse{Code: code, Msg: msgText}
	m.Set(fd, protoreflect.ValueOfMessage(base.ProtoReflect()))
}
