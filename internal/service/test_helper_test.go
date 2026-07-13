package service

import (
	"testing"
	"yimsg/internal/config"
	"yimsg/internal/dal"
	"yimsg/internal/plugin"
	"yimsg/internal/shard"
	"yimsg/internal/taskqueue"
)

func testState(t *testing.T) *AppState {
	t.Helper()
	db, err := shard.OpenMemory(2, dal.Schemas())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{
		Server:   config.ServerConfig{Host: "127.0.0.1", Port: 0, MachineID: 1},
		Database: config.DatabaseConfig{DataDir: "", ShardCount: 2},
		Session:  config.SessionConfig{TTLSeconds: 604800, TokenBytes: 16},
		Message:  config.MessageConfig{RecallWindowSeconds: 120},
		GC: config.GCConfig{
			MessageMaxCount:            5000,
			SessionCleanupIntervalSecs: 3600,
			ContactGCIntervalSecs:      86400,
			MessageGCIntervalSecs:      3600,
			UserGCIntervalSecs:         86400,
		},
		Frontend: config.FrontendConfig{StaticDir: ""},
		Media: config.MediaConfig{
			UploadDir:      t.TempDir(),
			MaxAvatarBytes: 5242880,
			MaxImageBytes:  10485760,
			MaxFileBytes:   104857600,
		},
	}
	registry := plugin.NewRegistry()
	state := NewAppState(db, cfg, registry)
	// 测试用持久化任务队列（临时目录），默认 manual 模式：fanout 任务缓冲，
	// 由 drainTasks 显式同步执行，方便断言 fanout 前 / 后的收件箱状态。
	tasks, err := taskqueue.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tasks.Close() })
	state.UseTaskQueue(tasks)
	return state
}

// drainTasks 同步执行队列中缓冲的 fanout 任务（testState 采用 manual 模式）。
func drainTasks(s *AppState) { s.tasks.RunPending() }

func registerUser(t *testing.T, s *AppState, username, password, nickname string) int64 {
	t.Helper()
	resp := registerService(s, "test", username, password, nickname)
	if !isOK(resp) {
		t.Fatalf("register %s: %s", username, errMsg(resp))
	}
	return resp.GetUid()
}

func loginUser(t *testing.T, s *AppState, username, password string) (int64, string) {
	t.Helper()
	resp := loginService(s, "test", username, password)
	if !isOK(resp) {
		t.Fatalf("login %s: %s", username, errMsg(resp))
	}
	return resp.GetUid(), resp.GetToken()
}

func registerAndLogin(t *testing.T, s *AppState, username, password, nickname string) (int64, string) {
	t.Helper()
	registerUser(t, s, username, password, nickname)
	return loginUser(t, s, username, password)
}

func makeFriends(t *testing.T, s *AppState, uid1, uid2 int64) {
	t.Helper()
	addFriendService(s, "test", uid1, uid2, "")
	acceptFriendService(s, "test", uid2, uid1)
}
