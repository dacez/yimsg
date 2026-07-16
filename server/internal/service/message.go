package service

import (
	"fmt"
	"log"
	"sync"
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/appmsg"
	"yimsg/server/internal/auth"
	"yimsg/server/internal/dal"
	"yimsg/server/internal/msgid"
	"yimsg/server/internal/service/taskpb"

	"google.golang.org/protobuf/proto"
)

// 异步任务 kind：群消息 fanout 与群系统消息 fanout。
const (
	taskKindGroupMessage = "group_message"
	taskKindGroupSystem  = "group_system"
)

// submitTask 把任务序列化为 protobuf 并投递到异步队列；handler 须幂等，重放 / 并发安全。
func (s *AppState) submitTask(kind string, task proto.Message) {
	payload, err := proto.Marshal(task)
	if err != nil {
		log.Printf("task queue marshal kind=%s err=%v", kind, err)
		return
	}
	if err := s.tasks.Submit(kind, payload); err != nil {
		log.Printf("task queue submit kind=%s err=%v", kind, err)
	}
}

// handleGroupMessageTask 是 group_message 任务的执行体：向各成员收件箱写入并通知。
func (s *AppState) handleGroupMessageTask(payload []byte) error {
	var task taskpb.GroupMessageTask
	if err := proto.Unmarshal(payload, &task); err != nil {
		log.Printf("group message task unmarshal err=%v", err)
		return nil // 丢弃损坏载荷，避免每次启动无限重放
	}

	// 按分片批量并行写入，提升 fanout 吞吐。
	shardBatches := make(map[int][]int64)
	for _, uid := range task.GetTargetUids() {
		idx := s.DB().UIDShards.ShardIndex(uid)
		shardBatches[idx] = append(shardBatches[idx], uid)
	}
	var wg sync.WaitGroup
	for _, uids := range shardBatches {
		wg.Add(1)
		go func(batch []int64) {
			defer wg.Done()
			for _, uid := range batch {
				if err := s.applyGroupMessage(&task, uid); err != nil {
					log.Printf("fanout apply uid=%d msg_id=%s err=%v", uid, task.GetMsgId(), err)
				}
			}
		}(uids)
	}
	wg.Wait()

	// 通知全体成员 + 发送者（所有设备）。
	notif := appmsg.NewMessageNotif(task.GetFromUid(), task.GetGroupId(), task.GetMsgId())
	for _, uid := range task.GetTargetUids() {
		s.Online().Notify(uid, notif)
	}
	s.Online().Notify(task.GetFromUid(), notif)
	return nil
}

// applyGroupMessage 把一条群消息（普通或撤回）写入单个成员的收件箱。
// 幂等性由 Insert(OR IGNORE) + UpdateByMsgID 保证：send / recall 任务无论先后或并发，
// 最终都收敛到一致状态，因此不再需要 outbox 的 version 收敛。
func (s *AppState) applyGroupMessage(task *taskpb.GroupMessageTask, uid int64) error {
	store := s.MessageStore(uid)
	msgType := int8(task.GetMsgType())
	seq, err := store.Insert(uid, task.GetMsgId(), task.GetFromUid(), 0, task.GetGroupId(), msgType, task.GetBody(), task.GetSearchText(), task.GetSendTime())
	if err != nil {
		return err
	}
	if task.GetRecalled() {
		if seq == 0 {
			if _, err := store.UpdateByMsgID(uid, task.GetMsgId(), msgType, task.GetBody(), task.GetSearchText()); err != nil {
				return err
			}
		}
		recallSeq, err := store.Insert(uid, task.GetRecallMsgId(), task.GetFromUid(), 0, task.GetGroupId(), int8(task.GetRecallMsgType()), task.GetRecallBody(), task.GetRecallSearchText(), task.GetRecallTime())
		if err != nil {
			return err
		}
		if recallSeq > 0 {
			upsertConversation(s, uid, task.GetFromUid(), 0, task.GetGroupId(), recallSeq, task.GetRecallMsgId(), dal.ConversationUnreadKeep)
		}
		return nil
	}
	if seq > 0 {
		mode := recipientUnreadMode(s, uid, 0, task.GetGroupId())
		upsertConversation(s, uid, task.GetFromUid(), 0, task.GetGroupId(), seq, task.GetMsgId(), mode)
	}
	return nil
}

