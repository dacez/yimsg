// Package config loads and provides the application configuration from TOML.
package config

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

type Config struct {
	Server   ServerConfig   `toml:"server"`
	Database DatabaseConfig `toml:"database"`
	Session  SessionConfig  `toml:"session"`
	Message  MessageConfig  `toml:"message"`
	GC       GCConfig       `toml:"gc"`
	Frontend FrontendConfig `toml:"frontend"`
	Website  WebsiteConfig  `toml:"website"`
	Media    MediaConfig    `toml:"media"`
	Client   ClientConfig   `toml:"client"`
}

type ServerConfig struct {
	Host      string `toml:"host"`
	Port      int    `toml:"port"`
	MachineID int64  `toml:"machine_id"`
	TLSCert   string `toml:"tls_cert"`
	TLSKey    string `toml:"tls_key"`
}

type DatabaseConfig struct {
	DataDir    string `toml:"data_dir"`
	ShardCount int    `toml:"shard_count"`
}

type SessionConfig struct {
	TTLSeconds int64 `toml:"ttl_seconds"`
	TokenBytes int   `toml:"token_bytes"`
}

type MessageConfig struct {
	RecallWindowSeconds int64 `toml:"recall_window_seconds"`
}

type GCConfig struct {
	MessageMaxCount            int64 `toml:"message_max_count"`
	ConversationMaxCount       int64 `toml:"conversation_max_count"`
	SessionCleanupIntervalSecs int64 `toml:"session_cleanup_interval_secs"`
	ContactGCIntervalSecs      int64 `toml:"contact_gc_interval_secs"`
	BlocklistGCIntervalSecs    int64 `toml:"blocklist_gc_interval_secs"`
	MutelistGCIntervalSecs     int64 `toml:"mutelist_gc_interval_secs"`
	OrgGCIntervalSecs          int64 `toml:"org_gc_interval_secs"`
	MessageGCIntervalSecs      int64 `toml:"message_gc_interval_secs"`
	ConversationGCIntervalSecs int64 `toml:"conversation_gc_interval_secs"`
	UserGCIntervalSecs         int64 `toml:"user_gc_interval_secs"`
}

// FrontendConfig 描述前端 IM 应用（聊天界面）的挂载方式。默认挂载在
// MountPath 子路径（而非根路径），根路径留给官网首页。
type FrontendConfig struct {
	StaticDir string `toml:"static_dir"`
	MountPath string `toml:"mount_path"`
}

// WebsiteConfig 描述官网（纯静态营销站）的挂载方式。官网与前端 IM 应用是
// 两套独立的静态资源：官网默认挂载在根路径作为首页，前端 IM 应用挂载在
// MountPath 子路径下。StaticDir 为空表示不挂载官网。
type WebsiteConfig struct {
	StaticDir string `toml:"static_dir"`
	MountPath string `toml:"mount_path"`
}

type MediaConfig struct {
	UploadDir      string `toml:"upload_dir"`
	MaxAvatarBytes int64  `toml:"max_avatar_bytes"`
	MaxImageBytes  int64  `toml:"max_image_bytes"`
	MaxFileBytes   int64  `toml:"max_file_bytes"`
}

type ClientConfig struct {
	CacheTTLSeconds int64 `toml:"cache_ttl_seconds"`
	CacheMaxEntries int   `toml:"cache_max_entries"`
	BatchMaxLimit   int64 `toml:"batch_max_limit"`
}

const (
	DefaultServerHost            = "127.0.0.1"
	DefaultServerPort            = 38081
	DefaultServerMachineID int64 = 1

	DefaultDatabaseDataDir    = "./data"
	DefaultDatabaseShardCount = 4

	DefaultSessionTTLSeconds int64 = 30 * 24 * 60 * 60
	DefaultSessionTokenBytes       = 32

	// DefaultRecallWindowSeconds is used when [message].recall_window_seconds is
	// not set (i.e. left at Go zero value) in the server config. A negative value
	// is treated as "explicitly disabled" and is preserved as-is.
	DefaultRecallWindowSeconds int64 = 120

	DefaultGCMessageMaxCount            int64 = 100000
	DefaultGCConversationMaxCount       int64 = 10000
	DefaultGCSessionCleanupIntervalSecs int64 = 3600
	DefaultGCContactIntervalSecs        int64 = 3600
	DefaultGCBlocklistIntervalSecs      int64 = 3600
	DefaultGCMutelistIntervalSecs       int64 = 3600
	DefaultGCOrgIntervalSecs            int64 = 3600
	DefaultGCMessageIntervalSecs        int64 = 3600
	DefaultGCConversationIntervalSecs   int64 = 3600
	DefaultGCUserIntervalSecs           int64 = 3600

	// 前端 IM 应用默认从仓库根目录的 web/ 提供构建产物，挂载在 /chat/ 子路径；
	// 根路径留给官网首页。
	DefaultFrontendStaticDir = "web"
	DefaultFrontendMountPath = "/chat/"

	// 官网默认从仓库根目录的 website/ 提供纯静态资源，挂载在根路径作为首页。
	DefaultWebsiteStaticDir = "website"
	DefaultWebsiteMountPath = "/"

	DefaultMediaUploadDir            = "./data/media"
	DefaultMediaMaxAvatarBytes int64 = 5 * 1024 * 1024
	DefaultMediaMaxImageBytes  int64 = 10 * 1024 * 1024
	DefaultMediaMaxFileBytes   int64 = 100 * 1024 * 1024
)

