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
