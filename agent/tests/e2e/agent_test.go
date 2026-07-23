package e2e

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestAgentAutoRepliesToDirectMessage 覆盖完整链路：两个真实账号互为好友，其中
// 一个由 yimsg-agent 接管；alice 发一条消息，agent 轮询拉到消息、调用（模拟）
// DeepSeek、把回复通过真实 WebSocket 发回去，并且把处理进度游标与记忆按预期
// 落盘到 agent_state.json（agent方案.md 第 3、4、5 节）。
func TestAgentAutoRepliesToDirectMessage(t *testing.T) {
	uidAlice, uidBot, userAlice, userBot, passAlice, passBot := setupFriendPair(t)

	dataDir := t.TempDir()
	deepseekURL := startFakeDeepSeek(t)

	args := []string{
		"-server", wsURL,
		"-username", userBot,
		"-password", passBot,
		"-data-dir", dataDir,
		"-deepseek-base-url", deepseekURL,
		"-deepseek-api-key", "sk-e2e-test",
		"-poll-interval", "1",
		"-max-pull", "30",
	}
	if serverTLS {
		args = append(args, "-insecure")
	}
	runAgent(t, args...)

	alice := dialRaw(t)
	alice.login(userAlice, passAlice)
	alice.sendTextTo(uidBot, "你好机器人")

	if !alice.waitForTextFrom(uidBot, fakeDirectAnswerText, 30*time.Second) {
		t.Fatal("超时未收到 agent 的自动回复")
	}

	// 账号目录以用户名命名（与 cli/account 共用的布局，见 agent方案.md 第 3 节），不是 uid。
	statePath := filepath.Join(dataDir, userBot, "agent_state.json")
	st, ok := waitForAgentState(t, statePath, 10*time.Second)
	if !ok {
		t.Fatalf("超时未看到 agent_state.json 落盘: %s", statePath)
	}
	if st.ProcessedSeq <= 0 {
		t.Errorf("processed_seq = %d, want > 0", st.ProcessedSeq)
	}
	peerKey := "u:" + strconv.FormatInt(uidAlice, 10)
	peer, ok := st.Memory.Peers[peerKey]
	if !ok {
		t.Fatalf("agent_state.json 缺少 peer %s 的记忆，实际 peers=%v", peerKey, st.Memory.Peers)
	}
	if peer.Summary != fakeMemorySummary {
		t.Errorf("peer summary = %q, want %q", peer.Summary, fakeMemorySummary)
	}
	if peer.Turns != 1 {
		t.Errorf("peer turns = %d, want 1", peer.Turns)
	}

	// 全部账号共享的只读知识库目录应该由 agent 启动时自动创建，不需要用户提前准备。
	resourcesInfo, err := os.Stat(filepath.Join(dataDir, "resources"))
	if err != nil {
		t.Fatalf("共享 resources 目录未自动创建: %v", err)
	}
	if !resourcesInfo.IsDir() {
		t.Errorf("resources 不是目录")
	}
}

// TestAgentRejectsInvalidFlagsWithoutAccount 校验没有任何账号来源（既无 -config
// 也无 -username/-account）时进程直接以非 0 退出并给出清楚的错误信息，而不是
// 静默启动一个什么都不做的进程。
func TestAgentRejectsInvalidFlagsWithoutAccount(t *testing.T) {
	cmd := exec.Command(agentBinary)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit, got success, output=%s", out)
	}
	if !strings.Contains(string(out), "必须指定 -config") {
		t.Errorf("output = %q, want it to mention 必须指定 -config", out)
	}
}

type agentStateFile struct {
	ProcessedSeq int64 `json:"processed_seq"`
	Memory       struct {
		Peers map[string]struct {
			Summary string `json:"summary"`
			Turns   int    `json:"turns"`
		} `json:"peers"`
	} `json:"memory"`
}

func waitForAgentState(t *testing.T, path string, timeout time.Duration) (agentStateFile, bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			var st agentStateFile
			if json.Unmarshal(data, &st) == nil && st.ProcessedSeq > 0 {
				return st, true
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return agentStateFile{}, false
}
