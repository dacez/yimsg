package config

import (
	"fmt"
	"strings"
)

// ParseAccountFlag 解析形如 "username:password" 的命令行 -account 参数，用于
// 命令行方式一次性传入一个账号。
func ParseAccountFlag(spec string) (AccountFile, error) {
	parts := strings.SplitN(spec, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return AccountFile{}, fmt.Errorf("非法 -account 参数 %q，格式必须是 username:password", spec)
	}
	return AccountFile{Username: parts[0], Password: parts[1]}, nil
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
	DeepSeekAPIKeyFile  string
	DeepSeekAPIKeyEnv   string
	PollIntervalSeconds int
	MaxPull             int
	// Accounts 至少要有一项：要么来自单账号的 -username/-password，要么来自
	// 一个或多个 -account 重复参数。
	Accounts []AccountFile
}

// ToFile 把命令行输入组装成与配置文件等价的 File 结构，复用同一套 Resolve 校验逻辑。
func (o FlagOptions) ToFile() *File {
	return &File{
		DeepSeek: DeepSeekFile{
			BaseURL:    o.DeepSeekBaseURL,
			Model:      o.DeepSeekModel,
			APIKey:     o.DeepSeekAPIKey,
			APIKeyFile: o.DeepSeekAPIKeyFile,
			APIKeyEnv:  o.DeepSeekAPIKeyEnv,
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