// 下列常量是 [client] 段的默认值，保证 `client_config` 中的每个字段在配置
// 漏配时也能返回合理取值，避免前端回落到 SDK 内置兜底。取值与前端
// frontend/src/sdk/sdk-defaults.ts 保持一致。
const (
	DefaultClientCacheTTLSeconds int64 = 7 * 24 * 60 * 60 // 7 天
	DefaultClientCacheMaxEntries int   = 10000
	DefaultClientBatchMaxLimit   int64 = 500
	ClientBatchHardLimit         int64 = 500
)

// Default returns a complete configuration suitable for local development. The
// values also document the effective defaults used when config.toml comments out
// individual fields.
func Default() Config {
	return Config{
		Server: ServerConfig{
			Host:      DefaultServerHost,
			Port:      DefaultServerPort,
			MachineID: DefaultServerMachineID,
		},
		Database: DatabaseConfig{
			DataDir:    DefaultDatabaseDataDir,
			ShardCount: DefaultDatabaseShardCount,
		},
		Session: SessionConfig{
			TTLSeconds: DefaultSessionTTLSeconds,
			TokenBytes: DefaultSessionTokenBytes,
		},
		Message: MessageConfig{
			RecallWindowSeconds: DefaultRecallWindowSeconds,
		},
		GC: GCConfig{
			MessageMaxCount:            DefaultGCMessageMaxCount,
			ConversationMaxCount:       DefaultGCConversationMaxCount,
			SessionCleanupIntervalSecs: DefaultGCSessionCleanupIntervalSecs,
			ContactGCIntervalSecs:      DefaultGCContactIntervalSecs,
			BlocklistGCIntervalSecs:    DefaultGCBlocklistIntervalSecs,
			MutelistGCIntervalSecs:     DefaultGCMutelistIntervalSecs,
			OrgGCIntervalSecs:          DefaultGCOrgIntervalSecs,
			MessageGCIntervalSecs:      DefaultGCMessageIntervalSecs,
			ConversationGCIntervalSecs: DefaultGCConversationIntervalSecs,
			UserGCIntervalSecs:         DefaultGCUserIntervalSecs,
		},
		Frontend: FrontendConfig{
			StaticDir: DefaultFrontendStaticDir,
			MountPath: DefaultFrontendMountPath,
		},
		Website: WebsiteConfig{
			StaticDir: DefaultWebsiteStaticDir,
			MountPath: DefaultWebsiteMountPath,
		},
		Media: MediaConfig{
			UploadDir:      DefaultMediaUploadDir,
			MaxAvatarBytes: DefaultMediaMaxAvatarBytes,
			MaxImageBytes:  DefaultMediaMaxImageBytes,
			MaxFileBytes:   DefaultMediaMaxFileBytes,
		},
		Client: ClientConfig{
			CacheTTLSeconds: DefaultClientCacheTTLSeconds,
			CacheMaxEntries: DefaultClientCacheMaxEntries,
			BatchMaxLimit:   DefaultClientBatchMaxLimit,
		},
	}
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	// 先放入完整默认值，再让 TOML 只覆盖显式配置的字段；这样模板中保持
	// 注释的字段会自然沿用默认值。
	cfg := Default()
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	applyDefaults(&cfg)
	return &cfg, nil
}

// applyDefaults fills in sensible defaults for config values that are safe to
// auto-populate when omitted. This keeps the system working out-of-the-box when
// a deployer writes a partial config file.
func applyDefaults(cfg *Config) {
	// recall_window_seconds: 0 means "unset" → use default; negative means
	// "explicitly disabled" and is preserved.
	if cfg.Message.RecallWindowSeconds == 0 {
		cfg.Message.RecallWindowSeconds = DefaultRecallWindowSeconds
	}
	// [client] 下的所有字段都必须有默认值，以便 login / authenticate 的
	// `client_config` 中每个字段都携带合理取值。这里仅在 Go 零值（即完全未
	// 配置）时填充默认，显式配置的正/负值都原样保留。
	if cfg.Client.CacheTTLSeconds == 0 {
		cfg.Client.CacheTTLSeconds = DefaultClientCacheTTLSeconds
	}
	if cfg.Client.CacheMaxEntries == 0 {
		cfg.Client.CacheMaxEntries = DefaultClientCacheMaxEntries
	}
	if cfg.Client.BatchMaxLimit <= 0 {
		cfg.Client.BatchMaxLimit = DefaultClientBatchMaxLimit
	}
	if cfg.Client.BatchMaxLimit > ClientBatchHardLimit {
		cfg.Client.BatchMaxLimit = ClientBatchHardLimit
	}
	// 官网 / 前端 IM 应用：配置了 static_dir 却漏配 mount_path 时回落到各自默认
	// 挂载路径；static_dir 显式留空表示不挂载。
	if cfg.Website.StaticDir != "" && cfg.Website.MountPath == "" {
		cfg.Website.MountPath = DefaultWebsiteMountPath
	}
	if cfg.Frontend.StaticDir != "" && cfg.Frontend.MountPath == "" {
		cfg.Frontend.MountPath = DefaultFrontendMountPath
	}
}
