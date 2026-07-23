package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenMissingFileStartsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_state.json")
	s, err := Open(path, 4000, 500)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if s.ProcessedSeq() != 0 {
		t.Errorf("ProcessedSeq = %d, want 0", s.ProcessedSeq())
	}
	if got := s.PeerMemory(PeerKeyForUser(1)); got.Summary != "" {
		t.Errorf("expected empty PeerMemory, got %+v", got)
	}
}

func TestCommitAdvancesSeqAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_state.json")
	s, err := Open(path, 4000, 500)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	key := PeerKeyForUser(42)
	if err := s.Commit(10, []PeerUpdate{{Key: key, Summary: "first summary"}}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if s.ProcessedSeq() != 10 {
		t.Errorf("ProcessedSeq = %d, want 10", s.ProcessedSeq())
	}
	pm := s.PeerMemory(key)
	if pm.Summary != "first summary" || pm.Turns != 1 {
		t.Errorf("PeerMemory = %+v", pm)
	}

	// 重新打开应该读到落盘的状态。
	s2, err := Open(path, 4000, 500)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	if s2.ProcessedSeq() != 10 {
		t.Errorf("reloaded ProcessedSeq = %d, want 10", s2.ProcessedSeq())
	}
	if s2.PeerMemory(key).Summary != "first summary" {
		t.Errorf("reloaded PeerMemory = %+v", s2.PeerMemory(key))
	}

	// 落盘文件必须是合法 JSON，且没有残留临时文件。
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted file: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("persisted file is not valid JSON: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("expected no leftover .tmp file, stat err = %v", err)
	}
}

func TestCommitSeqNeverGoesBackward(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_state.json")
	s, _ := Open(path, 4000, 500)
	if err := s.Commit(20, nil); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := s.Commit(5, nil); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if s.ProcessedSeq() != 20 {
		t.Errorf("ProcessedSeq = %d, want 20 (should not go backward)", s.ProcessedSeq())
	}
}

func TestCommitTruncatesOverlongSummary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_state.json")
	s, _ := Open(path, 10, 500)
	key := PeerKeyForUser(1)
	if err := s.Commit(1, []PeerUpdate{{Key: key, Summary: strings.Repeat("x", 100)}}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if got := s.PeerMemory(key).Summary; len(got) != 10 {
		t.Errorf("summary len = %d, want 10 (hard truncated)", len(got))
	}
}

func TestCommitEvictsOldestPeersBeyondMax(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_state.json")
	s, _ := Open(path, 4000, 2)
	base := time.Unix(1700000000, 0)
	tick := 0
	s.clock = func() time.Time {
		tick++
		return base.Add(time.Duration(tick) * time.Minute)
	}

	if err := s.Commit(1, []PeerUpdate{{Key: "u:1", Summary: "a"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Commit(2, []PeerUpdate{{Key: "u:2", Summary: "b"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Commit(3, []PeerUpdate{{Key: "u:3", Summary: "c"}}); err != nil {
		t.Fatal(err)
	}
	if s.PeerCount() != 2 {
		t.Fatalf("PeerCount = %d, want 2", s.PeerCount())
	}
	if s.PeerMemory("u:1").Summary != "" {
		t.Errorf("expected u:1 to be evicted (oldest), still present: %+v", s.PeerMemory("u:1"))
	}
	if s.PeerMemory("u:2").Summary == "" || s.PeerMemory("u:3").Summary == "" {
		t.Errorf("expected u:2 and u:3 to survive eviction")
	}
}

func TestPeerKeyHelpers(t *testing.T) {
	if PeerKeyForUser(7) != "u:7" {
		t.Errorf("PeerKeyForUser = %q", PeerKeyForUser(7))
	}
	if PeerKeyForGroup(9) != "g:9" {
		t.Errorf("PeerKeyForGroup = %q", PeerKeyForGroup(9))
	}
}
