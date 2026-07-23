// Package config 负责解析 yimsg-agent 的配置文件（TOML）与命令行参数，
// 归一化成统一的 *Config，供 runtime/pipeline/engine 使用。两种输入方式
// （配置文件 / 命令行）互斥，最终都收敛到同一份校验逻辑，调用方不需要
// 关心配置来自哪里。方案详见 agent/docs/agent方案.md 第 2 节。
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// 全局默认值，对应方案文档 §2.2 的 TOML 示例。
const (
	DefaultDeepSeekBaseURL       = "https://api.deepseek.com"
	DefaultDeepSeekModel         = "deepseek-chat"
	DefaultDeepSeekAPIKeyEnv     = "DEEPSEEK_API_KEY"
	DefaultTemperature           = 0.7
	DefaultRequestTimeoutSecs    = 60
	DefaultDataDir               = "./agent_data"
	ResourcesDirName             = "resources"
	DefaultPollIntervalSeconds   = 2
	MinPollIntervalSeconds       = 1 // 需求硬性下限："最小间隔一秒"
	DefaultMaxPull               = 30
	DefaultMaxPlanSteps          = 6
	DefaultMaxToolCallsPerStep   = 4
	DefaultMemoryMaxCharsPerPeer = 4000
	DefaultMemoryMaxPeers        = 500
)

// DeepSeekFile 是 TOML [deepseek] 段的原始结构。
type DeepSeekFile struct {
	BaseURL string `toml:"base_url"`
	Model   string `toml:"model"`
	APIKey  string `toml:"api_key"`
	// APIKeyFile 指向一个只包含 key 本身的文件，用法参考 server 的 tls_cert/tls_key：
	// 部署时把真正的密钥文件放在部署流程不会碰的路径，配置文件里只留路径，密钥内容
	// 不进版本库、不进部署流水线，一次性人工写好后长期有效，不需要每次部署都重新设置。
	APIKeyFile            string  `toml:"api_key_file"`
	APIKeyEnv             string  `toml:"api_key_env"`
	Temperature           float64 `toml:"temperature"`
	RequestTimeoutSeconds int     `toml:"request_timeout_seconds"`
}

// AgentDefaultsFile 是 TOML [agent] 段的原始结构，账号未覆盖时的全局默认值。
type AgentDefaultsFile struct {
	Server                string `toml:"server"`
	DataDir               string `toml:"data_dir"`
	PollIntervalSeconds   int    `toml:"poll_interval_seconds"`
	MaxPull               int    `toml:"max_pull"`
	MaxPlanSteps          int    `toml:"max_plan_steps"`
	MaxToolCallsPerStep   int    `toml:"max_tool_calls_per_step"`
	MemoryMaxCharsPerPeer int    `toml:"memory_max_chars_per_peer"`
	MemoryMaxPeers        int    `toml:"memory_max_peers"`
	InsecureSkipVerify    bool   `toml:"insecure_skip_verify"`
}

// AccountFile 是 TOML [[accounts]] 段的原始结构。
type AccountFile struct {
	Username            string `toml:"username"`
	Password            string `toml:"password"`
	PasswordEnv         string `toml:"password_env"`
	PollIntervalSeconds int    `toml:"poll_interval_seconds"`
	MaxPull             int    `toml:"max_pull"`
}

// File 是配置文件的顶层结构，对应 agent方案.md §2.2。
type File struct {
	DeepSeek DeepSeekFile      `toml:"deepseek"`
	Agent    AgentDefaultsFile `toml:"agent"`
	Accounts []AccountFile     `toml:"accounts"`
}

// DeepSeekSettings 是归一化后的 DeepSeek 客户端配置。
type DeepSeekSettings struct {
	BaseURL        string
	Model          string
	APIKey         string
	Temperature    float64
	RequestTimeout time.Duration
}

// Account 是归一化后的单账号配置：密码已解析、轮询参数已套上账号级覆盖 + 全局默认值。
type Account struct {
	Username     string
	Password     string
	PollInterval time.Duration
	MaxPull      int
	// ResourcesDir 是 <DataDir>/<Username>/resources：该账号独享的只读知识库，
	// 由 Resolve 自动创建，与 Config.ResourcesDir（全部账号共享）是两棵独立的
	// 目录树，互不递归（避免账号之间通过"共享兜底"读到彼此的私有资料），查找顺序
	// 先私有后共享见 agent方案.md §2.3。
	ResourcesDir string
}

