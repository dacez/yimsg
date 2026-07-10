# 工具目录

> 主要对照：`tools/scripts/`、`tools/cmd/protocolgen/`、`tools/cmd/check-docs-consistency/`、根目录 `AGENTS.md`。
> 最后复核：2026-07-11。
> 触发更新：新增仓库级脚本、Go 工具命令或调整测试 / 文档校验入口时同步更新。
> 入口关系：上级索引见 [`../docs/README.md`](../docs/README.md)；测试策略见 [`../docs/测试方案.md`](../docs/测试方案.md)。

## 目录约定

| 路径 | 职责 |
|---|---|
| `scripts/` | shell 脚本真实实现，包含全量测试、文档校验、覆盖率、质量门禁和服务器环境初始化 |
| `cmd/protocolgen/` | protobuf 协议生成器，负责调用 `protoc-gen-go` / `ts-proto` 刷新 Go / TypeScript protobuf 生成物 |
| `cmd/check-docs-consistency/` | 文档、schema、接口和 SDK 清单一致性检查 |
| `cmd/seed-data/` | 本地演示数据生成 |
| `cmd/test-seed/` | Playwright / E2E 测试数据生成 |
| `cmd/debug-messages/` | 消息调试辅助命令 |

根目录下的 `tools/*.sh` 是兼容入口，供文档、CI 和开发者继续使用稳定命令；新增脚本实现应放到 `tools/scripts/`。全量测试入口 `tools/scripts/run_all_tests.sh` 会准备前端依赖、安装 Playwright Chromium 依赖，并把固定版本的 `protoc-gen-go` 安装到 `$(go env GOPATH)/bin` 后再运行协议生成。服务器环境初始化入口是 `tools/init_server_env.sh <ssh-alias>`，用于按 `docs/部署方案.md` 标准化各台独立服务器（当前实际是 `yimsg-se`）的账号、目录、配置、systemd unit 和证书权限。Windows 本机部署（研发/演示用，见 `docs/部署方案.md` 第 11 节）由 `tools/scripts/install-windows-autostart.ps1`（首次注册开机自启计划任务）和 `tools/scripts/deploy-windows-local.ps1`（后续更新：编译、替换产物、跑 `seed-demo`、重启计划任务）两个脚本负责，均需在管理员 PowerShell 中运行。
