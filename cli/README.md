# yimsg-cli

供 AI 调用的 yimsg 命令行客户端：登录并保存 token（下次无需再登录）、把消息增量同步到本地、按会话查询本地聊天记录、记录/查询 AI 上次处理到的消息 seq、查询好友或群资料、给好友或群发送消息。设计方案见 [`docs/cli方案.md`](docs/cli方案.md)。

## 构建

```bash
go build -o yimsg-cli ./cli/cmd/yimsg-cli
```

## 使用示例

一个根目录（`--dir`，或设置环境变量 `YIMSG_CLI_DIR` 免去每次传参）可以同时管理多个账号，账号之间用 uid 区分子目录，无需手动切换文件夹。

```bash
# 登录一次，token 保存在 <dir>/<uid>/session.json 下
./yimsg-cli login --dir ./data --server ws://127.0.0.1:8080/ws --username bot --password '******'
# => {"ok":true,"uid":123,"username":"bot","dir":"./data/123"}

# 之后的命令只需要 --dir + --uid，无需再传用户名密码
./yimsg-cli sync --dir ./data --uid 123

# 查询自己上次处理到的消息 seq，取本地已同步、seq 更大的新消息（默认排除自己发的）
./yimsg-cli ai-cursor get --dir ./data --uid 123
./yimsg-cli pending --dir ./data --uid 123

# 给某个好友或某个群回复
./yimsg-cli send --dir ./data --uid 123 --to-user 456 --text "已收到"
./yimsg-cli send --dir ./data --uid 123 --to-group 789 --markdown "**收到**"

# 处理完这批消息后推进游标，下次从这里继续
./yimsg-cli ai-cursor set --dir ./data --uid 123 --seq 42

# 查询与某人或某群的历史聊天记录（来自本地同步库，不回源服务端）
./yimsg-cli history --dir ./data --uid 123 --with-user 456

# 查询好友 / 群资料
./yimsg-cli user-info --dir ./data --uid 123 --targets 456,789
./yimsg-cli group-info --dir ./data --uid 123 --groups 789
./yimsg-cli contacts --dir ./data --uid 123
```

所有命令把结果打印为一段 JSON 到 stdout：成功时顶层 `"ok": true`，失败时 `"ok": false` 并带 `"error"`，同时进程以退出码 1 结束。运行 `./yimsg-cli --help` 查看完整子命令与参数列表。
