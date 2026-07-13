package service

import (
	"strconv"

	"yimsg/internal/appmsg"
	"yimsg/internal/auth"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/shard"
)

func (s *AppState) CreateGroup(info *BaseInfo, req *pb.CreateGroupRequest) *pb.CreateGroupResponse {
	reqID := info.RequestID
	ownerUID := info.UID
	memberUIDs := req.GetMemberUids()
	// Ensure owner is in the member list
	hasOwner := false
	for _, uid := range memberUIDs {
		if uid == ownerUID {
			hasOwner = true
			break
		}
	}
	if !hasOwner {
		memberUIDs = append([]int64{ownerUID}, memberUIDs...)
	}

	groupID := s.IDGen().NextID()
	now := auth.NowMs()

	profiles := LookupProfiles(s, memberUIDs)

	groupStore := s.GroupStore(groupID)
	if err := groupStore.CreateGroup(groupID, req.GetName(), ownerUID, memberUIDs, now); err != nil {
		return toCreateGroupResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	// Send system message to all members
	ownerNick := profiles[ownerUID][0]
	if ownerNick == "" {
		ownerNick = "Someone"
	}
	sendSystemMessageToUIDs(s, groupID, FormatGroupSystemMsg("created", ownerNick), memberUIDs)

	return toCreateGroupResponse(appmsg.OKGroupCreated(reqID, groupID))
}

func (s *AppState) GetGroupInfos(info *BaseInfo, req *pb.GetGroupInfosRequest) *pb.GetGroupInfosResponse {
	reqID := info.RequestID
	callerUID := info.UID
	groupIDs := req.GetGroupIds()
	if exceededBatch(groupIDs, s.MaxBatchLimit()) {
		return toGetGroupInfosResponse(errBatchLimit(reqID, s.MaxBatchLimit()))
	}
	infos, err := batchQueryShard(s.DB().GroupShards, groupIDs, func(db *shard.DB, batch []int64) ([]dal.GroupInfo, error) {
		return dal.NewGroupStore(db).ListByIDs(batch)
	})
	if err != nil {
		return toGetGroupInfosResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if callerUID != 0 && len(infos) > 0 {
		names := make(map[int64]string, len(infos))
		for _, info := range infos {
			names[info.GroupID] = info.Name
		}
		changed, err := s.ContactStore(callerUID).UpdateGroupProjections(callerUID, names, auth.NowMs())
		if err != nil {
			return toGetGroupInfosResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		if changed > 0 {
			notifyContactsUpdated(s, callerUID)
		}
	}

	return toGetGroupInfosResponse(appmsg.OKGroupInfos(reqID, infos))
}

func (s *AppState) GetGroupMembers(info *BaseInfo, req *pb.GetGroupMembersRequest) *pb.GetGroupMembersResponse {
	reqID := info.RequestID
	groupID := req.GetGroupId()
	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())
	groupStore := s.GroupStore(groupID)

	parts, err := decodeCursor(page.cursor)
	if err != nil {
		return toGetGroupMembersResponse(appmsg.ErrInvalidArgument(reqID, "invalid cursor"))
	}
	// 群成员展示通道 keyset 分页：role 倒序、uid 升序。
	members, err := groupStore.ListMembersPage(groupID, parts, page.backward, page.limit+1)
	if err != nil {
		return toGetGroupMembersResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	hasMoreTraveled := int64(len(members)) > page.limit
	if hasMoreTraveled {
		members = members[:page.limit]
	}
	if page.backward {
		reverseInPlace(members) // ListMembersPage backward 返回反展示序，转回展示序
	}

	membersDTO := make([]appmsg.GroupMember, len(members))
	for i, m := range members {
		membersDTO[i] = appmsg.GroupMember{
			UID:      m.UID,
			Role:     m.Role,
			JoinedAt: m.JoinedAt,
		}
	}

	total, err := groupStore.CountMembers(groupID)
	if err != nil {
		return toGetGroupMembersResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	info2 := appmsg.PageInfo{Total: total}
	if len(members) > 0 {
		info2.StartCursor = memberCursor(members[0])
		info2.EndCursor = memberCursor(members[len(members)-1])
	}
	if page.backward {
		info2.HasMoreBackward = hasMoreTraveled
		info2.HasMoreForward = page.hasCursor
	} else {
		info2.HasMoreForward = hasMoreTraveled
		info2.HasMoreBackward = page.hasCursor
	}
	resp := appmsg.OKGroupMembers(reqID, membersDTO)
	resp.Page = &info2
	return toGetGroupMembersResponse(resp)
}

// memberCursor 按展示序编码群成员的不透明 keyset 游标 [role, uid]。
func memberCursor(m dal.GroupMember) string {
	return encodeCursor(strconv.FormatInt(int64(m.Role), 10), strconv.FormatInt(m.UID, 10))
}

func (s *AppState) UpdateGroupInfo(info *BaseInfo, req *pb.UpdateGroupInfoRequest) *pb.UpdateGroupInfoResponse {
	reqID := info.RequestID
	uid := info.UID
	groupID := req.GetGroupId()
	groupStore := s.GroupStore(groupID)

	groupInfo, err := groupStore.GetInfo(groupID)
	if err != nil {
		return toUpdateGroupInfoResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if groupInfo == nil {
		return toUpdateGroupInfoResponse(appmsg.ErrNotFound(reqID, "group not found"))
	}
	if groupInfo.OwnerUID != uid {
		return toUpdateGroupInfoResponse(appmsg.ErrForbidden(reqID, "only the group owner can update group info"))
	}

	ok, err := groupStore.UpdateInfo(groupID, req.GetName(), req.GetAvatar(), auth.NowMs())
	if err != nil {
		return toUpdateGroupInfoResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toUpdateGroupInfoResponse(appmsg.ErrNotFound(reqID, "group not found"))
	}

	return toUpdateGroupInfoResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) AddGroupMember(info *BaseInfo, req *pb.AddGroupMemberRequest) *pb.AddGroupMemberResponse {
	reqID := info.RequestID
	groupID := req.GetGroupId()
	newUID := req.GetUid()
	groupStore := s.GroupStore(groupID)

	// Lookup profile for system message
	newProfiles := LookupProfiles(s, []int64{newUID})
	newP := newProfiles[newUID]

	ok, err := groupStore.AddMember(groupID, newUID, dal.RoleMember, auth.NowMs())
	if err != nil {
		return toAddGroupMemberResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toAddGroupMemberResponse(appmsg.ErrAlreadyExists(reqID, "member already exists"))
	}

	// System message
	members, _ := groupStore.ListAllMembers(groupID)
	nick := newP[0]
	if nick == "" {
		nick = "Someone"
	}
	sendSystemMessage(s, groupID, FormatGroupSystemMsg("joined", nick), members)

	return toAddGroupMemberResponse(appmsg.OKEmpty(reqID))
}

func (s *AppState) RemoveGroupMember(info *BaseInfo, req *pb.RemoveGroupMemberRequest) *pb.RemoveGroupMemberResponse {
	reqID := info.RequestID
	groupID := req.GetGroupId()
	targetUID := req.GetUid()
	groupStore := s.GroupStore(groupID)

	// Get current members before removal for notification
	members, _ := groupStore.ListAllMembers(groupID)

	ok, err := groupStore.RemoveMember(groupID, targetUID)
	if err != nil {
		return toRemoveGroupMemberResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toRemoveGroupMemberResponse(appmsg.ErrNotFound(reqID, "member not found"))
	}

	// System message to remaining + removed member
	profiles := LookupProfiles(s, []int64{targetUID})
	nick := profiles[targetUID][0]
	if nick == "" {
		nick = "Someone"
	}
	sendSystemMessage(s, groupID, FormatGroupSystemMsg("removed", nick), members)

	return toRemoveGroupMemberResponse(appmsg.OKEmpty(reqID))
}
