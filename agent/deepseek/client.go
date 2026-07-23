package deepseek

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// maxRetries 是网络错误/5xx/429 的最大重试次数（不含首次尝试）。
const maxRetries = 3

// retryBaseDelay 是重试的初始退避时长，之后按 2 的幂指数递增。
const retryBaseDelay = 500 * time.Millisecond

// Client 是 DeepSeek Chat Completions 的最小客户端。
type Client struct {
	httpClient  *http.Client
	baseURL     string
	apiKey      string
	model       string
	temperature float64
}

// New 构造一个 DeepSeek 客户端。baseURL 不带尾部斜杠（如 "https://api.deepseek.com"）。
func New(baseURL, apiKey, model string, temperature float64, timeout time.Duration) *Client {
	return &Client{
		httpClient:  &http.Client{Timeout: timeout},
		baseURL:     baseURL,
		apiKey:      apiKey,
		model:       model,
		temperature: temperature,
	}
}

// CreateChatCompletion 发起一次 Chat Completions 调用；tools 为空时不携带 tools 字段。
// 对连接失败、超时、5xx、429 按指数退避重试，其余 4xx 不重试直接返回错误。
func (c *Client) CreateChatCompletion(ctx context.Context, messages []Message, tools []Tool) (*ChatResponse, error) {
	reqBody := chatRequest{
		Model:       c.model,
		Messages:    messages,
		Tools:       tools,
		Temperature: c.temperature,
	}
	if len(tools) > 0 {
		reqBody.ToolChoice = "auto"
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("编码 DeepSeek 请求失败: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			delay := retryBaseDelay << uint(attempt-1)
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		resp, retryable, err := c.doOnce(ctx, payload)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
	}
	return nil, fmt.Errorf("DeepSeek 调用重试 %d 次后仍失败: %w", maxRetries, lastErr)
}

// doOnce 发起一次 HTTP 请求；返回值的 retryable 表示这次失败是否值得重试。
func (c *Client) doOnce(ctx context.Context, payload []byte) (*ChatResponse, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, false, fmt.Errorf("构造 DeepSeek 请求失败: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("请求 DeepSeek 失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, true, fmt.Errorf("读取 DeepSeek 响应失败: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		retryable := resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests
		var eb apiErrorBody
		msg := string(body)
		if json.Unmarshal(body, &eb) == nil && eb.Error.Message != "" {
			msg = eb.Error.Message
		}
		return nil, retryable, fmt.Errorf("DeepSeek 返回 %d: %s", resp.StatusCode, msg)
	}

	var out ChatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, false, fmt.Errorf("解析 DeepSeek 响应失败: %w", err)
	}
	if len(out.Choices) == 0 {
		return nil, false, fmt.Errorf("DeepSeek 响应不包含 choices")
	}
	return &out, false, nil
}
