# Yimsg 文档索引

> 主要对照：`docs/` 实际文件树、根 `README.md`、服务端/前端二级索引、`tools/check_docs_consistency.sh`。
> 最后复核：2026-07-05。
> 触发更新：`docs/` 文档增删改名、阅读路径或维护口径变化时同步更新。
> 入口关系：仓库根目录 [`../README.md`](../README.md) 面向首次进入项目的读者；本文件是 `docs/` 内部导航、文档分层和维护口径的单一入口。

## 目录

- [1. 文档架构原则](#1-文档架构原则)
- [2. 当前文档树](#2-当前文档树)
- [3. 推荐阅读路径](#3-推荐阅读路径)
- [4. 文档变更检查清单](#4-文档变更检查清单)
- [5. 专题文档模板](#5-专题文档模板)
- [6. 历史内容处理规则](#6-历史内容处理规则)
- [7. 主题导航](#7-主题导航)
  - [7.1 架构与核心约束](#71-架构与核心约束)
  - [7.2 接口与对外契约](#72-接口与对外契约)
  - [7.3 服务端专题](#73-服务端专题)
  - [7.4 前端专题](#74-前端专题)
- [8. 文档维护约定](#8-文档维护约定)

## 1. 文档架构原则

Yimsg 文档按“读者任务”而不是“历史迭代记录”组织：

1. **总览先行**：先用根 README 与本文建立项目、目录和阅读路径。
2. **架构与接口分离**：架构文档说明模块边界和数据流；接口文档说明协议、SDK、UIKit 的调用契约。
3. **服务端与前端分层**：服务端文档对应 `cmd/server/`、`internal/`、`tests/e2e/`；前端文档对应 `frontend/src/`、`frontend/tests/`。
4. **数据库单独成组**：分片、表结构和 GC 是服务端核心约束，集中在 `docs/server/db/`。
5. **专题只保留当前实现**：历史 patch 式说明合并回权威文档；不再为已落地的局部改造保留单独文档。
6. **评估与改进可追踪**：当前评估、评分和优化建议记录在 [`项目文档评估.md`](项目文档评估.md)；历史治理过程归档在 [`archive/`](archive/)。

## 2. 当前文档树

```text
docs/
├── README.md                    — 本文件，文档索引与维护口径
├── 项目文档评估.md              — 文档体系当前评估与优化建议
├── 接口总览.md                  — UIKit / SDK / 服务端接口权威总览
├── 测试方案.md                  — 测试分层、全量执行、重点覆盖
├── 部署方案.md                  — 服务端 + 前端产物部署到自建服务器的操作手册
├── 插件架构方案.md              — 后端插件接口、宿主能力、通用扩展模板
├── 同步机制方案.md              — 消息、通讯录、屏蔽列表、免打扰、会话的通用同步机制
├── archive/                     — 历史记录与过程文档归档（仅供追溯，不作为当前事实源）
├── generated/                   — 工具生成的协议速查表（不要手工编辑）
├── protocol/                    — 协议治理、单一事实源和轻量代码生成方案
├── server/                      — 服务端架构、协议、业务专题
│   ├── 服务器架构方案.md        — 服务端模块、启动、WebSocket dispatch、后处理动作
│   ├── README.md                 — 服务端二级索引、专题分组与维护口径
│   ├── 推送事件方案.md          — Notification 类型、触发矩阵、客户端桥接
│   ├── 多媒体资源方案.md        — HTTP 上传、静态资源访问、消息类型扩展
│   ├── 关系与会话偏好方案.md    — 屏蔽列表、会话免打扰、未读 / 红点
│   ├── 消息能力方案.md          — Markdown / 引用 / 转发 / @ 提及 / 撤回
│   ├── 组织架构方案.md          — 组织通讯录：org 分片、组织即根 tag、成员资格并入 contacts、tag 图 seq 同步域
│   └── db/                      — 数据库分片、表结构、GC 与各领域表设计（含 schema 字段对照）
└── frontend/                    — 前端架构、SDK、UIKit、UI 与对外接口
    ├── README.md                — 前端二级索引、专题分组与维护口径
    ├── 前端设计方案.md          — 前端总览：运行形态、分层、存储、持久存储数据表、启动、阅读路径
    ├── sdk设计方案.md           — SDK 内核、状态机、DataGateway、缓存、通知、内存边界
    ├── sdk接口说明.md           — SDK 对业务方公开 API 的权威说明
    ├── DisplayInfoCache接口.md  — DisplayInfoCache 内部接口、必要性和精简空间
    ├── UIKit方案.md             — UIKit 设计、嵌入接口、构建产物、宿主接入
    └── UI设计方案.md            — 视图结构、交互、有界消息流窗口、状态与样式
```

## 3. 推荐阅读路径

| 目标 | 阅读顺序 |
|---|---|
| 首次了解项目 | [`../README.md`](../README.md) → 本文 → [`server/服务器架构方案.md`](server/服务器架构方案.md) → [`frontend/前端设计方案.md`](frontend/前端设计方案.md) |
| 修改服务端业务 | [`server/README.md`](server/README.md) → [`server/服务器架构方案.md`](server/服务器架构方案.md) → [`接口总览.md`](接口总览.md) → 对应专题 / `server/db/` 文档；涉及同步时先读 [`同步机制方案.md`](同步机制方案.md) |
| 修改协议契约或生成策略 | [`protocol/README.md`](protocol/README.md) → [`接口总览.md`](接口总览.md) → [`server/服务器架构方案.md`](server/服务器架构方案.md) → [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md) |
| 修改数据库或存储实现 | [`server/db/数据库设计总览.md`](server/db/数据库设计总览.md) → [`server/db/schema字段对照.md`](server/db/schema字段对照.md) → 对应领域数据库文档 → [`接口总览.md`](接口总览.md) |
| 修改前端主应用 | [`frontend/README.md`](frontend/README.md) → [`frontend/前端设计方案.md`](frontend/前端设计方案.md) → [`frontend/UIKit方案.md`](frontend/UIKit方案.md) → [`frontend/UI设计方案.md`](frontend/UI设计方案.md) |
| 修改 SDK | [`frontend/README.md`](frontend/README.md) → [`frontend/sdk设计方案.md`](frontend/sdk设计方案.md) → [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md) → [`接口总览.md`](接口总览.md)；涉及 DataGateway 同步时先读 [`同步机制方案.md`](同步机制方案.md) |
| 接入嵌入式 UIKit | [`frontend/UIKit方案.md`](frontend/UIKit方案.md) → [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md) → [`接口总览.md`](接口总览.md) |
| 核对测试 | [`测试方案.md`](测试方案.md) → [`../tools/run_all_tests.sh`](../tools/run_all_tests.sh) |
| 部署上线 | [`部署方案.md`](部署方案.md) → [`../tools/build.sh`](../tools/build.sh) |

## 4. 文档变更检查清单

| 变更类型 | 必须同步的文档 | 建议校验 |
|---|---|---|
| 改 WebSocket action、请求 / 响应字段或通知 | [`protocol/README.md`](protocol/README.md) → [`接口总览.md`](接口总览.md) → [`server/服务器架构方案.md`](server/服务器架构方案.md) → 对应服务端专题 → [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md)（若 SDK 暴露） | `./tools/check_docs_consistency.sh`；涉及实现时跑 `./tools/run_all_tests.sh` |
| 改消息、通讯录、屏蔽列表、免打扰或会话同步机制 | [`同步机制方案.md`](同步机制方案.md) → [`接口总览.md`](接口总览.md) → 对应领域数据库 / 业务专题 → [`frontend/sdk设计方案.md`](frontend/sdk设计方案.md) → [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md)（若公开 API 变化） | `./tools/check_docs_consistency.sh`；涉及实现时跑全量测试 |
| 改 schema、索引或路由键 | [`server/db/schema字段对照.md`](server/db/schema字段对照.md) → [`server/db/数据库设计总览.md`](server/db/数据库设计总览.md) → 对应领域数据库文档 → [`接口总览.md`](接口总览.md) | 先确认 schema 变更；随后跑 `./tools/check_docs_consistency.sh` 和全量测试 |
| 改 SDK 公开 API、事件、类型或 `ClientOptions` | [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md) → [`frontend/sdk设计方案.md`](frontend/sdk设计方案.md) → [`接口总览.md`](接口总览.md)（若 action 映射变化） | `./tools/check_docs_consistency.sh`；涉及前端实现时跑全量测试 |
| 改 UIKit 接入、主应用 UI 交互、样式或响应式布局 | [`frontend/UIKit方案.md`](frontend/UIKit方案.md) → [`frontend/UI设计方案.md`](frontend/UI设计方案.md) → [`frontend/前端设计方案.md`](frontend/前端设计方案.md)（若启动 / 分层变化） | 仅文档改动可跑文档校验；涉及实现时跑全量测试 |
| 只改文档导航、索引、历史归档规则 | 本文件 → 对应二级索引 → [`项目文档评估.md`](项目文档评估.md)（若治理结论变化） | `./tools/check_docs_consistency.sh` |

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
| 阶段性评估 / 分析 | 仍有治理价值但不属于运行事实 | 归档到 [`archive/`](archive/)；若有当前结论，提炼到 [`项目文档评估.md`](项目文档评估.md) |
| 临时方案 / 草案 | 已被实现替代或放弃 | 删除；若仍有边界约束，转写为“当前实现 / 边界” |
| 旧接口、旧 schema、旧 UI 流程 | 当前研发阶段已不再使用 | 不保留兼容说明，不写 migration 或旧数据升级逻辑 |
| 过长专题中的完整接口矩阵 | 已由 `接口总览`、`schema字段对照`、`sdk接口说明` 覆盖 | 改为链接权威文档，只保留流程和边界 |

## 7. 主题导航

### 7.1 架构与核心约束

| 主题 | 文档 |
|---|---|
| 服务端总体架构 | [`server/服务器架构方案.md`](server/服务器架构方案.md) |
| 服务端专题索引 | [`server/README.md`](server/README.md) |
| 前端总体架构 | [`frontend/前端设计方案.md`](frontend/前端设计方案.md) |
| 前端专题索引 | [`frontend/README.md`](frontend/README.md) |
| 协议治理 | [`protocol/README.md`](protocol/README.md) |
| 生成协议速查表 | [`generated/协议接口表.md`](generated/协议接口表.md) |
| 数据库分片与表结构 | [`server/db/数据库设计总览.md`](server/db/数据库设计总览.md)、[`server/db/schema字段对照.md`](server/db/schema字段对照.md) |
| 跨领域同步机制 | [`同步机制方案.md`](同步机制方案.md) |
| 插件系统 | [`插件架构方案.md`](插件架构方案.md) |
| 测试体系 | [`测试方案.md`](测试方案.md) |
| 部署与运维 | [`部署方案.md`](部署方案.md) |

### 7.2 接口与对外契约

| 受众 | 权威文档 |
|---|---|
| 后端 / 协议使用方 | [`接口总览.md`](接口总览.md) |
| 协议维护者 | [`protocol/README.md`](protocol/README.md) |
| 跨层接口核对 | [`接口总览.md`](接口总览.md) |
| 前端 SDK 使用者 | [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md) |
| UIKit 宿主页面 | [`frontend/UIKit方案.md`](frontend/UIKit方案.md) |
| SDK 维护者 | [`frontend/sdk设计方案.md`](frontend/sdk设计方案.md) |
| UI 维护者 | [`frontend/UI设计方案.md`](frontend/UI设计方案.md) |

### 7.3 服务端专题

服务端专题的二级分组以 [`server/README.md`](server/README.md) 为准；下表只保留常用入口。

| 主题 | 文档 |
|---|---|
| 推送事件 | [`server/推送事件方案.md`](server/推送事件方案.md) |
| 多媒体上传 | [`server/多媒体资源方案.md`](server/多媒体资源方案.md) |
| 关系与会话偏好 | [`server/关系与会话偏好方案.md`](server/关系与会话偏好方案.md) |
| 消息能力 | [`server/消息能力方案.md`](server/消息能力方案.md) |
| 组织架构 | [`server/组织架构方案.md`](server/组织架构方案.md) |

### 7.4 前端专题

前端专题的二级分组以 [`frontend/README.md`](frontend/README.md) 为准；下表只保留常用入口。

| 主题 | 文档 |
|---|---|
| 前端索引 | [`frontend/README.md`](frontend/README.md) |
| 前端运行形态与装配 | [`frontend/前端设计方案.md`](frontend/前端设计方案.md) |
| SDK 设计 | [`frontend/sdk设计方案.md`](frontend/sdk设计方案.md) |
| SDK 公开接口 | [`frontend/sdk接口说明.md`](frontend/sdk接口说明.md) |
| DisplayInfoCache 接口 | [`frontend/DisplayInfoCache接口.md`](frontend/DisplayInfoCache接口.md) |
| UIKit 嵌入 | [`frontend/UIKit方案.md`](frontend/UIKit方案.md) |
| UI 视图与交互 | [`frontend/UI设计方案.md`](frontend/UI设计方案.md) |

## 8. 文档维护约定

1. **单一事实源**：每个主题只保留一份权威文档；落地后的阶段性说明必须合并回权威文档。
2. **先代码后文档核对**：字段名、action、配置项、常量、路径、测试命令必须能在当前代码中找到依据。
3. **禁止保留失效路线图**：建议、历史结论、已实现状态必须明确区分；过期内容直接删除或改写为当前事实。
4. **中文书写**：文档、注释、提交信息统一使用中文。
5. **相对链接**：仓库内引用统一使用相对路径，避免绝对路径和易失效外链。
6. **数据库变更需确认**：涉及 schema 的设计调整必须先征求确认；研发阶段不写 migration、ALTER TABLE 或旧数据兼容逻辑。
7. **头部状态模板**：设计文档头部统一使用“主要对照 / 最后复核 / 触发更新 / 入口关系”四行，避免只写日期而缺少复核范围、更新条件和入口边界。
8. **只读一致性校验**：提交前可运行 [`../tools/check_docs_consistency.sh`](../tools/check_docs_consistency.sh)，核对 schema、索引、action、SDK 公开 API、文档四行头部模板和相对链接，并查看脚本输出的表数、字段数、接口数、SDK 方法数和测试统计。
9. **验证路径选择**：只改文档、索引或治理说明时跑文档一致性校验；改代码、测试、schema、接口、SDK API 或 UI 行为时跑全量 [`../tools/run_all_tests.sh`](../tools/run_all_tests.sh)。
