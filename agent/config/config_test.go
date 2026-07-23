package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestResolveDefaultsAndAccount(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	if err := os.Mkdir(ws, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "pw1", WorkspaceDir: "ws1"},
		},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.DeepSeek.BaseURL != DefaultDeepSeekBaseURL {
		t.Errorf("base_url default = %q", cfg.DeepSeek.BaseURL)
	}
	if cfg.DeepSeek.Model != DefaultDeepSeekModel {
		t.Errorf("model default = %q", cfg.DeepSeek.Model)
	}
	if cfg.DeepSeek.APIKey != "sk-test" {
		t.Errorf("api key from env = %q", cfg.DeepSeek.APIKey)
	}
	if len(cfg.Accounts) != 1 {
		t.Fatalf("accounts len = %d", len(cfg.Accounts))
	}
	acc := cfg.Accounts[0]
	if acc.WorkspaceDir != ws {
		t.Errorf("workspace_dir = %q, want %q", acc.WorkspaceDir, ws)
	}
	if acc.PollInterval != time.Duration(DefaultPollIntervalSeconds)*time.Second {
		t.Errorf("poll interval = %v", acc.PollInterval)
	}
	if acc.MaxPull != DefaultMaxPull {
		t.Errorf("max pull = %d", acc.MaxPull)
	}
}

func TestResolvePollIntervalClampedToMinimum(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "pw1", WorkspaceDir: "ws1", PollIntervalSeconds: 0},
		},
	}
	f.Accounts[0].PollIntervalSeconds = -5 // 非法配置，也应该被 clamp 到下限而不是直接拒绝
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.Accounts[0].PollInterval != time.Duration(MinPollIntervalSeconds)*time.Second {
		t.Errorf("poll interval not clamped: %v", cfg.Accounts[0].PollInterval)
	}
}

func TestResolveRejectsNoAccounts(t *testing.T) {
	f := &File{Agent: AgentDefaultsFile{Server: "ws://x"}}
	if _, err := Resolve(f, t.TempDir()); err == nil {
		t.Fatal("expected error for empty accounts")
	}
}

func TestResolveRejectsMissingServer(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	f := &File{Accounts: []AccountFile{{Username: "bot1", Password: "pw1", WorkspaceDir: "ws1"}}}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing server")
	}
}

func TestResolveRejectsDuplicateUsername(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "a", WorkspaceDir: "ws1"},
			{Username: "bot1", Password: "b", WorkspaceDir: "ws1"},
		},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for duplicate username")
	}
}

func TestResolveRejectsMissingWorkspaceDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1", Password: "a", WorkspaceDir: "does-not-exist"}},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing workspace_dir")
	}
}

func TestResolvePasswordEnv(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	t.Setenv("BOT1_PW", "secret-pw")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1", PasswordEnv: "BOT1_PW", WorkspaceDir: "ws1"}},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.Accounts[0].Password != "secret-pw" {
		t.Errorf("password = %q", cfg.Accounts[0].Password)
	}
}

func TestResolveRejectsMissingPassword(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1", WorkspaceDir: "ws1"}},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing password")
	}
}

func TestResolveRejectsMissingAPIKey(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	t.Setenv("DEEPSEEK_API_KEY", "")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1", Password: "a", WorkspaceDir: "ws1"}},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing deepseek api key")
	}
}

func TestLoadFromTOMLFile(t *testing.T) {
	dir := t.TempDir()
	ws := filepath.Join(dir, "ws1")
	os.Mkdir(ws, 0o700)
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	cfgPath := filepath.Join(dir, "agent.toml")
	writeFile(t, cfgPath, `
[agent]
server = "ws://127.0.0.1:8080/ws"
max_pull = 5

[[accounts]]
username = "bot1"
password = "pw1"
workspace_dir = "ws1"
`)
	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accounts[0].MaxPull != 5 {
		t.Errorf("max_pull = %d, want 5", cfg.Accounts[0].MaxPull)
	}
}

func TestParseAccountFlag(t *testing.T) {
	af, err := ParseAccountFlag("bot1:secret:/tmp/ws")
	if err != nil {
		t.Fatalf("ParseAccountFlag: %v", err)
	}
	if af.Username != "bot1" || af.Password != "secret" || af.WorkspaceDir != "/tmp/ws" {
		t.Errorf("unexpected parse result: %+v", af)
	}
	if _, err := ParseAccountFlag("bot1:secret"); err == nil {
		t.Fatal("expected error for malformed -account")
	}
}
