// Package fsread 是多步执行引擎用到的只读 Markdown 文件工具，严格限制在账号的
// workspace_dir 内，禁止任何形式越出该目录。方案见 agent/docs/agent方案.md 第 7 节。
package fsread

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// MaxFileBytes 是单个 Markdown 文件允许读取的最大字节数，超出截断并附加提示。
const MaxFileBytes = 200 * 1024

// MaxListEntries 是 ListMarkdown 单次返回的最大文件数，防止超大目录拖垮响应。
const MaxListEntries = 500

// Sandbox 把文件访问限制在 root 目录内。
type Sandbox struct {
	root string
}

// NewSandbox 用 workspace_dir 构造一个沙箱；root 必须已存在且是目录。
func NewSandbox(root string) (*Sandbox, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("解析 workspace_dir 绝对路径失败: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("workspace_dir %s 不存在: %w", abs, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workspace_dir %s 不是目录", abs)
	}
	// 真实路径（解开顶层可能的符号链接），后续越界校验都基于这个真实前缀比较。
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("解析 workspace_dir 真实路径失败: %w", err)
	}
	return &Sandbox{root: real}, nil
}

// Root 返回沙箱根目录的真实绝对路径。
func (s *Sandbox) Root() string {
	return s.root
}

// resolve 把调用方传入的相对路径解析、校验成沙箱内的真实绝对路径；任何形式的
// 越界（绝对路径输入、".." 穿越、符号链接逃逸）都会被拒绝。
func (s *Sandbox) resolve(relPath string) (string, error) {
	if relPath == "" {
		return "", fmt.Errorf("路径不能为空")
	}
	if filepath.IsAbs(relPath) {
		return "", fmt.Errorf("不允许绝对路径: %s", relPath)
	}
	joined := filepath.Join(s.root, relPath)
	cleaned := filepath.Clean(joined)
	if !isWithin(s.root, cleaned) {
		return "", fmt.Errorf("路径越出 workspace_dir: %s", relPath)
	}

	// 文件存在时才能 EvalSymlinks；不存在则直接用清理后的路径做前缀校验即可
	// （调用方随后会因文件不存在而收到相应错误，不需要在这里额外处理）。
	if real, err := filepath.EvalSymlinks(cleaned); err == nil {
		if !isWithin(s.root, real) {
			return "", fmt.Errorf("路径通过符号链接越出 workspace_dir: %s", relPath)
		}
		return real, nil
	}
	return cleaned, nil
}

// isWithin 判断 target 是否等于 root 或在 root 之内。
func isWithin(root, target string) bool {
	if target == root {
		return true
	}
	return strings.HasPrefix(target, root+string(filepath.Separator))
}

func isMarkdown(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".md" || ext == ".markdown"
}

// ListMarkdown 递归列出 workspace_dir/subdir 下的 .md/.markdown 文件，返回相对
// workspace_dir 的路径（正斜杠分隔），按字典序排列；subdir 为空表示整个 workspace_dir。
func (s *Sandbox) ListMarkdown(subdir string) ([]string, error) {
	start := s.root
	if subdir != "" {
		resolved, err := s.resolve(subdir)
		if err != nil {
			return nil, err
		}
		start = resolved
	}
	info, err := os.Stat(start)
	if err != nil {
		return nil, fmt.Errorf("目录不存在: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s 不是目录", subdir)
	}

	var out []string
	err = filepath.WalkDir(start, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !isMarkdown(d.Name()) {
			return nil
		}
		rel, relErr := filepath.Rel(s.root, path)
		if relErr != nil {
			return relErr
		}
		out = append(out, filepath.ToSlash(rel))
		if len(out) >= MaxListEntries {
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("遍历目录失败: %w", err)
	}
	sort.Strings(out)
	return out, nil
}

// ReadMarkdown 读取 workspace_dir 内一个 .md/.markdown 文件的内容；超过 MaxFileBytes
// 时截断并附加提示，不返回错误（截断是可用的部分结果，不是失败）。
func (s *Sandbox) ReadMarkdown(relPath string) (string, error) {
	if !isMarkdown(relPath) {
		return "", fmt.Errorf("只允许读取 .md/.markdown 文件: %s", relPath)
	}
	real, err := s.resolve(relPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("文件不存在: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录，不是文件", relPath)
	}

	f, err := os.Open(real)
	if err != nil {
		return "", fmt.Errorf("打开文件失败: %w", err)
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	if len(data) > MaxFileBytes {
		return string(data[:MaxFileBytes]) + "\n\n...[内容过长，已截断]", nil
	}
	return string(data), nil
}