// handleGroupSystemTask 是 group_system 任务的执行体：向全体成员写入系统消息并通知。
func (s *AppState) handleGroupSystemTask(payload []byte) error {
	var task taskpb.GroupSystemTask
	if err := proto.Unmarshal(payload, &task); err != nil {
		log.Printf("group system task unmarshal err=%v", err)
		return nil
	}
	for _, uid := range task.GetUids() {
		store := s.MessageStore(uid)
		seq, err := store.Insert(uid, task.GetMsgId(), 0, 0, task.GetGroupId(), dal.MsgSystem, task.GetBody(), task.GetSearchText(), task.GetSendTime())
		if err != nil {
			log.Printf("system msg insert uid=%d err=%v", uid, err)
			continue
		}
		if seq > 0 {
			upsertConversation(s, uid, 0, 0, task.GetGroupId(), seq, task.GetMsgId(), dal.ConversationUnreadIncrement)
		}
	}
	notif := appmsg.NewMessageNotif(0, task.GetGroupId(), task.GetMsgId())
	for _, uid := range task.GetUids() {
		s.Online().Notify(uid, notif)
	}
	return nil
}

// SendMessageResult holds the response produced by the send pipeline.
type SendMessageResult struct {
	Response *appmsg.Response
}

// upsertConversation updates the conversation table after a message insert.
// toUID is the peer for DM (computed as peer), 0 for group.
func upsertConversation(s *AppState, uid, fromUID, toUID, groupID, seq int64, msgID string, unreadMode dal.ConversationUnreadMode) {
	peer := int64(0)
	if groupID == 0 {
		peer = fromUID
		if fromUID == uid {
			peer = toUID
		}
	}
	store := s.ConversationStore(uid)
	if err := store.Upsert(uid, peer, groupID, seq, msgID, unreadMode); err != nil {
		log.Printf("upsert conversation uid=%d err=%v", uid, err)
	}
}

// senderResponseSeq 返回发送响应应回传的 seq。msg_id 幂等：当 Insert 因重复返回 0 时，
// 回查已有消息的 seq，使重复发送（含重试 / 重连重发）返回相同 msg_id 与已有 seq。
func senderResponseSeq(store dal.MessageStoreAPI, uid int64, msgID string, insertedSeq int64) int64 {
	if insertedSeq > 0 {
		return insertedSeq
	}
	if existing, err := store.GetByMsgID(uid, msgID); err == nil && existing != nil {
		return existing.Seq
	}
	return insertedSeq
}

func recipientUnreadMode(s *AppState, uid, peerUID, groupID int64) dal.ConversationUnreadMode {
	entry, err := s.MutelistStore(uid).Get(uid, peerUID, groupID)
	if err != nil {
		log.Printf("get conversation mutelist uid=%d peer=%d group=%d err=%v", uid, peerUID, groupID, err)
		return dal.ConversationUnreadIncrement
	}
	if entry != nil && entry.Status == dal.MutelistActive {
		return dal.ConversationUnreadKeep
	}
	return dal.ConversationUnreadIncrement
}

// SendMessage 是 action 入口：群消息 fanout 已在 sendMessage 内部直接投递到异步队列，
// dispatch 层不感知队列存在。单聊 recipient inbox 与通知已在 sendMessage 内同步完成。
func (s *AppState) SendMessage(info *BaseInfo, req *pb.SendMessageRequest) *pb.SendMessageResponse {
	return toSendMessageResponse(s.sendMessage(info, req).Response)
}

func (s *AppState) sendMessage(info *BaseInfo, req *pb.SendMessageRequest) SendMessageResult {
	reqID := info.RequestID
	uid := info.UID
	toUID, groupID := targetIDs(req.GetTarget())

	if toUID == 0 && groupID == 0 {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "to_uid or group_id required")}
	}
	if toUID > 0 && groupID > 0 {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "cannot set both to_uid and group_id")}
	}

	msgType := int8(req.GetMsgType())
	body := req.GetBody()

	// msg_id 由 SDK 生成，服务端只校验、保存、回传并据此幂等；缺失或非法直接拒绝。
	msgID := req.GetMsgId()
	if err := msgid.Validate(msgID); err != nil {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "invalid msg_id: "+err.Error())}
	}

	// 撤回统一走 send_message + MESSAGE_TYPE_RECALL + RecallBody；撤回事件消息使用本请求的 msg_id。
	if msgType == dal.MsgRecall {
		return s.recallViaSend(info, msgID, toUID, groupID, body)
	}

	if err := validateSendBody(msgType, body); err != nil {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, err.Error())}
	}
	raw, searchText, err := encodeBodyWithSearch(body)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, err.Error())}
	}

	if groupID > 0 {
		return sendGroupMessage(s, reqID, msgID, uid, groupID, msgType, raw, searchText)
	}
	return sendDM(s, reqID, msgID, uid, toUID, msgType, raw, searchText)
}

