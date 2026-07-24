# yimsg-cli

供 AI 调用的 yimsg 命令行客户端：登录并保存 token（下次无需再登录）、把消息增量同步到本地、按会话查询本地聊天记录、按调用方指定的游标查询待处理增量消息、查询好友或群资料、给好友或群发送消息。设计方案见 [`docs/cli方案.md`](docs/cli方案.md)。

除 `login`/`switch-user` 外，所有命令都不需要（也不接受）传自己的 uid——协议本身也不需要，身份永远来自已鉴权连接的 token。CLI 维护一个"当前账号"指针，`login` 会自动把新登录的账号设为当前账号；要同时管理多个账号时用 `switch-user` 切换。跟其他人互动一律用用户名（没人记得住 uid），群没有用户名，只能继续用数字 `group_id`。

## 构建

```bash
go build -o yimsg-cli ./cli/cmd/yimsg-cli
```

## 使用示例

一个根目录（`--dir`，或设置环境变量 `YIMSG_CLI_DIR` 免去每次传参；都不传则默认使用当前工作目录下的 `cli_data`，不存在会自动创建）可以同时管理多个账号，账号之间用用户名区分子目录（目录名对人可读，方便直接在文件系统上分辨账号），无需手动切换文件夹。

```bash
# 不传 --dir 时默认用 ./cli_data；这里显式指定 --dir 只是为了示例更清楚。
# 登录，token 保存在 <dir>/<username>/session.json 下，同时设为当前账号
./yimsg-cli login --dir ./data --server ws://127.0.0.1:8080/ws --username bot --password '******'
# => {"ok":true,"uid":123,"username":"bot","dir":"./data/bot"}

# 之后的命令只需要 --dir，无需再传用户名密码或 uid
./yimsg-cli current --dir ./data
./yimsg-cli sync --dir ./data

# 取本地已同步、seq 大于给定游标的新消息（默认排除自己发的）；--after-seq 必须
# 显式指定，调用方自行维护"处理到哪了"，例如上一次调用返回的 max_seq
./yimsg-cli pending --dir ./data --after-seq 0

# 给某个好友或某个群回复：人用用户名，群没有用户名只能用 group_id
./yimsg-cli send --dir ./data --to-user alice --text "已收到"
./yimsg-cli send --dir ./data --to-group 789 --markdown "**收到**"

# 处理完这批消息后，下次 pending 从上一次返回的 max_seq 继续
./yimsg-cli pending --dir ./data --after-seq 42

# 查询与某人或某群的历史聊天记录（优先来自本地同步库；--with-user 若是第一次
# 提到这个用户名，会临时回源解析一次 uid 并缓存，之后同一用户名不再联网）
./yimsg-cli history --dir ./data --with-user alice

# 查询好友 / 群资料、按用户名查资料
./yimsg-cli user-info --dir ./data --usernames alice,carol
./yimsg-cli group-info --dir ./data --groups 789
./yimsg-cli contacts --dir ./data

# 同一个根目录下管理另一个账号：先 login 一次（此后无需再传密码），
# 之后随时用 switch-user 切换"当前账号"
./yimsg-cli login --dir ./data --server ws://127.0.0.1:8080/ws --username bot2 --password '******'
./yimsg-cli switch-user --dir ./data --username bot
./yimsg-cli accounts --dir ./data
```

所有命令把结果打印为一段 JSON 到 stdout：成功时顶层 `"ok": true`，失败时 `"ok": false` 并带 `"error"`，同时进程以退出码 1 结束。运行 `./yimsg-cli --help` 查看完整子命令与参数列表。

> 同一个根目录下的"当前账号"是进程间共享的单个指针（`<dir>/current.json`）。如果要用同一个根目录**并发**运行多个进程分别扮演不同账号自动回复，请在每次调用前先 `switch-user` 到目标账号，且不要并发调用 `switch-user`/依赖当前账号的命令，避免互相覆盖；更简单的做法是给每个机器人账号各用一个独立的根目录。

本组件采用 `Apache-2.0`，详见 [LICENSING.md](../LICENSING.md)。
