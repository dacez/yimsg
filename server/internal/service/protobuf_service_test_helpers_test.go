package service

import (
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/msgid"

	"google.golang.org/protobuf/proto"
)

func testInfo(uid int64) *BaseInfo {
	return &BaseInfo{UID: uid}
}

// baseResponse 是所有 pb.XxxResponse 结构性满足的接口：每个生成的响应类型都有
// GetBase() *pb.BaseResponse 方法，用它统一读取 code/msg，不必为每个 action 单独判断。
type baseResponse interface {
	GetBase() *pb.BaseResponse
}

// isOK 报告响应是否成功（BaseResponse.code == ERROR_OK）。
func isOK(resp baseResponse) bool {
	return resp.GetBase().GetCode() == pb.ErrorCode_ERROR_OK
}

// errMsg 读取响应的错误信息，成功响应返回空串。
func errMsg(resp baseResponse) string {
	return resp.GetBase().GetMsg()
}

func optContactStatus(status *uint8) *pb.ContactStatus {
	if status == nil {
		return nil
	}
	value := pb.ContactStatus(*status)
	return &value
}

func optBlocklistStatus(status *uint8) *pb.BlocklistStatus {
	if status == nil {
		return nil
	}
	value := pb.BlocklistStatus(*status)
	return &value
}

func optMutelistStatus(status *uint8) *pb.MutelistStatus {
	if status == nil {
		return nil
	}
	value := pb.MutelistStatus(*status)
	return &value
}

func testTarget(uid, groupID int64) *pb.ConversationTarget {
	if groupID > 0 {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: groupID}}
	}
	if uid > 0 {
		return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: uid}}
	}
	return nil
}

func testTargets(toUIDs, groupIDs []int64) []*pb.ConversationTarget {
	targets := make([]*pb.ConversationTarget, 0, len(toUIDs)+len(groupIDs))
	for _, uid := range toUIDs {
		targets = append(targets, testTarget(uid, 0))
	}
	for _, groupID := range groupIDs {
		targets = append(targets, testTarget(0, groupID))
	}
	return targets
}

func testContactTarget(uid, groupID int64) *pb.ContactTarget {
	if groupID > 0 {
		return &pb.ContactTarget{Kind: &pb.ContactTarget_GroupId{GroupId: groupID}}
	}
	if uid > 0 {
		return &pb.ContactTarget{Kind: &pb.ContactTarget_Uid{Uid: uid}}
	}
	return nil
}

func testContactTargets(friendUID, groupID int64, friendUIDs, groupIDs []int64) []*pb.ContactTarget {
	targets := make([]*pb.ContactTarget, 0, len(friendUIDs)+len(groupIDs)+2)
	if friendUID > 0 {
		targets = append(targets, testContactTarget(friendUID, 0))
	}
	if groupID > 0 {
		targets = append(targets, testContactTarget(0, groupID))
	}
	for _, uid := range friendUIDs {
		targets = append(targets, testContactTarget(uid, 0))
	}
	for _, groupID := range groupIDs {
		targets = append(targets, testContactTarget(0, groupID))
	}
	return targets
}

func appendNonZero(values []int64, value int64) []int64 {
	if value <= 0 {
		return values
	}
	out := make([]int64, 0, len(values)+1)
	out = append(out, values...)
	out = append(out, value)
	return out
}

func registerService(s *AppState, _ string, username, password, nickname string) *pb.RegisterResponse {
	return s.Register(testInfo(0), &pb.RegisterRequest{Username: username, Password: password, Nickname: nickname})
}

func loginService(s *AppState, _ string, username, password string) *pb.LoginResponse {
	return s.Login(testInfo(0), &pb.LoginRequest{Username: username, Password: password})
}

func authenticateTokenService(s *AppState, _ string, token string) *pb.AuthenticateResponse {
	return s.Authenticate(testInfo(0), &pb.AuthenticateRequest{Token: token})
}

func logoutService(s *AppState, _ string, token string) *pb.LogoutResponse {
	return s.Logout(testInfo(0), &pb.LogoutRequest{Token: token})
}

func updateUserInfoService(s *AppState, _ string, uid int64, nickname, avatar string) *pb.UpdateUserInfoResponse {
	return s.UpdateUserInfo(testInfo(uid), &pb.UpdateUserInfoRequest{Nickname: nickname, Avatar: avatar})
}

func updatePasswordService(s *AppState, _ string, uid int64, oldPwd, newPwd string) *pb.UpdatePasswordResponse {
	return s.UpdatePassword(testInfo(uid), &pb.UpdatePasswordRequest{OldPassword: oldPwd, NewPassword: newPwd})
}

