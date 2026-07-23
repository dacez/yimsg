package fsread

import (
	"fmt"
	"strings"
)

// PrivatePrefix/SharedPrefix 是 LayeredSandbox 对外暴露的相对路径命名空间前缀：
// 私有（账号独享）知识库下的文件路径都以 PrivatePrefix 开头，共享（全部账号）知识库
// 下的文件路径都以 SharedPrefix 开头，用来区分两棵目录树里可能同名的文件，调用方
// （list_md_files/search_md_files 返回的路径）据此判断 read_md_file 应该读哪一棵。
const (
	PrivatePrefix = "private/"
	SharedPrefix  = "shared/"
)

// LayeredSandbox 组合账号私有（独享）知识库沙箱与全部账号共享的知识库沙箱，对外
// 暴露成单个 FileTool 语义：list/search 留空 subdir 时同时看两棵目录树（私有排在
// 前面），read 必须带 private/ 或 shared/ 前缀指明读哪一棵。两个 *Sandbox 各自
// 严格限制在自己的 root 内，互不递归，因此不会出现一个账号通过"共享兜底"读到另一
// 个账号私有资料的情况。方案见 agent方案.md §2.3。
type LayeredSandbox struct {
	Private *Sandbox
	Shared  *Sandbox
}

// ListMarkdown 见 LayeredSandbox 的前缀路由规则。
func (l *LayeredSandbox) ListMarkdown(subdir string) ([]string, error) {
	switch {
	case subdir == "":
		priv, err := l.Private.ListMarkdown("")
		if err != nil {
			return nil, err
		}
		shared, err := l.Shared.ListMarkdown("")
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(priv)+len(shared))
		out = append(out, prefixAll(PrivatePrefix, priv)...)
		out = append(out, prefixAll(SharedPrefix, shared)...)
		return out, nil
	case strings.HasPrefix(subdir, PrivatePrefix):
		files, err := l.Private.ListMarkdown(strings.TrimPrefix(subdir, PrivatePrefix))
		if err != nil {
			return nil, err
		}
		return prefixAll(PrivatePrefix, files), nil
	case strings.HasPrefix(subdir, SharedPrefix):
		files, err := l.Shared.ListMarkdown(strings.TrimPrefix(subdir, SharedPrefix))
		if err != nil {
			return nil, err
		}
		return prefixAll(SharedPrefix, files), nil
	default:
		return nil, fmt.Errorf("subdir 必须以 %q 或 %q 开头，或留空表示同时列出两者: %s", PrivatePrefix, SharedPrefix, subdir)
	}
}

// ReadMarkdown 见 LayeredSandbox 的前缀路由规则；relPath 必须带 private/ 或
// shared/ 前缀，不接受不带前缀的路径（避免"该读哪一棵"的歧义）。
func (l *LayeredSandbox) ReadMarkdown(relPath string) (string, error) {
	switch {
	case strings.HasPrefix(relPath, PrivatePrefix):
		return l.Private.ReadMarkdown(strings.TrimPrefix(relPath, PrivatePrefix))
	case strings.HasPrefix(relPath, SharedPrefix):
		return l.Shared.ReadMarkdown(strings.TrimPrefix(relPath, SharedPrefix))
	default:
		return "", fmt.Errorf("path 必须以 %q 或 %q 开头（用 list_md_files/search_md_files 返回的路径）: %s", PrivatePrefix, SharedPrefix, relPath)
	}
}

// Search 见 LayeredSandbox 的前缀路由规则；留空 subdir 时两棵目录树都搜，私有
// 命中排在共享命中前面，truncated 只要有一侧被截断就置 true。
func (l *LayeredSandbox) Search(pattern, subdir string, contextChars int) ([]SearchMatch, bool, error) {
	switch {
	case subdir == "":
		privMatches, privTruncated, err := l.Private.Search(pattern, "", contextChars)
		if err != nil {
			return nil, false, err
		}
		sharedMatches, sharedTruncated, err := l.Shared.Search(pattern, "", contextChars)
		if err != nil {
			return nil, false, err
		}
		matches := make([]SearchMatch, 0, len(privMatches)+len(sharedMatches))
		matches = append(matches, prefixMatches(PrivatePrefix, privMatches)...)
		matches = append(matches, prefixMatches(SharedPrefix, sharedMatches)...)
		return matches, privTruncated || sharedTruncated, nil
	case strings.HasPrefix(subdir, PrivatePrefix):
		matches, truncated, err := l.Private.Search(pattern, strings.TrimPrefix(subdir, PrivatePrefix), contextChars)
		if err != nil {
			return nil, false, err
		}
		return prefixMatches(PrivatePrefix, matches), truncated, nil
	case strings.HasPrefix(subdir, SharedPrefix):
		matches, truncated, err := l.Shared.Search(pattern, strings.TrimPrefix(subdir, SharedPrefix), contextChars)
		if err != nil {
			return nil, false, err
		}
		return prefixMatches(SharedPrefix, matches), truncated, nil
	default:
		return nil, false, fmt.Errorf("subdir 必须以 %q 或 %q 开头，或留空表示同时搜索两者: %s", PrivatePrefix, SharedPrefix, subdir)
	}
}

func prefixAll(prefix string, paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = prefix + p
	}
	return out
}

func prefixMatches(prefix string, matches []SearchMatch) []SearchMatch {
	out := make([]SearchMatch, len(matches))
	for i, m := range matches {
		m.Path = prefix + m.Path
		out[i] = m
	}
	return out
}
