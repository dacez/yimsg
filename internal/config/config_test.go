package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad_UsesDefaults_WhenAllFieldsCommented(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
# 默认配置模板中所有配置项都可以保持注释状态。
[server]
# host = "127.0.0.1"
# port = 38081
# machine_id = 1
# tls_cert = ""
# tls_key = ""

[database]
# data_dir = "./data"
# shard_count = 4

[session]
# ttl_seconds = 2592000
# token_bytes = 32

[message]
# recall_window_seconds = 120

[gc]
# message_max_count = 100000
# conversation_max_count = 10000
# session_cleanup_interval_secs = 3600
# contact_gc_interval_secs = 3600
# blocklist_gc_interval_secs = 3600
# mutelist_gc_interval_secs = 3600
# message_gc_interval_secs = 3600
# conversation_gc_interval_secs = 3600
# user_gc_interval_secs = 3600

[frontend]
# static_dir = "web"

[media]
# upload_dir = "./data/media"
# max_avatar_bytes = 5242880
# max_image_bytes = 10485760
# max_file_bytes = 104857600

[client]
# cache_ttl_seconds = 604800
# cache_max_entries = 10000
# batch_max_limit = 500
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	assertDefaultConfig(t, cfg)
}

func assertDefaultConfig(t *testing.T, cfg *Config) {
	t.Helper()
	stringChecks := []struct {
		name string
		got  string
		want string
	}{
		{"server.host", cfg.Server.Host, DefaultServerHost},
		{"server.tls_cert", cfg.Server.TLSCert, ""},
		{"server.tls_key", cfg.Server.TLSKey, ""},
		{"database.data_dir", cfg.Database.DataDir, DefaultDatabaseDataDir},
		{"frontend.static_dir", cfg.Frontend.StaticDir, DefaultFrontendStaticDir},
		{"frontend.mount_path", cfg.Frontend.MountPath, DefaultFrontendMountPath},
		{"website.static_dir", cfg.Website.StaticDir, DefaultWebsiteStaticDir},
		{"website.mount_path", cfg.Website.MountPath, DefaultWebsiteMountPath},
		{"media.upload_dir", cfg.Media.UploadDir, DefaultMediaUploadDir},
	}
	for _, tt := range stringChecks {
		if tt.got != tt.want {
			t.Fatalf("expected %s %q, got %q", tt.name, tt.want, tt.got)
		}
	}

	intChecks := []struct {
		name string
		got  int
		want int
	}{
		{"server.port", cfg.Server.Port, DefaultServerPort},
		{"database.shard_count", cfg.Database.ShardCount, DefaultDatabaseShardCount},
		{"session.token_bytes", cfg.Session.TokenBytes, DefaultSessionTokenBytes},
		{"client.cache_max_entries", cfg.Client.CacheMaxEntries, DefaultClientCacheMaxEntries},
	}
	for _, tt := range intChecks {
		if tt.got != tt.want {
			t.Fatalf("expected %s %d, got %d", tt.name, tt.want, tt.got)
		}
	}

	int64Checks := []struct {
		name string
		got  int64
		want int64
	}{
		{"server.machine_id", cfg.Server.MachineID, DefaultServerMachineID},
		{"session.ttl_seconds", cfg.Session.TTLSeconds, DefaultSessionTTLSeconds},
		{"message.recall_window_seconds", cfg.Message.RecallWindowSeconds, DefaultRecallWindowSeconds},
		{"gc.message_max_count", cfg.GC.MessageMaxCount, DefaultGCMessageMaxCount},
		{"gc.conversation_max_count", cfg.GC.ConversationMaxCount, DefaultGCConversationMaxCount},
		{"gc.session_cleanup_interval_secs", cfg.GC.SessionCleanupIntervalSecs, DefaultGCSessionCleanupIntervalSecs},
		{"gc.contact_gc_interval_secs", cfg.GC.ContactGCIntervalSecs, DefaultGCContactIntervalSecs},
		{"gc.blocklist_gc_interval_secs", cfg.GC.BlocklistGCIntervalSecs, DefaultGCBlocklistIntervalSecs},
		{"gc.mutelist_gc_interval_secs", cfg.GC.MutelistGCIntervalSecs, DefaultGCMutelistIntervalSecs},
		{"gc.message_gc_interval_secs", cfg.GC.MessageGCIntervalSecs, DefaultGCMessageIntervalSecs},
		{"gc.conversation_gc_interval_secs", cfg.GC.ConversationGCIntervalSecs, DefaultGCConversationIntervalSecs},
		{"gc.user_gc_interval_secs", cfg.GC.UserGCIntervalSecs, DefaultGCUserIntervalSecs},
		{"media.max_avatar_bytes", cfg.Media.MaxAvatarBytes, DefaultMediaMaxAvatarBytes},
		{"media.max_image_bytes", cfg.Media.MaxImageBytes, DefaultMediaMaxImageBytes},
		{"media.max_file_bytes", cfg.Media.MaxFileBytes, DefaultMediaMaxFileBytes},
		{"client.cache_ttl_seconds", cfg.Client.CacheTTLSeconds, DefaultClientCacheTTLSeconds},
		{"client.batch_max_limit", cfg.Client.BatchMaxLimit, DefaultClientBatchMaxLimit},
	}
	for _, tt := range int64Checks {
		if tt.got != tt.want {
			t.Fatalf("expected %s %d, got %d", tt.name, tt.want, tt.got)
		}
	}
}

func TestLoad_PreservesExplicitEmptyStaticDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[frontend]
static_dir = ""
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Frontend.StaticDir != "" {
		t.Fatalf("expected explicit empty static_dir preserved, got %q", cfg.Frontend.StaticDir)
	}
}

func TestLoad_WebsiteMountPathFallback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	// 只配 static_dir、漏配 mount_path 时应回落到默认子路径。
	if err := os.WriteFile(path, []byte(`
[website]
static_dir = "site-dist"
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Website.StaticDir != "site-dist" {
		t.Fatalf("expected website static_dir %q, got %q", "site-dist", cfg.Website.StaticDir)
	}
	if cfg.Website.MountPath != DefaultWebsiteMountPath {
		t.Fatalf("expected website mount_path fallback %q, got %q", DefaultWebsiteMountPath, cfg.Website.MountPath)
	}
}

func TestLoad_WebsiteDisabledWhenStaticDirEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	// static_dir 显式留空表示不挂载官网，mount_path 不应被回落填充。
	if err := os.WriteFile(path, []byte(`
[website]
static_dir = ""
mount_path = ""
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Website.StaticDir != "" {
		t.Fatalf("expected empty website static_dir preserved, got %q", cfg.Website.StaticDir)
	}
	if cfg.Website.MountPath != "" {
		t.Fatalf("expected empty website mount_path preserved, got %q", cfg.Website.MountPath)
	}
}

func TestLoad_FrontendMountPathFallback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	// 只配 static_dir、漏配 mount_path 时应回落到默认子路径。
	if err := os.WriteFile(path, []byte(`
[frontend]
static_dir = "app-dist"
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Frontend.StaticDir != "app-dist" {
		t.Fatalf("expected frontend static_dir %q, got %q", "app-dist", cfg.Frontend.StaticDir)
	}
	if cfg.Frontend.MountPath != DefaultFrontendMountPath {
		t.Fatalf("expected frontend mount_path fallback %q, got %q", DefaultFrontendMountPath, cfg.Frontend.MountPath)
	}
}

func TestLoad_FrontendDisabledWhenStaticDirEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	// static_dir 显式留空表示不挂载聊天 App，mount_path 不应被回落填充。
	if err := os.WriteFile(path, []byte(`
[frontend]
static_dir = ""
mount_path = ""
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Frontend.StaticDir != "" {
		t.Fatalf("expected empty frontend static_dir preserved, got %q", cfg.Frontend.StaticDir)
	}
	if cfg.Frontend.MountPath != "" {
		t.Fatalf("expected empty frontend mount_path preserved, got %q", cfg.Frontend.MountPath)
	}
}

func TestLoad_PartialConfigOverridesOnlyExplicitFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
port = 39000

[database]
# data_dir = "./data"
shard_count = 8

[client]
cache_max_entries = 42
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.Port != 39000 {
		t.Fatalf("expected explicit port 39000, got %d", cfg.Server.Port)
	}
	if cfg.Database.ShardCount != 8 {
		t.Fatalf("expected explicit shard_count 8, got %d", cfg.Database.ShardCount)
	}
	if cfg.Client.CacheMaxEntries != 42 {
		t.Fatalf("expected explicit cache_max_entries 42, got %d", cfg.Client.CacheMaxEntries)
	}
	if cfg.Server.Host != DefaultServerHost {
		t.Fatalf("expected default host %q, got %q", DefaultServerHost, cfg.Server.Host)
	}
	if cfg.Database.DataDir != DefaultDatabaseDataDir {
		t.Fatalf("expected default data_dir %q, got %q", DefaultDatabaseDataDir, cfg.Database.DataDir)
	}
	if cfg.Client.CacheTTLSeconds != DefaultClientCacheTTLSeconds {
		t.Fatalf("expected default cache_ttl_seconds %d, got %d", DefaultClientCacheTTLSeconds, cfg.Client.CacheTTLSeconds)
	}
}

// 当 config.toml 完全未设置 [message].recall_window_seconds 时，应自动填充为
// DefaultRecallWindowSeconds，以避免前端 canRecallMessage 因 <=0 直接隐藏
// 「撤回」入口。
func TestLoad_DefaultRecallWindowSeconds_WhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
host = "127.0.0.1"
port = 8080
machine_id = 1

[database]
data_dir = "/tmp"
shard_count = 1

[session]
ttl_seconds = 86400
token_bytes = 16
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Message.RecallWindowSeconds != DefaultRecallWindowSeconds {
		t.Fatalf("expected default %d, got %d", DefaultRecallWindowSeconds, cfg.Message.RecallWindowSeconds)
	}
}

