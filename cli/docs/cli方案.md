# yimsg-cli 方案

> 主要对照：`cli/` 目录下的 Go 实现与 `cli/cmd/yimsg-cli/main.go` 的子命令列表。
> 最后复核：2026-07-20。
> 触发更新：新增/修改子命令、本地存储 schema 或账号目录布局时同步更新。
> 入口关系：本文件是 `cli/` 的组件专属方案文档；跨组件文档导航见 [`../../docs/README.md`](../../docs/README.md)。

## 1. 定位

`yimsg-cli` 是一个独立的 Go WebSocket 客户端命令行工具，供 AI（或其它自动化脚本）调用，实现"自动回复"这类场景：登录一次、把消息增量同步到本地、按会话查询历史、记录/查询自己上次处理到的消息进度、查询好友或群资料、给好友或群发消息。它不是给终端用户交互使用的聊天客户端，因此没有 TUI，只有"一次调用、输出一段 JSON、退出"的批处理式命令。

它与 `packages/sdk`（TypeScript SDK）、`server/internal/ws` 一样，各自独立实现同一份 `protocol/yimsg.proto` 定义的二进制帧协议（见 `cli/wire`、`cli/msgid`），不依赖服务端 `internal` 包。

## 2. 账号目录布局

调用方指定一个根目录（`--dir` 或环境变量 `YIMSG_CLI_DIR`），不需要为不同账号切换不同文件夹——根目录的二级目录固定为账号 `uid`：

```text
<dir>/
  <uid>/
    session.json   # {uid, username, token, server_url, login_at}
    data.db        # 本地同步库（SQLite），见第 3 节
```

`login` 命令负责创建 `<dir>/<uid>/` 并写入 `session.json`；此后所有其它命令只需要 `--dir` + `--uid` 即可完成鉴权（用保存的 token 调 `authenticate`），不需要再传用户名密码。token 失效时命令会报错提示重新执行 `login`，不做静默降级。

## 3. 本地同步库（`data.db`）

每个账号目录下一个 SQLite 文件，由 `cli/store` 管理，研发阶段不做 schema 迁移：版本不匹配时直接删除文件、重新执行 `sync` 追平（与项目其余本地库一致，见根 `CLAUDE.md` 项目不变量）。

### 3.1 `messages`

| 字段 | 说明 |
|---|---|
| `seq` | 主键；账号级同步序号，来自 `sync_messages` |
| `msg_id` | 唯一；UUIDv7 base64url |
| `from_uid` | 发送者 uid |
| `to_uid` | 单聊时的原始 `target.uid`；群消息为 0 |
| `group_id` | 群消息的群 ID；单聊为 0 |
| `peer_uid` | 单聊时推导出的会话对方 uid（见下）；群消息为 0 |
| `msg_type` / `send_time` / `status` | 与协议字段一致 |
| `body` | `MessageBody` 的 protobuf 编码原文 |

**会话对方推导（非显而易见，需特别说明）**：服务端 `Message.target` 字段语义是"这条消息的收件人"，单聊场景下无论这条消息存在发送者还是接收者自己的收件箱副本里，`target.uid` 都恒为原始收件人。因此不能直接拿 `target.uid` 当"会话对方"——如果 `from_uid` 就是我自己，会话对方才是 `target.uid`；否则会话对方就是 `from_uid` 本身。`SaveMessages` 在写入时用当前账号的 uid 完成这一推导，写入 `peer_uid`，`history --with-user` 直接按 `peer_uid` 查询。群消息没有这个问题，`group_id` 在所有副本里恒定。

### 3.2 `sync_state`

`key/value` 表，两个 key：

- `last_synced_seq`：`sync` 命令已追平的 `sync_messages` 游标。
- `ai_cursor_seq`：AI 上次处理完成的最大 seq，由 `ai-cursor set` 写入、`pending`/`ai-cursor get` 读取，用于驱动"取新消息 → 处理 → 推进游标"的轮询，重启后从这里继续，不重复处理。

两个游标都是账号级（跟 `sync_messages` 的 seq 域一致），不是按会话分别维护。

## 4. 子命令一览

所有命令把结果编码为一段 JSON 打印到 stdout；成功时顶层 `"ok": true`，失败时 `"ok": false` 且带 `"error"`，同时进程以退出码 1 结束——调用方（AI）只需检查退出码或 `ok` 字段即可判断成败，无需额外解析 stderr。

| 命令 | 作用 |
|---|---|
| `login` | 用户名密码登录并保存 token 到本地，下次调用无需再登录 |
| `accounts` | 列出 `--dir` 下所有已登录账号 |
| `sync` | 增量同步消息到本地（循环 `sync_messages` 直至追平） |
| `send` | 给好友（`--to-user`）或群（`--to-group`）发文本或 Markdown 消息 |
| `history` | 从本地同步库查询与某人（`--with-user`）或某群（`--with-group`）的聊天记录 |
| `pending` | 查询本地同步库中 seq 大于给定游标（默认取 `ai-cursor`）的消息，默认排除自己发出的消息 |
| `ai-cursor get` / `ai-cursor set` | 查询 / 记录 AI 上次处理到的最大 seq |
| `user-info` | 批量查询用户展示资料 |
| `group-info` | 批量查询群展示资料 |
| `contacts` | 列出好友 / 收藏群（默认 `status=friend`，支持分页读取待处理好友申请） |

完整参数见 `yimsg-cli --help` 或 `cli/README.md`。

## 5. 消息发送与 msg_id

`msg_id` 必须由发起消息的客户端生成（见根 `CLAUDE.md` 项目不变量：UUIDv7 的 base64url 编码，固定 22 字符）。`cli/msgid` 独立实现同一套算法，`send` 命令据此为每条消息生成 `msg_id`，服务端只做校验、保存、回传与按 `(uid, msg_id)` 幂等。

## 6. 测试

- `cli/wire`、`cli/store`、`cli/account`：纯 Go 单元测试，不依赖网络。`cli/wire` 额外用与 `server/internal/ws`、TypeScript SDK 相同的 golden vector 验证帧字节完全一致。
- `cli/tests/e2e`：对已启动的真实服务端，编译并以子进程方式驱动 `yimsg-cli` 二进制本身（而非直接调用内部包），覆盖 login 落盘 token 复用、send/sync/history/pending/ai-cursor 全链路、user-info/group-info/contacts、非法参数本地拒绝。运行方式与 `server/tests/e2e` 一致，由 `tools/run_all_tests.sh` 统一启动服务端后执行。
