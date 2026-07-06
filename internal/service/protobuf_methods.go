package service

import (
	"fmt"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/encoding/protojson"
)

// exceededBatch 报告批量 ID 去重后是否超过服务端上限。max<=0 表示不限制。
func exceededBatch(values []int64, max int64) bool {
	if max <= 0 {
		return false
	}
	seen := make(map[int64]struct{}, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		if int64(len(seen)) > max {
			return true
		}
	}
	return false
}

// okBase 构造成功通用响应。
func okBase() *pb.BaseResponse {
	return &pb.BaseResponse{Code: pb.ErrorCode_ERROR_OK}
}

// errBase 构造失败通用响应。
func errBase(code pb.ErrorCode, msg string) *pb.BaseResponse {
	if code == pb.ErrorCode_ERROR_OK {
		code = pb.ErrorCode_ERROR_INTERNAL_ERROR
	}
	return &pb.BaseResponse{Code: code, Msg: msg}
}

// batchLimitExceeded 构造批量超限通用响应。
func batchLimitExceeded(max int64) *pb.BaseResponse {
	return errBase(pb.ErrorCode_ERROR_BATCH_LIMIT_EXCEEDED, fmt.Sprintf("batch limit exceeded: max %d", max))
}

// errBatchLimit 保留给现有调用点使用。
func errBatchLimit(reqID uint64, max int64) *appmsg.Response {
	return appmsg.ErrResponseCode(reqID, appmsg.ErrorCodeBatchLimitExceeded, fmt.Sprintf("batch limit exceeded: max %d", max))
}

func effectiveLimit(limit, maxLimit int64) int64 {
	const defaultLimit int64 = 200
	if maxLimit <= 0 {
		maxLimit = defaultLimit
	}
	if limit <= 0 {
		if defaultLimit > maxLimit {
			return maxLimit
		}
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}

func setCursor(resp *appmsg.Response, seqs []int64, newer bool, hasMore bool) {
	resp.HasMore = appmsg.BoolPtr(hasMore)
	if len(seqs) == 0 {
		resp.CursorSeq = appmsg.Int64Ptr(0)
		return
	}
	cursor := seqs[len(seqs)-1]
	if newer {
		cursor = seqs[0]
		for _, seq := range seqs[1:] {
			if seq > cursor {
				cursor = seq
			}
		}
	}
	resp.CursorSeq = appmsg.Int64Ptr(cursor)
}

func baseFromApp(resp *appmsg.Response) *pb.BaseResponse {
	if resp == nil {
		return errBase(pb.ErrorCode_ERROR_INTERNAL_ERROR, "nil response")
	}
	if resp.OK {
		return okBase()
	}
	code := resp.ErrorCode
	if code == "" {
		code = appmsg.ErrorCodeInternal
	}
	return errBase(appmsg.ErrorCodeToPb(code), resp.Error)
}

func clientConfigToProto(cc *appmsg.ClientConfig) *pb.ClientConfig {
	if cc == nil {
		return nil
	}
	return &pb.ClientConfig{CacheTtlSeconds: cc.CacheTTLSeconds, CacheMaxEntries: int64(cc.CacheMaxEntries), RecallWindowSeconds: cc.RecallWindowSeconds, BatchMaxLimit: cc.BatchMaxLimit}
}

func userToProto(u dal.User) *pb.UserInfo {
	return &pb.UserInfo{Uid: u.UID, Username: u.Username, Nickname: u.Nickname, Avatar: u.Avatar, CreatedAt: u.CreatedAt, UpdatedAt: u.UpdatedAt}
}

func groupToProto(g dal.GroupInfo) *pb.GroupInfo {
	return &pb.GroupInfo{GroupId: g.GroupID, Name: g.Name, Avatar: g.Avatar, OwnerUid: g.OwnerUID, CreatedAt: g.CreatedAt, UpdatedAt: g.UpdatedAt}
}

func contactTargetToProto(t appmsg.ConversationTarget) *pb.ContactTarget {
	if t.OrgID != nil && int64(*t.OrgID) > 0 {
		return &pb.ContactTarget{Kind: &pb.ContactTarget_OrgId{OrgId: int64(*t.OrgID)}}
	}
	if t.GroupID != nil && int64(*t.GroupID) > 0 {
		return &pb.ContactTarget{Kind: &pb.ContactTarget_GroupId{GroupId: int64(*t.GroupID)}}
	}
	if t.UID != nil && int64(*t.UID) > 0 {
		return &pb.ContactTarget{Kind: &pb.ContactTarget_Uid{Uid: int64(*t.UID)}}
	}
	return &pb.ContactTarget{}
}

func conversationTargetToProto(t appmsg.ConversationTarget) *pb.ConversationTarget {
	if t.GroupID != nil && int64(*t.GroupID) > 0 {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: int64(*t.GroupID)}}
	}
	if t.UID != nil && int64(*t.UID) > 0 {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: int64(*t.UID)}}
	}
	return &pb.ConversationTarget{}
}