func getUserInfosService(s *AppState, _ string, uid int64, uids []int64) *pb.GetUserInfosResponse {
	return s.GetUserInfos(testInfo(uid), &pb.GetUserInfosRequest{Uids: uids})
}

func searchUserService(s *AppState, _ string, uid int64, username string) *pb.SearchUserResponse {
	return s.SearchUser(testInfo(uid), &pb.SearchUserRequest{Username: username})
}

func addFriendService(s *AppState, _ string, uid, friendUID int64, remarkName string) *pb.AddFriendResponse {
	return s.AddFriend(testInfo(uid), &pb.AddFriendRequest{FriendUid: friendUID, RemarkName: remarkName})
}

func acceptFriendService(s *AppState, _ string, uid, friendUID int64) *pb.AcceptFriendResponse {
	return s.AcceptFriend(testInfo(uid), &pb.AcceptFriendRequest{FriendUid: friendUID})
}

func rejectFriendService(s *AppState, _ string, uid, friendUID int64) *pb.RejectFriendResponse {
	return s.RejectFriend(testInfo(uid), &pb.RejectFriendRequest{FriendUid: friendUID})
}

func deleteFriendService(s *AppState, _ string, uid, friendUID int64) *pb.DeleteFriendResponse {
	return s.DeleteFriend(testInfo(uid), &pb.DeleteFriendRequest{FriendUid: friendUID})
}

func updateRemarkService(s *AppState, _ string, uid, friendUID, groupID int64, remarkName string) *pb.UpdateRemarkResponse {
	return s.UpdateRemark(testInfo(uid), &pb.UpdateRemarkRequest{Target: testContactTarget(friendUID, groupID), RemarkName: remarkName})
}

func favoriteGroupService(s *AppState, _ string, uid, groupID int64, remarkName string) *pb.FavoriteGroupResponse {
	return s.FavoriteGroup(testInfo(uid), &pb.FavoriteGroupRequest{GroupId: groupID, RemarkName: remarkName})
}

func unfavoriteGroupService(s *AppState, _ string, uid, groupID int64) *pb.UnfavoriteGroupResponse {
	return s.UnfavoriteGroup(testInfo(uid), &pb.UnfavoriteGroupRequest{GroupId: groupID})
}

func listContactsService(s *AppState, _ string, uid int64, filter dal.ContactListFilter, cursor string, limit int64) *pb.GetContactsResponse {
	return s.GetContacts(testInfo(uid), &pb.GetContactsRequest{Status: optContactStatus(filter.Status), Targets: testContactTargets(filter.FriendUID, filter.GroupID, filter.FriendUIDs, filter.GroupIDs), Page: &pb.PageQuery{Cursor: cursor, Limit: limit}})
}

func countPendingContactsService(s *AppState, _ string, uid int64) *pb.GetContactCountResponse {
	return s.GetContactCount(testInfo(uid), &pb.GetContactCountRequest{Status: pb.ContactStatus_CONTACT_STATUS_PENDING_INCOMING})
}

func syncContactsService(s *AppState, _ string, uid, lastSeq, limit int64, rebuild bool) *pb.SyncContactsResponse {
	return s.SyncContacts(testInfo(uid), &pb.SyncContactsRequest{LastSeq: lastSeq, Limit: limit, Rebuild: rebuild})
}

func blockUserService(s *AppState, _ string, uid, blockUID int64) *pb.BlockUserResponse {
	return s.BlockUser(testInfo(uid), &pb.BlockUserRequest{Uid: blockUID})
}

func unblockUserService(s *AppState, _ string, uid, blockUID int64) *pb.UnblockUserResponse {
	return s.UnblockUser(testInfo(uid), &pb.UnblockUserRequest{Uid: blockUID})
}

func listBlocklistService(s *AppState, _ string, uid int64, filter dal.BlocklistFilter, cursor string, limit int64) *pb.GetBlocklistResponse {
	return s.GetBlocklist(testInfo(uid), &pb.GetBlocklistRequest{Status: optBlocklistStatus(filter.Status), Uids: filter.UIDs, Page: &pb.PageQuery{Cursor: cursor, Limit: limit}})
}

func syncBlocklistService(s *AppState, _ string, uid, lastSeq, limit int64, rebuild bool) *pb.SyncBlocklistResponse {
	return s.SyncBlocklist(testInfo(uid), &pb.SyncBlocklistRequest{LastSeq: lastSeq, Limit: limit, Rebuild: rebuild})
}

// muteConversationService 按 muted 分别调用 MuteConversation / UnmuteConversation；
// 两个响应类型都只有 Base 字段，用 baseResponse 接口统一返回，调用方用 isOK/errMsg 判定。
func muteConversationService(s *AppState, _ string, uid, toUID, groupID int64, muted bool) baseResponse {
	if muted {
		return s.MuteConversation(testInfo(uid), &pb.MuteConversationRequest{Target: testTarget(toUID, groupID)})
	}
	return s.UnmuteConversation(testInfo(uid), &pb.UnmuteConversationRequest{Target: testTarget(toUID, groupID)})
}