func sendDM(s *AppState, reqID uint64, msgID string, fromUID int64, toUID int64, msgType int8, body []byte, searchText string) SendMessageResult {
	if fromUID == toUID {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "不能给自己发送消息")}
	}
	blocked, err := isEitherWayBlocked(s, fromUID, toUID)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}
	if blocked {
		return SendMessageResult{Response: appmsg.ErrForbidden(reqID, "对方暂不接受私聊")}
	}

	now := auth.NowMs()

	// Sender inbox
	senderStore := s.MessageStore(fromUID)
	senderSeq, err := senderStore.Insert(fromUID, msgID, fromUID, toUID, 0, msgType, body, searchText, now)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}
	upsertConversation(s, fromUID, fromUID, toUID, 0, senderSeq, msgID, dal.ConversationUnreadKeep)

	// Recipient inbox
	rcptStore := s.MessageStore(toUID)
	rcptSeq, err := rcptStore.Insert(toUID, msgID, fromUID, toUID, 0, msgType, body, searchText, now)
	if err != nil {
		log.Printf("DM recipient insert uid=%d err=%v", toUID, err)
	}
	if rcptSeq > 0 {
		mode := recipientUnreadMode(s, toUID, fromUID, 0)
		upsertConversation(s, toUID, fromUID, toUID, 0, rcptSeq, msgID, mode)
	}

	// Notify recipient and sender (all devices)
	notif := appmsg.NewMessageNotif(fromUID, 0, msgID)
	s.Online().Notify(toUID, notif)
	s.Online().Notify(fromUID, notif)

	return SendMessageResult{Response: appmsg.OKMessageSent(reqID, msgID, senderResponseSeq(senderStore, fromUID, msgID, senderSeq))}
}

func sendGroupMessage(s *AppState, reqID uint64, msgID string, fromUID int64, groupID int64, msgType int8, body []byte, searchText string) SendMessageResult {
	// Verify membership
	groupStore := s.GroupStore(groupID)
	isMember, err := groupStore.IsMember(groupID, fromUID)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}
	if !isMember {
		return SendMessageResult{Response: appmsg.ErrForbidden(reqID, "非群员")}
	}

	now := auth.NowMs()

	// Sender inbox (synchronous)
	senderStore := s.MessageStore(fromUID)
	senderSeq, err := senderStore.Insert(fromUID, msgID, fromUID, 0, groupID, msgType, body, searchText, now)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}
	upsertConversation(s, fromUID, fromUID, 0, groupID, senderSeq, msgID, dal.ConversationUnreadKeep)

	// Get all members for fan-out
	members, err := groupStore.ListAllMembers(groupID)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}

	var otherUIDs []int64
	for _, m := range members {
		if m.UID != fromUID {
			otherUIDs = append(otherUIDs, m.UID)
		}
	}

	// 在主流程中直接把 fanout 投递到异步队列（启用持久化时先落盘，崩溃后可重放）。
	s.submitTask(taskKindGroupMessage, &taskpb.GroupMessageTask{
		MsgId:      msgID,
		FromUid:    fromUID,
		GroupId:    groupID,
		MsgType:    int32(msgType),
		Body:       body,
		SearchText: searchText,
		SendTime:   now,
		TargetUids: otherUIDs,
	})

	return SendMessageResult{
		Response: appmsg.OKMessageSent(reqID, msgID, senderResponseSeq(senderStore, fromUID, msgID, senderSeq)),
	}
}

func (s *AppState) SyncMessages(info *BaseInfo, req *pb.SyncMessagesRequest) *pb.SyncMessagesResponse {
	reqID := info.RequestID
	uid := info.UID
	lastSeq := req.GetLastSeq()
	limit := effectiveLimit(req.GetLimit(), s.MaxBatchLimit())
	store := s.MessageStore(uid)
	return toSyncMessagesResponse(respondSyncPage(reqID, limit, func() ([]dal.Message, error) {
		return store.Sync(uid, lastSeq, limit+1)
	}, func(m dal.Message) int64 { return m.Seq }, appmsg.OKConversationMessages))
}

