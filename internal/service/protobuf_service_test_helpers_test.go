package service

import (
	"encoding/json"
	"strconv"
	"yimsg/internal/appmsg"
	"yimsg/internal/dal"
	"yimsg/internal/msgid"
	"yimsg/internal/protocol/pb"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var testProtoJSON = protojson.MarshalOptions{UseProtoNames: true, UseEnumNumbers: true}

func testInfo(uid int64) *BaseInfo {
	return &BaseInfo{UID: uid}
}

// parseJSONInt64 把 json.Number 解析为 int64，空值或非法返回 0（测试辅助）。
func parseJSONInt64(n json.Number) int64 {
	v, _ := n.Int64()
	return v
}

func responseFromProto(msg proto.Message) *appmsg.Response {
	raw, err := testProtoJSON.Marshal(msg)
	if err != nil {
		panic(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		panic(err)
	}
	resp := &appmsg.Response{}
	if base, _ := payload["base"].(map[string]any); base != nil {
		code := int64(0)
		switch v := base["code"].(type) {
		case float64:
			code = int64(v)
		case string:
			code, _ = strconv.ParseInt(v, 10, 64)
		}
		if code == 0 {
			resp.OK = true
		} else {
			resp.OK = false
			resp.ErrorCode = appmsg.ErrorCodeByNumber(code)
			if msg, _ := base["msg"].(string); msg != "" {
				resp.Error = msg
			}
		}
		delete(payload, "base")
	}
	normalizeProtoJSON(payload, 0, "")
	body, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(body, resp); err != nil {
		panic(err)
	}
	return resp
}

func normalizeProtoJSON(v any, depth int, parent string) {
	switch x := v.(type) {
	case map[string]any:
		for key, value := range x {
			if s, ok := value.(string); ok && numericProtoField(key, depth, parent) {
				if n, err := strconv.ParseInt(s, 10, 64); err == nil {
					x[key] = n
					continue
				}
			}
			normalizeProtoJSON(value, depth+1, key)
		}
	case []any:
		for _, item := range x {
			normalizeProtoJSON(item, depth+1, parent)
		}
	}
}

func numericProtoField(key string, depth int, parent string) bool {
	if depth == 0 {
		switch key {
		case "uid", "group_id", "cursor_seq", "cursor_offset":
			return true
		}
	}
	if parent == "contacts" || parent == "conversations" || parent == "members" {
		switch key {
		case "uid", "friend_uid", "group_id":
			return true
		}
	}
	switch key {
	case "seq", "last_seq", "before_seq", "after_seq", "around_seq", "unread_count", "total",
		"created_at", "updated_at", "send_time", "joined_at", "status", "role", "msg_type",
		"cache_ttl_seconds", "cache_max_entries", "recall_window_seconds", "batch_max_limit":
		return true
	default:
		return false
	}
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

func registerService(s *AppState, _ string, username, password, nickname string) *appmsg.Response {
	return responseFromProto(s.Register(testInfo(0), &pb.RegisterRequest{Username: username, Password: password, Nickname: nickname}))
}

func loginService(s *AppState, _ string, username, password string) *appmsg.Response {
	return responseFromProto(s.Login(testInfo(0), &pb.LoginRequest{Username: username, Password: password}))
}

func authenticateTokenService(s *AppState, _ string, token string) *appmsg.Response {
	return responseFromProto(s.Authenticate(testInfo(0), &pb.AuthenticateRequest{Token: token}))
}

func logoutService(s *AppState, _ string, token string) *appmsg.Response {
	return responseFromProto(s.Logout(testInfo(0), &pb.LogoutRequest{Token: token}))
}

func updateUserInfoService(s *AppState, _ string, uid int64, nickname, avatar string) *appmsg.Response {
	return responseFromProto(s.UpdateUserInfo(testInfo(uid), &pb.UpdateUserInfoRequest{Nickname: nickname, Avatar: avatar}))
}

func updatePasswordService(s *AppState, _ string, uid int64, oldPwd, newPwd string) *appmsg.Response {
	return responseFromProto(s.UpdatePassword(testInfo(uid), &pb.UpdatePasswordRequest{OldPassword: oldPwd, NewPassword: newPwd}))
}

func getUserInfosService(s *AppState, _ string, uid int64, uids []int64) *appmsg.Response {
	return responseFromProto(s.GetUserInfos(testInfo(uid), &pb.GetUserInfosRequest{Uids: uids}))
}

func searchUserService(s *AppState, _ string, uid int64, username string) *appmsg.Response {
	return responseFromProto(s.SearchUser(testInfo(uid), &pb.SearchUserRequest{Username: username}))
}

func addFriendService(s *AppState, _ string, uid, friendUID int64, remarkName string) *appmsg.Response {
	return responseFromProto(s.AddFriend(testInfo(uid), &pb.AddFriendRequest{FriendUid: friendUID, RemarkName: remarkName}))
}

func acceptFriendService(s *AppState, _ string, uid, friendUID int64) *appmsg.Response {
	return responseFromProto(s.AcceptFriend(testInfo(uid), &pb.AcceptFriendRequest{FriendUid: friendUID}))
}

func rejectFriendService(s *AppState, _ string, uid, friendUID int64) *appmsg.Response {
	return responseFromProto(s.RejectFriend(testInfo(uid), &pb.RejectFriendRequest{FriendUid: friendUID}))
}

func deleteFriendService(s *AppState, _ string, uid, friendUID int64) *appmsg.Response {
	return responseFromProto(s.DeleteFriend(testInfo(uid), &pb.DeleteFriendRequest{FriendUid: friendUID}))
}

func updateRemarkService(s *AppState, _ string, uid, friendUID, groupID int64, remarkName string) *appmsg.Response {
	return responseFromProto(s.UpdateRemark(testInfo(uid), &pb.UpdateRemarkRequest{Target: testContactTarget(friendUID, groupID), RemarkName: remarkName}))
}

func favoriteGroupService(s *AppState, _ string, uid, groupID int64, remarkName string) *appmsg.Response {
	return responseFromProto(s.FavoriteGroup(testInfo(uid), &pb.FavoriteGroupRequest{GroupId: groupID, RemarkName: remarkName}))
}

func unfavoriteGroupService(s *AppState, _ string, uid, groupID int64) *appmsg.Response {
	return responseFromProto(s.UnfavoriteGroup(testInfo(uid), &pb.UnfavoriteGroupRequest{GroupId: groupID}))
}

func listContactsService(s *AppState, _ string, uid int64, filter dal.ContactListFilter, cursor string, limit int64) *appmsg.Response {
	return responseFromProto(s.GetContacts(testInfo(uid), &pb.GetContactsRequest{Status: optContactStatus(filter.Status), Targets: testContactTargets(filter.FriendUID, filter.GroupID, filter.FriendUIDs, filter.GroupIDs), Page: &pb.PageQuery{Cursor: cursor, Limit: limit}}))
}

func countPendingContactsService(s *AppState, _ string, uid int64) *appmsg.Response {
	return responseFromProto(s.GetContactCount(testInfo(uid), &pb.GetContactCountRequest{Status: pb.ContactStatus_CONTACT_STATUS_PENDING}))
}

func syncContactsService(s *AppState, _ string, uid, lastSeq, limit int64, rebuild bool) *appmsg.Response {
	out := s.SyncContacts(testInfo(uid), &pb.SyncContactsRequest{LastSeq: lastSeq, Limit: limit, Rebuild: rebuild})
	resp := responseFromProto(out)
	resp.HasMore = appmsg.BoolPtr(out.GetHasMore())
	resp.CursorSeq = appmsg.Int64Ptr(out.GetCursorSeq())
	return resp
}

func blockUserService(s *AppState, _ string, uid, blockUID int64) *appmsg.Response {
	return responseFromProto(s.BlockUser(testInfo(uid), &pb.BlockUserRequest{Uid: blockUID}))
}

func unblockUserService(s *AppState, _ string, uid, blockUID int64) *appmsg.Response {
	return responseFromProto(s.UnblockUser(testInfo(uid), &pb.UnblockUserRequest{Uid: blockUID}))
}

func listBlocklistService(s *AppState, _ string, uid int64, filter dal.BlocklistFilter, cursor string, limit int64) *appmsg.Response {
	return responseFromProto(s.GetBlocklist(testInfo(uid), &pb.GetBlocklistRequest{Status: optBlocklistStatus(filter.Status), Uids: filter.UIDs, Page: &pb.PageQuery{Cursor: cursor, Limit: limit}}))
}

func syncBlocklistService(s *AppState, _ string, uid, lastSeq, limit int64, rebuild bool) *appmsg.Response {
	out := s.SyncBlocklist(testInfo(uid), &pb.SyncBlocklistRequest{LastSeq: lastSeq, Limit: limit, Rebuild: rebuild})
	resp := responseFromProto(out)
	resp.HasMore = appmsg.BoolPtr(out.GetHasMore())
	resp.CursorSeq = appmsg.Int64Ptr(out.GetCursorSeq())
	return resp
}

func muteConversationService(s *AppState, _ string, uid, toUID, groupID int64, muted bool) *appmsg.Response {
	if muted {
		return responseFromProto(s.MuteConversation(testInfo(uid), &pb.MuteConversationRequest{Target: testTarget(toUID, groupID)}))
	}
	return responseFromProto(s.UnmuteConversation(testInfo(uid), &pb.UnmuteConversationRequest{Target: testTarget(toUID, groupID)}))
}

func listMutelistService(s *AppState, _ string, uid int64, filter dal.MutelistFilter, cursor string, limit int64) *appmsg.Response {
	return responseFromProto(s.GetMutelist(testInfo(uid), &pb.GetMutelistRequest{Status: optMutelistStatus(filter.Status), Targets: testTargets(appendNonZero(filter.ToUIDs, filter.ToUID), appendNonZero(filter.GroupIDs, filter.GroupID)), Page: &pb.PageQuery{Cursor: cursor, Limit: limit}}))
}

func syncMutelistService(s *AppState, _ string, uid, lastSeq, limit int64, rebuild bool) *appmsg.Response {
	out := s.SyncMutelist(testInfo(uid), &pb.SyncMutelistRequest{LastSeq: lastSeq, Limit: limit, Rebuild: rebuild})
	resp := responseFromProto(out)
	resp.HasMore = appmsg.BoolPtr(out.GetHasMore())
	resp.CursorSeq = appmsg.Int64Ptr(out.GetCursorSeq())
	return resp
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

// bodyText 从响应 Message.body（protojson）解出可读文本，供断言使用。
func bodyText(m appmsg.Message) string {
	var body pb.MessageBody
	if len(m.Body) == 0 {
		return ""
	}
	if err := protojson.Unmarshal(m.Body, &body); err != nil {
		return ""
	}
	switch b := body.GetKind().(type) {
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

func sendMessageService(s *AppState, _ string, uid int64, req *appmsg.Request) SendMessageResult {
	// 用户消息的 msg_id 由客户端提供：测试缺省时用 msgid.Generate() 造一个合法值。
	id := req.MsgID
	if id == "" {
		id = msgid.Generate()
	}
	result := s.sendMessage(testInfo(uid), &pb.SendMessageRequest{MsgId: id, Target: testTarget(parseJSONInt64(req.ToUID), parseJSONInt64(req.GroupID)), MsgType: pb.MessageType(req.MsgType), Body: testBodyFromContent(req.MsgType, req.Content)})
	result.Response = responseFromProto(toSendMessageResponse(result.Response))
	return result
}

// sendBodyService 直接发送指定强类型 body，用于引用/图片/文件等结构化消息测试。
func sendBodyService(s *AppState, uid, toUID, groupID int64, msgType int8, body *pb.MessageBody) SendMessageResult {
	result := s.sendMessage(testInfo(uid), &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: testTarget(toUID, groupID), MsgType: pb.MessageType(msgType), Body: body})
	result.Response = responseFromProto(toSendMessageResponse(result.Response))
	return result
}

func syncMessagesService(s *AppState, _ string, uid, lastSeq, limit int64) *appmsg.Response {
	out := s.SyncMessages(testInfo(uid), &pb.SyncMessagesRequest{LastSeq: lastSeq, Limit: limit})
	resp := responseFromProto(out)
	resp.HasMore = appmsg.BoolPtr(out.GetHasMore())
	resp.CursorSeq = appmsg.Int64Ptr(out.GetCursorSeq())
	return resp
}

func listByConversationService(s *AppState, _ string, uid int64, req *appmsg.Request) *appmsg.Response {
	// 消息展示序为旧→新（ascTop）：after=向新(FORWARD)，before=向旧(BACKWARD)，缺省取最旧页。
	page := &pb.PageQuery{Limit: req.Limit}
	if req.AfterSeq > 0 {
		page.Cursor = encodeSeqCursor(req.AfterSeq)
		page.Direction = pb.PageDirection_PAGE_DIRECTION_FORWARD
	} else if req.BeforeSeq > 0 {
		page.Cursor = encodeSeqCursor(req.BeforeSeq)
		page.Direction = pb.PageDirection_PAGE_DIRECTION_BACKWARD
	}
	return responseFromProto(s.GetMessages(testInfo(uid), &pb.GetMessagesRequest{Target: testTarget(parseJSONInt64(req.ToUID), parseJSONInt64(req.GroupID)), Page: page}))
}

func listConversationsService(s *AppState, _ string, uid int64, cursor string, limit int64) *appmsg.Response {
	return responseFromProto(s.GetConversations(testInfo(uid), &pb.GetConversationsRequest{Page: &pb.PageQuery{Cursor: cursor, Limit: limit}}))
}

func getConversationsByTargetsService(s *AppState, uid int64, targets ...*pb.ConversationTarget) *appmsg.Response {
	return responseFromProto(s.GetConversations(testInfo(uid), &pb.GetConversationsRequest{Targets: targets}))
}

func syncConversationsService(s *AppState, _ string, uid, lastSeq, limit int64) *appmsg.Response {
	out := s.SyncConversations(testInfo(uid), &pb.SyncConversationsRequest{LastSeq: lastSeq, Limit: limit})
	resp := responseFromProto(out)
	resp.HasMore = appmsg.BoolPtr(out.GetHasMore())
	resp.CursorSeq = appmsg.Int64Ptr(out.GetCursorSeq())
	return resp
}

func getUnreadCountService(s *AppState, _ string, uid int64) *appmsg.Response {
	out := s.GetUnreadCount(testInfo(uid), &pb.GetUnreadCountRequest{})
	resp := responseFromProto(out)
	resp.UnreadCount = appmsg.Int64Ptr(out.GetUnreadCount())
	return resp
}

func clearUnreadService(s *AppState, _ string, uid, toUID, groupID int64) *appmsg.Response {
	return responseFromProto(s.ClearUnread(testInfo(uid), &pb.ClearUnreadRequest{Target: testTarget(toUID, groupID)}))
}

func deleteMessageService(s *AppState, _ string, uid int64, req *appmsg.Request) *appmsg.Response {
	return responseFromProto(s.DeleteMessage(testInfo(uid), &pb.DeleteMessageRequest{MsgId: req.MsgID}))
}

func deleteConversationService(s *AppState, _ string, uid, toUID, groupID int64) *appmsg.Response {
	return responseFromProto(s.DeleteConversation(testInfo(uid), &pb.DeleteConversationRequest{Target: testTarget(toUID, groupID)}))
}

// recallMessageService 通过 send_message + MESSAGE_TYPE_RECALL + RecallBody 表达撤回。
// 故意填入虚假的 operator_uid/recall_time/text，验证服务端会忽略并覆盖它们。
func recallMessageService(s *AppState, _ string, uid int64, req *appmsg.Request) SendMessageResult {
	body := &pb.MessageBody{Kind: &pb.MessageBody_Recall{Recall: &pb.RecallBody{
		MsgId:       req.MsgID,
		OperatorUid: 999999,
		RecallTime:  1,
		Text:        "client-supplied-should-be-ignored",
	}}}
	// 顶层 MsgId 是撤回事件消息自身的 id，由客户端新生成；RecallBody.MsgId 才是被撤回目标。
	result := s.sendMessage(testInfo(uid), &pb.SendMessageRequest{MsgId: msgid.Generate(), Target: testTarget(parseJSONInt64(req.ToUID), parseJSONInt64(req.GroupID)), MsgType: pb.MessageType(dal.MsgRecall), Body: body})
	result.Response = responseFromProto(toSendMessageResponse(result.Response))
	return result
}

func createGroupService(s *AppState, _ string, ownerUID int64, name string, memberUIDs []int64) *appmsg.Response {
	return responseFromProto(s.CreateGroup(testInfo(ownerUID), &pb.CreateGroupRequest{Name: name, MemberUids: memberUIDs}))
}

func getGroupInfosService(s *AppState, _ string, callerUID int64, groupIDs []int64) *appmsg.Response {
	return responseFromProto(s.GetGroupInfos(testInfo(callerUID), &pb.GetGroupInfosRequest{GroupIds: groupIDs}))
}

func getGroupMembersService(s *AppState, _ string, groupID int64, cursor string, limit int64) *appmsg.Response {
	out := s.GetGroupMembers(testInfo(0), &pb.GetGroupMembersRequest{GroupId: groupID, Page: &pb.PageQuery{Cursor: cursor, Limit: limit}})
	resp := responseFromProto(out)
	resp.Total = appmsg.Int64Ptr(out.GetPage().GetTotal())
	return resp
}

func updateGroupInfoService(s *AppState, _ string, uid, groupID int64, name, avatar string) *appmsg.Response {
	return responseFromProto(s.UpdateGroupInfo(testInfo(uid), &pb.UpdateGroupInfoRequest{GroupId: groupID, Name: name, Avatar: avatar}))
}

func addGroupMemberService(s *AppState, _ string, uid, groupID, newUID int64) *appmsg.Response {
	return responseFromProto(s.AddGroupMember(testInfo(uid), &pb.AddGroupMemberRequest{GroupId: groupID, Uid: newUID}))
}

func removeGroupMemberService(s *AppState, _ string, uid, groupID, targetUID int64) *appmsg.Response {
	return responseFromProto(s.RemoveGroupMember(testInfo(uid), &pb.RemoveGroupMemberRequest{GroupId: groupID, Uid: targetUID}))
}

func targetUID(target appmsg.ConversationTarget) int64 {
	if target.UID == nil {
		return 0
	}
	return int64(*target.UID)
}

func targetGroupID(target appmsg.ConversationTarget) int64 {
	if target.GroupID == nil {
		return 0
	}
	return int64(*target.GroupID)
}
