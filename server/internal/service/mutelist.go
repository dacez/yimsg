package service

import (
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/auth"
	"yimsg/server/internal/dal"
)

func (s *AppState) MuteConversation(info *BaseInfo, req *pb.MuteConversationRequest) *pb.MuteConversationResponse {
	toUID, groupID := targetIDs(req.GetTarget())
	return toMuteConversationResponse(s.setMuteConversation(info, toUID, groupID, true))
}

func (s *AppState) UnmuteConversation(info *BaseInfo, req *pb.UnmuteConversationRequest) *pb.UnmuteConversationResponse {
	toUID, groupID := targetIDs(req.GetTarget())
	return toUnmuteConversationResponse(s.setMuteConversation(info, toUID, groupID, false))
}

func (s *AppState) setMuteConversation(info *BaseInfo, toUID, groupID int64, muted bool) *appmsg.Response {
	reqID := info.RequestID
	uid := info.UID
	if (toUID == 0 && groupID == 0) || (toUID > 0 && groupID > 0) {
		return appmsg.ErrInvalidArgument(reqID, "to_uid or group_id required")
	}
	if toUID == uid {
		return appmsg.ErrInvalidArgument(reqID, "cannot mutelist yourself")
	}

	if groupID > 0 {
		ok, err := s.GroupStore(groupID).IsMember(groupID, uid)
		if err != nil {
			return appmsg.ErrInternal(reqID, err.Error())
		}
		if !ok {
			return appmsg.ErrForbidden(reqID, "not a group member")
		}
	} else {
		profile, err := s.UserStore(toUID).GetInfo(toUID)
		if err != nil {
			return appmsg.ErrInternal(reqID, err.Error())
		}
		if profile == nil {
			return appmsg.ErrNotFound(reqID, "user not found")
		}
	}

	seq, err := s.MutelistStore(uid).Upsert(uid, toUID, groupID, muted, auth.NowMs())
	if err != nil {
		return appmsg.ErrInternal(reqID, err.Error())
	}

	notifyOnlineUser(s, uid, appmsg.MutelistUpdatedNotif)
	return appmsg.OKContactWrite(reqID, seq)
}

func optionalMutelistStatus(status *pb.MutelistStatus) (*uint8, bool) {
	if status == nil {
		return nil, true
	}
	switch *status {
	case pb.MutelistStatus_MUTELIST_STATUS_ACTIVE, pb.MutelistStatus_MUTELIST_STATUS_DELETED:
		value := uint8(*status)
		return &value, true
	default:
		return nil, false
	}
}

func (s *AppState) GetMutelist(info *BaseInfo, req *pb.GetMutelistRequest) *pb.GetMutelistResponse {
	reqID := info.RequestID
	uid := info.UID
	status, ok := optionalMutelistStatus(req.Status)
	if !ok {
		return toGetMutelistResponse(appmsg.ErrInvalidArgument(reqID, "invalid mutelist status"))
	}
	var toUIDs, groupIDs []int64
	for _, target := range req.GetTargets() {
		itemToUID, itemGroupID := targetIDs(target)
		if itemGroupID > 0 {
			groupIDs = append(groupIDs, itemGroupID)
		} else if itemToUID > 0 {
			toUIDs = append(toUIDs, itemToUID)
		}
	}
	filter := dal.MutelistFilter{Status: status, ToUIDs: toUIDs, GroupIDs: groupIDs}
	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())
	store := s.MutelistStore(uid)

	// 免打扰列表展示序为 新→旧（descTop，按 seq 倒序）。older=向旧(before)、newer=向新(after)。
	mutes, pageInfo, err := fetchSeqPage(
		page, true,
		func(b, l int64) ([]dal.MutelistEntry, error) { return store.ListFiltered(uid, filter, b, 0, l) },
		func(b, l int64) ([]dal.MutelistEntry, error) { return store.ListFiltered(uid, filter, 0, b, l) },
		func(m dal.MutelistEntry) int64 { return m.Seq },
	)
	if err != nil {
		return toGetMutelistResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	resp := appmsg.OKMutelist(reqID, mutes)
	resp.Page = &pageInfo
	return toGetMutelistResponse(resp)
}

func (s *AppState) SyncMutelist(info *BaseInfo, req *pb.SyncMutelistRequest) *pb.SyncMutelistResponse {
	reqID := info.RequestID
	uid := info.UID
	lastSeq := req.GetLastSeq()
	limit := effectiveLimit(req.GetLimit(), s.MaxBatchLimit())
	rebuild := req.GetRebuild()
	store := s.MutelistStore(uid)
	gcSafeSeq, _, err := store.GetVersion(uid)
	if err != nil {
		return toSyncMutelistResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if resp := rejectTooOldSyncSeq(reqID, lastSeq, gcSafeSeq, rebuild); resp != nil {
		return toSyncMutelistResponse(resp)
	}
	return toSyncMutelistResponse(respondSyncPage(reqID, limit, func() ([]dal.MutelistEntry, error) {
		return store.Sync(uid, lastSeq, limit+1)
	}, func(m dal.MutelistEntry) int64 { return m.Seq }, appmsg.OKMutelist))
}
