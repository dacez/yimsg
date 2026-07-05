package plugin

import (
	"fmt"
	"yimsg/internal/appmsg"
)

// Registry 管理所有已注册的插件
type Registry struct {
	plugins map[string]Plugin // 插件名 → 插件实例
	actions map[string]Plugin // action 名 → 所属插件
}

// NewRegistry 创建新的插件注册中心
func NewRegistry() *Registry {
	return &Registry{
		plugins: make(map[string]Plugin),
		actions: make(map[string]Plugin),
	}
}

// Register 注册插件，检测冲突（action 重名会 panic）
func (r *Registry) Register(p Plugin) {
	name := p.Name()
	if _, exists := r.plugins[name]; exists {
		panic(fmt.Sprintf("plugin %q already registered", name))
	}
	r.plugins[name] = p

	// 检查 action 冲突
	for action := range p.Actions() {
		if existing, exists := r.actions[action]; exists {
			panic(fmt.Sprintf("action %q conflicts: already registered by plugin %q (attempted by %q)", action, existing.Name(), name))
		}
		r.actions[action] = p
	}
}

// MergeSchemas 合并核心 schema + 插件 schema
func (r *Registry) MergeSchemas(base map[string]string) map[string]string {
	merged := make(map[string]string)
	for group, ddl := range base {
		merged[group] = ddl
	}
	for _, p := range r.plugins {
		for group, ddl := range p.Schemas() {
			if ddl == "" {
				continue
			}
			if existing, ok := merged[group]; ok {
				merged[group] = existing + "\n" + ddl
			} else {
				merged[group] = ddl
			}
		}
	}
	return merged
}

// Dispatch 分发请求到插件的 action handler
// 返回 (response, handled)，handled=true 表示插件处理了该 action
func (r *Registry) Dispatch(host Host, reqID uint64, uid int64, req *appmsg.Request) (*appmsg.Response, bool) {
	p, exists := r.actions[req.Action]
	if !exists {
		return nil, false
	}
	handler := p.Actions()[req.Action]
	resp := handler(host, reqID, uid, req)
	return resp, true
}

// HandleDisconnect 调用所有插件的 OnDisconnect 钩子
func (r *Registry) HandleDisconnect(host Host, uid int64) {
	for _, p := range r.plugins {
		p.OnDisconnect(host, uid)
	}
}

// Start 调用所有插件的 OnStart 钩子（服务器启动后执行）
func (r *Registry) Start(host Host) {
	for _, p := range r.plugins {
		p.OnStart(host)
	}
}
