package engine

import (
	"encoding/json"
	"fmt"

	"yimsg/agent/deepseek"
	"yimsg/agent/fsread"
)

const (
	toolListMarkdown   = "list_md_files"
	toolReadMarkdown   = "read_md_file"
	toolSearchMarkdown = "search_md_files"
	toolSubmitPlan     = "submit_plan"
)

// defaultSearchContextChars 是模型调用 search_md_files 时不传 context_chars
// （即 args.ContextChars 为 nil）时使用的默认上下文长度；模型显式传 0 则遵从模型
// 的选择，只返回命中文本本身。
const defaultSearchContextChars = 200

func listMarkdownTool() deepseek.Tool {
	return deepseek.NewFunctionTool(toolListMarkdown,
		"列出知识库内某个子目录下的 .md/.markdown 文件，返回相对路径列表；路径以 private/ 开头表示你独享的私有知识库，"+
			"以 shared/ 开头表示全部客服共享的公用知识库。subdir 留空表示同时列出两者（私有排在前面）；"+
			"传 private/xxx 或 shared/xxx 可以只列出其中一棵下的子目录。",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"subdir": map[string]any{"type": "string", "description": "留空表示同时列出私有与公用知识库；否则必须以 private/ 或 shared/ 开头"},
			},
		})
}

func readMarkdownTool() deepseek.Tool {
	return deepseek.NewFunctionTool(toolReadMarkdown,
		"读取知识库内一个 .md/.markdown 文件的完整内容。",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "必须是 list_md_files/search_md_files 返回的完整路径（以 private/ 或 shared/ 开头），例如 private/faq.md 或 shared/product.md"},
			},
			"required": []string{"path"},
		})
}

func searchMarkdownTool() deepseek.Tool {
	return deepseek.NewFunctionTool(toolSearchMarkdown,
		"在知识库内的 .md/.markdown 文件中做类似 grep 的正则搜索（纯文本匹配，不依赖向量库/语义检索），"+
			"返回每处命中前后 context_chars 个字符的原文上下文；适合在通读整份文件之前，先定位包含关键字/正则的位置，"+
			"再按需用 read_md_file 读取完整内容。subdir 留空表示同时搜索你独享的私有知识库（private/）和全部客服"+
			"共享的公用知识库（shared/），私有命中排在前面；也可以传 private/xxx 或 shared/xxx 只搜其中一棵。",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "要搜索的正则表达式或普通关键字"},
				"subdir":  map[string]any{"type": "string", "description": "留空表示同时搜索私有与公用知识库；否则必须以 private/ 或 shared/ 开头"},
				"context_chars": map[string]any{
					"type":        "integer",
					"description": "每处命中前后各返回多少个字符的上下文，由你自己根据需要决定；不传默认 200，最多 2000",
				},
			},
			"required": []string{"pattern"},
		})
}

func submitPlanTool() deepseek.Tool {
	return deepseek.NewFunctionTool(toolSubmitPlan,
		"当这个请求需要多个步骤才能完成（例如需要先查证多份资料、分点推理）时调用本工具提交一个有序步骤计划；能够直接回答的问题不要调用本工具，直接以文本回复即可。",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"steps": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "按执行顺序排列的步骤描述列表",
				},
			},
			"required": []string{"steps"},
		})
}

type listArgs struct {
	Subdir string `json:"subdir"`
}

type readArgs struct {
	Path string `json:"path"`
}

type searchArgs struct {
	Pattern string `json:"pattern"`
	Subdir  string `json:"subdir"`
	// ContextChars 用指针区分"模型没传"（走默认值）和"模型显式传了 0"（只要
	// 命中本身，不要上下文）。
	ContextChars *int `json:"context_chars"`
}

type planArgs struct {
	Steps []string `json:"steps"`
}

// FileTool 是引擎依赖的只读文件能力，由 fsread.Sandbox（单一目录树）或
// fsread.LayeredSandbox（私有 + 共享两棵目录树，见 agent方案.md §2.3）实现；
// 单独定义接口是为了让单元测试可以注入不落真实磁盘的假实现。
type FileTool interface {
	ListMarkdown(subdir string) ([]string, error)
	ReadMarkdown(relPath string) (string, error)
	Search(pattern, subdir string, contextChars int) (matches []fsread.SearchMatch, truncated bool, err error)
}

// executeToolCall 执行一次工具调用，返回喂给模型的文本结果；submit_plan 额外
// 返回解析出的步骤列表与 isPlan=true。
func executeToolCall(fs FileTool, tc deepseek.ToolCall) (result string, steps []string, isPlan bool) {
	switch tc.Function.Name {
	case toolListMarkdown:
		var args listArgs
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			return fmt.Sprintf("参数解析失败: %v", err), nil, false
		}
		files, err := fs.ListMarkdown(args.Subdir)
		if err != nil {
			return fmt.Sprintf("列出文件失败: %v", err), nil, false
		}
		out, _ := json.Marshal(files)
		return string(out), nil, false
	case toolReadMarkdown:
		var args readArgs
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			return fmt.Sprintf("参数解析失败: %v", err), nil, false
		}
		content, err := fs.ReadMarkdown(args.Path)
		if err != nil {
			return fmt.Sprintf("读取文件失败: %v", err), nil, false
		}
		return content, nil, false
	case toolSearchMarkdown:
		var args searchArgs
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			return fmt.Sprintf("参数解析失败: %v", err), nil, false
		}
		contextChars := defaultSearchContextChars
		if args.ContextChars != nil {
			contextChars = *args.ContextChars
		}
		matches, truncated, err := fs.Search(args.Pattern, args.Subdir, contextChars)
		if err != nil {
			return fmt.Sprintf("搜索失败: %v", err), nil, false
		}
		out, _ := json.Marshal(map[string]any{"matches": matches, "truncated": truncated})
		return string(out), nil, false
	case toolSubmitPlan:
		var args planArgs
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			return fmt.Sprintf("参数解析失败: %v", err), nil, false
		}
		return "计划已收到", args.Steps, true
	default:
		return fmt.Sprintf("未知工具: %s", tc.Function.Name), nil, false
	}
}
