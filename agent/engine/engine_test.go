package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"yimsg/agent/deepseek"
	"yimsg/agent/fsread"
)

// scriptedCompleter 按预先注入的顺序回放响应，供测试断言引擎在每一轮实际发出的
// messages/tools，不依赖真实网络。
type scriptedCompleter struct {
	t         *testing.T
	responses []deepseek.ChatResponse
	calls     []capturedCall
	idx       int
}

type capturedCall struct {
	messages []deepseek.Message
	tools    []deepseek.Tool
}

func (s *scriptedCompleter) CreateChatCompletion(ctx context.Context, messages []deepseek.Message, tools []deepseek.Tool) (*deepseek.ChatResponse, error) {
	s.calls = append(s.calls, capturedCall{messages: messages, tools: tools})
	if s.idx >= len(s.responses) {
		s.t.Fatalf("未预期的第 %d 次 CreateChatCompletion 调用", s.idx+1)
	}
	resp := s.responses[s.idx]
	s.idx++
	return &resp, nil
}

func assistantText(content string) deepseek.ChatResponse {
	return deepseek.ChatResponse{Choices: []deepseek.Choice{{Message: deepseek.Message{Role: "assistant", Content: content}}}}
}

func assistantToolCall(id, name string, args any) deepseek.ChatResponse {
	raw, _ := json.Marshal(args)
	return deepseek.ChatResponse{Choices: []deepseek.Choice{{Message: deepseek.Message{
		Role: "assistant",
		ToolCalls: []deepseek.ToolCall{{
			ID:       id,
			Type:     "function",
			Function: deepseek.FunctionCall{Name: name, Arguments: string(raw)},
		}},
	}}}}
}

type fakeFS struct {
	readResult   map[string]string
	readCalls    []string
	searchResult []fsread.SearchMatch
	searchTrunc  bool
	searchCalls  []fakeSearchCall
}

type fakeSearchCall struct {
	pattern      string
	subdir       string
	contextChars int
}

func (f *fakeFS) ListMarkdown(subdir string) ([]string, error) {
	return []string{"a.md", "b.md"}, nil
}

func (f *fakeFS) ReadMarkdown(relPath string) (string, error) {
	f.readCalls = append(f.readCalls, relPath)
	if v, ok := f.readResult[relPath]; ok {
		return v, nil
	}
	return "", fmt.Errorf("not found: %s", relPath)
}

func (f *fakeFS) Search(pattern, subdir string, contextChars int) ([]fsread.SearchMatch, bool, error) {
	f.searchCalls = append(f.searchCalls, fakeSearchCall{pattern: pattern, subdir: subdir, contextChars: contextChars})
	return f.searchResult, f.searchTrunc, nil
}

func TestRunDirectAnswer(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantText("直接的回答"),
	}}
	e := New(sc, &fakeFS{}, 6, 4)

	var notified []string
	result, err := e.Run(context.Background(), Request{SystemPrompt: "你是助手", UserText: "你好"}, func(text string) error {
		notified = append(notified, text)
		return nil
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Direct {
		t.Errorf("expected Direct=true")
	}
	if result.FinalAnswer != "直接的回答" {
		t.Errorf("FinalAnswer = %q", result.FinalAnswer)
	}
	if len(notified) != 0 {
		t.Errorf("expected no progress notifications for direct answer, got %v", notified)
	}
	if len(sc.calls) != 1 {
		t.Errorf("expected exactly 1 model call, got %d", len(sc.calls))
	}
}

func TestRunPlanExecutesStepsInOrderAndNotifies(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantToolCall("call_1", toolSubmitPlan, planArgs{Steps: []string{"第一步", "第二步"}}),
		assistantText("第一步结论"),
		assistantText("第二步结论"),
		assistantText("最终汇总回复"),
	}}
	e := New(sc, &fakeFS{}, 6, 4)

	var notified []string
	result, err := e.Run(context.Background(), Request{SystemPrompt: "你是助手", UserText: "帮我查一下"}, func(text string) error {
		notified = append(notified, text)
		return nil
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Direct {
		t.Errorf("expected Direct=false")
	}
	if result.StepsExecuted != 2 {
		t.Errorf("StepsExecuted = %d, want 2", result.StepsExecuted)
	}
	if result.FinalAnswer != "最终汇总回复" {
		t.Errorf("FinalAnswer = %q", result.FinalAnswer)
	}
	wantNotified := []string{"第一步结论", "第二步结论"}
	if len(notified) != len(wantNotified) {
		t.Fatalf("notified = %v, want %v", notified, wantNotified)
	}
	for i := range wantNotified {
		if notified[i] != wantNotified[i] {
			t.Errorf("notified[%d] = %q, want %q", i, notified[i], wantNotified[i])
		}
	}
}

func TestRunStepCanCallReadMarkdownTool(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantToolCall("call_1", toolSubmitPlan, planArgs{Steps: []string{"查一下 notes.md"}}),
		assistantToolCall("call_2", toolReadMarkdown, readArgs{Path: "notes.md"}),
		assistantText("notes.md 里写着：休息一下"),
		assistantText("最终回复"),
	}}
	fs := &fakeFS{readResult: map[string]string{"notes.md": "休息一下"}}
	e := New(sc, fs, 6, 4)

	var notified []string
	_, err := e.Run(context.Background(), Request{SystemPrompt: "你是助手", UserText: "查一下笔记"}, func(text string) error {
		notified = append(notified, text)
		return nil
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(fs.readCalls) != 1 || fs.readCalls[0] != "notes.md" {
		t.Errorf("readCalls = %v", fs.readCalls)
	}
	if len(notified) != 1 || notified[0] != "notes.md 里写着：休息一下" {
		t.Errorf("notified = %v", notified)
	}
}

func TestRunStepCanCallSearchMarkdownToolWithModelChosenContext(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantToolCall("call_1", toolSubmitPlan, planArgs{Steps: []string{"搜索关键字"}}),
		assistantToolCall("call_2", toolSearchMarkdown, searchArgs{Pattern: "TODO", ContextChars: intPtr(50)}),
		assistantText("找到了相关的 TODO"),
		assistantText("最终回复"),
	}}
	fs := &fakeFS{searchResult: []fsread.SearchMatch{{Path: "a.md", Before: "before", Match: "TODO", After: "after"}}}
	e := New(sc, fs, 6, 4)

	_, err := e.Run(context.Background(), Request{SystemPrompt: "你是助手", UserText: "帮我找找 TODO"}, func(text string) error { return nil })
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(fs.searchCalls) != 1 {
		t.Fatalf("searchCalls = %v", fs.searchCalls)
	}
	got := fs.searchCalls[0]
	if got.pattern != "TODO" || got.contextChars != 50 {
		t.Errorf("search call = %+v, want pattern=TODO contextChars=50", got)
	}
}

