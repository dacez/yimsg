package engine

import (
	"encoding/json"
	"fmt"

	"yimsg/agent/deepseek"
)

const (
	toolListMarkdown = "list_md_files"
	toolReadMarkdown = "read_md_file"
	toolSubmitPlan   = "submit_plan"
)

func listMarkdownTool() deepseek.Tool {
	return deepseek.NewFunctionTool(toolListMarkdown,
		"列出工作目录（workspace）内某个子目录下的 .md/.markdown 文件，返回相对路径列表；subdir 留空表示列出整个工作目录。",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"subdir": map[string]any{"type": "string", "description": "相对工作目录的子目录路径，留空表示根目录"},
			},
		})
}

func readMarkdownTool() deepseek.Tool {
	return deepseek.NewFunctionTool(toolReadMarkdown,
		"读取工作目录内一个 .md/.markdown 文件的完整内容。",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "相对工作目录的文件路径，例如 notes/todo.md"},
			},
			"required": []string{"path"},
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

type planArgs struct {
	Steps []string `json:"steps"`
}

// FileTool 是引擎依赖的只读文件能力，由 fsread.Sandbox 实现；单独定义接口是
// 为了让单元测试可以注入不落真实磁盘的假实现。
type FileTool interface {
	ListMarkdown(subdir string) ([]string, error)
	ReadMarkdown(relPath string) (string, error)
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
