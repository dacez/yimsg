package plugin

import (
	"testing"
	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/online"
	"yimsg/internal/shard"
	"yimsg/internal/snowflake"
)

// mockPlugin 是测试用的 mock 插件
type mockPlugin struct {
	name              string
	schemas           map[string]string
	onDisconnectCalls []int64
	onStartCalled     bool
}

func (m *mockPlugin) Name() string {
	return m.name
}

func (m *mockPlugin) Schemas() map[string]string {
	return m.schemas
}

func (m *mockPlugin) OnDisconnect(host Host, uid int64) {
	m.onDisconnectCalls = append(m.onDisconnectCalls, uid)
}

func (m *mockPlugin) OnStart(host Host) {
	m.onStartCalled = true
}

// mockHost 是测试用的 mock Host
type mockHost struct{}

func (h *mockHost) DB() *shard.Database                                    { return nil }
func (h *mockHost) IDGen() *snowflake.Generator                            { return nil }
func (h *mockHost) Config() *config.Config                                 { return nil }
func (h *mockHost) Online() *online.Registry                               { return nil }
func (h *mockHost) UserStore(uid int64) dal.UserStoreAPI                   { return nil }
func (h *mockHost) ContactStore(uid int64) dal.ContactStoreAPI             { return nil }
func (h *mockHost) BlocklistStore(uid int64) dal.BlocklistStoreAPI         { return nil }
func (h *mockHost) MessageStore(uid int64) dal.MessageStoreAPI             { return nil }
func (h *mockHost) ConversationStore(uid int64) dal.ConversationStoreAPI   { return nil }
func (h *mockHost) MutelistStore(uid int64) dal.MutelistStoreAPI           { return nil }
func (h *mockHost) UserSessionStore(uid int64) dal.UserSessionStoreAPI     { return nil }
func (h *mockHost) GroupStore(groupID int64) dal.GroupStoreAPI             { return nil }
func (h *mockHost) SessionStore(token string) dal.SessionStoreAPI          { return nil }
func (h *mockHost) UserLookupStore(username string) dal.UserLookupStoreAPI { return nil }
func (h *mockHost) IsEitherWayBlocked(a, b int64) (bool, error)            { return false, nil }

// TestRegisterAndNameConflict 测试插件注册与重名冲突检测。
func TestRegisterAndNameConflict(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic on duplicate plugin name")
		}
	}()

	registry := NewRegistry()
	registry.Register(&mockPlugin{name: "plugin1"})
	registry.Register(&mockPlugin{name: "plugin1"}) // 同名重复注册应该 panic
}

// TestMergeSchemas 测试 schema 合并
func TestMergeSchemas(t *testing.T) {
	registry := NewRegistry()

	base := map[string]string{
		"uid":   "CREATE TABLE user_info (uid INT);",
		"token": "CREATE TABLE session (token TEXT);",
	}

	p1 := &mockPlugin{
		name: "plugin1",
		schemas: map[string]string{
			"uid":   "CREATE TABLE plugin1_data (id INT);",
			"group": "CREATE TABLE plugin1_group (gid INT);",
		},
	}
	registry.Register(p1)

	merged := registry.MergeSchemas(base)

	if merged["uid"] != "CREATE TABLE user_info (uid INT);\nCREATE TABLE plugin1_data (id INT);" {
		t.Errorf("uid schema merge failed: %q", merged["uid"])
	}
	if merged["token"] != "CREATE TABLE session (token TEXT);" {
		t.Errorf("token schema should be unchanged: %q", merged["token"])
	}
	if merged["group"] != "CREATE TABLE plugin1_group (gid INT);" {
		t.Errorf("group schema should be added: %q", merged["group"])
	}
}

// TestDisconnectHooks 测试 OnDisconnect 钩子
func TestDisconnectHooks(t *testing.T) {
	registry := NewRegistry()
	host := &mockHost{}

	p1 := &mockPlugin{name: "plugin1"}
	p2 := &mockPlugin{name: "plugin2"}
	registry.Register(p1)
	registry.Register(p2)

	registry.HandleDisconnect(host, 123)

	if len(p1.onDisconnectCalls) != 1 || p1.onDisconnectCalls[0] != 123 {
		t.Errorf("plugin1 OnDisconnect not called correctly")
	}
	if len(p2.onDisconnectCalls) != 1 || p2.onDisconnectCalls[0] != 123 {
		t.Errorf("plugin2 OnDisconnect not called correctly")
	}
}

// TestStartHooks 测试 OnStart 钩子
func TestStartHooks(t *testing.T) {
	registry := NewRegistry()
	host := &mockHost{}

	p1 := &mockPlugin{name: "plugin1"}
	p2 := &mockPlugin{name: "plugin2"}
	registry.Register(p1)
	registry.Register(p2)

	registry.Start(host)

	if !p1.onStartCalled {
		t.Errorf("plugin1 OnStart not called")
	}
	if !p2.onStartCalled {
		t.Errorf("plugin2 OnStart not called")
	}
}
