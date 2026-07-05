// Package service 提供业务逻辑层。
package service

// BaseInfo 是从 WebSocket 二进制帧头解析出的请求上下文，由框架层填充后传入业务方法。
// 业务代码只读；不能信任客户端 body 中的任何类似字段。
type BaseInfo struct {
	UID       int64
	RequestID uint64
	// Token 是当前连接已绑定的会话 token，由框架层从连接态填入；
	// 仅 logout 在请求未显式携带 token 时回退使用。
	Token string
}
