// Command yimsg-cli 是给 AI 调用的 yimsg 命令行客户端：登录并保存 token（下次
// 无需再登录）、把消息增量同步到本地、按会话查询本地聊天记录、记录/查询 AI 上次
// 处理到的消息 seq、查询好友或群资料、给好友或群发送消息。
//
// 使用方指定一个根目录（--dir 或环境变量 YIMSG_CLI_DIR），目录的二级目录固定
// 为用户 uid（见 cli/account），因此同一个根目录下可以同时管理多个账号，无需
// 为不同账号切换不同文件夹。
//
// 除 login/switch-user 外，其它子命令一律不接受自己的 uid 作为参数——协议本身
// 也不需要（身份永远来自已鉴权连接的 token），CLI 只维护一个"当前账号"指针：
// login 自动把新登录的账号设为当前账号，也可以用 switch-user 切换到本地已登录
// 过的另一个账号。跟其他人或群互动时，用户目标一律用用户名（没人记得住 uid）；
// 群没有用户名，只能继续用数字 group_id。
//
// 所有命令都以单行 JSON 输出到 stdout，成功时顶层带 "ok": true，失败时
// "ok": false 且进程以退出码 1 结束，方便 AI 侧解析。
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	var err error
	switch cmd {
	case "login":
		err = cmdLogin(args)
	case "switch-user":
		err = cmdSwitchUser(args)
	case "current":
		err = cmdCurrent(args)
	case "accounts":
		err = cmdAccounts(args)
	case "sync":
		err = cmdSync(args)
	case "send":
		err = cmdSend(args)
	case "history":
		err = cmdHistory(args)
	case "pending":
		err = cmdPending(args)
	case "ai-cursor":
		err = cmdAICursor(args)
	case "user-info":
		err = cmdUserInfo(args)
	case "group-info":
		err = cmdGroupInfo(args)
	case "contacts":
		err = cmdContacts(args)
	case "-h", "--help", "help":
		printUsage()
		return
	default:
		err = fmt.Errorf("未知子命令: %s", cmd)
	}
	if err != nil {
		emitFail(err)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `yimsg-cli 子命令（除 login/switch-user 外均对"当前账号"操作，无需传自己的 uid）：
  login       --dir DIR --server WS_URL --username U --password P   登录并保存 token，同时设为当前账号
  switch-user --dir DIR --username U                                切换当前账号（须是本地已 login 过的账号）
  current     --dir DIR                                             查看当前账号
  accounts    --dir DIR                                             列出目录下已登录账号，标出当前账号
  sync        --dir DIR [--limit N]                                 增量同步消息到本地
  send        --dir DIR (--to-user USERNAME|--to-group GROUP_ID) (--text T|--markdown M)
  history     --dir DIR (--with-user USERNAME|--with-group GROUP_ID) [--after-seq N] [--limit N]
  pending     --dir DIR [--after-seq N] [--limit N] [--include-self]
  ai-cursor   get --dir DIR
  ai-cursor   set --dir DIR --seq N
  user-info   --dir DIR --usernames U1,U2,...
  group-info  --dir DIR --groups G1,G2,...
  contacts    --dir DIR [--status friend|pending_incoming|pending_outgoing] [--limit N]`)
}

// resolveDir 优先取 --dir，其次取 YIMSG_CLI_DIR 环境变量。
func resolveDir(flagVal string) (string, error) {
	if flagVal != "" {
		return flagVal, nil
	}
	if env := os.Getenv("YIMSG_CLI_DIR"); env != "" {
		return env, nil
	}
	return "", fmt.Errorf("缺少 --dir（或环境变量 YIMSG_CLI_DIR）")
}

// readPassword 优先取 --password；为空时从 stdin 读一行，避免密码出现在进程参数列表里。
func readPassword(flagVal string) (string, error) {
	if flagVal != "" {
		return flagVal, nil
	}
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", fmt.Errorf("未提供 --password 且无法从 stdin 读取: %w", err)
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func parseInt64List(raw string) ([]int64, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("列表不能为空")
	}
	parts := strings.Split(raw, ",")
	out := make([]int64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		v, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("非法 ID %q: %w", p, err)
		}
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("列表不能为空")
	}
	return out, nil
}

func parseStringList(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("列表不能为空")
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("列表不能为空")
	}
	return out, nil
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}