// 显式设置的正整数应原样保留。
func TestLoad_PreservesExplicitRecallWindow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
host = "127.0.0.1"
port = 8080
machine_id = 1

[database]
data_dir = "/tmp"
shard_count = 1

[session]
ttl_seconds = 86400
token_bytes = 16

[message]
recall_window_seconds = 30
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Message.RecallWindowSeconds != 30 {
		t.Fatalf("expected 30, got %d", cfg.Message.RecallWindowSeconds)
	}
}

// 负数语义为「显式禁用撤回」，不应被覆盖；服务端 RecallMessage 与前端
// canRecallMessage 都会因 <=0 拒绝/隐藏撤回。
func TestLoad_PreservesNegativeRecallWindowAsDisabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
host = "127.0.0.1"
port = 8080
machine_id = 1

[database]
data_dir = "/tmp"
shard_count = 1

[session]
ttl_seconds = 86400
token_bytes = 16

[message]
recall_window_seconds = -1
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Message.RecallWindowSeconds != -1 {
		t.Fatalf("expected -1 preserved, got %d", cfg.Message.RecallWindowSeconds)
	}
}

// 当 config.toml 完全未设置 [client] 段时，cache_ttl_seconds 与
// cache_max_entries 都应填充为默认值，保证 login / authenticate 返回的
// `client_config` 每个字段都有合理取值。
func TestLoad_DefaultClientConfig_WhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
host = "127.0.0.1"
port = 8080
machine_id = 1

[database]
data_dir = "/tmp"
shard_count = 1

[session]
ttl_seconds = 86400
token_bytes = 16
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Client.CacheTTLSeconds != DefaultClientCacheTTLSeconds {
		t.Fatalf("expected default cache_ttl_seconds %d, got %d", DefaultClientCacheTTLSeconds, cfg.Client.CacheTTLSeconds)
	}
	if cfg.Client.CacheMaxEntries != DefaultClientCacheMaxEntries {
		t.Fatalf("expected default cache_max_entries %d, got %d", DefaultClientCacheMaxEntries, cfg.Client.CacheMaxEntries)
	}
	if cfg.Client.BatchMaxLimit != DefaultClientBatchMaxLimit {
		t.Fatalf("expected default batch_max_limit %d, got %d", DefaultClientBatchMaxLimit, cfg.Client.BatchMaxLimit)
	}
}

// 显式设置的 [client] 字段应原样保留，不被默认值覆盖。
func TestLoad_PreservesExplicitClientConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
host = "127.0.0.1"
port = 8080
machine_id = 1

[database]
data_dir = "/tmp"
shard_count = 1

[session]
ttl_seconds = 86400
token_bytes = 16

[client]
cache_ttl_seconds = 60
cache_max_entries = 42
batch_max_limit = 128
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Client.CacheTTLSeconds != 60 {
		t.Fatalf("expected cache_ttl_seconds 60, got %d", cfg.Client.CacheTTLSeconds)
	}
	if cfg.Client.CacheMaxEntries != 42 {
		t.Fatalf("expected cache_max_entries 42, got %d", cfg.Client.CacheMaxEntries)
	}
	if cfg.Client.BatchMaxLimit != 128 {
		t.Fatalf("expected batch_max_limit 128, got %d", cfg.Client.BatchMaxLimit)
	}
}

func TestLoad_ClampsClientBatchMaxLimitToHardLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(`
[server]
host = "127.0.0.1"
port = 8080
machine_id = 1

[database]
data_dir = "/tmp"
shard_count = 1

[session]
ttl_seconds = 86400
token_bytes = 16

[client]
batch_max_limit = 999
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Client.BatchMaxLimit != ClientBatchHardLimit {
		t.Fatalf("expected batch_max_limit clamped to %d, got %d", ClientBatchHardLimit, cfg.Client.BatchMaxLimit)
	}
}