func TestRunSearchDefaultsContextCharsWhenOmitted(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantToolCall("call_1", toolSearchMarkdown, searchArgs{Pattern: "TODO"}),
		assistantText("直接回答"),
	}}
	fs := &fakeFS{}
	e := New(sc, fs, 6, 4)

	if _, err := e.Run(context.Background(), Request{SystemPrompt: "sys", UserText: "u"}, nil); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(fs.searchCalls) != 1 || fs.searchCalls[0].contextChars != defaultSearchContextChars {
		t.Errorf("searchCalls = %v, want contextChars=%d", fs.searchCalls, defaultSearchContextChars)
	}
}

func intPtr(v int) *int { return &v }

func TestRunTruncatesPlanExceedingMaxSteps(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantToolCall("call_1", toolSubmitPlan, planArgs{Steps: []string{"步骤1", "步骤2", "步骤3"}}),
		assistantText("步骤1结论"),
		assistantText("最终回复"),
	}}
	e := New(sc, &fakeFS{}, 1, 4) // maxPlanSteps=1

	var notified []string
	result, err := e.Run(context.Background(), Request{SystemPrompt: "sys", UserText: "u"}, func(text string) error {
		notified = append(notified, text)
		return nil
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.StepsTruncated {
		t.Errorf("expected StepsTruncated=true")
	}
	if result.StepsExecuted != 1 {
		t.Errorf("StepsExecuted = %d, want 1", result.StepsExecuted)
	}
	if len(notified) != 1 {
		t.Errorf("notified = %v, want 1 entry", notified)
	}
}

func TestRunForcesConclusionAfterMaxToolCalls(t *testing.T) {
	// 决策阶段模型反复请求 list_md_files，永不主动给出结论；超过
	// maxToolCallsPerStep 轮后引擎必须在最后一轮不提供 tools，逼出结论。
	responses := []deepseek.ChatResponse{
		assistantToolCall("c1", toolListMarkdown, listArgs{}),
		assistantToolCall("c2", toolListMarkdown, listArgs{}),
	}
	sc := &scriptedCompleter{t: t, responses: responses}
	// 最后一轮（round == maxToolCallsPerStep）用一个会校验 tools==nil 的响应。
	sc.responses = append(sc.responses, assistantText("基于已有信息的结论"))

	e := New(sc, &fakeFS{}, 6, 2) // maxToolCallsPerStep=2：round 0,1 带 tools，round 2 强制无 tools

	result, err := e.Run(context.Background(), Request{SystemPrompt: "sys", UserText: "u"}, nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Direct || result.FinalAnswer != "基于已有信息的结论" {
		t.Errorf("result = %+v", result)
	}
	lastCall := sc.calls[len(sc.calls)-1]
	if lastCall.tools != nil {
		t.Errorf("expected last forced round to have nil tools, got %v", lastCall.tools)
	}
}

func TestReflectProducesTruncatedSummary(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantText("这是一个很长的摘要内容用于测试截断行为"),
	}}
	e := New(sc, &fakeFS{}, 6, 4)

	summary, err := e.Reflect(context.Background(), "旧摘要", "用户消息", "最终回复", 10)
	if err != nil {
		t.Fatalf("Reflect: %v", err)
	}
	if len([]rune(summary)) > 10 {
		// 按字节截断，中文场景下长度校验用字节数即可，这里只确认确实被截断了。
	}
	if len(summary) > 10 {
		t.Errorf("summary len = %d, want <= 10", len(summary))
	}
}

func TestReflectNoTruncationWhenWithinLimit(t *testing.T) {
	sc := &scriptedCompleter{t: t, responses: []deepseek.ChatResponse{
		assistantText("短摘要"),
	}}
	e := New(sc, &fakeFS{}, 6, 4)

	summary, err := e.Reflect(context.Background(), "", "u", "a", 4000)
	if err != nil {
		t.Fatalf("Reflect: %v", err)
	}
	if summary != "短摘要" {
		t.Errorf("summary = %q", summary)
	}
}