// Config 是归一化后供 runtime 直接使用的最终配置。
type Config struct {
	Server  string
	DataDir string
	// ResourcesDir 是 <DataDir>/resources：全部账号共享的只读 Markdown 知识库，
	// 由 Resolve 自动创建，不是用户可配置项（见 agent方案.md §2.3）。每个账号自己
	// 独享的知识库见 Account.ResourcesDir。
	ResourcesDir          string
	InsecureSkipVerify    bool
	DeepSeek              DeepSeekSettings
	MaxPlanSteps          int
	MaxToolCallsPerStep   int
	MemoryMaxCharsPerPeer int
	MemoryMaxPeers        int
	Accounts              []Account
}

// Load 从 TOML 配置文件路径加载并归一化配置。baseDir 用于把配置文件里的相对
// 路径（data_dir）解析成绝对路径，传入配置文件所在目录。
func Load(path string) (*Config, error) {
	var f File
	if _, err := toml.DecodeFile(path, &f); err != nil {
		return nil, fmt.Errorf("解析配置文件 %s 失败: %w", path, err)
	}
	baseDir := filepath.Dir(path)
	return Resolve(&f, baseDir)
}

// Resolve 把原始 File 结构归一化、校验成最终 Config；baseDir 用于解析相对路径。
func Resolve(f *File, baseDir string) (*Config, error) {
	if len(f.Accounts) == 0 {
		return nil, fmt.Errorf("配置中至少需要一个 [[accounts]] 账号")
	}

	server := strings.TrimSpace(f.Agent.Server)
	if server == "" {
		return nil, fmt.Errorf("缺少 agent.server（yimsg WebSocket 地址）")
	}

	dataDir := f.Agent.DataDir
	if dataDir == "" {
		dataDir = DefaultDataDir
	}
	dataDir = resolvePath(baseDir, dataDir)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("创建 data_dir %s 失败: %w", dataDir, err)
	}
	resourcesDir := filepath.Join(dataDir, ResourcesDirName)
	if err := os.MkdirAll(resourcesDir, 0o700); err != nil {
		return nil, fmt.Errorf("创建 resources 目录 %s 失败: %w", resourcesDir, err)
	}

	ds, err := resolveDeepSeek(f.DeepSeek, baseDir)
	if err != nil {
		return nil, err
	}

	defaultPoll := f.Agent.PollIntervalSeconds
	if defaultPoll == 0 {
		defaultPoll = DefaultPollIntervalSeconds
	}
	defaultMaxPull := f.Agent.MaxPull
	if defaultMaxPull == 0 {
		defaultMaxPull = DefaultMaxPull
	}

	maxPlanSteps := f.Agent.MaxPlanSteps
	if maxPlanSteps == 0 {
		maxPlanSteps = DefaultMaxPlanSteps
	}
	maxToolCalls := f.Agent.MaxToolCallsPerStep
	if maxToolCalls == 0 {
		maxToolCalls = DefaultMaxToolCallsPerStep
	}
	memMaxChars := f.Agent.MemoryMaxCharsPerPeer
	if memMaxChars == 0 {
		memMaxChars = DefaultMemoryMaxCharsPerPeer
	}
	memMaxPeers := f.Agent.MemoryMaxPeers
	if memMaxPeers == 0 {
		memMaxPeers = DefaultMemoryMaxPeers
	}

	seenUsernames := make(map[string]bool, len(f.Accounts))
	accounts := make([]Account, 0, len(f.Accounts))
	for i, af := range f.Accounts {
		username := strings.TrimSpace(af.Username)
		if username == "" {
			return nil, fmt.Errorf("accounts[%d] 缺少 username", i)
		}
		if seenUsernames[username] {
			return nil, fmt.Errorf("accounts 中 username %q 重复", username)
		}
		seenUsernames[username] = true

		password := af.Password
		if af.PasswordEnv != "" {
			v, ok := os.LookupEnv(af.PasswordEnv)
			if !ok || v == "" {
				return nil, fmt.Errorf("账号 %q 的 password_env=%s 未设置或为空", username, af.PasswordEnv)
			}
			password = v
		}
		if password == "" {
			return nil, fmt.Errorf("账号 %q 未提供 password 或 password_env", username)
		}

		poll := af.PollIntervalSeconds
		if poll == 0 {
			poll = defaultPoll
		}
		if poll < MinPollIntervalSeconds {
			poll = MinPollIntervalSeconds
		}

		maxPull := af.MaxPull
		if maxPull == 0 {
			maxPull = defaultMaxPull
		}
		if maxPull < 1 {
			return nil, fmt.Errorf("账号 %q 的 max_pull 必须 >= 1", username)
		}

		// 账号私有知识库：<data_dir>/<username>/resources，与账号自己的 session/同步库/
		// agent_state.json 同级（cli/account 的目录布局），和共享 resources/ 是两棵完全
		// 独立的目录树，不嵌套在彼此之下，避免共享侧递归列出/搜索时读到其它账号的私有资料。
		accResourcesDir := filepath.Join(dataDir, username, ResourcesDirName)
		if err := os.MkdirAll(accResourcesDir, 0o700); err != nil {
			return nil, fmt.Errorf("创建账号 %q 的私有 resources 目录 %s 失败: %w", username, accResourcesDir, err)
		}

		accounts = append(accounts, Account{
			Username:     username,
			Password:     password,
			PollInterval: time.Duration(poll) * time.Second,
			MaxPull:      maxPull,
			ResourcesDir: accResourcesDir,
		})
	}

	return &Config{
		Server:                server,
		DataDir:               dataDir,
		ResourcesDir:          resourcesDir,
		InsecureSkipVerify:    f.Agent.InsecureSkipVerify,
		DeepSeek:              ds,
		MaxPlanSteps:          maxPlanSteps,
		MaxToolCallsPerStep:   maxToolCalls,
		MemoryMaxCharsPerPeer: memMaxChars,
		MemoryMaxPeers:        memMaxPeers,
		Accounts:              accounts,
	}, nil
}