func contactToProto(c appmsg.Contact) *pb.Contact {
	return &pb.Contact{Target: contactTargetToProto(c.Target), Status: pb.ContactStatus(c.Status), Seq: c.Seq, RemarkName: c.RemarkName, SortKey: c.SortKey, SearchText: c.SearchText}
}

func muteToProto(m appmsg.MutelistEntry) *pb.MutelistEntry {
	return &pb.MutelistEntry{Target: conversationTargetToProto(m.Target), Status: pb.MutelistStatus(m.Status), Seq: m.Seq, UpdatedAt: m.UpdatedAt}
}

func messageToProto(m appmsg.Message) *pb.Message {
	out := &pb.Message{Seq: m.Seq, MsgId: m.MsgID, FromUid: int64(m.FromUID), Target: conversationTargetToProto(m.Target), MsgType: pb.MessageType(m.MsgType), SendTime: m.SendTime, Status: pb.MessageStatus(m.Status)}
	if len(m.Body) > 0 {
		var body pb.MessageBody
		if err := protojson.Unmarshal(m.Body, &body); err == nil {
			out.Body = &body
		}
	}
	if out.Body == nil {
		out.Body = &pb.MessageBody{}
	}
	return out
}

func pageToProto(p *appmsg.PageInfo) *pb.PageInfo {
	if p == nil {
		return nil
	}
	return &pb.PageInfo{StartCursor: p.StartCursor, EndCursor: p.EndCursor, HasMoreBackward: p.HasMoreBackward, HasMoreForward: p.HasMoreForward, Total: p.Total}
}

func blockToProto(u dal.BlocklistEntry) *pb.BlocklistUser {
	return &pb.BlocklistUser{Uid: u.BlockUID, Status: pb.BlocklistStatus(u.Status), Seq: u.Seq, CreatedAt: u.CreatedAt, UpdatedAt: u.UpdatedAt}
}

func groupMemberToProto(m appmsg.GroupMember) *pb.GroupMember {
	return &pb.GroupMember{Uid: int64(m.UID), Role: int64(m.Role), JoinedAt: m.JoinedAt}
}

func orgInfoToProto(o appmsg.OrgInfo) *pb.OrgInfo {
	return &pb.OrgInfo{OrgId: int64(o.OrgID), Name: o.Name, Avatar: o.Avatar}
}

func tagInfoToProto(t appmsg.TagInfo) *pb.TagInfo {
	return &pb.TagInfo{TagId: int64(t.TagID), Name: t.Name, Avatar: t.Avatar}
}

func tagToProto(t appmsg.Tag) *pb.Tag {
	return &pb.Tag{
		TagId:     int64(t.TagID),
		ChildId:   int64(t.ChildID),
		ChildType: pb.TagChildType(t.ChildType),
		Title:     t.Title,
		Rank:      t.Rank,
		SortKey:   t.SortKey,
		Role:      pb.TagRole(t.Role),
		Status:    pb.TagStatus(t.Status),
		Seq:       t.Seq,
	}
}

