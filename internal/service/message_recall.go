package service

import (
	"fmt"
	"strconv"

	"yimsg/internal/appmsg"
	"yimsg/internal/auth"
	"yimsg/internal/dal"
	"yimsg/internal/protocol/pb"
	"yimsg/internal/service/taskpb"
)

type recallKind int

const (
	recallKindNone recallKind = iota
	recallKindPlaceholder
	recallKindEvent
)

// recallViaSend 处理 send_message + MESSAGE_TYPE_RECALL 的撤回请求。
// recallMsgID 是本请求顶层的 msg_id（由 SDK 生成），作为撤回事件消息的 ID。
// operator_uid、recall_time、text 全部由服务端设置，客户端传入值被忽略。
func (s *AppState) recallViaSend(info *BaseInfo, recallMsgID string, toUID, groupID int64, body *pb.MessageBody) SendMessageResult {
	reqID := info.RequestID
	uid := info.UID

	recall := body.GetRecall()
	if recall == nil {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "recall body required")}
	}
	msgID := recall.GetMsgId()
	if msgID == "" {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "msg_id required")}
	}
	if recallMsgID == msgID {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "recall event msg_id must differ from target")}
	}
	if (toUID == 0 && groupID == 0) || (toUID > 0 && groupID > 0) {
		return SendMessageResult{Response: appmsg.ErrInvalidArgument(reqID, "to_uid or group_id required")}
	}
	if s.Config() == nil || s.Config().Message.RecallWindowSeconds <= 0 {
		return SendMessageResult{Response: appmsg.ErrForbidden(reqID, "recall_disabled")}
	}

	senderMsg, err := s.MessageStore(uid).GetByMsgID(uid, msgID)
	if err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}
	if senderMsg == nil || senderMsg.FromUID != uid || senderMsg.ToUID != toUID || senderMsg.GroupID != groupID {
		return SendMessageResult{Response: appmsg.ErrNotFound(reqID, "message_not_found")}
	}
	switch classifyRecallMessage(*senderMsg) {
	case recallKindPlaceholder:
		return SendMessageResult{Response: appmsg.ErrAlreadyExists(reqID, "message_already_recalled")}
	case recallKindEvent:
		return SendMessageResult{Response: appmsg.ErrNotFound(reqID, "message_not_found")}
	}
	if senderMsg.MsgType == dal.MsgSystem {
		return SendMessageResult{Response: appmsg.ErrForbidden(reqID, "system_message_cannot_be_recalled")}
	}

	now := auth.NowMs()
	if now-senderMsg.SendTime > s.Config().Message.RecallWindowSeconds*1000 {
		return SendMessageResult{Response: appmsg.ErrForbidden(reqID, "recall_window_expired")}
	}

	operatorName := lookupUserDisplayName(s, uid)

	senderText := "你撤回了一条消息"
	recipientText := "对方撤回了一条消息"
	if groupID > 0 {
		recipientText = fmt.Sprintf("%s 撤回了一条消息", operatorName)
	}

	// 操作者自己的收件箱：覆盖原消息为撤回占位 + 写入撤回事件消息。
	if err := applyRecallState(s, uid, uid, toUID, groupID, msgID, senderMsg.SendTime, recallMsgID, now, senderText); err != nil {
		return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
	}

	if groupID > 0 {
		if err := recallGroupMessage(s, uid, groupID, msgID, senderMsg.SendTime, recipientText, recallMsgID, now); err != nil {
			return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
		}
	} else {
		if err := applyRecallState(s, toUID, uid, toUID, 0, msgID, senderMsg.SendTime, recallMsgID, now, recipientText); err != nil {
			return SendMessageResult{Response: appmsg.ErrInternal(reqID, err.Error())}
		}
	}

	if groupID > 0 {
		// 群撤回的 messages:received 信号由异步任务队列的 recall 任务在写完各成员收件箱后发出。
	} else {
		// 通知携带原消息 msg_id（撤回占位）：占位在收发双方收件箱都按原 msg_id 存在，
		// instant / persistent 都能用 get_messages(msg_ids=[msg_id]) 取到，撤回事件消息不单独落持久库。
		notif := appmsg.NewMessageNotif(uid, 0, msgID)
		s.Online().Notify(toUID, notif)
		s.Online().Notify(uid, notif)
	}

	recallEventMsg, err := s.MessageStore(uid).GetByMsgID(uid, recallMsgID)
	if err != nil || recallEventMsg == nil {
		return SendMessageResult{Response: appmsg.ErrNotFound(reqID, "recall_event_not_found")}
	}
	return SendMessageResult{
		Response: appmsg.OKMessageSent(reqID, msgID, recallEventMsg.Seq),
	}
}