// resolveDeepSeek 归一化 [deepseek] 段；baseDir 用于把 api_key_file 的相对路径
// 解析成绝对路径（与 data_dir 的解析方式一致）。api_key 的来源按 api_key（明文，
// 仅本地联调）> api_key_file（文件路径，推荐的生产部署方式）> api_key_env（环境
// 变量，未显式配置 api_key_env 时仍会兜底检查 DefaultDeepSeekAPIKeyEnv）依次尝试，
// 命中第一个非空值即用，全部为空则拒绝启动。
func resolveDeepSeek(f DeepSeekFile, baseDir string) (DeepSeekSettings, error) {
	baseURL := f.BaseURL
	if baseURL == "" {
		baseURL = DefaultDeepSeekBaseURL
	}
	model := f.Model
	if model == "" {
		model = DefaultDeepSeekModel
	}
	temperature := f.Temperature
	if temperature == 0 {
		temperature = DefaultTemperature
	}
	timeoutSecs := f.RequestTimeoutSeconds
	if timeoutSecs == 0 {
		timeoutSecs = DefaultRequestTimeoutSecs
	}

	apiKey := f.APIKey
	if apiKey == "" && f.APIKeyFile != "" {
		path := resolvePath(baseDir, f.APIKeyFile)
		data, err := os.ReadFile(path)
		if err != nil {
			return DeepSeekSettings{}, fmt.Errorf("读取 deepseek.api_key_file %s 失败: %w", path, err)
		}
		apiKey = strings.TrimSpace(string(data))
	}
	if apiKey == "" {
		envName := f.APIKeyEnv
		if envName == "" {
			envName = DefaultDeepSeekAPIKeyEnv
		}
		apiKey = os.Getenv(envName)
	}
	if apiKey == "" {
		return DeepSeekSettings{}, fmt.Errorf("DeepSeek api_key 未配置：请设置 deepseek.api_key、deepseek.api_key_file 或 deepseek.api_key_env 指向的环境变量")
	}

	return DeepSeekSettings{
		BaseURL:        strings.TrimRight(baseURL, "/"),
		Model:          model,
		APIKey:         apiKey,
		Temperature:    temperature,
		RequestTimeout: time.Duration(timeoutSecs) * time.Second,
	}, nil
}

func resolvePath(baseDir, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(baseDir, p))
}
