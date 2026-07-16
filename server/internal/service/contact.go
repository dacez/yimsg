package service

import (
	"strconv"

	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/auth"
	"yimsg/server/internal/dal"
)

func userNickname(s *AppState, uid int64) string {
	profiles, err := batchGetUserInfos(s, []int64{uid})
	if err != nil || len(profiles) == 0 {
		return ""
	}
	return profiles[0].Nickname
}

func groupName(s *AppState, groupID int64) string {
	info, err := s.GroupStore(groupID).GetInfo(groupID)
	if err != nil || info == nil {
		return ""
	}
	return info.Name
}

// exactlyOneTargetID 报告 friend_uid / group_id / org_id 三者是否恰好一个为正。
func exactlyOneTargetID(friendUID, groupID, orgID int64) bool {
	positive := 0
	for _, id := range []int64{friendUID, groupID, orgID} {
		if id > 0 {
			positive++
		}
	}
	return positive == 1
}

func notifyContactsUpdated(s *AppState, uid int64) {
	notifyOnlineUser(s, uid, appmsg.ContactsUpdatedNotif)
}

func (s *AppState) AddFriend(info *BaseInfo, req *pb.AddFriendRequest) *pb.AddFriendResponse {
	reqID := info.RequestID
	uid := info.UID
	friendUID := req.GetFriendUid()
	if uid == friendUID {
		return toAddFriendResponse(appmsg.ErrInvalidArgument(reqID, "cannot add yourself as a friend"))
	}
	blocked, err := isEitherWayBlocked(s, uid, friendUID)
	if err != nil {
		return toAddFriendResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if blocked {
		return toAddFriendResponse(appmsg.ErrForbidden(reqID, "当前无法发起该操作"))
	}

	remarkName := req.GetRemarkName()
	myNickname := userNickname(s, uid)
	friendNickname := userNickname(s, friendUID)
	now := auth.NowMs()

	// 申请方保存自己的联系人视图：自身记录为 PENDING_OUTGOING（等对方处理）。
	myStore := s.ContactStore(uid)
	mySeq, err := myStore.Upsert(uid, friendUID, 0, 0, dal.ContactPendingOutgoing, remarkName,
		dal.ContactSortKey(remarkName, friendNickname), dal.ContactSearchText(remarkName, friendNickname), now)
	if err != nil {
		return toAddFriendResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	// 被申请方不自动写备注，但用申请方昵称生成排序/搜索投影；自身记录为 PENDING_INCOMING（等自己处理）。
	theirStore := s.ContactStore(friendUID)
	_, _ = theirStore.Upsert(friendUID, uid, 0, 0, dal.ContactPendingIncoming, "",
		dal.ContactSortKey("", myNickname), dal.ContactSearchText("", myNickname), now)

	notifyContactsUpdated(s, friendUID)

	return toAddFriendResponse(appmsg.OKContactWrite(reqID, mySeq))
}

func (s *AppState) AcceptFriend(info *BaseInfo, req *pb.AcceptFriendRequest) *pb.AcceptFriendResponse {
	reqID := info.RequestID
	uid := info.UID
	friendUID := req.GetFriendUid()
	blocked, err := isEitherWayBlocked(s, uid, friendUID)
	if err != nil {
		return toAcceptFriendResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if blocked {
		return toAcceptFriendResponse(appmsg.ErrForbidden(reqID, "当前无法发起该操作"))
	}

	// 调用者必须是这条请求的接收方（自身记录为 PENDING_INCOMING），否则 AcceptRequest 不会命中，
	// 避免申请方对自己发出的请求调用 accept 也能成功入库好友关系。
	myStore := s.ContactStore(uid)
	ok, err := myStore.AcceptRequest(uid, friendUID)
	if err != nil {
		return toAcceptFriendResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toAcceptFriendResponse(appmsg.ErrConflict(reqID, "no pending request"))
	}

	// 申请方那一侧的记录是 PENDING_OUTGOING，同步翻成 FRIEND。
	theirStore := s.ContactStore(friendUID)
	_, _ = theirStore.AcceptCounterpartRequest(friendUID, uid)

	notifyOnlineUsers(s, appmsg.ContactsUpdatedNotif, uid, friendUID)

	return toAcceptFriendResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) RejectFriend(info *BaseInfo, req *pb.RejectFriendRequest) *pb.RejectFriendResponse {
	reqID := info.RequestID
	uid := info.UID
	friendUID := req.GetFriendUid()
	// 调用者必须是这条请求的接收方（自身记录为 PENDING_INCOMING），语义与 AcceptFriend 一致。
	myStore := s.ContactStore(uid)
	ok, err := myStore.RejectRequest(uid, friendUID)
	if err != nil {
		return toRejectFriendResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toRejectFriendResponse(appmsg.ErrConflict(reqID, "no pending request"))
	}

	// 申请方那一侧的记录是 PENDING_OUTGOING，同步翻成 DELETED。
	theirStore := s.ContactStore(friendUID)
	_, _ = theirStore.RejectCounterpartRequest(friendUID, uid)

	notifyOnlineUsers(s, appmsg.ContactsUpdatedNotif, uid, friendUID)

	return toRejectFriendResponse(appmsg.OKEmpty(reqID))
}

func removeContact(s *AppState, reqID uint64, uid, friendUID, groupID int64) *appmsg.Response {
	if (friendUID == 0 && groupID == 0) || (friendUID > 0 && groupID > 0) {
		return appmsg.ErrInvalidArgument(reqID, "friend_uid or group_id required")
	}
	store := s.ContactStore(uid)
	seq, ok, err := store.Delete(uid, friendUID, groupID, 0)
	if err != nil {
		return appmsg.ErrInternal(reqID, err.Error())
	}
	if !ok {
		return appmsg.ErrNotFound(reqID, "contact not found")
	}

	notifyContactsUpdated(s, uid)

	return appmsg.OKContactWrite(reqID, seq)
}

func (s *AppState) DeleteFriend(info *BaseInfo, req *pb.DeleteFriendRequest) *pb.DeleteFriendResponse {
	return toDeleteFriendResponse(removeContact(s, info.RequestID, info.UID, req.GetFriendUid(), 0))
}

func (s *AppState) UpdateRemark(info *BaseInfo, req *pb.UpdateRemarkRequest) *pb.UpdateRemarkResponse {
	reqID := info.RequestID
	uid := info.UID
	friendUID, groupID, orgID := contactTargetIDs(req.GetTarget())
	remarkName := req.GetRemarkName()
	if !exactlyOneTargetID(friendUID, groupID, orgID) {
		return toUpdateRemarkResponse(appmsg.ErrInvalidArgument(reqID, "exactly one of friend_uid, group_id, org_id required"))
	}

	store := s.ContactStore(uid)
	// search_text 始终包含昵称/群名/组织名，因此无论是否有备注都需要展示名来重算投影。
	var displayName string
	switch {
	case groupID != 0:
		displayName = groupName(s, groupID)
	case orgID != 0:
		displayName = orgName(s, orgID)
	default:
		displayName = userNickname(s, friendUID)
	}
	now := auth.NowMs()
	ok, err := store.UpdateRemark(uid, friendUID, groupID, orgID, remarkName,
		dal.ContactSortKey(remarkName, displayName), dal.ContactSearchText(remarkName, displayName), now)
	if err != nil {
		return toUpdateRemarkResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toUpdateRemarkResponse(appmsg.ErrNotFound(reqID, "contact not found"))
	}
	return toUpdateRemarkResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) FavoriteGroup(info *BaseInfo, req *pb.FavoriteGroupRequest) *pb.FavoriteGroupResponse {
	reqID := info.RequestID
	uid := info.UID
	groupID := req.GetGroupId()
	if groupID == 0 {
		return toFavoriteGroupResponse(appmsg.ErrInvalidArgument(reqID, "group_id required"))
	}
	groupStore := s.GroupStore(groupID)
	isMember, err := groupStore.IsMember(groupID, uid)
	if err != nil {
		return toFavoriteGroupResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !isMember {
		return toFavoriteGroupResponse(appmsg.ErrForbidden(reqID, "not a group member"))
	}

	remarkName := req.GetRemarkName()
	gname := groupName(s, groupID)
	now := auth.NowMs()
	store := s.ContactStore(uid)
	seq, err := store.Upsert(uid, 0, groupID, 0, dal.ContactFriend, remarkName,
		dal.ContactSortKey(remarkName, gname), dal.ContactSearchText(remarkName, gname), now)
	if err != nil {
		return toFavoriteGroupResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toFavoriteGroupResponse(appmsg.OKContactWrite(reqID, seq))
}

func (s *AppState) UnfavoriteGroup(info *BaseInfo, req *pb.UnfavoriteGroupRequest) *pb.UnfavoriteGroupResponse {
	reqID := info.RequestID
	uid := info.UID
	groupID := req.GetGroupId()
	if groupID == 0 {
		return toUnfavoriteGroupResponse(appmsg.ErrInvalidArgument(reqID, "group_id required"))
	}
	store := s.ContactStore(uid)
	seq, ok, err := store.Delete(uid, 0, groupID, 0)
	if err != nil {
		return toUnfavoriteGroupResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toUnfavoriteGroupResponse(appmsg.ErrNotFound(reqID, "contact not found"))
	}
	return toUnfavoriteGroupResponse(appmsg.OKContactWrite(reqID, seq))
}

func contactsFromDAL(contacts []dal.Contact) []appmsg.Contact {
	result := make([]appmsg.Contact, len(contacts))
	for i, c := range contacts {
		result[i] = appmsg.Contact{
			Target:     appmsg.NewContactTarget(c.FriendUID, c.GroupID, c.OrgID),
			Status:     c.Status,
			Seq:        c.Seq,
			RemarkName: c.RemarkName,
			SortKey:    c.SortKey,
			SearchText: c.SearchText,
		}
	}
	return result
}

func (s *AppState) SyncContacts(info *BaseInfo, req *pb.SyncContactsRequest) *pb.SyncContactsResponse {
	reqID := info.RequestID
	uid := info.UID
	afterSeq := req.GetLastSeq()
	limit := effectiveLimit(req.GetLimit(), s.MaxBatchLimit())
	rebuild := req.GetRebuild()
	store := s.ContactStore(uid)

	gcSafeSeq, _, err := store.GetVersion(uid)
	if err != nil {
		return toSyncContactsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	if resp := rejectTooOldSyncSeq(reqID, afterSeq, gcSafeSeq, rebuild); resp != nil {
		return toSyncContactsResponse(resp)
	}

	return toSyncContactsResponse(respondSyncPage(reqID, limit, func() ([]dal.Contact, error) {
		return store.SyncList(uid, afterSeq, limit+1)
	}, func(c dal.Contact) int64 { return c.Seq }, func(id uint64, items []dal.Contact) *appmsg.Response {
		return appmsg.OKSyncContacts(id, contactsFromDAL(items))
	}))
}

func optionalContactStatus(status *pb.ContactStatus) (*uint8, bool) {
	if status == nil {
		return nil, true
	}
	value, ok := requiredContactStatus(*status)
	if !ok {
		return nil, false
	}
	return &value, true
}

func requiredContactStatus(status pb.ContactStatus) (uint8, bool) {
	switch status {
	case pb.ContactStatus_CONTACT_STATUS_FRIEND,
		pb.ContactStatus_CONTACT_STATUS_PENDING_OUTGOING,
		pb.ContactStatus_CONTACT_STATUS_PENDING_INCOMING,
		pb.ContactStatus_CONTACT_STATUS_DELETED:
		return uint8(status), true
	default:
		return 0, false
	}
}

func (s *AppState) GetContacts(info *BaseInfo, req *pb.GetContactsRequest) *pb.GetContactsResponse {
	reqID := info.RequestID
	uid := info.UID
	status, ok := optionalContactStatus(req.Status)
	if !ok {
		return toGetContactsResponse(appmsg.ErrInvalidArgument(reqID, "invalid contact status"))
	}
	var friendUIDs, groupIDs, orgIDs []int64
	for _, target := range req.GetTargets() {
		friendUID, groupID, orgID := contactTargetIDs(target)
		switch {
		case orgID > 0:
			orgIDs = append(orgIDs, orgID)
		case groupID > 0:
			groupIDs = append(groupIDs, groupID)
		case friendUID > 0:
			friendUIDs = append(friendUIDs, friendUID)
		}
	}
	filter := dal.ContactListFilter{Status: status, FriendUIDs: friendUIDs, GroupIDs: groupIDs, OrgIDs: orgIDs}
	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())
	store := s.ContactStore(uid)

	parts, err := decodeCursor(page.cursor)
	if err != nil {
		return toGetContactsResponse(appmsg.ErrInvalidArgument(reqID, "invalid cursor"))
	}
	// 通讯录展示通道 keyset 分页：FRIEND/默认按 sort_key 升序，PENDING 按 seq 倒序。
	rows, err := store.ListPage(uid, filter, parts, page.backward, page.limit+1)
	if err != nil {
		return toGetContactsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	hasMoreTraveled := int64(len(rows)) > page.limit
	if hasMoreTraveled {
		rows = rows[:page.limit]
	}
	if page.backward {
		reverseInPlace(rows) // ListPage backward 返回反展示序，转回展示序
	}

	pending := filter.Status != nil && dal.IsPendingStatus(*filter.Status)
	pi := appmsg.PageInfo{Total: -1}
	if len(rows) > 0 {
		pi.StartCursor = contactCursor(rows[0], pending)
		pi.EndCursor = contactCursor(rows[len(rows)-1], pending)
	}
	if page.backward {
		pi.HasMoreBackward = hasMoreTraveled
		pi.HasMoreForward = page.hasCursor
	} else {
		pi.HasMoreForward = hasMoreTraveled
		pi.HasMoreBackward = page.hasCursor
	}
	resp := appmsg.OKListContacts(reqID, contactsFromDAL(rows))
	resp.Page = &pi
	return toGetContactsResponse(resp)
}

// contactCursor 按展示序编码通讯录条目的不透明 keyset 游标。
func contactCursor(c dal.Contact, pending bool) string {
	if pending {
		return encodeCursor(strconv.FormatInt(c.Seq, 10))
	}
	return encodeCursor(c.SortKey, strconv.FormatInt(c.Type, 10), strconv.FormatInt(c.ID, 10))
}

func (s *AppState) GetContactCount(info *BaseInfo, req *pb.GetContactCountRequest) *pb.GetContactCountResponse {
	reqID := info.RequestID
	uid := info.UID
	status, ok := requiredContactStatus(req.GetStatus())
	if !ok {
		return toGetContactCountResponse(appmsg.ErrInvalidArgument(reqID, "invalid contact status"))
	}
	total, err := s.ContactStore(uid).Count(uid, dal.ContactListFilter{Status: &status})
	if err != nil {
		return toGetContactCountResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	return toGetContactCountResponse(appmsg.OKContactCount(reqID, total))
}
