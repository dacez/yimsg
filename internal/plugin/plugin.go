// Package plugin provides the plugin infrastructure for Yimsg.
package plugin

import (
	"yimsg/internal/appmsg"
	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/online"
	"yimsg/internal/shard"
	"yimsg/internal/snowflake"
)

// Plugin 定义插件必须实现的接口
type Plugin interface {
	// Name 返回插件唯一标识符
	Name() string

	// Schemas 返回插件需要的额外 DDL，按 shard group 分组
	// key: "uid" | "username" | "token" | "group"
	// value: DDL 字符串（CREATE TABLE ... 等）
	Schemas() map[string]string

	// Actions 返回插件注册的 action 名称 → handler 映射
	Actions() map[string]Handler

	// OnDisconnect 在用户 WebSocket 断连时被调用（可选钩子）
	OnDisconnect(host Host, uid int64)

	// OnStart 在服务器启动完成后调用，用于启动后台任务（GC、定时器等，可选）
	OnStart(host Host)
}

// Handler 是插件 action 处理函数签名
// 返回 Response（必须设置 RequestID），若返回 nil 则视为"未处理"
type Handler func(host Host, reqID uint64, uid int64, req *appmsg.Request) *appmsg.Response

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
