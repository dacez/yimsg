# Yimsg Copilot Instructions

## 全局规则
+ 只能使用中文和英文，不准使用任何其它语言：回答、代码、注释、文档、提交信息一律如此，且以中文为主；必须使用中文回应用户。图尽量使用 mermaid，使用 ASCII 图要注意对齐。
+ 所有修改之前，先判断是否合理，不合理就不要改动，拒绝。
+ 只有在修改代码时才执行完整变更流程：完善文档，完善测试用例，修改代码，删除无用的代码，最后从仓库根目录运行 `./tools/run_all_tests.sh`。
+ 修改代码后，无论在本地、远程沙箱、CI 还是任何其它环境，都必须从仓库根目录完整运行 `./tools/run_all_tests.sh` 全量测试，不得以环境受限为由跳过或只跑部分测试；运行完成后必须把每一步（Go 单测、E2E、前端 unit/sdk/ui 等）的通过 / 失败结果明确输出告诉用户。
+ 全量测试脚本因环境问题（依赖缺失、端口占用、浏览器未安装等）无法跑完时，必须尽最大努力自行排查并解决该环境问题，保证 `./tools/run_all_tests.sh` 能完整跑完，不得因环境受限而放弃或改为跳过。
+ 等待长耗时命令（全量测试脚本、下载安装等后台任务）的结果时，每次查看间隔不得超过 30 秒，分批查看进度并及时反馈，不得一次性静默等待整个命令跑完。
+ 任何数据库 schema 变更和接口变更都要先征求确认。
+ 项目处于研发阶段，不做 migration、ALTER TABLE 升级逻辑或旧数据兼容，只要最优雅的代码。
+ 过期的文档放到 ./docs/archive 里面。
+ 如果需要部署，线上服务器相互独立，当前实际部署 `ssh yimsg-se`（首尔）一台，登录对应服务器后部署；部署脚本支持按同样步骤增加更多独立服务器，详见 `docs/部署方案.md`。
+ 修改任何文档（含本指南三份文件）后，必须从仓库根目录运行 `go run ./tools/cmd/check-docs-consistency/`（或 `./tools/scripts/check_docs_consistency.sh`）校验文档一致性。
+ 仓库同时维护 `AGENTS.md`、`.github/copilot-instructions.md`、`CLAUDE.md` 三份编码指南，分别供 Agent/Codex、GitHub Copilot、Claude 使用；除各自标题（`Yimsg Agent Guide`、`Yimsg Copilot Instructions`、`Yimsg Claude Guide`）外，正文内容必须完全一致。主动修改其中任意一份时，必须把改动同步到另外两份。

## 项目不变量
- 服务端主接口是 WebSocket 二进制帧，协议单一事实源是 `internal/protocol/yimsg.proto`。帧格式固定为 `magic:uint8('M') + codec:uint8(bitfield) + reserved:uint8(0) + checksum:uint8(CRC-8) + size:uint16 + request_id:uint64 + type:uint16 + body`：`codec` 从低位到高位为 bit0 endian（0=big-endian，1=little-endian）、bit1-4 version（当前 1）、bit5-7 保留且必须为 0，并与后续 reserved 字节连续；HTTP 仅用于上传、静态资源和媒体文件访问。协议整包上限是 `0xffff` 字节，header 为 16 字节，所以 `size` 最大是 `65519`；校验码按 checksum 字节置 0 后对整包计算 CRC-8（poly `0x07`，init `0x00`）；`type=0` 是无效值，服务端通知固定使用 `request_id=0` 且 `type` 为通知段枚举值。
- 每个接口在 protobuf 中必须有独立 Request / Response。`uid` 与 `request_id` 由 WebSocket 帧头解析后填入 Go 端 `BaseInfo` 结构体，作为每个业务方法的第一个参数传入（proto 中不再包含 `BaseRequest`）。Response 通过 `BaseResponse base = 1` 承载 `ErrorCode code` 和 `msg`，业务字段从 10 开始。业务代码不能信任或修改客户端 body 中的身份字段。
- 除 `ErrorCode` 的 `0` 表示 `OK` 外，protobuf enum 的 `0` 都只能表示 invalid / reserved / error，真实业务枚举值从 1 开始。
- 数据按 `uid`、`username`、`group_id`、`token` 四类路由键分片；跨表聚合在应用层完成，路由分片键不在同一个分片的表绝对不能 JOIN，在同一分片，尽量避免 JOIN。
- 同步模型是"轻通知 + 主动拉取"：服务端 WebSocket notification 只提示某类数据变化，客户端通过 `get_*` / `sync_*`、分页和 seq 游标追平。
- `msg_id` 全项目统一为 string：UUIDv7 的 base64url 编码（固定 22 字符），禁止任何二进制 UUID 表示（bytes / `[16]byte` / `Uint8Array` / `msg_id_bin` 等）。用户消息的 `msg_id` 只由 TypeScript SDK 生成并随 `send_message` 上送，服务端只做校验、保存、回传与按 `(uid, msg_id)` 幂等，缺失或非法直接拒绝；禁止服务端为用户消息补生成 `msg_id`。系统消息一律由服务端发起、无 SDK 来源，因此**只有系统消息**可以使用服务端生成的 UUID（同一 UUIDv7 base64url 方案）。消息顺序只依赖 `seq` / `send_time`，不得以 `msg_id` 排序。
- 研发阶段本地持久库或服务端 schema 不做迁移；schema 版本不匹配时优先重建并重新同步。

