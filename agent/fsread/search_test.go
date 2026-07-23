package fsread

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchReturnsContextBeforeAndAfter(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "notes.md"), "0123456789关键字abcdefghij")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}

	matches, truncated, err := sb.Search("关键字", "", 5)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if truncated {
		t.Errorf("truncated = true, want false")
	}
	if len(matches) != 1 {
		t.Fatalf("matches = %v, want 1 match", matches)
	}
	m := matches[0]
	if m.Path != "notes.md" {
		t.Errorf("Path = %q", m.Path)
	}
	if m.Match != "关键字" {
		t.Errorf("Match = %q", m.Match)
	}
	if m.Before != "56789" {
		t.Errorf("Before = %q, want %q", m.Before, "56789")
	}
	if m.After != "abcde" {
		t.Errorf("After = %q, want %q", m.After, "abcde")
	}
}

func TestSearchHandlesMultiByteContextBoundaries(t *testing.T) {
	dir := t.TempDir()
	// 中文字符是多字节的，上下文必须按 rune 而不是 byte 切片，否则会切出半个字符。
	mustWrite(t, filepath.Join(dir, "cn.md"), "你好世界MATCH再见地球")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	matches, _, err := sb.Search("MATCH", "", 4)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("matches = %v", matches)
	}
	if matches[0].Before != "你好世界" {
		t.Errorf("Before = %q, want %q", matches[0].Before, "你好世界")
	}
	if matches[0].After != "再见地球" {
		t.Errorf("After = %q, want %q", matches[0].After, "再见地球")
	}
}

func TestSearchSupportsRegexPattern(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.md"), "foo123 bar456 baz789")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	matches, _, err := sb.Search(`[a-z]+\d+`, "", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(matches) != 3 {
		t.Fatalf("matches = %v, want 3", matches)
	}
}

func TestSearchRejectsInvalidRegex(t *testing.T) {
	dir := t.TempDir()
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	if _, _, err := sb.Search("(unclosed", "", 10); err == nil {
		t.Fatal("expected error for invalid regex")
	}
}

func TestSearchRejectsEmptyPattern(t *testing.T) {
	dir := t.TempDir()
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	if _, _, err := sb.Search("", "", 10); err == nil {
		t.Fatal("expected error for empty pattern")
	}
}

func TestSearchClampsContextChars(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.md"), strings.Repeat("x", 100)+"HIT"+strings.Repeat("y", 100))
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}

	// 请求一个远超 MaxContextChars 的上下文，应该被 clamp，而不是把整份文件都吐出来。
	matches, _, err := sb.Search("HIT", "", MaxContextChars*10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("matches = %v", matches)
	}
	if len(matches[0].Before) != 100 || len(matches[0].After) != 100 {
		t.Errorf("Before/After len = %d/%d, want 100/100 (file itself is only 100 chars on each side)",
			len(matches[0].Before), len(matches[0].After))
	}

	// 负数应该被 clamp 到 0。
	matches, _, err = sb.Search("HIT", "", -5)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if matches[0].Before != "" || matches[0].After != "" {
		t.Errorf("expected empty context for negative contextChars, got before=%q after=%q", matches[0].Before, matches[0].After)
	}
}

func TestSearchTruncatesAtMaxMatches(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.md"), strings.Repeat("HIT ", MaxSearchMatches+10))
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	matches, truncated, err := sb.Search("HIT", "", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if !truncated {
		t.Errorf("expected truncated=true")
	}
	if len(matches) != MaxSearchMatches {
		t.Errorf("matches len = %d, want %d", len(matches), MaxSearchMatches)
	}
}

func TestSearchNoMatchesReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.md"), "nothing interesting here")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	matches, truncated, err := sb.Search("不存在的关键字", "", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if truncated {
		t.Errorf("truncated = true, want false")
	}
	if len(matches) != 0 {
		t.Errorf("matches = %v, want empty", matches)
	}
}

func TestSearchScopedToSubdir(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "in.md"), "target-word here")
	mustWrite(t, filepath.Join(dir, "sub", "in.md"), "target-word here too")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	matches, _, err := sb.Search("target-word", "sub", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(matches) != 1 || matches[0].Path != "sub/in.md" {
		t.Errorf("matches = %v, want only sub/in.md", matches)
	}
}

func TestSearchAcrossMultipleFiles(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.md"), "shared-term in a")
	mustWrite(t, filepath.Join(dir, "b.md"), "shared-term in b")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	matches, _, err := sb.Search("shared-term", "", 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("matches = %v, want 2", matches)
	}
}
