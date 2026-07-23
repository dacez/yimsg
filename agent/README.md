# yimsg-agent

多账号自动回复常驻进程：登录多个 yimsg 账号，循环拉取每个账号收到的消息（最小间隔 1 秒，每轮最多拉取 `max_pull` 条，默认 30），调用 DeepSeek 官方 API 生成回复——可以直接回答，也可以先规划再分步执行，每步执行完发一条纯文本进度消息，执行过程中可以只读访问该账号专属文件夹下的 Markdown 文件（不能越出该文件夹），文件较多或较长时可以先用类似 grep 的正则搜索定位关键字（纯文本匹配，不用向量数据库），命中前后各返回多少字符的上下文由模型自己决定。每个账号有独立的处理进度游标和独立的记忆，处理完一批消息后回写。设计方案见 [`docs/agent方案.md`](docs/agent方案.md)。

## 构建

```bash
go build -o yimsg-agent ./agent/cmd/yimsg-agent
```

## 配置文件方式（推荐，多账号）

```toml
# agent.toml
[deepseek]
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"

[agent]
server = "ws://127.0.0.1:8080/ws"
data_dir = "./agent_data"
poll_interval_seconds = 2
max_pull = 30

[[accounts]]
username = "bot1"
password_env = "YIMSG_AGENT_BOT1_PASSWORD"
workspace_dir = "./workspaces/bot1"

[[accounts]]
username = "bot2"
password_env = "YIMSG_AGENT_BOT2_PASSWORD"
workspace_dir = "./workspaces/bot2"
```

```bash
export DEEPSEEK_API_KEY=sk-xxx
export YIMSG_AGENT_BOT1_PASSWORD='******'
export YIMSG_AGENT_BOT2_PASSWORD='******'
./yimsg-agent -config agent.toml
```

## 命令行方式（单账号快速启动 / 调试）

```bash
./yimsg-agent \
  -server ws://127.0.0.1:8080/ws \
  -username bot1 --password "$YIMSG_AGENT_BOT1_PASSWORD" \
  -workspace ./workspaces/bot1 \
  -deepseek-api-key-env DEEPSEEK_API_KEY \
  -data-dir ./agent_data
```

也可以用重复的 `-account "username:password:workspace_dir"` 一次传入多个账号；密码会出现在进程参数列表里，仅建议本地调试使用，生产场景请用配置文件 + `password_env`。

## 完整配置项、目录布局、计划/执行引擎、记忆结构

见 [`docs/agent方案.md`](docs/agent方案.md)，尤其是第 6 节"计划与多步执行引擎"和第 11 节"与业内通用执行引擎的差距"。

## 测试

- `agent/config`、`agent/fsread`、`agent/state`、`agent/deepseek`、`agent/engine`：纯 Go 单元测试，不依赖真实网络（DeepSeek 调用用 `httptest` 模拟）。
- `agent/tests/e2e`：对已启动的真实服务端 + 模拟 DeepSeek 接口，编译并驱动 `yimsg-agent` 二进制本身，覆盖完整轮询-处理-回复链路。运行方式与 `cli/tests/e2e` 一致，由 `tools/run_all_tests.sh` 统一启动服务端后执行。
