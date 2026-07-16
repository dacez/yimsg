// Package plugin provides the plugin infrastructure for Yimsg.
package plugin

import (
	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/online"
	"yimsg/internal/shard"
	"yimsg/internal/snowflake"
)

// Plugin 定义插件必须实现的接口。
//
// 插件只贡献 schema 与生命周期钩子；不提供按请求分发的 action 扩展点——核心
// WebSocket 通道是强类型 protobuf（内部路由按 internal/protocol/yimsg.proto
// 生成的数值 type 做 switch），插件如需暴露新的对外 action，必须像核心 action
// 一样先在 yimsg.proto 里定义明确的 message 并跑 protocolgen，不存在通用的
// JSON 按请求分发层，详见 docs/server/插件架构方案.md。
type Plugin interface {
	// Name 返回插件唯一标识符
	Name() string

	// Schemas 返回插件需要的额外 DDL，按 shard group 分组
	// key: "uid" | "username" | "token" | "group"
	// value: DDL 字符串（CREATE TABLE ... 等）
	Schemas() map[string]string

	// OnDisconnect 在用户 WebSocket 断连时被调用（可选钩子）
	OnDisconnect(host Host, uid int64)

	// OnStart 在服务器启动完成后调用，用于启动后台任务（GC、定时器等，可选）
	OnStart(host Host)
}

// Host 定义插件可访问的宿主能力，避免循环依赖（plugin ↔ service）
type Host interface {
	DB() *shard.Database
	IDGen() *snowflake.Generator
	Config() *config.Config
	Online() *online.Registry

	// Store 访问器（按路由键返回 store）
	UserStore(uid int64) dal.UserStoreAPI
	ContactStore(uid int64) dal.ContactStoreAPI
	BlocklistStore(uid int64) dal.BlocklistStoreAPI
	MessageStore(uid int64) dal.MessageStoreAPI
	ConversationStore(uid int64) dal.ConversationStoreAPI
	MutelistStore(uid int64) dal.MutelistStoreAPI
	UserSessionStore(uid int64) dal.UserSessionStoreAPI
	GroupStore(groupID int64) dal.GroupStoreAPI
	SessionStore(token string) dal.SessionStoreAPI
	UserLookupStore(username string) dal.UserLookupStoreAPI

	// 业务逻辑辅助方法
	IsEitherWayBlocked(a, b int64) (bool, error)
}
