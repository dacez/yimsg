// Command yimsg-agent 是多账号自动回复常驻进程：登录多个 yimsg 账号，循环拉取
// 每个账号收到的消息（最小间隔 1 秒），调用 DeepSeek 官方 API 生成回复——可以
// 直接回答，也可以先规划再分步执行，每步执行完发一条纯文本进度消息，执行过程
// 中可以只读访问该账号专属文件夹下的 Markdown 文件。方案见 agent/docs/agent方案.md。
//
// 支持配置文件（-config，推荐用于多账号）或命令行（单账号 -username/-password/
// -workspace，或重复 -account username:password:workspace_dir 传入多账号）两种
// 互斥的输入方式，见 agent/README.md。
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"yimsg/agent/config"
	"yimsg/agent/runtime"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "yimsg-agent:", err)
		os.Exit(1)
	}
}

func run() error {
	fs := flag.NewFlagSet("yimsg-agent", flag.ExitOnError)
	configPath := fs.String("config", "", "配置文件路径（TOML）；与下面的命令行账号参数互斥")
	server := fs.String("server", "", "yimsg WebSocket 地址，例如 ws://127.0.0.1:8080/ws")
	dataDir := fs.String("data-dir", "", "agent 本地状态根目录")
	insecure := fs.Bool("insecure", false, "跳过 TLS 证书校验（自签名证书部署使用）")
	pollInterval := fs.Int("poll-interval", 0, "全局默认轮询间隔（秒），最终会被 clamp 到 >= 1")
	maxPull := fs.Int("max-pull", 0, "全局默认单轮最大拉取条数，默认 30")
	username := fs.String("username", "", "单账号模式：用户名")
	password := fs.String("password", "", "单账号模式：密码；留空则从 stdin 读取一行")
	workspace := fs.String("workspace", "", "单账号模式：workspace_dir")
	deepseekBaseURL := fs.String("deepseek-base-url", "", "DeepSeek base_url，默认官方地址")
	deepseekModel := fs.String("deepseek-model", "", "DeepSeek model，默认 deepseek-chat")
	deepseekAPIKey := fs.String("deepseek-api-key", "", "DeepSeek api key（会出现在进程参数里，不推荐）")
	deepseekAPIKeyEnv := fs.String("deepseek-api-key-env", "", "读取 DeepSeek api key 的环境变量名，默认 DEEPSEEK_API_KEY")
	var accountFlags multiFlag
	fs.Var(&accountFlags, "account", "多账号命令行模式，重复传入 username:password:workspace_dir")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return err
	}

	cfg, err := loadConfig(loadConfigInput{
		configPath: *configPath, server: *server, dataDir: *dataDir, insecure: *insecure,
		pollInterval: *pollInterval, maxPull: *maxPull,
		username: *username, password: *password, workspace: *workspace,
		deepseekBaseURL: *deepseekBaseURL, deepseekModel: *deepseekModel,
		deepseekAPIKey: *deepseekAPIKey, deepseekAPIKeyEnv: *deepseekAPIKeyEnv,
		accountFlags: accountFlags,
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runtime.New(cfg).Run(ctx)
	return nil
}

type loadConfigInput struct {
	configPath, server, dataDir       string
	insecure                          bool
	pollInterval, maxPull             int
	username, password, workspace     string
	deepseekBaseURL, deepseekModel    string
	deepseekAPIKey, deepseekAPIKeyEnv string
	accountFlags                      multiFlag
}

// loadConfig 归一化 -config 与命令行两种互斥输入方式，最终都调用同一套
// config.Resolve 校验逻辑。
func loadConfig(in loadConfigInput) (*config.Config, error) {
	hasCLIAccounts := in.username != "" || len(in.accountFlags) > 0
	if in.configPath != "" {
		if hasCLIAccounts {
			return nil, fmt.Errorf("-config 与命令行账号参数（-username/-account）互斥，只能二选一")
		}
		return config.Load(in.configPath)
	}
	if !hasCLIAccounts {
		return nil, fmt.Errorf("必须指定 -config 或至少一个账号（-username.../-account...）")
	}

	opts := config.FlagOptions{
		Server: in.server, DataDir: in.dataDir, InsecureSkipVerify: in.insecure,
		PollIntervalSeconds: in.pollInterval, MaxPull: in.maxPull,
		DeepSeekBaseURL: in.deepseekBaseURL, DeepSeekModel: in.deepseekModel,
		DeepSeekAPIKey: in.deepseekAPIKey, DeepSeekAPIKeyEnv: in.deepseekAPIKeyEnv,
	}
	if in.username != "" {
		if in.workspace == "" {
			return nil, fmt.Errorf("单账号模式需要 -workspace")
		}
		password := in.password
		if password == "" {
			p, err := readPasswordFromStdin()
			if err != nil {
				return nil, err
			}
			password = p
		}
		opts.Accounts = append(opts.Accounts, config.AccountFile{Username: in.username, Password: password, WorkspaceDir: in.workspace})
	}
	for _, spec := range in.accountFlags {
		af, err := config.ParseAccountFlag(spec)
		if err != nil {
			return nil, err
		}
		opts.Accounts = append(opts.Accounts, af)
	}

	wd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	return config.Resolve(opts.ToFile(), wd)
}

func readPasswordFromStdin() (string, error) {
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", fmt.Errorf("未提供 -password 且无法从 stdin 读取: %w", err)
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// multiFlag 支持 -account 重复传入多次。
type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}
