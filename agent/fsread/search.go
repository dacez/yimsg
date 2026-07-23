package fsread

import (
	"fmt"
	"regexp"
	"unicode/utf8"
)

// MaxContextChars 是 Search 单侧上下文字符数上限，调用方传入的 contextChars
// 超过这个值会被 clamp，避免一次搜索返回过多内容。
const MaxContextChars = 2000

// MaxSearchMatches 是 Search 单次调用返回的最大命中数；超过时截断并通过返回值
// truncated 告知调用方还有更多结果没有返回，调用方可以缩小 pattern 或加 subdir
// 再搜一次，而不是一次性把整个 workspace 的命中都塞进模型上下文。
const MaxSearchMatches = 50

// SearchMatch 是一次 grep 式搜索命中的结果，Before/After 是命中文本前后各
// 最多 contextChars 个字符的原文片段。
type SearchMatch struct {
	Path   string `json:"path"`
	Before string `json:"before"`
	Match  string `json:"match"`
	After  string `json:"after"`
}

// Search 在 workspace_dir/subdir 下的 .md/.markdown 文件里做类似 grep 的正则
// 搜索：纯文本正则匹配，不依赖向量库/语义检索。每个命中返回其前后最多
// contextChars 个字符的上下文，contextChars 由调用方（模型）在每次调用时自行
// 决定，这里只做 [0, MaxContextChars] 的安全 clamp。按 rune（而不是 byte）切片
// 上下文，避免多字节字符（如中文）被从中间切断。
func (s *Sandbox) Search(pattern, subdir string, contextChars int) (matches []SearchMatch, truncated bool, err error) {
	if pattern == "" {
		return nil, false, fmt.Errorf("搜索关键字不能为空")
	}
	if contextChars < 0 {
		contextChars = 0
	}
	if contextChars > MaxContextChars {
		contextChars = MaxContextChars
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, false, fmt.Errorf("非法的搜索正则表达式: %w", err)
	}

	files, err := s.ListMarkdown(subdir)
	if err != nil {
		return nil, false, err
	}

	for _, rel := range files {
		content, readErr := s.ReadMarkdown(rel)
		if readErr != nil {
			// 单个文件读取失败（例如并发被删除）不应该让整次搜索失败，跳过继续。
			continue
		}
		fileMatches, fileTruncated := searchInContent(rel, content, re, contextChars, MaxSearchMatches-len(matches))
		matches = append(matches, fileMatches...)
		if fileTruncated || len(matches) >= MaxSearchMatches {
			return matches, true, nil
		}
	}
	return matches, false, nil
}

// searchInContent 在单个文件内容里查找最多 limit 个命中，返回值 truncated 表示
// 该文件本身的命中数是否超过了 limit（调用方据此判断是否需要提前结束整个 Search）。
func searchInContent(path, content string, re *regexp.Regexp, contextChars, limit int) (matches []SearchMatch, truncated bool) {
	if limit <= 0 {
		return nil, true
	}
	locs := re.FindAllStringIndex(content, -1)
	if len(locs) == 0 {
		return nil, false
	}
	runes := []rune(content)
	for i, loc := range locs {
		if i >= limit {
			return matches, true
		}
		startRune := utf8.RuneCountInString(content[:loc[0]])
		endRune := utf8.RuneCountInString(content[:loc[1]])

		beforeStart := startRune - contextChars
		if beforeStart < 0 {
			beforeStart = 0
		}
		afterEnd := endRune + contextChars
		if afterEnd > len(runes) {
			afterEnd = len(runes)
		}

		matches = append(matches, SearchMatch{
			Path:   path,
			Before: string(runes[beforeStart:startRune]),
			Match:  string(runes[startRune:endRune]),
			After:  string(runes[endRune:afterEnd]),
		})
	}
	return matches, false
}
