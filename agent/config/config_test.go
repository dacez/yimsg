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
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "pw1"},
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
	if acc.PollInterval != time.Duration(DefaultPollIntervalSeconds)*time.Second {
		t.Errorf("poll interval = %v", acc.PollInterval)
	}
	if acc.MaxPull != DefaultMaxPull {
		t.Errorf("max pull = %d", acc.MaxPull)
	}
}

// TestResolveCreatesSharedResourcesDir 校验多账号共享的只读知识库目录
// <data_dir>/resources 由 Resolve 自动创建，不需要调用方提前准备。
func TestResolveCreatesSharedResourcesDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws", DataDir: "data"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "pw1"},
			{Username: "bot2", Password: "pw2"},
		},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	wantResources := filepath.Join(dir, "data", "resources")
	if cfg.ResourcesDir != wantResources {
		t.Errorf("ResourcesDir = %q, want %q", cfg.ResourcesDir, wantResources)
	}
	info, statErr := os.Stat(cfg.ResourcesDir)
	if statErr != nil {
		t.Fatalf("resources dir not created: %v", statErr)
	}
	if !info.IsDir() {
		t.Errorf("resources path is not a directory")
	}
	// 两个账号共享同一个 resources 目录，不是各自一份。
	if len(cfg.Accounts) != 2 {
		t.Fatalf("accounts len = %d", len(cfg.Accounts))
	}
}

// TestResolveCreatesPerAccountPrivateResourcesDir 校验每个账号独享的私有知识库
// 目录 <data_dir>/<username>/resources 由 Resolve 自动创建，且与共享目录、
// 其它账号的私有目录都是不同的路径（互相隔离，见 agent方案.md §2.3）。
func TestResolveCreatesPerAccountPrivateResourcesDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws", DataDir: "data"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "pw1"},
			{Username: "bot2", Password: "pw2"},
		},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	want1 := filepath.Join(dir, "data", "bot1", "resources")
	want2 := filepath.Join(dir, "data", "bot2", "resources")
	if cfg.Accounts[0].ResourcesDir != want1 {
		t.Errorf("bot1 ResourcesDir = %q, want %q", cfg.Accounts[0].ResourcesDir, want1)
	}
	if cfg.Accounts[1].ResourcesDir != want2 {
		t.Errorf("bot2 ResourcesDir = %q, want %q", cfg.Accounts[1].ResourcesDir, want2)
	}
	if cfg.Accounts[0].ResourcesDir == cfg.ResourcesDir {
		t.Error("账号私有目录不应该和共享目录相同")
	}

	for _, p := range []string{want1, want2} {
		info, statErr := os.Stat(p)
		if statErr != nil {
			t.Fatalf("私有 resources 目录未创建: %v", statErr)
		}
		if !info.IsDir() {
			t.Errorf("%s 不是目录", p)
		}
	}
}

func TestResolvePollIntervalClampedToMinimum(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "pw1", PollIntervalSeconds: -5}, // 非法配置，也应该被 clamp 到下限而不是直接拒绝
		},
	}
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
	f := &File{Accounts: []AccountFile{{Username: "bot1", Password: "pw1"}}}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing server")
	}
}

func TestResolveRejectsDuplicateUsername(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	f := &File{
		Agent: AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{
			{Username: "bot1", Password: "a"},
			{Username: "bot1", Password: "b"},
		},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for duplicate username")
	}
}

func TestResolvePasswordEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	t.Setenv("BOT1_PW", "secret-pw")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1", PasswordEnv: "BOT1_PW"}},
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
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1"}},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing password")
	}
}

func TestResolveRejectsMissingAPIKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "")
	f := &File{
		Agent:    AgentDefaultsFile{Server: "ws://x"},
		Accounts: []AccountFile{{Username: "bot1", Password: "a"}},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing deepseek api key")
	}
}

func TestLoadFromTOMLFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-test")

	cfgPath := filepath.Join(dir, "agent.toml")
	writeFile(t, cfgPath, `
[agent]
server = "ws://127.0.0.1:8080/ws"
max_pull = 5

[[accounts]]
username = "bot1"
password = "pw1"
`)
	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Accounts[0].MaxPull != 5 {
		t.Errorf("max_pull = %d, want 5", cfg.Accounts[0].MaxPull)
	}
	if cfg.ResourcesDir != filepath.Join(dir, DefaultDataDir[2:], ResourcesDirName) {
		t.Errorf("ResourcesDir = %q", cfg.ResourcesDir)
	}
}

func TestParseAccountFlag(t *testing.T) {
	af, err := ParseAccountFlag("bot1:secret")
	if err != nil {
		t.Fatalf("ParseAccountFlag: %v", err)
	}
	if af.Username != "bot1" || af.Password != "secret" {
		t.Errorf("unexpected parse result: %+v", af)
	}
	if _, err := ParseAccountFlag("bot1"); err == nil {
		t.Fatal("expected error for malformed -account")
	}
}
