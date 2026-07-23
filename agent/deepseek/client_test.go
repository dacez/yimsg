package deepseek

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestCreateChatCompletionSuccess(t *testing.T) {
	var gotAuth string
	var gotBody chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ChatResponse{
			Choices: []Choice{{Message: Message{Role: "assistant", Content: "hello"}, FinishReason: "stop"}},
		})
	}))
	defer srv.Close()

	c := New(srv.URL, "sk-test", "deepseek-chat", 0.7, 5*time.Second)
	resp, err := c.CreateChatCompletion(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("CreateChatCompletion: %v", err)
	}
	if resp.Choices[0].Message.Content != "hello" {
		t.Errorf("content = %q", resp.Choices[0].Message.Content)
	}
	if gotAuth != "Bearer sk-test" {
		t.Errorf("Authorization header = %q", gotAuth)
	}
	if gotBody.Model != "deepseek-chat" {
		t.Errorf("model = %q", gotBody.Model)
	}
	if gotBody.ToolChoice != "" {
		t.Errorf("tool_choice should be empty without tools, got %q", gotBody.ToolChoice)
	}
}

func TestCreateChatCompletionSetsToolChoiceWhenToolsPresent(t *testing.T) {
	var gotBody chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(ChatResponse{Choices: []Choice{{Message: Message{Content: "ok"}}}})
	}))
	defer srv.Close()

	c := New(srv.URL, "sk-test", "deepseek-chat", 0.7, 5*time.Second)
	tool := NewFunctionTool("read_md_file", "read a markdown file", map[string]any{"type": "object"})
	_, err := c.CreateChatCompletion(context.Background(), []Message{{Role: "user", Content: "hi"}}, []Tool{tool})
	if err != nil {
		t.Fatalf("CreateChatCompletion: %v", err)
	}
	if gotBody.ToolChoice != "auto" {
		t.Errorf("tool_choice = %q, want auto", gotBody.ToolChoice)
	}
	if len(gotBody.Tools) != 1 || gotBody.Tools[0].Function.Name != "read_md_file" {
		t.Errorf("tools not round-tripped: %+v", gotBody.Tools)
	}
}

func TestCreateChatCompletionRetriesOn500ThenSucceeds(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		json.NewEncoder(w).Encode(ChatResponse{Choices: []Choice{{Message: Message{Content: "recovered"}}}})
	}))
	defer srv.Close()

	c := New(srv.URL, "sk-test", "deepseek-chat", 0.7, 5*time.Second)
	resp, err := c.CreateChatCompletion(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("CreateChatCompletion: %v", err)
	}
	if resp.Choices[0].Message.Content != "recovered" {
		t.Errorf("content = %q", resp.Choices[0].Message.Content)
	}
	if atomic.LoadInt32(&calls) != 2 {
		t.Errorf("calls = %d, want 2", calls)
	}
}

func TestCreateChatCompletionNoRetryOn400(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"message":"bad request"}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "sk-test", "deepseek-chat", 0.7, 5*time.Second)
	_, err := c.CreateChatCompletion(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Errorf("calls = %d, want 1 (no retry on 4xx)", calls)
	}
}

func TestCreateChatCompletionExhaustsRetriesOn500(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, "sk-test", "deepseek-chat", 0.7, 5*time.Second)
	_, err := c.CreateChatCompletion(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	if got := atomic.LoadInt32(&calls); got != maxRetries+1 {
		t.Errorf("calls = %d, want %d", got, maxRetries+1)
	}
}
