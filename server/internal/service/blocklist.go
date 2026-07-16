package service

import (
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/auth"
	"yimsg/server/internal/dal"
)

func isEitherWayBlocked(s *AppState, a, b int64) (bool, error) {
	blocked, err := s.BlocklistStore(a).IsBlocked(a, b)
	if err != nil || blocked {
		return blocked, err
	}
	return s.BlocklistStore(b).IsBlocked(b, a)
}

func (s *AppState) BlockUser(info *BaseInfo, req *pb.BlockUserRequest) *pb.BlockUserResponse {
	reqID := info.RequestID
	uid := info.UID
	blockUID := req.GetUid()
	if blockUID == 0 {
		return toBlockUserResponse(appmsg.ErrInvalidArgument(reqID, "uid required"))
	}
	if uid == blockUID {
		return toBlockUserResponse(appmsg.ErrInvalidArgument(reqID, "cannot block yourself"))
	}

	profile, err := s.UserStore(blockUID).GetInfo(blockUID)
	if err != nil {
		return toBlockUserResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if profile == nil {
		return toBlockUserResponse(appmsg.ErrNotFound(reqID, "user not found"))
	}

	now := auth.NowMs()
	seq, err := s.BlocklistStore(uid).Upsert(uid, blockUID, now)
	if err != nil {
		return toBlockUserResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	if _, err := s.ContactStore(uid).RejectRequest(uid, blockUID); err == nil {
		notifyContactsUpdated(s, uid)
	}

	notifyOnlineUser(s, uid, appmsg.BlocklistUpdatedNotif)
	return toBlockUserResponse(appmsg.OKContactWrite(reqID, seq))
}

func (s *AppState) UnblockUser(info *BaseInfo, req *pb.UnblockUserRequest) *pb.UnblockUserResponse {
	reqID := info.RequestID
	uid := info.UID
	blockUID := req.GetUid()
	if blockUID == 0 {
		return toUnblockUserResponse(appmsg.ErrInvalidArgument(reqID, "uid required"))
	}
	seq, _, err := s.BlocklistStore(uid).Delete(uid, blockUID, auth.NowMs())
	if err != nil {
		return toUnblockUserResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	notifyOnlineUser(s, uid, appmsg.BlocklistUpdatedNotif)
	if seq == 0 {
		return toUnblockUserResponse(appmsg.OKEmpty(reqID))
	}
	return toUnblockUserResponse(appmsg.OKContactWrite(reqID, seq))
}

func optionalBlocklistStatus(status *pb.BlocklistStatus) (*uint8, bool) {
	if status == nil {
		return nil, true
	}
	switch *status {
	case pb.BlocklistStatus_BLOCKLIST_STATUS_ACTIVE, pb.BlocklistStatus_BLOCKLIST_STATUS_DELETED:
		value := uint8(*status)
		return &value, true
	default:
		return nil, false
	}
}

func (s *AppState) GetBlocklist(info *BaseInfo, req *pb.GetBlocklistRequest) *pb.GetBlocklistResponse {
	reqID := info.RequestID
	uid := info.UID
	status, ok := optionalBlocklistStatus(req.Status)
	if !ok {
		return toGetBlocklistResponse(appmsg.ErrInvalidArgument(reqID, "invalid blocklist status"))
	}
	filter := dal.BlocklistFilter{Status: status, UIDs: req.GetUids()}
	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())
	store := s.BlocklistStore(uid)

	// 屏蔽列表展示序为 新→旧（descTop，按 seq 倒序）。older=向旧(before)、newer=向新(after)。
	users, pageInfo, err := fetchSeqPage(
		page, true,
		func(b, l int64) ([]dal.BlocklistEntry, error) { return store.ListFiltered(uid, filter, b, 0, l) },
		func(b, l int64) ([]dal.BlocklistEntry, error) { return store.ListFiltered(uid, filter, 0, b, l) },
		func(u dal.BlocklistEntry) int64 { return u.Seq },
	)
	if err != nil {
		return toGetBlocklistResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	resp := appmsg.OKBlocklistUsers(reqID, users)
	resp.Page = &pageInfo
	return toGetBlocklistResponse(resp)
}

func (s *AppState) SyncBlocklist(info *BaseInfo, req *pb.SyncBlocklistRequest) *pb.SyncBlocklistResponse {
	reqID := info.RequestID
	uid := info.UID
	lastSeq := req.GetLastSeq()
	limit := effectiveLimit(req.GetLimit(), s.MaxBatchLimit())
	rebuild := req.GetRebuild()
	store := s.BlocklistStore(uid)
	gcSafeSeq, _, err := store.GetVersion(uid)
	if err != nil {
		return toSyncBlocklistResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if resp := rejectTooOldSyncSeq(reqID, lastSeq, gcSafeSeq, rebuild); resp != nil {
		return toSyncBlocklistResponse(resp)
	}
	return toSyncBlocklistResponse(respondSyncPage(reqID, limit, func() ([]dal.BlocklistEntry, error) {
		return store.Sync(uid, lastSeq, limit+1)
	}, func(u dal.BlocklistEntry) int64 { return u.Seq }, appmsg.OKBlocklistUsers))
}
