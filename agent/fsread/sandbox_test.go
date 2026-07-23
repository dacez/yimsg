package fsread

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadMarkdownWithinWorkspace(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "notes.md"), "# hello")
	mustWrite(t, filepath.Join(dir, "sub", "a.md"), "sub content")

	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	content, err := sb.ReadMarkdown("notes.md")
	if err != nil {
		t.Fatalf("ReadMarkdown: %v", err)
	}
	if content != "# hello" {
		t.Errorf("content = %q", content)
	}
	content, err = sb.ReadMarkdown("sub/a.md")
	if err != nil {
		t.Fatalf("ReadMarkdown sub: %v", err)
	}
	if content != "sub content" {
		t.Errorf("content = %q", content)
	}
}

func TestReadMarkdownRejectsPathTraversal(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret.md"), "secret")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	rel, _ := filepath.Rel(dir, filepath.Join(outside, "secret.md"))
	if _, err := sb.ReadMarkdown(rel); err == nil {
		t.Fatalf("expected traversal via %q to be rejected", rel)
	}
}

func TestReadMarkdownRejectsAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret.md"), "secret")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	if _, err := sb.ReadMarkdown(filepath.Join(outside, "secret.md")); err == nil {
		t.Fatal("expected absolute path to be rejected")
	}
}

func TestReadMarkdownRejectsSymlinkEscape(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret.md"), "secret")
	linkPath := filepath.Join(dir, "escape.md")
	if err := os.Symlink(filepath.Join(outside, "secret.md"), linkPath); err != nil {
		t.Skipf("symlink not supported on this platform: %v", err)
	}
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	if _, err := sb.ReadMarkdown("escape.md"); err == nil {
		t.Fatal("expected symlink escape to be rejected")
	}
}

func TestReadMarkdownRejectsNonMarkdown(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "notes.txt"), "plain text")
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	if _, err := sb.ReadMarkdown("notes.txt"); err == nil {
		t.Fatal("expected non-.md file to be rejected")
	}
}

func TestReadMarkdownTruncatesLargeFile(t *testing.T) {
	dir := t.TempDir()
	big := strings.Repeat("a", MaxFileBytes+1000)
	mustWrite(t, filepath.Join(dir, "big.md"), big)
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	content, err := sb.ReadMarkdown("big.md")
	if err != nil {
		t.Fatalf("ReadMarkdown: %v", err)
	}
	if !strings.HasSuffix(content, "...[内容过长，已截断]") {
		t.Errorf("expected truncation marker, got suffix: %q", content[len(content)-40:])
	}
}

func TestListMarkdownRecursiveAndSorted(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "b.md"), "b")
	mustWrite(t, filepath.Join(dir, "a.md"), "a")
	mustWrite(t, filepath.Join(dir, "sub", "c.md"), "c")
	mustWrite(t, filepath.Join(dir, "ignore.txt"), "ignored")

	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	files, err := sb.ListMarkdown("")
	if err != nil {
		t.Fatalf("ListMarkdown: %v", err)
	}
	want := []string{"a.md", "b.md", "sub/c.md"}
	if len(files) != len(want) {
		t.Fatalf("files = %v, want %v", files, want)
	}
	for i := range want {
		if files[i] != want[i] {
			t.Errorf("files[%d] = %q, want %q", i, files[i], want[i])
		}
	}
}

func TestListMarkdownRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	sb, err := NewSandbox(dir)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	if _, err := sb.ListMarkdown("../"); err == nil {
		t.Fatal("expected traversal to be rejected")
	}
}

func TestNewSandboxRejectsMissingDir(t *testing.T) {
	if _, err := NewSandbox(filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Fatal("expected error for missing root")
	}
}
