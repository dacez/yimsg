package service

import "testing"

// TestStoreShortcutsExposeDALInterfaces ensures AppState 对外暴露的是 DAL 接口类型，
// 以避免 Service 层依赖具体 Store 实现。
func TestStoreShortcutsExposeDALInterfaces(t *testing.T) {
	s := testState(t)

	if s.UserStore(1) == nil || s.ContactStore(1) == nil || s.MessageStore(1) == nil {
		t.Fatal("uid 路由的 store shortcut 不应返回 nil")
	}
	if s.ConversationStore(1) == nil || s.UserSessionStore(1) == nil {
		t.Fatal("uid 路由的辅助 store shortcut 不应返回 nil")
	}
	if s.GroupStore(1) == nil || s.SessionStore("token") == nil || s.UserLookupStore("u") == nil {
		t.Fatal("group/token/username 路由的 store shortcut 不应返回 nil")
	}
}
