# Yimsg 文档索引

> 主要对照：`docs/` 实际文件树、根 `README.md`、服务端 / 前端二级索引、`tools/scripts/check_docs_consistency.sh`。
> 最后复核：2026-07-16。
> 触发更新：`docs/` 文档增删改名、阅读路径或维护口径变化时同步更新。
> 入口关系：仓库根目录 [`../README.md`](../README.md) 面向首次进入项目的读者；本文件是 `docs/` 内部导航、文档分层和维护口径的单一入口。

## 目录

- [1. 文档架构原则](#1-文档架构原则)
- [2. 文档树](#2-文档树)
- [3. 推荐阅读路径](#3-推荐阅读路径)
- [4. 文档变更检查清单](#4-文档变更检查清单)
- [5. 专题文档模板](#5-专题文档模板)
- [6. 历史内容处理规则](#6-历史内容处理规则)
- [7. 文档维护约定](#7-文档维护约定)

## 1. 文档架构原则

Yimsg 文档按“读者任务”而不是“历史迭代记录”组织：

1. **唯一导航**：本文 §2 的文档树是全仓库唯一一份文档清单；二级索引（`protocol/`、`server/`、`frontend/` 的 README）只做本目录内的分组和代码对照，不重复维护全局树。
2. **按域分层**：`protocol/` 收拢对外契约（协议治理、接口总览、生成速查表）；`server/`、`frontend/` 对应各自代码目录；跨端横切机制（同步）与工程操作（测试、部署）留在顶层。
3. **单一事实源**：每个事实只在一处维护——帧格式在 `protocol/README.md`，接口矩阵在 `protocol/接口总览.md`，SDK 公开 API 在 `frontend/sdk/sdk接口说明.md`，UIKit 挂载 API 在 `frontend/uikit/UIKit方案.md`，推送触发矩阵在 `server/推送事件方案.md`，表结构在 `server/db/schema字段对照.md`；其余文档只链接，不复述。
4. **前端按职责分组**：`frontend/sdk/` 面向 SDK 使用者和维护者；`frontend/uikit/` 面向 UI / 嵌入宿主；`前端设计方案.md` 是两组之上的总览。
5. **专题只保留当前实现**：历史 patch 式说明合并回权威文档；不为已落地的局部改造保留单独文档。
6. **过程产物归档**：评估、治理记录等过程文档进入 [`archive/`](archive/)，不作为当前事实源。

## 2. 文档树

```text
docs/
├── README.md                    — 本文件，唯一文档地图与维护口径
├── 同步机制方案.md              — 消息、通讯录、屏蔽列表、免打扰、会话、组织关系的通用同步机制（跨服务端 / SDK）
├── 测试方案.md                  — 测试分层、全量执行、重点覆盖
├── 部署方案.md                  — 服务端 + 前端产物部署到自建服务器的操作手册
├── protocol/                    — 对外契约域
│   ├── README.md                — 协议治理：帧格式权威说明、单一事实源、代码生成规则
│   └── 接口总览.md              — 接口契约权威：分层规范、SDK ↔ 服务端映射、服务端接口矩阵、错误码
├── generated/                   — protocolgen 生成的协议速查表（禁止手工编辑）
│   ├── 协议接口表.md            — 逐 action / notification 的 type 与字段速查
│   └── protocol_manifest.json   — 协议中间清单
├── server/                      — 服务端域
│   ├── README.md                — 服务端二级索引：分组、代码对照、阅读顺序
│   ├── 服务器架构方案.md        — 模块、启动、WebSocket dispatch、PostAction、GC
│   ├── 插件架构方案.md          — 后端插件接口、宿主能力、协议扩展机制
│   ├── 推送事件方案.md          — Notification 类型、触发矩阵（权威）、客户端桥接
│   ├── 多媒体资源方案.md        — HTTP 上传、静态资源访问、消息类型扩展
│   ├── 关系与会话偏好方案.md    — 屏蔽列表、会话免打扰、未读 / 红点
│   ├── 消息能力方案.md          — Markdown / 引用 / 转发 / @ 提及 / 撤回
│   ├── 组织架构方案.md          — 组织通讯录：org 分片、tag 图、成员资格、管理权限
│   └── db/                      — 数据库分片、表结构、GC
│       ├── 数据库设计总览.md    — 分片组、表清单、全局约束、GC 总览
│       ├── schema字段对照.md    — 全部表字段、主键、索引对照（权威转录）
│       ├── 用户数据库设计.md    — user_lookup / user_info 与注册登录约束
│       ├── 登录态数据库设计.md  — session / user_session 与踢下线、GC
│       ├── 通讯录数据库设计.md  — 联系人、收藏群、增量同步、排序缓存名
│       ├── 消息数据库设计.md    — 消息收件箱、会话物化视图、消息 / 会话 GC
│       └── 群数据库设计.md      — 群属性、成员关系、成员分页读取
├── frontend/                    — 前端域
│   ├── README.md                — 前端二级索引：分组、代码对照、阅读顺序
│   ├── 前端设计方案.md          — 前端总览：运行形态、分层、存储、启动装配
│   ├── sdk/                     — SDK 子域
│   │   ├── sdk设计方案.md       — SDK 内核、状态机、DataGateway、缓存、内存边界
│   │   ├── sdk接口说明.md       — SDK 公开 API 权威：方法、事件、类型、前置条件
│   │   ├── DataGateway接口.md   — DataGateway 内部接口与 instant / persistent 差异
│   │   ├── DisplayInfoCache接口.md — 展示信息缓存内部接口与设计决策
│   │   └── 有界集合方案.md      — BoundedU64Map / Set / Queue 基础设施与峰值内存估算
│   └── uikit/                   — UIKit / UI 子域
│       ├── UIKit方案.md         — UIKit 挂载 API 权威：mount、MountOptions、构建产物、宿主接入
│       ├── UI设计方案.md        — 视图结构、交互、状态管理、样式系统
│       ├── 有界消息流窗口设计方案.md — 列表渲染引擎：数据窗口、渲染窗口、分页锚点
│       └── UIKit阅读指南.md     — 面向后端读者的 HTML / CSS / DOM 入门导读
└── archive/                     — 历史记录归档（仅供追溯，不作为当前事实源）
    ├── README.md                — 归档边界与收纳规则
    ├── 文档治理历史.md          — 历次文档合并、删除、迁移与重组记录
    └── 项目文档评估.md          — 2026-06 文档治理评估快照（已归档）
```

## 3. 推荐阅读路径

| 目标 | 阅读顺序 |
|---|---|
| 首次了解项目 | [`../README.md`](../README.md) → 本文 → [`server/服务器架构方案.md`](server/服务器架构方案.md) → [`frontend/前端设计方案.md`](frontend/前端设计方案.md) |
| 修改服务端业务 | [`server/README.md`](server/README.md) → [`server/服务器架构方案.md`](server/服务器架构方案.md) → [`protocol/接口总览.md`](protocol/接口总览.md) → 对应专题 / `server/db/` 文档；涉及同步时先读 [`同步机制方案.md`](同步机制方案.md) |
| 修改协议契约或生成策略 | [`protocol/README.md`](protocol/README.md) → [`protocol/接口总览.md`](protocol/接口总览.md) → [`server/服务器架构方案.md`](server/服务器架构方案.md) → [`frontend/sdk/sdk接口说明.md`](frontend/sdk/sdk接口说明.md) |
| 修改数据库或存储实现 | [`server/db/数据库设计总览.md`](server/db/数据库设计总览.md) → [`server/db/schema字段对照.md`](server/db/schema字段对照.md) → 对应领域数据库文档 → [`protocol/接口总览.md`](protocol/接口总览.md) |
| 修改前端主应用 | [`frontend/README.md`](frontend/README.md) → [`frontend/前端设计方案.md`](frontend/前端设计方案.md) → [`frontend/uikit/UIKit方案.md`](frontend/uikit/UIKit方案.md) → [`frontend/uikit/UI设计方案.md`](frontend/uikit/UI设计方案.md) |
| 修改 SDK | [`frontend/README.md`](frontend/README.md) → [`frontend/sdk/sdk设计方案.md`](frontend/sdk/sdk设计方案.md) → [`frontend/sdk/sdk接口说明.md`](frontend/sdk/sdk接口说明.md) → [`protocol/接口总览.md`](protocol/接口总览.md)；涉及 DataGateway 同步时先读 [`同步机制方案.md`](同步机制方案.md) |
| 接入嵌入式 UIKit | [`frontend/uikit/UIKit方案.md`](frontend/uikit/UIKit方案.md) → [`frontend/sdk/sdk接口说明.md`](frontend/sdk/sdk接口说明.md) |
| 核对测试 | [`测试方案.md`](测试方案.md) → [`../tools/run_all_tests.sh`](../tools/run_all_tests.sh) |
| 部署上线 | [`部署方案.md`](部署方案.md) → [`../tools/build.sh`](../tools/build.sh) |

## 4. 文档变更检查清单

| 变更类型 | 必须同步的文档 | 建议校验 |
|---|---|---|
| 改 WebSocket action、请求 / 响应字段或通知 | [`protocol/README.md`](protocol/README.md) → [`protocol/接口总览.md`](protocol/接口总览.md) → 对应服务端专题 → [`frontend/sdk/sdk接口说明.md`](frontend/sdk/sdk接口说明.md)（若 SDK 暴露）；涉及推送时同步 [`server/推送事件方案.md`](server/推送事件方案.md) | `go run ./tools/cmd/check-docs-consistency/`；涉及实现时跑 `./tools/run_all_tests.sh` |
| 改消息、通讯录、屏蔽列表、免打扰、会话或组织关系同步机制 | [`同步机制方案.md`](同步机制方案.md) → [`protocol/接口总览.md`](protocol/接口总览.md) → 对应领域数据库 / 业务专题 → [`frontend/sdk/sdk设计方案.md`](frontend/sdk/sdk设计方案.md) → [`frontend/sdk/sdk接口说明.md`](frontend/sdk/sdk接口说明.md)（若公开 API 变化） | 同上 |
| 改 schema、索引或路由键 | [`server/db/schema字段对照.md`](server/db/schema字段对照.md) → [`server/db/数据库设计总览.md`](server/db/数据库设计总览.md) → 对应领域数据库文档 | 先确认 schema 变更；随后跑文档校验和全量测试 |
| 改 SDK 公开 API、事件、类型或 `ClientOptions` | [`frontend/sdk/sdk接口说明.md`](frontend/sdk/sdk接口说明.md) → [`frontend/sdk/sdk设计方案.md`](frontend/sdk/sdk设计方案.md) → [`protocol/接口总览.md`](protocol/接口总览.md)（若 action 映射变化） | `go run ./tools/cmd/check-docs-consistency/`；涉及前端实现时跑全量测试 |
| 改 UIKit 接入、主应用 UI 交互、样式或响应式布局 | [`frontend/uikit/UIKit方案.md`](frontend/uikit/UIKit方案.md) → [`frontend/uikit/UI设计方案.md`](frontend/uikit/UI设计方案.md) → [`frontend/前端设计方案.md`](frontend/前端设计方案.md)（若启动 / 分层变化） | 仅文档改动可跑文档校验；涉及实现时跑全量测试 |
| 只改文档导航、索引、归档规则 | 本文件 → 对应二级索引 | `go run ./tools/cmd/check-docs-consistency/` |

## 5. 专题文档模板

新增或重排专题文档时，长期采用以下小节顺序；不适用的小节可以合并，但不要新增“改造说明”“阶段报告”等临时事实源：

1. **定位**：说明本文负责的边界和不负责的内容。
2. **当前实现**：只描述当前代码事实和权威入口。
3. **接口或数据结构**：列关键 action、公开 API、schema、配置项或状态结构；完整矩阵优先链接权威文档。
4. **流程**：说明核心读写、同步、推送或渲染流程。
5. **测试**：列对应测试入口和高风险场景。
6. **边界**：记录安全、性能、兼容、分片、缓存或 UI 限制。
7. **维护点**：列后续代码变更时必须回看的位置。

## 6. 历史内容处理规则

| 内容类型 | 触发条件 | 处理方式 |
|---|---|---|
| 一次性整改报告 | 结论已落实到代码或权威文档 | 合并关键结论到权威段落，再删除独立报告 |
| 阶段性评估 / 分析 | 仍有治理价值但不属于运行事实 | 归档到 [`archive/`](archive/)，并在 [`archive/文档治理历史.md`](archive/文档治理历史.md) 记录处理结果 |
| 临时方案 / 草案 | 已被实现替代或放弃 | 删除；若仍有边界约束，转写为“当前实现 / 边界” |
| 旧接口、旧 schema、旧 UI 流程 | 当前研发阶段已不再使用 | 不保留兼容说明，不写 migration 或旧数据升级逻辑 |
| 过长专题中的完整接口矩阵 | 已由 `protocol/接口总览`、`schema字段对照`、`sdk接口说明` 覆盖 | 改为链接权威文档，只保留流程和边界 |

## 7. 文档维护约定

1. **单一事实源**：每个主题只保留一份权威文档；落地后的阶段性说明必须合并回权威文档。
2. **先代码后文档核对**：字段名、action、配置项、常量、路径、测试命令必须能在当前代码中找到依据。
3. **禁止保留失效路线图**：建议、历史结论、已实现状态必须明确区分；过期内容直接删除或改写为当前事实。
4. **中文书写**：文档、注释、提交信息统一使用中文。
5. **相对链接**：仓库内引用统一使用相对路径，避免绝对路径和易失效外链。
6. **数据库变更需确认**：涉及 schema 的设计调整必须先征求确认；研发阶段不写 migration、ALTER TABLE 或旧数据兼容逻辑。
7. **头部状态模板**：设计文档头部统一使用“主要对照 / 最后复核 / 触发更新 / 入口关系”四行，避免只写日期而缺少复核范围、更新条件和入口边界。
8. **新增文档先入树**：新增文档必须先判断能否合并进现有文档；确需新增时补齐四行头部模板，并同步更新本文 §2 的文档树和对应二级索引。
9. **只读一致性校验**：提交前运行 `go run ./tools/cmd/check-docs-consistency/`（或 [`../tools/scripts/check_docs_consistency.sh`](../tools/scripts/check_docs_consistency.sh)），核对 schema、索引、action、SDK 公开 API、文档四行头部模板和相对链接，并查看脚本输出的表数、字段数、接口数、SDK 方法数和测试统计。
10. **验证路径选择**：只改文档、索引或治理说明时跑文档一致性校验；改代码、测试、schema、接口、SDK API 或 UI 行为时跑全量 [`../tools/run_all_tests.sh`](../tools/run_all_tests.sh)。