func listMutelistService(s *AppState, _ string, uid int64, filter dal.MutelistFilter, cursor string, limit int64) *pb.GetMutelistResponse {
	return s.GetMutelist(testInfo(uid), &pb.GetMutelistRequest{Status: optMutelistStatus(filter.Status), Targets: testTargets(appendNonZero(filter.ToUIDs, filter.ToUID), appendNonZero(filter.GroupIDs, filter.GroupID)), Page: &pb.PageQuery{Cursor: cursor, Limit: limit}})
}

func syncMutelistService(s *AppState, _ string, uid, lastSeq, limit int64, rebuild bool) *pb.SyncMutelistResponse {
	return s.SyncMutelist(testInfo(uid), &pb.SyncMutelistRequest{LastSeq: lastSeq, Limit: limit, Rebuild: rebuild})
}

// testBodyFromContent 把测试里的 Content 字符串映射为强类型 MessageBody。
func testBodyFromContent(msgType int8, content string) *pb.MessageBody {
	switch msgType {
	case dal.MsgMarkdown:
		return &pb.MessageBody{Kind: &pb.MessageBody_Markdown{Markdown: &pb.MarkdownBody{Markdown: content}}}
	case dal.MsgSystem:
		return &pb.MessageBody{Kind: &pb.MessageBody_System{System: &pb.SystemBody{Text: content}}}
	default:
		return &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: content}}}
	}
}

// bodyText 从 pb.Message.Body 读出可读文本，供断言使用。
func bodyText(m *pb.Message) string {
	switch b := m.GetBody().GetKind().(type) {
	case *pb.MessageBody_Text:
		return b.Text.GetText()
	case *pb.MessageBody_Markdown:
		return b.Markdown.GetMarkdown()
	case *pb.MessageBody_System:
		return b.System.GetText()
	case *pb.MessageBody_Quote:
		return b.Quote.GetText().GetText()
	case *pb.MessageBody_Recall:
		return b.Recall.GetText()
	default:
		return ""
	}
}

// dalText 从 DAL 消息 body 解出文本，用于直接读 store 的测试断言。
func dalText(m dal.Message) string {
	var body pb.MessageBody
	if len(m.Body) > 0 {
		_ = proto.Unmarshal(m.Body, &body)
	}
	if t := body.GetText(); t != nil {
		return t.GetText()
	}
	return ""
}

// sendResult 是 send_message / recall_message 测试封装的返回结果：
// s.sendMessage 是内部私有方法，返回 appmsg.Response，测试用 toSendMessageResponse
// 转成真正的 pb.SendMessageResponse。
type sendResult struct {
	Response *pb.SendMessageResponse
}

func sendMessageService(s *AppState, _ string, uid int64, req *appmsg.Request) sendResult {
	// 用户消息的 msg_id 由客户端提供：测试缺省时用 msgid.Generate() 造一个合法值。
	id := req.MsgID
	if id == "" {
		id = msgid.Generate()
	}
	result := s.sendMessage(testInfo(uid), &pb.SendMessageRequest{MsgId: id, Target: testTarget(req.ToUID, req.GroupID), MsgType: pb.MessageType(req.MsgType), Body: testBodyFromContent(req.MsgType, req.Content)})
	return sendResult{Response: toSendMessageResponse(result.Response)}
}

// sendBodyService 直接发送指定强类型 body，用于引用/图片/文件等结构化消息测试。
func sendBodyService(s *AppState, uid, toUID, groupID int64, msgType int8, body *pb.MessageBody) sendResult {
	result := s.sendMessage(testInfo(uid), &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: testTarget(toUID, groupID), MsgType: pb.MessageType(msgType), Body: body})
	return sendResult{Response: toSendMessageResponse(result.Response)}
}

func syncMessagesService(s *AppState, _ string, uid, lastSeq, limit int64) *pb.SyncMessagesResponse {
	return s.SyncMessages(testInfo(uid), &pb.SyncMessagesRequest{LastSeq: lastSeq, Limit: limit})
}

func listByConversationService(s *AppState, _ string, uid int64, req *appmsg.Request) *pb.GetMessagesResponse {
	// 消息展示序为旧→新（ascTop）：after=向新(FORWARD)，before=向旧(BACKWARD)，缺省取最旧页。
	page := &pb.PageQuery{Limit: req.Limit}
	if req.AfterSeq > 0 {
		page.Cursor = encodeSeqCursor(req.AfterSeq)
		page.Direction = pb.PageDirection_PAGE_DIRECTION_FORWARD
	}
	return s.GetMessages(testInfo(uid), &pb.GetMessagesRequest{Target: testTarget(req.ToUID, req.GroupID), Page: page})
}

