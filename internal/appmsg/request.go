// Package appmsg defines the application-level WebSocket message types.
package appmsg

// Request 不是线上协议类型——真实请求是 internal/protocol/yimsg.proto 定义的
// 二进制 protobuf 帧，按 action 解到各自的 pb.XxxRequest，不经过这个结构体。
// Request 只是 internal/service/*_test.go（如 message_test.go）用来构造
// sendMessageService / listByConversationService 等测试辅助调用参数的便捷
// 字面量类型，只保留实际用到的字段。
type Request struct {
	// Message
	ToUID   int64
	GroupID int64
	MsgID   string
	MsgType int8
	Content string

	// Sync / Pagination
	AfterSeq int64
	Limit    int64
}
