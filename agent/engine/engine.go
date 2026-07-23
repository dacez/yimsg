// Package engine 实现 yimsg-agent 的计划与多步执行引擎：先决策"直接回答"还是
// "分步执行"，分步执行时逐步调用模型、按需读取工作目录内的 Markdown 文件、每步
// 完成后通过 Notifier 发一条纯文本进度通知，最后生成汇总回复；处理完一轮后再
// 用 Reflect 生成新的记忆摘要。方案见 agent/docs/agent方案.md 第 6 节。
package engine

import (
	"context"
	"fmt"
	"strings"

	"yimsg/agent/deepseek"
)

// decisionGuidance 追加在调用方传入的角色设定之后，指导模型选择直接回答还是提交计划。
const decisionGuidance = `你可以直接用文本回答；如果这个问题需要多个步骤才能完成（例如需要先查证多份资料、
分点推理、逐项核实），才调用 submit_plan 提交一个有序步骤列表，不要不必要地拆分步骤。
需要查阅工作目录内的资料时可以调用 list_md_files / read_md_file，文件较多或较长时先用 search_md_files
定位包含关键字的位置再精读，工作目录之外没有任何可用信息。`

// summaryInstruction 是步骤全部执行完之后，要求模型给出最终回复的提示。
const summaryInstruction = "以上所有步骤都已完成。请基于每一步的结论，给用户一个完整、简洁的最终回复（不需要逐条复述每一步过程，只需要给出结论性的回答）。"

// ChatCompleter 是引擎依赖的模型调用能力，*deepseek.Client 满足该接口；单独
// 定义接口是为了让单元测试可以注入脚本化的假实现，不需要真实网络调用。
type ChatCompleter interface {
	CreateChatCompletion(ctx context.Context, messages []deepseek.Message, tools []deepseek.Tool) (*deepseek.ChatResponse, error)
}

// Notifier 在每个步骤执行完后被调用一次，用于把进度文本发成一条聊天消息。
type Notifier func(text string) error

// Request 是一次引擎调用的输入。
type Request struct {
	SystemPrompt  string // 角色设定，例如"你是 xxx 的客服助手"
	MemorySummary string // 该对端现有的记忆摘要，可为空
	UserText      string // 本轮用户消息内容
}

// Result 是一次引擎调用的输出。
type Result struct {
	FinalAnswer    string // 最终要发给用户的回复
	Direct         bool   // true 表示走的是"直接回答"分支，没有分步、没有进度通知
	StepsExecuted  int    // 分步执行时实际执行的步骤数
	StepsTruncated bool   // 计划步骤数超过 MaxPlanSteps 被截断
}

// Engine 是计划/执行引擎。
type Engine struct {
	ai                  ChatCompleter
	fs                  FileTool
	maxPlanSteps        int
	maxToolCallsPerStep int
}

// New 构造一个 Engine。maxPlanSteps/maxToolCallsPerStep 对应
// agent方案.md §6.5 的成本上限，必须为正数。
func New(ai ChatCompleter, fs FileTool, maxPlanSteps, maxToolCallsPerStep int) *Engine {
	if maxPlanSteps <= 0 {
		maxPlanSteps = 1
	}
	if maxToolCallsPerStep <= 0 {
		maxToolCallsPerStep = 1
	}
	return &Engine{ai: ai, fs: fs, maxPlanSteps: maxPlanSteps, maxToolCallsPerStep: maxToolCallsPerStep}
}

// Run 执行一次完整的决策 + （可选）分步执行流程。notify 为 nil 时跳过进度通知
// （仅用于测试直接回答分支等不关心通知的场景，pipeline 正常使用时必须传入）。
func (e *Engine) Run(ctx context.Context, req Request, notify Notifier) (*Result, error) {
	transcript := []deepseek.Message{
		{Role: "system", Content: strings.TrimSpace(req.SystemPrompt + "\n\n" + decisionGuidance)},
		{Role: "user", Content: buildUserMessage(req.MemorySummary, req.UserText)},
	}

	decisionTools := []deepseek.Tool{listMarkdownTool(), readMarkdownTool(), searchMarkdownTool(), submitPlanTool()}
	finalText, steps, transcript, err := e.toolLoop(ctx, transcript, decisionTools)
	if err != nil {
		return nil, fmt.Errorf("决策阶段失败: %w", err)
	}
	if steps == nil {
		return &Result{FinalAnswer: finalText, Direct: true}, nil
	}

	truncated := false
	if len(steps) > e.maxPlanSteps {
		steps = steps[:e.maxPlanSteps]
		truncated = true
	}

	stepTools := []deepseek.Tool{listMarkdownTool(), readMarkdownTool(), searchMarkdownTool()}
	for i, step := range steps {
		prompt := fmt.Sprintf(
			"当前执行第 %d/%d 步：%s\n\n请只完成这一步，不要提前做后面的步骤。完成后用纯文本给出这一步的结论，"+
				"这段文本会直接作为进度通知发给用户，请保持简洁清楚。", i+1, len(steps), step)
		transcript = append(transcript, deepseek.Message{Role: "user", Content: prompt})

		stepText, _, updated, err := e.toolLoop(ctx, transcript, stepTools)
		if err != nil {
			return nil, fmt.Errorf("执行第 %d 步失败: %w", i+1, err)
		}
		transcript = append(updated, deepseek.Message{Role: "assistant", Content: stepText})

		if notify != nil {
			if err := notify(stepText); err != nil {
				return nil, fmt.Errorf("发送第 %d 步进度通知失败: %w", i+1, err)
			}
		}
	}

	transcript = append(transcript, deepseek.Message{Role: "user", Content: summaryInstruction})
	resp, err := e.ai.CreateChatCompletion(ctx, transcript, nil)
	if err != nil {
		return nil, fmt.Errorf("汇总阶段失败: %w", err)
	}

	return &Result{
		FinalAnswer:    resp.Choices[0].Message.Content,
		Direct:         false,
		StepsExecuted:  len(steps),
		StepsTruncated: truncated,
	}, nil
}