func toRegisterResponse(resp *appmsg.Response) *pb.RegisterResponse {
	out := &pb.RegisterResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.UID != nil {
		out.Uid = int64(*resp.UID)
	}
	return out
}
func toLoginResponse(resp *appmsg.Response) *pb.LoginResponse {
	out := &pb.LoginResponse{Base: baseFromApp(resp)}
	if resp != nil {
		if resp.UID != nil {
			out.Uid = int64(*resp.UID)
		}
		out.Token = resp.Token
		out.ClientConfig = clientConfigToProto(resp.ClientConfig)
	}
	return out
}
func toAuthenticateResponse(resp *appmsg.Response) *pb.AuthenticateResponse {
	out := &pb.AuthenticateResponse{Base: baseFromApp(resp)}
	if resp != nil {
		if resp.UID != nil {
			out.Uid = int64(*resp.UID)
		}
		out.ClientConfig = clientConfigToProto(resp.ClientConfig)
	}
	return out
}
func toLogoutResponse(resp *appmsg.Response) *pb.LogoutResponse {
	return &pb.LogoutResponse{Base: baseFromApp(resp)}
}
func toPingResponse(resp *appmsg.Response) *pb.PingResponse {
	return &pb.PingResponse{Base: baseFromApp(resp)}
}
func toUpdateUserInfoResponse(resp *appmsg.Response) *pb.UpdateUserInfoResponse {
	return &pb.UpdateUserInfoResponse{Base: baseFromApp(resp)}
}
func toUpdatePasswordResponse(resp *appmsg.Response) *pb.UpdatePasswordResponse {
	return &pb.UpdatePasswordResponse{Base: baseFromApp(resp)}
}
func toGetUserInfosResponse(resp *appmsg.Response) *pb.GetUserInfosResponse {
	out := &pb.GetUserInfosResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Profiles {
			out.Profiles = append(out.Profiles, userToProto(v))
		}
	}
	return out
}
func toSearchUserResponse(resp *appmsg.Response) *pb.SearchUserResponse {
	out := &pb.SearchUserResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Profile != nil {
		out.Profile = userToProto(*resp.Profile)
	}
	return out
}
func toAddFriendResponse(resp *appmsg.Response) *pb.AddFriendResponse {
	out := &pb.AddFriendResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toAcceptFriendResponse(resp *appmsg.Response) *pb.AcceptFriendResponse {
	return &pb.AcceptFriendResponse{Base: baseFromApp(resp)}
}
func toRejectFriendResponse(resp *appmsg.Response) *pb.RejectFriendResponse {
	return &pb.RejectFriendResponse{Base: baseFromApp(resp)}
}
func toDeleteFriendResponse(resp *appmsg.Response) *pb.DeleteFriendResponse {
	out := &pb.DeleteFriendResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toUpdateRemarkResponse(resp *appmsg.Response) *pb.UpdateRemarkResponse {
	return &pb.UpdateRemarkResponse{Base: baseFromApp(resp)}
}
func toGetContactsResponse(resp *appmsg.Response) *pb.GetContactsResponse {
	out := &pb.GetContactsResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Contacts {
			out.Contacts = append(out.Contacts, contactToProto(v))
		}
	}
	return out
}
func toGetContactCountResponse(resp *appmsg.Response) *pb.GetContactCountResponse {
	out := &pb.GetContactCountResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Total != nil {
		out.Total = *resp.Total
	}
	return out
}
func toSyncContactsResponse(resp *appmsg.Response) *pb.SyncContactsResponse {
	out := &pb.SyncContactsResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Contacts {
			out.Contacts = append(out.Contacts, contactToProto(v))
		}
		if resp.HasMore != nil {
			out.HasMore = *resp.HasMore
		}
		if resp.CursorSeq != nil {
			out.CursorSeq = *resp.CursorSeq
		}
	}
	return out
}
func toFavoriteGroupResponse(resp *appmsg.Response) *pb.FavoriteGroupResponse {
	out := &pb.FavoriteGroupResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toUnfavoriteGroupResponse(resp *appmsg.Response) *pb.UnfavoriteGroupResponse {
	out := &pb.UnfavoriteGroupResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toBlockUserResponse(resp *appmsg.Response) *pb.BlockUserResponse {
	out := &pb.BlockUserResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toUnblockUserResponse(resp *appmsg.Response) *pb.UnblockUserResponse {
	out := &pb.UnblockUserResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toGetBlocklistResponse(resp *appmsg.Response) *pb.GetBlocklistResponse {
	out := &pb.GetBlocklistResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Users {
			out.Users = append(out.Users, blockToProto(v))
		}
	}
	return out
}
func toSyncBlocklistResponse(resp *appmsg.Response) *pb.SyncBlocklistResponse {
	out := &pb.SyncBlocklistResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Users {
			out.Users = append(out.Users, blockToProto(v))
		}
		if resp.HasMore != nil {
			out.HasMore = *resp.HasMore
		}
		if resp.CursorSeq != nil {
			out.CursorSeq = *resp.CursorSeq
		}
	}
	return out
}
func toSendMessageResponse(resp *appmsg.Response) *pb.SendMessageResponse {
	out := &pb.SendMessageResponse{Base: baseFromApp(resp)}
	if resp != nil {
		if resp.Seq != nil {
			out.Seq = *resp.Seq
		}
		if resp.MsgID != nil {
			out.MsgId = *resp.MsgID
		}
	}
	return out
}
func toSyncMessagesResponse(resp *appmsg.Response) *pb.SyncMessagesResponse {
	out := &pb.SyncMessagesResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Messages {
			out.Messages = append(out.Messages, messageToProto(v))
		}
		if resp.HasMore != nil {
			out.HasMore = *resp.HasMore
		}
		if resp.CursorSeq != nil {
			out.CursorSeq = *resp.CursorSeq
		}
	}
	return out
}
func toGetMessagesResponse(resp *appmsg.Response) *pb.GetMessagesResponse {
	out := &pb.GetMessagesResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Messages {
			out.Messages = append(out.Messages, messageToProto(v))
		}
	}
	return out
}
func toDeleteMessageResponse(resp *appmsg.Response) *pb.DeleteMessageResponse {
	out := &pb.DeleteMessageResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toGetConversationsResponse(resp *appmsg.Response) *pb.GetConversationsResponse {
	out := &pb.GetConversationsResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Conversations {
			e := &pb.ConversationEntry{Target: conversationTargetToProto(v.Target), LastSeq: v.LastSeq, UnreadCount: v.UnreadCount, Status: pb.ConversationStatus(v.Status)}
			if v.LastMsg != nil {
				e.LastMsg = messageToProto(*v.LastMsg)
			}
			out.Conversations = append(out.Conversations, e)
		}
	}
	return out
}
func toSyncConversationsResponse(resp *appmsg.Response) *pb.SyncConversationsResponse {
	out := &pb.SyncConversationsResponse{Base: baseFromApp(resp)}
	if resp != nil {
		tmp := toGetConversationsResponse(resp)
		out.Conversations = tmp.Conversations
		if resp.HasMore != nil {
			out.HasMore = *resp.HasMore
		}
		if resp.CursorSeq != nil {
			out.CursorSeq = *resp.CursorSeq
		}
	}
	return out
}
func toGetUnreadCountResponse(resp *appmsg.Response) *pb.GetUnreadCountResponse {
	out := &pb.GetUnreadCountResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.UnreadCount != nil {
		out.UnreadCount = *resp.UnreadCount
	}
	return out
}
func toClearUnreadResponse(resp *appmsg.Response) *pb.ClearUnreadResponse {
	return &pb.ClearUnreadResponse{Base: baseFromApp(resp)}
}
func toDeleteConversationResponse(resp *appmsg.Response) *pb.DeleteConversationResponse {
	out := &pb.DeleteConversationResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toMuteConversationResponse(resp *appmsg.Response) *pb.MuteConversationResponse {
	out := &pb.MuteConversationResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toUnmuteConversationResponse(resp *appmsg.Response) *pb.UnmuteConversationResponse {
	out := &pb.UnmuteConversationResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.Seq != nil {
		out.Seq = *resp.Seq
	}
	return out
}
func toGetMutelistResponse(resp *appmsg.Response) *pb.GetMutelistResponse {
	out := &pb.GetMutelistResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Mutelist {
			out.Mutes = append(out.Mutes, muteToProto(v))
		}
	}
	return out
}
func toSyncMutelistResponse(resp *appmsg.Response) *pb.SyncMutelistResponse {
	out := &pb.SyncMutelistResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Mutelist {
			out.Mutes = append(out.Mutes, muteToProto(v))
		}
		if resp.HasMore != nil {
			out.HasMore = *resp.HasMore
		}
		if resp.CursorSeq != nil {
			out.CursorSeq = *resp.CursorSeq
		}
	}
	return out
}
func toCreateGroupResponse(resp *appmsg.Response) *pb.CreateGroupResponse {
	out := &pb.CreateGroupResponse{Base: baseFromApp(resp)}
	if resp != nil && resp.GroupIDResp != nil {
		out.GroupId = int64(*resp.GroupIDResp)
	}
	return out
}
func toGetGroupInfosResponse(resp *appmsg.Response) *pb.GetGroupInfosResponse {
	out := &pb.GetGroupInfosResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Groups {
			out.Groups = append(out.Groups, groupToProto(v))
		}
	}
	return out
}
func toGetGroupMembersResponse(resp *appmsg.Response) *pb.GetGroupMembersResponse {
	out := &pb.GetGroupMembersResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Members {
			out.Members = append(out.Members, groupMemberToProto(v))
		}
	}
	return out
}
func toUpdateGroupInfoResponse(resp *appmsg.Response) *pb.UpdateGroupInfoResponse {
	return &pb.UpdateGroupInfoResponse{Base: baseFromApp(resp)}
}
func toAddGroupMemberResponse(resp *appmsg.Response) *pb.AddGroupMemberResponse {
	return &pb.AddGroupMemberResponse{Base: baseFromApp(resp)}
}
func toRemoveGroupMemberResponse(resp *appmsg.Response) *pb.RemoveGroupMemberResponse {
	return &pb.RemoveGroupMemberResponse{Base: baseFromApp(resp)}
}

