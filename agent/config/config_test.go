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

// TestResolveReadsAPIKeyFromFile 校验 deepseek.api_key_file 指向的文件内容会被
// 读取并去除首尾空白（典型的 echo "sk-xxx" > file 会带一个换行符）作为 api_key。
func TestResolveReadsAPIKeyFromFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "")
	keyPath := filepath.Join(dir, "deepseek_api_key")
	writeFile(t, keyPath, "sk-from-file\n")

	f := &File{
		DeepSeek: DeepSeekFile{APIKeyFile: keyPath},
		Agent:    AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{{Username: "bot1", Password: "pw1"}},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.DeepSeek.APIKey != "sk-from-file" {
		t.Errorf("api key from file = %q, want %q", cfg.DeepSeek.APIKey, "sk-from-file")
	}
}

// TestResolveAPIKeyFileRelativeToBaseDir 校验相对路径的 api_key_file 按 baseDir
// 解析，与 data_dir 的相对路径解析方式保持一致。
func TestResolveAPIKeyFileRelativeToBaseDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "")
	writeFile(t, filepath.Join(dir, "deepseek_api_key"), "sk-relative")

	f := &File{
		DeepSeek: DeepSeekFile{APIKeyFile: "deepseek_api_key"},
		Agent:    AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{{Username: "bot1", Password: "pw1"}},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.DeepSeek.APIKey != "sk-relative" {
		t.Errorf("api key from relative file = %q", cfg.DeepSeek.APIKey)
	}
}

// TestResolveRejectsMissingAPIKeyFile 校验 api_key_file 指向的文件不存在时应该
// 直接拒绝启动并给出清楚的错误信息，而不是静默回退到环境变量。
func TestResolveRejectsMissingAPIKeyFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "")
	f := &File{
		DeepSeek: DeepSeekFile{APIKeyFile: filepath.Join(dir, "no-such-file")},
		Agent:    AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{{Username: "bot1", Password: "pw1"}},
	}
	if _, err := Resolve(f, dir); err == nil {
		t.Fatal("expected error for missing api_key_file")
	}
}

// TestResolveAPIKeyPrecedence 校验优先级：明文 api_key > api_key_file > api_key_env。
func TestResolveAPIKeyPrecedence(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEEPSEEK_API_KEY", "sk-from-env")
	keyPath := filepath.Join(dir, "deepseek_api_key")
	writeFile(t, keyPath, "sk-from-file")

	f := &File{
		DeepSeek: DeepSeekFile{APIKey: "sk-inline", APIKeyFile: keyPath},
		Agent:    AgentDefaultsFile{Server: "ws://127.0.0.1:8080/ws"},
		Accounts: []AccountFile{{Username: "bot1", Password: "pw1"}},
	}
	cfg, err := Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.DeepSeek.APIKey != "sk-inline" {
		t.Errorf("api key = %q, want inline api_key to win", cfg.DeepSeek.APIKey)
	}

	f.DeepSeek.APIKey = ""
	cfg, err = Resolve(f, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.DeepSeek.APIKey != "sk-from-file" {
		t.Errorf("api key = %q, want api_key_file to win over api_key_env", cfg.DeepSeek.APIKey)
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
