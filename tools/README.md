# 工具目录

> 主要对照：`tools/scripts/`、`tools/scripts/tests/`、`tools/release/`、`tools/cmd/protocolgen/`、`tools/cmd/check-docs-consistency/`、根目录 `AGENTS.md`。
> 最后复核：2026-07-29。
> 触发更新：新增仓库级脚本、Go 工具命令或调整测试 / 文档校验入口时同步更新。
> 入口关系：上级索引见 [`../docs/README.md`](../docs/README.md)；测试策略见 [`../docs/development/测试方案.md`](../docs/development/测试方案.md)。

## 目录约定

| 路径 | 职责 |
|---|---|
| `scripts/` | shell 脚本真实实现，包含全量测试编排、文档校验、覆盖率、质量门禁、发行包构建和服务器环境初始化 |
| `scripts/tests/` | 分类测试实现及无副作用的共用环境函数；由根目录稳定入口或全量脚本调用 |
| `release/` | 复制进公开发行包的中英文快速开始 |
| `cmd/protocolgen/` | protobuf 协议生成器，负责调用 `protoc-gen-go` / `ts-proto` 刷新 Go / TypeScript protobuf 生成物 |
| `cmd/check-docs-consistency/` | 文档、schema、接口和 SDK 清单一致性检查 |
| `cmd/package-release/` | 使用 Go 标准库生成跨平台发行用 zip / tar.gz，避免依赖系统压缩工具 |
| `cmd/seed-data/` | 本地演示数据生成 |
| `cmd/test-seed/` | Playwright / E2E 测试数据生成 |

根目录下的 `tools/*.sh` 是兼容入口，供文档、CI 和开发者使用稳定命令；新增公开 shell 入口仍应在根目录提供同名薄包装，真实实现放到 `tools/scripts/` 或 `tools/scripts/tests/`。

## 测试入口

| 入口 | 内容 | 服务端行为 |
|---|---|---|
| `./tools/run_unit_tests.sh` | Go 非 E2E、SDK 单元、UIKit 单元、Web 单元 | 不启动服务端 |
| `./tools/run_integration_tests.sh` | SDK 与真实服务端集成 | 独立运行时自行启动临时服务 |
| `./tools/run_e2e_tests.sh` | Server、CLI、Agent E2E 与 Web Chromium E2E | 三组 Go E2E 共用临时服务；Web E2E 另用独立 seed、数据目录和随机端口 |
| `./tools/run_component_tests.sh` | BoundedList Chromium 组件功能测试 | 使用独立 browser harness，不启动服务端 |
| `./tools/run_performance_tests.sh` | BoundedList Chromium 大数据容量与性能门禁 | 使用独立 browser harness，固定单 worker，不启动服务端 |
| `./tools/run_all_tests.sh` | 协议生成、文档一致性及 unit → integration → E2E → component | 依赖和构建只准备一次，集成与 Go E2E 复用一个服务；不包含性能分类 |

每个分类入口都可以独立执行。`run_all_tests.sh` 通过显式环境上下文复用已准备的依赖、前端产物、服务端二进制和集成 / Go E2E 服务；Web E2E 仍由 `apps/web/tests/support/global-setup.ts` 创建隔离数据和服务进程，只复用二进制与前端构建。性能门禁按设计保持独立，涉及 BoundedList 性能路径时需在全量正确性测试之外另行执行。

全量测试会准备前端依赖、安装 Playwright Chromium 依赖，并把固定版本的 `protoc-gen-go` 安装到 `$(go env GOPATH)/bin` 后再运行协议生成。公开发行包由 `bash tools/scripts/build_release.sh <version>` 构建，输出 Windows x86-64、Linux x86-64 / ARM64、macOS ARM64 四个平台压缩包及 `SHA256SUMS.txt`。服务器环境初始化入口是 `tools/init_server_env.sh <ssh-alias>`，用于按 `docs/deployment/部署方案.md` 标准化各台独立服务器（当前实际是 `yimsg-se`）的账号、目录、配置、systemd unit 和证书权限。Windows 本机部署（研发/演示用，见 `docs/deployment/部署方案.md` 第 11 节）由 `tools/scripts/install-windows-autostart.ps1`（首次注册开机自启计划任务）和 `tools/scripts/deploy-windows-local.ps1`（后续更新：编译、替换产物、跑 `seed-demo`、重启计划任务）两个脚本负责，均需在管理员 PowerShell 中运行。
