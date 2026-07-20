# yimsg-cli 方案

> 主要对照：`cli/` 目录下的 Go 实现与 `cli/cmd/yimsg-cli/main.go` 的子命令列表。
> 最后复核：2026-07-20。
> 触发更新：新增/修改子命令、本地存储 schema 或账号目录布局时同步更新。
> 入口关系：本文件是 `cli/` 的组件专属方案文档；跨组件文档导航见 [`../../docs/README.md`](../../docs/README.md)。

## 1. 定位

`yimsg-cli` 是一个独立的 Go WebSocket 客户端命令行工具，供 AI（或其它自动化脚本）调用，实现"自动回复"这类场景：登录一次、把消息增量同步到本地、按会话查询历史、记录/查询自己上次处理到的消息进度、查询好友或群资料、给好友或群发消息。它不是给终端用户交互使用的聊天客户端，因此没有 TUI，只有"一次调用、输出一段 JSON、退出"的批处理式命令。

它与 `packages/sdk`（TypeScript SDK）、`server/internal/ws` 一样，各自独立实现同一份 `protocol/yimsg.proto` 定义的二进制帧协议（见 `cli/wire`、`cli/msgid`），不依赖服务端 `internal` 包。

## 2. 账号目录布局与"当前账号"

调用方指定一个根目录（`--dir` 或环境变量 `YIMSG_CLI_DIR`；都不传则默认使用当前工作目录下的 `cli_data`，不存在会自动创建），不需要为不同账号切换不同文件夹——根目录的二级目录固定为账号 `uid`：

```text
<dir>/
  current.json    # {uid, username} 指针：未显式 switch-user 时默认操作哪个账号
  <uid>/
    session.json   # {uid, username, token, server_url, login_at}
    data.db        # 本地同步库（SQLite），见第 3 节
```

`login` 命令负责创建 `<dir>/<uid>/` 并写入 `session.json`，同时把这个账号写进 `current.json` 设为当前账号。`switch-user --username U` 把 `current.json` 指向本地已经 `login` 过的另一个账号。除 `login`/`switch-user` 外，其它子命令一律不接受、也不需要自己的 uid 作为参数——这不只是图方便：协议本身也不需要（身份永远来自已鉴权连接的 token，业务代码不信任 body 里的身份字段，见根 `CLAUDE.md` 项目不变量），子命令读取 `current.json` 找到 `<uid>/session.json` 里保存的 token 完成鉴权即可，token 失效时报错提示重新执行 `login`，不做静默降级。

`current.json` 只存 `{uid, username}` 指针，token 永远以 `<uid>/session.json` 为唯一权威来源，避免出现两份可能不一致的 token 副本（例如 `switch-user` 切走又切回来之后，读到的还是最新 token）。

**并发注意**：`current.json` 是同一个根目录下所有进程共享的单个指针。如果要在同一个根目录下并发运行多个进程分别扮演不同账号，需要各自在操作前 `switch-user` 且避免互相竞争，否则可能读到对方刚切换过去的账号；更简单可靠的做法是每个机器人账号各用一个独立的根目录。

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

### 3.2 增量同步游标

`sync` 命令已追平的 `sync_messages` 游标不单独持久化，直接取 `messages` 表的 `MAX(seq)`：`sync_messages` 响应的 `cursor_seq` 恒等于当次返回消息（含 tombstone）里的最大 `seq`，落库后二者天然一致，无需再维护一份独立的同步状态表。

`pending` 命令用于取本地已同步、`seq` 大于给定游标的增量消息，游标（`--after-seq`）必须由调用方显式传入，CLI 不再代为持久化"AI 处理到哪了"；调用方（AI 或驱动它的自动化脚本）自行记录上一次 `pending` 返回的 `max_seq`，下次调用时原样传回即可实现"取新消息 → 处理 → 推进游标"的轮询。

### 3.3 `users`

`(uid, username)` 的本地缓存，不是同步域，只是"这个 uid 对应哪个用户名"的确定性记录：`send --to-user`/`history --with-user` 按用户名解析出 uid 后写入这里，之后同一个用户名不用再联网解析；同时 `history`/`pending` 输出消息时会尽量按这张表把裸 `from_uid`/`to_uid` 补上 `from_username`/`to_username`，查不到就只输出裸 uid（不强行为此发起网络请求，保证这两个查询命令默认离线可用）。`contacts`/`user-info` 命令每次都会把查到的 `(uid, username)` 顺手写回这张表。

## 4. 子命令一览

所有命令把结果编码为一段 JSON 打印到 stdout；成功时顶层 `"ok": true`，失败时 `"ok": false` 且带 `"error"`，同时进程以退出码 1 结束——调用方（AI）只需检查退出码或 `ok` 字段即可判断成败，无需额外解析 stderr。

除 `login`/`switch-user` 外，以下命令都对"当前账号"（`current.json` 指向的账号）操作，不接受自己的 uid：

| 命令 | 作用 |
|---|---|
| `login` | 用户名密码登录并保存 token 到本地，同时设为当前账号 |
| `switch-user` | 按 `--username` 切换当前账号（必须是本地已 `login` 过的账号） |
| `current` | 查看当前账号 |
| `accounts` | 列出 `--dir` 下所有已登录账号，并标出哪个是当前账号 |
| `sync` | 增量同步消息到本地（循环 `sync_messages` 直至追平） |
| `send` | 给好友（`--to-user USERNAME`）或群（`--to-group GROUP_ID`）发文本或 Markdown 消息 |
| `history` | 从本地同步库查询与某人（`--with-user USERNAME`）或某群（`--with-group GROUP_ID`）的聊天记录 |
| `pending` | 查询本地同步库中 seq 大于给定游标（`--after-seq`，必填）的消息，默认排除自己发出的消息 |
| `user-info` | 按 `--usernames` 查询用户展示资料（内部用 `search_user`，逐个精确匹配） |
| `group-info` | 按 `--groups`（group_id）查询群展示资料 |
| `contacts` | 列出好友 / 收藏群（默认 `status=friend`，支持分页读取待处理好友申请），用户条目附带 `username`、群条目附带 `name` |

人（好友）一律用用户名指代，群没有用户名概念，只能继续用数字 `group_id`。完整参数见 `yimsg-cli --help` 或 `cli/README.md`。

## 5. 消息发送与 msg_id

`msg_id` 必须由发起消息的客户端生成（见根 `CLAUDE.md` 项目不变量：UUIDv7 的 base64url 编码，固定 22 字符）。`cli/msgid` 独立实现同一套算法，`send` 命令据此为每条消息生成 `msg_id`，服务端只做校验、保存、回传与按 `(uid, msg_id)` 幂等。

## 6. 测试

- `cli/wire`、`cli/store`、`cli/account`：纯 Go 单元测试，不依赖网络。`cli/wire` 额外用与 `server/internal/ws`、TypeScript SDK 相同的 golden vector 验证帧字节完全一致。
- `cli/tests/e2e`：对已启动的真实服务端，编译并以子进程方式驱动 `yimsg-cli` 二进制本身（而非直接调用内部包），覆盖 login 落盘 token 复用与自动置为当前账号、switch-user/current 切换、按用户名 send/history（含本地缓存未命中时的一次性回源解析）、sync/pending（含缺失 `--after-seq` 时的本地拒绝）全链路、user-info/group-info/contacts、非法参数与未登录场景本地拒绝。运行方式与 `server/tests/e2e` 一致，由 `tools/run_all_tests.sh` 统一启动服务端后执行。