func toGetOrgInfosResponse(resp *appmsg.Response) *pb.GetOrgInfosResponse {
	out := &pb.GetOrgInfosResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Orgs {
			out.Orgs = append(out.Orgs, orgInfoToProto(v))
		}
	}
	return out
}
func toGetTagInfosResponse(resp *appmsg.Response) *pb.GetTagInfosResponse {
	out := &pb.GetTagInfosResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.TagInfos {
			out.Tags = append(out.Tags, tagInfoToProto(v))
		}
	}
	return out
}
func toGetTagsResponse(resp *appmsg.Response) *pb.GetTagsResponse {
	out := &pb.GetTagsResponse{Base: baseFromApp(resp), Page: pageToProto(resp.Page)}
	if resp != nil {
		for _, v := range resp.Tags {
			out.Tags = append(out.Tags, tagToProto(v))
		}
	}
	return out
}
func toSyncTagsResponse(resp *appmsg.Response) *pb.SyncTagsResponse {
	out := &pb.SyncTagsResponse{Base: baseFromApp(resp)}
	if resp != nil {
		for _, v := range resp.Tags {
			out.Tags = append(out.Tags, tagToProto(v))
		}
		if resp.HasMore != nil {
			out.HasMore = *resp.HasMore
		}
		if resp.CursorSeq != nil {
			out.CursorSeq = *resp.CursorSeq
		}
	}
	return out
}

func (s *AppState) Ping(info *BaseInfo, req *pb.PingRequest) *pb.PingResponse {
	return toPingResponse(appmsg.OKEmpty(info.RequestID))
}
