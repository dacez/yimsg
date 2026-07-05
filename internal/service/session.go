package service

import (
	"yimsg/internal/appmsg"
	"yimsg/internal/auth"
	"yimsg/internal/protocol/pb"
)

func (s *AppState) Authenticate(info *BaseInfo, req *pb.AuthenticateRequest) *pb.AuthenticateResponse {
	reqID := info.RequestID
	uid, err := auth.Authenticate(s.DB().TokenShards, &s.Config().Session, req.GetToken())
	if err != nil {
		return toAuthenticateResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	return toAuthenticateResponse(appmsg.OKAuth(reqID, uid, clientConfig(s)))
}

func (s *AppState) Logout(info *BaseInfo, req *pb.LogoutRequest) *pb.LogoutResponse {
	reqID := info.RequestID
	token := req.GetToken()
	if token == "" {
		token = info.Token
	}
	sessStore := s.SessionStore(token)

	// Clean user_session
	sess, _ := sessStore.Get(token)
	if sess != nil {
		usStore := s.UserSessionStore(sess.UID)
		_ = usStore.RemoveToken(sess.UID, token)
	}

	if err := sessStore.Delete(token); err != nil {
		return toLogoutResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toLogoutResponse(appmsg.OKEmpty(reqID))
}
