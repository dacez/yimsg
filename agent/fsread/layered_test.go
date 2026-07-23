package fsread

import (
	"path/filepath"
	"testing"
)

func newLayered(t *testing.T) (*LayeredSandbox, string, string) {
	t.Helper()
	privDir := t.TempDir()
	sharedDir := t.TempDir()
	priv, err := NewSandbox(privDir)
	if err != nil {
		t.Fatalf("NewSandbox(private): %v", err)
	}
	shared, err := NewSandbox(sharedDir)
	if err != nil {
		t.Fatalf("NewSandbox(shared): %v", err)
	}
	return &LayeredSandbox{Private: priv, Shared: shared}, privDir, sharedDir
}

func TestLayeredListMarkdownMergesBothWithPrivateFirst(t *testing.T) {
	l, privDir, sharedDir := newLayered(t)
	mustWrite(t, filepath.Join(privDir, "notes.md"), "私有笔记")
	mustWrite(t, filepath.Join(sharedDir, "faq.md"), "公用 FAQ")

	files, err := l.ListMarkdown("")
	if err != nil {
		t.Fatalf("ListMarkdown: %v", err)
	}
	want := []string{"private/notes.md", "shared/faq.md"}
	if len(files) != len(want) || files[0] != want[0] || files[1] != want[1] {
		t.Errorf("files = %v, want %v", files, want)
	}
}

func TestLayeredListMarkdownWithPrefixOnlyListsThatSide(t *testing.T) {
	l, privDir, sharedDir := newLayered(t)
	mustWrite(t, filepath.Join(privDir, "notes.md"), "私有笔记")
	mustWrite(t, filepath.Join(sharedDir, "faq.md"), "公用 FAQ")

	files, err := l.ListMarkdown("private/")
	if err != nil {
		t.Fatalf("ListMarkdown(private/): %v", err)
	}
	if len(files) != 1 || files[0] != "private/notes.md" {
		t.Errorf("files = %v", files)
	}

	files, err = l.ListMarkdown("shared/")
	if err != nil {
		t.Fatalf("ListMarkdown(shared/): %v", err)
	}
	if len(files) != 1 || files[0] != "shared/faq.md" {
		t.Errorf("files = %v", files)
	}
}

func TestLayeredListMarkdownRejectsUnprefixedSubdir(t *testing.T) {
	l, _, _ := newLayered(t)
	if _, err := l.ListMarkdown("notes"); err == nil {
		t.Fatal("expected error for subdir without private/ or shared/ prefix")
	}
}

func TestLayeredReadMarkdownRoutesByPrefix(t *testing.T) {
	l, privDir, sharedDir := newLayered(t)
	mustWrite(t, filepath.Join(privDir, "faq.md"), "私有版本")
	mustWrite(t, filepath.Join(sharedDir, "faq.md"), "公用版本")

	content, err := l.ReadMarkdown("private/faq.md")
	if err != nil {
		t.Fatalf("ReadMarkdown(private/faq.md): %v", err)
	}
	if content != "私有版本" {
		t.Errorf("content = %q, want 私有版本", content)
	}

	content, err = l.ReadMarkdown("shared/faq.md")
	if err != nil {
		t.Fatalf("ReadMarkdown(shared/faq.md): %v", err)
	}
	if content != "公用版本" {
		t.Errorf("content = %q, want 公用版本", content)
	}
}

func TestLayeredReadMarkdownRejectsUnprefixedPath(t *testing.T) {
	l, privDir, _ := newLayered(t)
	mustWrite(t, filepath.Join(privDir, "faq.md"), "私有版本")
	if _, err := l.ReadMarkdown("faq.md"); err == nil {
		t.Fatal("expected error for path without private/ or shared/ prefix")
	}
}

func TestLayeredSearchMergesWithPrivateFirst(t *testing.T) {
	l, privDir, sharedDir := newLayered(t)
	mustWrite(t, filepath.Join(privDir, "notes.md"), "退款政策：私有备注")
	mustWrite(t, filepath.Join(sharedDir, "policy.md"), "退款政策：公用说明")

	matches, truncated, err := l.Search("退款政策", "", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if truncated {
		t.Errorf("truncated = true, want false")
	}
	if len(matches) != 2 {
		t.Fatalf("matches len = %d, want 2", len(matches))
	}
	if matches[0].Path != "private/notes.md" {
		t.Errorf("matches[0].Path = %q, want private/notes.md（私有应排在前面）", matches[0].Path)
	}
	if matches[1].Path != "shared/policy.md" {
		t.Errorf("matches[1].Path = %q, want shared/policy.md", matches[1].Path)
	}
}

func TestLayeredSearchWithPrefixOnlySearchesThatSide(t *testing.T) {
	l, privDir, sharedDir := newLayered(t)
	mustWrite(t, filepath.Join(privDir, "notes.md"), "关键字命中")
	mustWrite(t, filepath.Join(sharedDir, "policy.md"), "关键字命中")

	matches, _, err := l.Search("关键字", "shared/", 5)
	if err != nil {
		t.Fatalf("Search(shared/): %v", err)
	}
	if len(matches) != 1 || matches[0].Path != "shared/policy.md" {
		t.Errorf("matches = %+v, want only shared/policy.md", matches)
	}
}

// TestLayeredPrivateAndSharedAreIsolatedDirectoryTrees 校验私有、共享是两棵完全
// 独立的目录树：私有沙箱内部不会因为共享沙箱恰好是自己的父/子目录而互相递归读到，
// 对应 agent方案.md §2.3 "不会出现账号之间通过共享兜底互相看到私有资料"的要求。
func TestLayeredPrivateAndSharedAreIsolatedDirectoryTrees(t *testing.T) {
	l, privDir, sharedDir := newLayered(t)
	if privDir == sharedDir {
		t.Fatal("测试前提错误：私有、共享目录不应相同")
	}
	mustWrite(t, filepath.Join(privDir, "secret.md"), "只属于这个账号")

	// 共享沙箱的 root 不包含私有目录，越权读取应该被现有的越界防御拒绝。
	rel, _ := filepath.Rel(sharedDir, filepath.Join(privDir, "secret.md"))
	if _, err := l.Shared.ReadMarkdown(rel); err == nil {
		t.Fatalf("共享沙箱不应该能读到私有目录内容: %s", rel)
	}
}
