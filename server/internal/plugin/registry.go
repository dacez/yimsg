package plugin

import "fmt"

// Registry 管理所有已注册的插件
type Registry struct {
	plugins map[string]Plugin // 插件名 → 插件实例
}

// NewRegistry 创建新的插件注册中心
func NewRegistry() *Registry {
	return &Registry{
		plugins: make(map[string]Plugin),
	}
}

// Register 注册插件，检测冲突（插件名重复会 panic）
func (r *Registry) Register(p Plugin) {
	name := p.Name()
	if _, exists := r.plugins[name]; exists {
		panic(fmt.Sprintf("plugin %q already registered", name))
	}
	r.plugins[name] = p
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
