package account

import (
	"os"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := Session{UID: 42, Username: "alice", Token: "tok-1", ServerURL: "ws://127.0.0.1:8080/ws", LoginAt: 1000}
	if err := Save(dir, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := Load(dir, "alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != want {
		t.Fatalf("loaded session = %+v, want %+v", got, want)
	}
}

func TestLoadMissingSessionErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := Load(dir, "nobody"); err == nil {
		t.Fatalf("expected error for missing session")
	}
}

func TestSaveRejectsEmptyUsername(t *testing.T) {
	dir := t.TempDir()
	if err := Save(dir, Session{UID: 1}); err == nil {
		t.Fatalf("expected error for empty username")
	}
}

func TestSaveOverwritesSameUsername(t *testing.T) {
	dir := t.TempDir()
	first := Session{UID: 1, Username: "alice", Token: "tok-1"}
	if err := Save(dir, first); err != nil {
		t.Fatalf("save first: %v", err)
	}
	// 同一 username 先后在不同服务器注册出不同 uid 的极端场景：目录直接复用/覆盖。
	second := Session{UID: 999, Username: "alice", Token: "tok-2"}
	if err := Save(dir, second); err != nil {
		t.Fatalf("save second: %v", err)
	}
	got, err := Load(dir, "alice")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != second {
		t.Fatalf("loaded session = %+v, want %+v (overwritten)", got, second)
	}
}

func TestListReturnsAllAccounts(t *testing.T) {
	dir := t.TempDir()
	if err := Save(dir, Session{UID: 1, Username: "alice"}); err != nil {
		t.Fatalf("save 1: %v", err)
	}
	if err := Save(dir, Session{UID: 2, Username: "bob"}); err != nil {
		t.Fatalf("save 2: %v", err)
	}

	sessions, err := List(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("len(sessions) = %d, want 2", len(sessions))
	}
	byUsername := map[string]int64{}
	for _, s := range sessions {
		byUsername[s.Username] = s.UID
	}
	if byUsername["alice"] != 1 || byUsername["bob"] != 2 {
		t.Fatalf("unexpected accounts: %+v", byUsername)
	}
}

// TestListSkipsDirsWithoutSession 校验 List 会静默跳过没有 session.json 的子
// 目录，而不是报错——这是 yimsg-agent 共享 resources/ 目录能跟账号目录平级共存
// 在同一个根目录下的前提。
func TestListSkipsDirsWithoutSession(t *testing.T) {
	dir := t.TempDir()
	if err := Save(dir, Session{UID: 1, Username: "alice"}); err != nil {
		t.Fatalf("save alice: %v", err)
	}
	if err := os.MkdirAll(dir+"/resources", 0o700); err != nil {
		t.Fatalf("mkdir resources: %v", err)
	}

	sessions, err := List(dir)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 1 || sessions[0].Username != "alice" {
		t.Fatalf("sessions = %+v, want only alice", sessions)
	}
}

func TestListOnMissingBaseDirReturnsEmpty(t *testing.T) {
	sessions, err := List("/nonexistent/base/dir/for/yimsg-cli-test")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 0 {
		t.Fatalf("expected no accounts, got %+v", sessions)
	}
}

func TestLoadCurrentReflectsLatestToken(t *testing.T) {
	dir := t.TempDir()
	alice := Session{UID: 1, Username: "alice", Token: "tok-a1", ServerURL: "ws://x/ws"}
	if err := Save(dir, alice); err != nil {
		t.Fatalf("save alice: %v", err)
	}
	if err := SetCurrent(dir, alice); err != nil {
		t.Fatalf("set current: %v", err)
	}

	got, err := LoadCurrent(dir)
	if err != nil {
		t.Fatalf("load current: %v", err)
	}
	if got != alice {
		t.Fatalf("load current = %+v, want %+v", got, alice)
	}

	// current.json 只存指针；token 刷新后 LoadCurrent 应读到最新 session.json，而不是旧副本。
	alice.Token = "tok-a2"
	if err := Save(dir, alice); err != nil {
		t.Fatalf("re-save alice: %v", err)
	}
	got, err = LoadCurrent(dir)
	if err != nil {
		t.Fatalf("load current after refresh: %v", err)
	}
	if got.Token != "tok-a2" {
		t.Fatalf("token = %q, want tok-a2 (current.json must not shadow session.json)", got.Token)
	}
}

func TestSwitchUserViaFindByUsername(t *testing.T) {
	dir := t.TempDir()
	alice := Session{UID: 1, Username: "alice", Token: "tok-a", ServerURL: "ws://x/ws"}
	bob := Session{UID: 2, Username: "bob", Token: "tok-b", ServerURL: "ws://x/ws"}
	if err := Save(dir, alice); err != nil {
		t.Fatalf("save alice: %v", err)
	}
	if err := Save(dir, bob); err != nil {
		t.Fatalf("save bob: %v", err)
	}
	if err := SetCurrent(dir, alice); err != nil {
		t.Fatalf("set current alice: %v", err)
	}

	found, err := FindByUsername(dir, "bob")
	if err != nil {
		t.Fatalf("find by username: %v", err)
	}
	if found != bob {
		t.Fatalf("found = %+v, want %+v", found, bob)
	}
	if err := SetCurrent(dir, found); err != nil {
		t.Fatalf("set current bob: %v", err)
	}

	got, err := LoadCurrent(dir)
	if err != nil {
		t.Fatalf("load current: %v", err)
	}
	if got.UID != bob.UID {
		t.Fatalf("current uid = %d, want %d (switch-user should change current)", got.UID, bob.UID)
	}
}

func TestFindByUsernameMissingErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := FindByUsername(dir, "nobody"); err == nil {
		t.Fatalf("expected error for unknown username")
	}
}

func TestLoadCurrentWithoutLoginErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadCurrent(dir); err == nil {
		t.Fatalf("expected error when no current account set")
	}
}