func conversationSeqs(convs []dal.Conversation) []int64 {
	seqs := make([]int64, len(convs))
	for i, conv := range convs {
		seqs[i] = conv.Seq
	}
	return seqs
}

func (s *AppState) GetMessages(info *BaseInfo, req *pb.GetMessagesRequest) *pb.GetMessagesResponse {
	reqID := info.RequestID
	uid := info.UID
	toUID, groupID := targetIDs(req.GetTarget())
	store := s.MessageStore(uid)

	// 按 msg_ids 批量读取：与展示分页互斥，不分页、page 信息为空。
	if msgIDs := req.GetMsgIds(); len(msgIDs) > 0 {
		messages, err := store.ListByMsgIDs(uid, msgIDs)
		if err != nil {
			return toGetMessagesResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		return toGetMessagesResponse(appmsg.OKConversationMessages(reqID, messages))
	}

	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())

	// around：以 msg_id 为锚点居中定位（jump-to-message）。两端 has_more 先置 true，
	// 客户端滚动到真实边界拿到空页后再收敛，简洁且稳健。
	if page.around != "" {
		anchor, err := store.ListByMsgIDs(uid, []string{page.around})
		if err != nil {
			return toGetMessagesResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		if len(anchor) == 0 {
			return toGetMessagesResponse(appmsg.ErrNotFound(reqID, "around message not found"))
		}
		messages, err := store.ListAroundByConversation(uid, toUID, groupID, anchor[0].Seq, page.limit)
		if err != nil {
			return toGetMessagesResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		reverseInPlace(messages) // DAL 返回 seq DESC，转为展示序 ASC
		resp := appmsg.OKConversationMessages(reqID, messages)
		pi := appmsg.PageInfo{Total: -1, HasMoreBackward: len(messages) > 0, HasMoreForward: len(messages) > 0}
		if len(messages) > 0 {
			pi.StartCursor = encodeSeqCursor(messages[0].Seq)
			pi.EndCursor = encodeSeqCursor(messages[len(messages)-1].Seq)
		}
		resp.Page = &pi
		return toGetMessagesResponse(resp)
	}

	// 消息展示序为 旧→新（ascTop）：older=向旧、newer=向新。
	// 约定 older()返回 DESC、newer()返回 ASC；ListAfterByConversation 返回 DESC，需反转。
	messages, pageInfo, err := fetchSeqPage(
		page, false,
		func(b, l int64) ([]dal.Message, error) { return store.ListByConversation(uid, toUID, groupID, b, l) },
		func(b, l int64) ([]dal.Message, error) {
			m, err := store.ListAfterByConversation(uid, toUID, groupID, b, l)
			reverseInPlace(m)
			return m, err
		},
		func(m dal.Message) int64 { return m.Seq },
	)
	if err != nil {
		return toGetMessagesResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	resp := appmsg.OKConversationMessages(reqID, messages)
	resp.Page = &pageInfo
	return toGetMessagesResponse(resp)
}

func (s *AppState) GetConversations(info *BaseInfo, req *pb.GetConversationsRequest) *pb.GetConversationsResponse {
	reqID := info.RequestID
	uid := info.UID
	convStore := s.ConversationStore(uid)

	// targets 非空：按目标精确读取若干会话的当前状态（轻通知后定向刷新），忽略分页；
	// 仅返回仍活跃的会话，缺失（已删除 / 已 GC）目标不返回，客户端据此从数据窗口移除。
	if targets := req.GetTargets(); len(targets) > 0 {
		toUIDs := make([]int64, 0, len(targets))
		groupIDs := make([]int64, 0, len(targets))
		for _, t := range targets {
			toUID, groupID := targetIDs(t)
			toUIDs = append(toUIDs, toUID)
			groupIDs = append(groupIDs, groupID)
		}
		convs, err := convStore.GetByTargets(uid, toUIDs, groupIDs)
		if err != nil {
			return toGetConversationsResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		entries, err := conversationEntries(s, uid, convs)
		if err != nil {
			return toGetConversationsResponse(appmsg.ErrInternal(reqID, err.Error()))
		}
		return toGetConversationsResponse(appmsg.OKConversationList(reqID, entries))
	}

	page := parsePageQuery(req.GetPage(), s.MaxBatchLimit())
	// 会话展示序为 活跃→沉默（descTop，按 seq 倒序）。older=向旧(before)、newer=向新(after)。
	convs, pageInfo, err := fetchSeqPage(
		page, true,
		func(b, l int64) ([]dal.Conversation, error) { return convStore.List(uid, b, 0, l) },
		func(b, l int64) ([]dal.Conversation, error) { return convStore.List(uid, 0, b, l) },
		func(c dal.Conversation) int64 { return c.Seq },
	)
	if err != nil {
		return toGetConversationsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	entries, err := conversationEntries(s, uid, convs)
	if err != nil {
		return toGetConversationsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	resp := appmsg.OKConversationList(reqID, entries)
	resp.Page = &pageInfo
	return toGetConversationsResponse(resp)
}

func (s *AppState) SyncConversations(info *BaseInfo, req *pb.SyncConversationsRequest) *pb.SyncConversationsResponse {
	reqID := info.RequestID
	uid := info.UID
	afterSeq := req.GetLastSeq()
	limit := effectiveLimit(req.GetLimit(), s.MaxBatchLimit())
	store := s.ConversationStore(uid)
	convs, err := store.Sync(uid, afterSeq, limit+1)
	if err != nil {
		return toSyncConversationsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	hasMore := len(convs) > int(limit)
	if hasMore {
		convs = convs[:limit]
	}
	entries, err := conversationEntries(s, uid, convs)
	if err != nil {
		return toSyncConversationsResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	resp := appmsg.OKConversationList(reqID, entries)
	setCursor(resp, conversationSeqs(convs), true, hasMore)
	return toSyncConversationsResponse(resp)
}

func conversationEntries(s *AppState, uid int64, convs []dal.Conversation) ([]appmsg.ConversationEntry, error) {
	msgStore := s.MessageStore(uid)
	entries := make([]appmsg.ConversationEntry, 0, len(convs))
	for _, c := range convs {
		entry := appmsg.ConversationEntry{
			LastSeq:     c.Seq,
			UnreadCount: c.UnreadCount,
			Status:      c.Status,
		}
		entry.Target = appmsg.NewConversationTarget(c.ToUID, c.GroupID)
		if c.Status != dal.ConversationDeleted {
			msg, err := msgStore.GetBySeq(uid, c.Seq)
			if err != nil {
				return nil, err
			}
			if msg != nil {
				// recall 事件消息的 RecallBody.text 已是展示文案，会话预览直接返回，无需回查原消息。
				lastMsg := appmsg.MessageFromDAL(*msg)
				entry.LastMsg = &lastMsg
			}
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// GetUnreadCount returns the sum of unread_count across active conversations.
func (s *AppState) GetUnreadCount(info *BaseInfo, req *pb.GetUnreadCountRequest) *pb.GetUnreadCountResponse {
	reqID := info.RequestID
	uid := info.UID
	store := s.ConversationStore(uid)
	count, err := store.TotalUnreadCount(uid)
	if err != nil {
		return toGetUnreadCountResponse(appmsg.ErrInternal(reqID, fmt.Sprintf("total unread count: %v", err)))
	}
	return toGetUnreadCountResponse(appmsg.OKUnreadCount(reqID, count))
}

// ClearUnread clears unread count for a conversation and notifies other devices.
func (s *AppState) ClearUnread(info *BaseInfo, req *pb.ClearUnreadRequest) *pb.ClearUnreadResponse {
	reqID := info.RequestID
	uid := info.UID
	toUID, groupID := targetIDs(req.GetTarget())
	store := s.ConversationStore(uid)
	if err := store.ClearUnread(uid, toUID, groupID); err != nil {
		return toClearUnreadResponse(appmsg.ErrInternal(reqID, err.Error()))
	}

	// 通知本人其它设备：该会话未读已清除，仅清红点、不触发拉取会话列表
	notif := appmsg.ConversationsClearunreadNotif(toUID, groupID)
	s.Online().Notify(uid, notif)

	return toClearUnreadResponse(appmsg.OKEmpty(reqID))
}

// DeleteMessage soft-deletes one message in the caller's inbox and notifies the caller's devices.
func (s *AppState) DeleteMessage(info *BaseInfo, req *pb.DeleteMessageRequest) *pb.DeleteMessageResponse {
	reqID := info.RequestID
	uid := info.UID
	msgID := req.GetMsgId()
	if err := msgid.Validate(msgID); err != nil {
		return toDeleteMessageResponse(appmsg.ErrInvalidArgument(reqID, "invalid msg_id: "+err.Error()))
	}

	store := s.MessageStore(uid)
	msg, err := store.GetByMsgID(uid, msgID)
	if err != nil {
		return toDeleteMessageResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if msg == nil {
		return toDeleteMessageResponse(appmsg.ErrNotFound(reqID, "message not found"))
	}

	seq, ok, err := store.DeleteByMsgID(uid, msgID)
	if err != nil {
		return toDeleteMessageResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toDeleteMessageResponse(appmsg.ErrNotFound(reqID, "message not found"))
	}

	// 通知本人其它设备：该消息被删除，命中数据窗口则就地删除、不触发拉取
	s.Online().Notify(uid, appmsg.MessagesDeleteNotif(msg.FromUID, msg.GroupID, msgID))
	return toDeleteMessageResponse(appmsg.OKContactWrite(reqID, seq))
}

// DeleteConversation soft-deletes one conversation in the caller's inbox and notifies the caller's devices.
func (s *AppState) DeleteConversation(info *BaseInfo, req *pb.DeleteConversationRequest) *pb.DeleteConversationResponse {
	reqID := info.RequestID
	uid := info.UID
	toUID, groupID := targetIDs(req.GetTarget())
	if toUID <= 0 && groupID <= 0 {
		return toDeleteConversationResponse(appmsg.ErrInvalidArgument(reqID, "conversation target required"))
	}
	if groupID > 0 {
		toUID = 0
	}

	seq, ok, err := s.ConversationStore(uid).Delete(uid, toUID, groupID)
	if err != nil {
		return toDeleteConversationResponse(appmsg.ErrInternal(reqID, err.Error()))
	}
	if !ok {
		return toDeleteConversationResponse(appmsg.ErrNotFound(reqID, "conversation not found"))
	}

	// 通知本人其它设备：该会话被删除，命中数据窗口则就地删除、不触发拉取
	s.Online().Notify(uid, appmsg.ConversationsDeleteNotif(toUID, groupID))
	return toDeleteConversationResponse(appmsg.OKContactWrite(reqID, seq))
}

// sendSystemMessage is a helper for sending system notifications to group members.
func sendSystemMessage(s *AppState, groupID int64, text string, members []dal.GroupMember) {
	uids := make([]int64, len(members))
	for i, m := range members {
		uids[i] = m.UID
	}
	sendSystemMessageToUIDs(s, groupID, text, uids)
}

// sendSystemMessageToUIDs is like sendSystemMessage but takes a UID slice.
// 与群消息一致，系统消息的成员 fanout 也直接投递到异步队列，不阻塞触发它的请求主流程。
func sendSystemMessageToUIDs(s *AppState, groupID int64, text string, uids []int64) {
	// 系统消息由服务端发起、无 SDK 来源，是唯一允许服务端生成 msg_id 的消息类型（同样是 UUIDv7 base64url）。
	// msg_id / send_time 在主流程中生成并随任务持久化，保证重放幂等。
	msgID := msgid.Generate()
	now := auth.NowMs()
	body, searchText, err := encodeBodyWithSearch(systemBody(text))
	if err != nil {
		log.Printf("system msg encode err: %v", err)
		return
	}
	s.submitTask(taskKindGroupSystem, &taskpb.GroupSystemTask{
		MsgId:      msgID,
		GroupId:    groupID,
		Body:       body,
		SearchText: searchText,
		SendTime:   now,
		Uids:       uids,
	})
}

// FormatGroupSystemMsg creates a system message text for group events.
func FormatGroupSystemMsg(action, nickname string) string {
	switch action {
	case "created":
		return fmt.Sprintf("%s created the group", nickname)
	case "joined":
		return fmt.Sprintf("%s joined the group", nickname)
	case "left":
		return fmt.Sprintf("%s left the group", nickname)
	case "removed":
		return fmt.Sprintf("%s was removed from the group", nickname)
	default:
		return fmt.Sprintf("%s %s", nickname, action)
	}
}
