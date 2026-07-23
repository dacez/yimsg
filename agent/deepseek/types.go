// Package deepseek 是 DeepSeek 官方 Chat Completions 接口（OpenAI 兼容格式，
// 含 function calling / tools）的最小 Go 客户端，仅实现 agent/engine 用到的
// 子集。方案见 agent/docs/agent方案.md 第 8 节。
package deepseek

// Message 是一条对话消息，对应 OpenAI 兼容 Chat Completions 的 message 结构。
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// ToolCall 是模型请求调用的一次工具调用。
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

// FunctionCall 是 ToolCall 里具体的函数名与参数（JSON 字符串，由调用方自行解析）。
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Tool 描述一个可供模型调用的函数工具。
type Tool struct {
	Type     string       `json:"type"`
	Function FunctionSpec `json:"function"`
}

// FunctionSpec 是工具的 JSON Schema 描述。
type FunctionSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// NewFunctionTool 是构造 Tool 的便捷函数。
func NewFunctionTool(name, description string, parameters map[string]any) Tool {
	return Tool{Type: "function", Function: FunctionSpec{Name: name, Description: description, Parameters: parameters}}
}

// chatRequest 是发往 {base_url}/chat/completions 的请求体。
type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Tools       []Tool    `json:"tools,omitempty"`
	ToolChoice  string    `json:"tool_choice,omitempty"`
	Temperature float64   `json:"temperature,omitempty"`
}

// ChatResponse 是 Chat Completions 的响应体（只解析用得到的字段）。
type ChatResponse struct {
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
}

// Choice 是响应里的一个候选结果，agent 只使用第一个。
type Choice struct {
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason"`
}

// Usage 是本次调用的 token 消耗，供后续预算跟踪使用（v1 只记录不做限制，见方案第 11 节）。
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// apiErrorBody 是 DeepSeek 错误响应体的常见结构，用于把 4xx/5xx 错误信息拼进 Go error。
type apiErrorBody struct {
	Error struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}