func listConversationsService(s *AppState, _ string, uid int64, cursor string, limit int64) *pb.GetConversationsResponse {
	return s.GetConversations(testInfo(uid), &pb.GetConversationsRequest{Page: &pb.PageQuery{Cursor: cursor, Limit: limit}})
}

func getConversationsByTargetsService(s *AppState, uid int64, targets ...*pb.ConversationTarget) *pb.GetConversationsResponse {
	return s.GetConversations(testInfo(uid), &pb.GetConversationsRequest{Targets: targets})
}

func syncConversationsService(s *AppState, _ string, uid, lastSeq, limit int64) *pb.SyncConversationsResponse {
	return s.SyncConversations(testInfo(uid), &pb.SyncConversationsRequest{LastSeq: lastSeq, Limit: limit})
}

func getUnreadCountService(s *AppState, _ string, uid int64) *pb.GetUnreadCountResponse {
	return s.GetUnreadCount(testInfo(uid), &pb.GetUnreadCountRequest{})
}

func clearUnreadService(s *AppState, _ string, uid, toUID, groupID int64) *pb.ClearUnreadResponse {
	return s.ClearUnread(testInfo(uid), &pb.ClearUnreadRequest{Target: testTarget(toUID, groupID)})
}

func deleteMessageService(s *AppState, _ string, uid int64, req *appmsg.Request) *pb.DeleteMessageResponse {
	return s.DeleteMessage(testInfo(uid), &pb.DeleteMessageRequest{MsgId: req.MsgID})
}

func deleteConversationService(s *AppState, _ string, uid, toUID, groupID int64) *pb.DeleteConversationResponse {
	return s.DeleteConversation(testInfo(uid), &pb.DeleteConversationRequest{Target: testTarget(toUID, groupID)})
}

// recallMessageService 通过 send_message + MESSAGE_TYPE_RECALL + RecallBody 表达撤回。
// 故意填入虚假的 operator_uid/recall_time/text，验证服务端会忽略并覆盖它们。
func recallMessageService(s *AppState, _ string, uid int64, req *appmsg.Request) sendResult {
	body := &pb.MessageBody{Kind: &pb.MessageBody_Recall{Recall: &pb.RecallBody{
		MsgId:       req.MsgID,
		OperatorUid: 999999,
		RecallTime:  1,
		Text:        "client-supplied-should-be-ignored",
	}}}
	// 顶层 MsgId 是撤回事件消息自身的 id，由客户端新生成；RecallBody.MsgId 才是被撤回目标。
	result := s.sendMessage(testInfo(uid), &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: testTarget(req.ToUID, req.GroupID), MsgType: pb.MessageType(dal.MsgRecall), Body: body})
	return sendResult{Response: toSendMessageResponse(result.Response)}
}

func createGroupService(s *AppState, _ string, ownerUID int64, name string, memberUIDs []int64) *pb.CreateGroupResponse {
	return s.CreateGroup(testInfo(ownerUID), &pb.CreateGroupRequest{Name: name, MemberUids: memberUIDs})
}

func getGroupInfosService(s *AppState, _ string, callerUID int64, groupIDs []int64) *pb.GetGroupInfosResponse {
	return s.GetGroupInfos(testInfo(callerUID), &pb.GetGroupInfosRequest{GroupIds: groupIDs})
}

func getGroupMembersService(s *AppState, _ string, groupID int64, cursor string, limit int64) *pb.GetGroupMembersResponse {
	return s.GetGroupMembers(testInfo(0), &pb.GetGroupMembersRequest{GroupId: groupID, Page: &pb.PageQuery{Cursor: cursor, Limit: limit}})
}

func updateGroupInfoService(s *AppState, _ string, uid, groupID int64, name, avatar string) *pb.UpdateGroupInfoResponse {
	return s.UpdateGroupInfo(testInfo(uid), &pb.UpdateGroupInfoRequest{GroupId: groupID, Name: name, Avatar: avatar})
}

func addGroupMemberService(s *AppState, _ string, uid, groupID, newUID int64) *pb.AddGroupMemberResponse {
	return s.AddGroupMember(testInfo(uid), &pb.AddGroupMemberRequest{GroupId: groupID, Uid: newUID})
}

func removeGroupMemberService(s *AppState, _ string, uid, groupID, targetUID int64) *pb.RemoveGroupMemberResponse {
	return s.RemoveGroupMember(testInfo(uid), &pb.RemoveGroupMemberRequest{GroupId: groupID, Uid: targetUID})
}
