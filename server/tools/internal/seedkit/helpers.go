// Package seedkit 收拢数据构造工具（seed-data / test-seed / seed-demo）共用的
// service 层调用样板：BaseInfo 构造、响应判定、常见 ConversationTarget/MessageBody 构造。
package seedkit

import (
	"yimsg/protocol/generated/go/pb"
	"yimsg/server/internal/service"
)

// BaseInfo 构造种子脚本调用 service 方法所需的 BaseInfo；request_id 固定为 1，种子脚本不关心幂等重试。
func BaseInfo(uid int64) *service.BaseInfo {
	return &service.BaseInfo{UID: uid, RequestID: 1}
}

// OK 判断 BaseResponse 是否成功。
func OK(base *pb.BaseResponse) bool {
	return base != nil && base.Code == pb.ErrorCode_ERROR_OK
}

// UserTarget 构造单聊 ConversationTarget。
func UserTarget(uid int64) *pb.ConversationTarget {
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_Uid{Uid: uid}}
}

// GroupTarget 构造群聊 ConversationTarget。
func GroupTarget(groupID int64) *pb.ConversationTarget {
	return &pb.ConversationTarget{Kind: &pb.ConversationTarget_GroupId{GroupId: groupID}}
}

// TextBody 构造纯文本 MessageBody。
func TextBody(text string) *pb.MessageBody {
	return &pb.MessageBody{Kind: &pb.MessageBody_Text{Text: &pb.TextBody{Text: text}}}
}