## 快速入口
- 服务端启动入口：`cmd/server/main.go`。启动流程是加载配置、合并插件 schema、打开四类 SQLite 分片、打开异步任务队列并启动 worker、重放未完成任务、启动 GC 和插件任务，然后挂载 `/ws`、`/api/upload`、`/media/` 与静态前端。
- WebSocket 分发入口：`internal/ws/connection.go`。`dispatch` 按 action 调用 service，认证上线 / 登出清理在连接层处理；群消息 fanout 在 service 内投递到异步任务队列，dispatch 不感知。
- 服务端状态与分片路由入口：`internal/service/state.go`。新增 Store 访问或跨分片读取时，先确认路由键和应用层聚合边界。
- 数据库 schema 入口：`internal/dal/schema.go`；字段说明权威文档是 `docs/server/db/schema字段对照.md`。
- 协议单一事实源：`internal/protocol/yimsg.proto`。改 action、字段、错误码、Type、BaseRequest/BaseResponse 或 notification 时，先改 proto，再运行 `go run ./tools/cmd/protocolgen` 刷新生成物。
- 前端 SDK 公开入口：`frontend/src/sdk/client.ts` 和 `frontend/src/sdk/index.ts`。SDK 必须保持 UI 无关，长期内存状态必须有上限、淘汰策略或释放路径。
- 前端运行时核心：`frontend/src/sdk/client-session-runtime.ts`、`frontend/src/sdk/datagateway/`。`memory` 模式不保存完整本地副本，`persistent` 模式通过本地 SQLite/OPFS 同步副本读取。
- UIKit 嵌入入口：`frontend/src/uikit/embed.ts`；主应用和嵌入式 UIKit 共享 `frontend/src/uikit/app/views/` 下的视图。
- 文档索引入口：`docs/README.md`；服务端看 `docs/server/README.md`，前端看 `docs/frontend/README.md`，测试看 `docs/测试方案.md`。

## 文件结构速览
- `cmd/server/`：服务端启动入口和进程装配。
- `internal/protocol/`：protobuf 源、协议目录、帧编解码、Go 生成物和 wire 辅助。
- `internal/ws/`：WebSocket 连接状态、二进制 frame 收发、action dispatch 和通知转发。
- `internal/service/`：业务用例层，负责校验、跨 Store 编排、通知触发和 fanout 任务。
- `internal/dal/`：SQLite schema、分片 Store 和底层数据访问。
- `internal/online/`、`internal/taskqueue/`：在线连接注册 / 通知缓冲；通用持久化异步任务队列，承载群消息 / 系统消息扇出并在崩溃后重放。
- `frontend/src/sdk/`：对外 SDK、transport、协议生成物、同步运行时和 DataGateway。
- `frontend/src/uikit/`：主应用 / 嵌入式 UIKit 的视图、组件和挂载入口。
- `tests/e2e/`：后端 WebSocket/HTTP 端到端测试；`frontend/tests/`：SDK unit / integration 和 Playwright UI 测试。
- `tools/scripts/`：仓库级 shell 脚本真实实现；`tools/*.sh` 仅作为兼容入口。
- `tools/cmd/protocolgen/`、`tools/cmd/check-docs-consistency/`、`tools/cmd/seed-data/`、`tools/cmd/test-seed/`、`tools/cmd/seed-demo/`、`tools/cmd/debug-messages/`：Go 工具命令目录。
- `tools/internal/seedkit/`：seed-data / test-seed / seed-demo 共用的 service 层调用样板（BaseInfo 构造、响应判定、常见 ConversationTarget/MessageBody 构造）。
- `tools/protocolgen/`：protocolgen 的 proto 解析、manifest 与 Go / TS / Markdown 生成库；协议机械映射生成物落在 `internal/ws/*_gen.go` 与 `frontend/src/sdk/generated/{actions,notifications}.gen.ts`。
- `docs/`：长期设计文档；生成类协议速查位于 `docs/generated/`，过期文档放 `docs/archive/`。

## 变更检查点
- 改 WebSocket interface、请求/响应字段、错误码、notification、`client_config`：同步 `internal/protocol/yimsg.proto`、生成物、`docs/接口总览.md`、相关服务端/前端文档和测试。
- 改服务端业务：优先查 `internal/service/*`、`internal/dal/*_store.go`、`tests/e2e/` 和对应 `docs/server/` 专题；涉及推送时确认在线注册先于认证响应的时序。
- 改同步域：同步检查 DAL 的 `List/Sync/GetVersion/Purge`、Service 写路径、WebSocket action、SDK DataGateway、持久本地表、通知和 `docs/同步机制方案.md`。
- 改前端 SDK API：同步 `docs/frontend/sdk接口说明.md`、`docs/frontend/sdk设计方案.md`、`frontend/tests/unit/sdk/` 和必要的 integration 测试。
- 改 UIKit/UI：同步 `docs/frontend/UIKit方案.md` 或 `docs/frontend/UI设计方案.md`，同时关注主应用和嵌入式 UIKit 两种宿主。
- 改配置默认值：同步 `config.toml`、`internal/config/config.go`、`README.md` 或对应服务端文档。

## 全量测试脚本说明
- `./tools/run_all_tests.sh` 会准备前端依赖、安装 Playwright Chromium 浏览器、拉起服务端，再执行 Go 单测、E2E、前端 unit / sdk / ui 测试。
- 若只修改文档或聊天定制文件，可不运行全量测试。
