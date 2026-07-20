package account

import (
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := Session{UID: 42, Username: "alice", Token: "tok-1", ServerURL: "ws://127.0.0.1:8080/ws", LoginAt: 1000}
	if err := Save(dir, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := Load(dir, 42)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != want {
		t.Fatalf("loaded session = %+v, want %+v", got, want)
	}
}

func TestLoadMissingSessionErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := Load(dir, 1); err == nil {
		t.Fatalf("expected error for missing session")
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
	byUID := map[int64]string{}
	for _, s := range sessions {
		byUID[s.UID] = s.Username
	}
	if byUID[1] != "alice" || byUID[2] != "bob" {
		t.Fatalf("unexpected accounts: %+v", byUID)
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