// recallGroupMessage 在主流程中直接把群撤回 fanout 投递到异步队列。
// 撤回与原消息发送是两个独立任务：靠 Insert(OR IGNORE) + UpdateByMsgID 的幂等性，
// 无论先后或并发，各成员收件箱都收敛到撤回占位 + 撤回事件的最终状态。
func recallGroupMessage(s *AppState, fromUID, groupID int64, msgID string, originalSendTime int64, text string, recallMsgID string, recalledAt int64) error {
	raw, search, err := encodeBodyWithSearch(recallBody(msgID, fromUID, recalledAt, text))
	if err != nil {
		return err
	}

	members, err := s.GroupStore(groupID).ListAllMembers(groupID)
	if err != nil {
		return err
	}
	otherUIDs := make([]int64, 0, len(members))
	for _, member := range members {
		if member.UID == fromUID {
			continue
		}
		otherUIDs = append(otherUIDs, member.UID)
	}

	s.submitTask(taskKindGroupMessage, &taskpb.GroupMessageTask{
		MsgId:            msgID,
		FromUid:          fromUID,
		GroupId:          groupID,
		Recalled:         true,
		MsgType:          int32(dal.MsgRecall),
		Body:             raw,
		SearchText:       search,
		SendTime:         originalSendTime,
		TargetUids:       otherUIDs,
		RecallMsgId:      recallMsgID,
		RecallMsgType:    int32(dal.MsgRecall),
		RecallBody:       raw,
		RecallSearchText: search,
		RecallTime:       recalledAt,
	})
	return nil
}

// applyRecallState 覆盖原消息为撤回占位 body，并写入一条撤回事件消息。
// 占位与事件使用相同 RecallBody，仅 msg_id 不同：占位存在原 msg_id，事件存在新 recallMsgID。
func applyRecallState(s *AppState, uid, operatorUID, toUID, groupID int64, targetMsgID string, originalSendTime int64, recallMsgID string, recalledAt int64, text string) error {
	store := s.MessageStore(uid)
	raw, search, err := encodeBodyWithSearch(recallBody(targetMsgID, operatorUID, recalledAt, text))
	if err != nil {
		return err
	}
	seq, err := store.Insert(uid, targetMsgID, operatorUID, toUID, groupID, dal.MsgRecall, raw, search, originalSendTime)
	if err != nil {
		return err
	}
	if seq == 0 {
		if _, err := store.UpdateByMsgID(uid, targetMsgID, dal.MsgRecall, raw, search); err != nil {
			return err
		}
	}
	recallSeq, err := store.Insert(uid, recallMsgID, operatorUID, toUID, groupID, dal.MsgRecall, raw, search, recalledAt)
	if err != nil {
		return err
	}
	if recallSeq > 0 {
		upsertConversation(s, uid, operatorUID, toUID, groupID, recallSeq, recallMsgID, dal.ConversationUnreadKeep)
	}
	return nil
}

// classifyRecallMessage 判定一条消息是撤回占位、撤回事件，还是非撤回消息。
//   - 占位：RecallBody.msg_id == 自身 msg_id（原消息被覆盖）。
//   - 事件：RecallBody.msg_id != 自身 msg_id（新插入的撤回事件）。
func classifyRecallMessage(msg dal.Message) recallKind {
	r := decodeRecall(msg)
	if r == nil {
		return recallKindNone
	}
	if r.GetMsgId() == msg.MsgID {
		return recallKindPlaceholder
	}
	return recallKindEvent
}

func lookupUserDisplayName(s *AppState, uid int64) string {
	profile, err := s.UserStore(uid).GetInfo(uid)
	if err == nil && profile != nil {
		if profile.Nickname != "" {
			return profile.Nickname
		}
		if profile.Username != "" {
			return profile.Username
		}
	}
	return strconv.FormatInt(uid, 10)
}
