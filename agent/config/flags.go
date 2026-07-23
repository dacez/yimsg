package config

import (
	"fmt"
	"strings"
)

// ParseAccountFlag 解析形如 "username:password:workspace_dir" 的命令行 -account
// 参数，用于命令行方式一次性传入一个账号（workspace_dir 本身不能包含冒号）。
func ParseAccountFlag(spec string) (AccountFile, error) {
	parts := strings.SplitN(spec, ":", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return AccountFile{}, fmt.Errorf("非法 -account 参数 %q，格式必须是 username:password:workspace_dir", spec)
	}
	return AccountFile{Username: parts[0], Password: parts[1], WorkspaceDir: parts[2]}, nil
}

// FlagOptions 是命令行方式（非配置文件）启动时的原始输入，由
// cmd/yimsg-agent/main.go 的 flag 解析结果填充。
type FlagOptions struct {
	Server              string
	DataDir             string
	InsecureSkipVerify  bool
	DeepSeekBaseURL     string
	DeepSeekModel       string
	DeepSeekAPIKey      string
	DeepSeekAPIKeyEnv   string
	PollIntervalSeconds int
	MaxPull             int
	// Accounts 至少要有一项：要么来自单账号的 -username/-password/-workspace，
	// 要么来自一个或多个 -account 重复参数。
	Accounts []AccountFile
}

// ToFile 把命令行输入组装成与配置文件等价的 File 结构，复用同一套 Resolve 校验逻辑。
func (o FlagOptions) ToFile() *File {
	return &File{
		DeepSeek: DeepSeekFile{
			BaseURL:   o.DeepSeekBaseURL,
			Model:     o.DeepSeekModel,
			APIKey:    o.DeepSeekAPIKey,
			APIKeyEnv: o.DeepSeekAPIKeyEnv,
		},
		Agent: AgentDefaultsFile{
			Server:              o.Server,
			DataDir:             o.DataDir,
			PollIntervalSeconds: o.PollIntervalSeconds,
			MaxPull:             o.MaxPull,
			InsecureSkipVerify:  o.InsecureSkipVerify,
		},
		Accounts: o.Accounts,
	}
}