// toolLoop 反复调用模型，处理它请求的 list_md_files/read_md_file 工具调用，
// 直到模型返回纯文本结论，或者（tools 里包含 submit_plan 时）模型提交计划。
// 超过 maxToolCallsPerStep 轮工具调用后，最后一轮强制不提供 tools，逼模型
// 基于已有信息给出结论。返回值 transcript 是追加了本轮所有消息之后的完整对话。
func (e *Engine) toolLoop(ctx context.Context, transcript []deepseek.Message, tools []deepseek.Tool) (finalText string, planSteps []string, updated []deepseek.Message, err error) {
	for round := 0; round <= e.maxToolCallsPerStep; round++ {
		roundTools := tools
		if round == e.maxToolCallsPerStep {
			roundTools = nil
		}

		resp, callErr := e.ai.CreateChatCompletion(ctx, transcript, roundTools)
		if callErr != nil {
			return "", nil, transcript, callErr
		}
		msg := resp.Choices[0].Message
		if len(msg.ToolCalls) == 0 {
			return msg.Content, nil, transcript, nil
		}

		transcript = append(transcript, msg)
		var gotSteps []string
		for _, tc := range msg.ToolCalls {
			resultText, steps, isPlan := executeToolCall(e.fs, tc)
			transcript = append(transcript, deepseek.Message{Role: "tool", ToolCallID: tc.ID, Content: resultText})
			if isPlan {
				gotSteps = steps
			}
		}
		if gotSteps != nil {
			return "", gotSteps, transcript, nil
		}
	}
	return "", nil, transcript, fmt.Errorf("超过最大工具调用轮次仍未得到结论")
}

// Reflect 基于旧摘要和本轮对话生成新的记忆摘要，供 pipeline 在处理完一个 peer
// 分组后回写记忆（agent方案.md §5.2）。
func (e *Engine) Reflect(ctx context.Context, oldSummary, userText, finalAnswer string, maxChars int) (string, error) {
	prompt := fmt.Sprintf(`请把下面的"旧记忆摘要"与"本轮对话"合并压缩成一段不超过 %d 字符的新摘要，只保留后续对话
可能用得上的关键信息（例如对方的诉求、已经达成的结论、尚未解决的问题），不要输出除摘要本身以外的任何内容。

旧记忆摘要：
%s

本轮用户消息：
%s

本轮最终回复：
%s`, maxChars, orNone(oldSummary), userText, finalAnswer)

	resp, err := e.ai.CreateChatCompletion(ctx, []deepseek.Message{
		{Role: "system", Content: "你是一个负责压缩对话记忆的助手，只输出摘要文本本身，不要有任何额外说明。"},
		{Role: "user", Content: prompt},
	}, nil)
	if err != nil {
		return "", fmt.Errorf("生成记忆摘要失败: %w", err)
	}
	summary := strings.TrimSpace(resp.Choices[0].Message.Content)
	if maxChars > 0 && len(summary) > maxChars {
		summary = summary[:maxChars]
	}
	return summary, nil
}

func buildUserMessage(memorySummary, userText string) string {
	var b strings.Builder
	if memorySummary != "" {
		b.WriteString("以下是你和对方过去对话的记忆摘要：\n")
		b.WriteString(memorySummary)
		b.WriteString("\n\n")
	}
	b.WriteString("对方现在发来的消息：\n")
	b.WriteString(userText)
	return b.String()
}

func orNone(s string) string {
	if s == "" {
		return "(无)"
	}
	return s
}
