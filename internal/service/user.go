package service

import (
	"yimsg/internal/appmsg"
	"yimsg/internal/auth"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/shard"
)

func (s *AppState) Register(info *BaseInfo, req *pb.RegisterRequest) *pb.RegisterResponse {
	reqID := info.RequestID
	username := req.GetUsername()
	if username == "" {
		return toRegisterResponse(appmsg.ErrInvalidArgument(reqID, "username is required"))
	}
	hash, err := auth.HashPassword(req.GetPassword())
	if err != nil {
		return toRegisterResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	uid := s.IDGen().NextID()

	// Step 1: occupy username
	lookupStore := s.UserLookupStore(username)
	ok, err := lookupStore.Insert(username, uid)
	if err != nil {
		return toRegisterResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toRegisterResponse(appmsg.ErrAlreadyExists(reqID, "username already exists"))
	}

	// Step 2: create user
	now := auth.NowMs()
	userStore := s.UserStore(uid)
	if err := userStore.Create(uid, username, hash, req.GetNickname(), now); err != nil {
		return toRegisterResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	return toRegisterResponse(appmsg.OKRegister(reqID, uid))
}

func (s *AppState) Login(info *BaseInfo, req *pb.LoginRequest) *pb.LoginResponse {
	reqID := info.RequestID
	username := req.GetUsername()
	// Step 1: lookup uid
	lookupStore := s.UserLookupStore(username)
	uid, err := lookupStore.GetUID(username)
	if err != nil {
		return toLoginResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if uid == 0 {
		return toLoginResponse(appmsg.ErrNotFound(reqID, "user not found"))
	}

	// Step 2: verify password
	userStore := s.UserStore(uid)
	user, err := userStore.Get(uid)
	if err != nil {
		return toLoginResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if user == nil {
		return toLoginResponse(appmsg.ErrNotFound(reqID, "user not found"))
	}
	if !auth.VerifyPassword(req.GetPassword(), user.PasswordHash) {
		return toLoginResponse(appmsg.ErrAuthFailed(reqID, "wrong password"))
	}

	// Step 3: write user_session index
	token, err := auth.GenerateToken(s.Config().Session.TokenBytes)
	if err != nil {
		return toLoginResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	now := auth.NowMs()
	expireAt := now + s.Config().Session.TTLSeconds*1000

	usStore := s.UserSessionStore(uid)
	if err := usStore.AddToken(uid, token, "", now); err != nil {
		return toLoginResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	// Step 4: create session
	sessStore := s.SessionStore(token)
	if err := sessStore.Create(token, uid, now, expireAt); err != nil {
		return toLoginResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	return toLoginResponse(appmsg.OKLogin(reqID, token, uid, clientConfig(s)))
}

func (s *AppState) UpdateUserInfo(info *BaseInfo, req *pb.UpdateUserInfoRequest) *pb.UpdateUserInfoResponse {
	reqID := info.RequestID
	uid := info.UID
	store := s.UserStore(uid)
	ok, err := store.UpdateProfile(uid, req.GetNickname(), req.GetAvatar(), auth.NowMs())
	if err != nil {
		return toUpdateUserInfoResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toUpdateUserInfoResponse(appmsg.ErrNotFound(reqID, "user not found"))
	}
	// 昵称变化会影响组织边上的名字排序投影：按通讯录组织行找到所属组织逐个刷新并扇出。
	if req.GetNickname() != "" {
		refreshOrgMemberProjections(s, uid, req.GetNickname())
	}
	return toUpdateUserInfoResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) UpdatePassword(info *BaseInfo, req *pb.UpdatePasswordRequest) *pb.UpdatePasswordResponse {
	reqID := info.RequestID
	uid := info.UID
	store := s.UserStore(uid)
	user, err := store.Get(uid)
	if err != nil {
		return toUpdatePasswordResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if user == nil {
		return toUpdatePasswordResponse(appmsg.ErrNotFound(reqID, "user not found"))
	}
	if !auth.VerifyPassword(req.GetOldPassword(), user.PasswordHash) {
		return toUpdatePasswordResponse(appmsg.ErrAuthFailed(reqID, "wrong old password"))
	}

	newHash, err := auth.HashPassword(req.GetNewPassword())
	if err != nil {
		return toUpdatePasswordResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	if _, err := store.UpdatePassword(uid, newHash, auth.NowMs()); err != nil {
		return toUpdatePasswordResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	// Kick all sessions
	usStore := s.UserSessionStore(uid)
	sessions, _ := usStore.ListTokens(uid)
	for _, sess := range sessions {
		ss := s.SessionStore(sess.Token)
		_ = ss.Delete(sess.Token)
	}
	_ = usStore.RemoveTokens(uid)

	// Push session:kicked notification
	notif := appmsg.SessionKickedNotif()
	s.Online().Notify(uid, notif)

	return toUpdatePasswordResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) GetUserInfos(info *BaseInfo, req *pb.GetUserInfosRequest) *pb.GetUserInfosResponse {
	reqID := info.RequestID
	callerUID := info.UID
	uids := req.GetUids()
	if exceededBatch(uids, s.MaxBatchLimit()) {
		return toGetUserInfosResponse(errBatchLimit(reqID, s.MaxBatchLimit()))
	}
	profiles, err := getUserInfosWithContactRefresh(s, callerUID, uids)
	if err != nil {
		return toGetUserInfosResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	return toGetUserInfosResponse(appmsg.OKProfiles(reqID, profiles))
}

func getUserInfosWithContactRefresh(s *AppState, callerUID int64, uids []int64) ([]dal.User, error) {
	profiles, err := batchGetUserInfos(s, uids)
	if err != nil {
		return nil, err
	}
	if callerUID == 0 || len(profiles) == 0 {
		return profiles, nil
	}
	names := make(map[int64]string, len(profiles))
	for _, profile := range profiles {
		names[profile.UID] = profile.Nickname
	}
	changed, err := s.ContactStore(callerUID).UpdateFriendProjections(callerUID, names, auth.NowMs())
	if err != nil {
		return nil, err
	}
	if changed > 0 {
		notifyContactsUpdated(s, callerUID)
	}
	return profiles, nil
}

// batchGetUserInfos loads public profiles for a list of UIDs across shards.
func batchGetUserInfos(s *AppState, uids []int64) ([]dal.User, error) {
	return batchQueryShard(s.DB().UIDShards, uids, func(db *shard.DB, batch []int64) ([]dal.User, error) {
		return dal.NewUserStore(db).ListByUIDs(batch)
	})
}

func (s *AppState) SearchUser(info *BaseInfo, req *pb.SearchUserRequest) *pb.SearchUserResponse {
	reqID := info.RequestID
	callerUID := info.UID
	username := req.GetUsername()
	lookupStore := s.UserLookupStore(username)
	uid, err := lookupStore.GetUID(username)
	if err != nil {
		return toSearchUserResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if uid == 0 {
		return toSearchUserResponse(appmsg.OKSearch(reqID, nil))
	}
	if callerUID != 0 && callerUID != uid {
		blocked, err := isEitherWayBlocked(s, callerUID, uid)
		if err != nil {
			return toSearchUserResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		if blocked {
			return toSearchUserResponse(appmsg.OKSearch(reqID, nil))
		}
	}

	userStore := s.UserStore(uid)
	user, err := userStore.GetInfo(uid)
	if err != nil {
		return toSearchUserResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toSearchUserResponse(appmsg.OKSearch(reqID, user))
}
