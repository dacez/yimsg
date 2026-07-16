# 前端文档索引

> 主要对照：`frontend/src/`、`frontend/tests/` 与 `docs/frontend/` 实际文件树。
> 最后复核：2026-07-16。
> 触发更新：前端文档增删改名、专题分组或关键代码目录变化时同步更新。
> 入口关系：上级索引见 [`../README.md`](../README.md)；本文只负责前端文档的二级导航、专题归类和维护口径。

## 目录

- [1. 阅读顺序](#1-阅读顺序)
- [2. 文档分组](#2-文档分组)
  - [2.1 架构与装配](#21-架构与装配)
  - [2.2 SDK 与协议契约](#22-sdk-与协议契约)
  - [2.3 UI 与交互专题](#23-ui-与交互专题)
- [3. 前端验证入口](#3-前端验证入口)
- [4. 维护约定](#4-维护约定)

## 1. 阅读顺序

| 目标 | 推荐阅读 |
|---|---|
| 无前端经验、首次读 UIKit 代码 | [`UIKit阅读指南.md`](uikit/UIKit阅读指南.md) → [`UI设计方案.md`](uikit/UI设计方案.md) → [`UIKit方案.md`](uikit/UIKit方案.md) |
| 理解前端整体实现 | [`前端设计方案.md`](前端设计方案.md) → [`sdk设计方案.md`](sdk/sdk设计方案.md) → [`UIKit方案.md`](uikit/UIKit方案.md) |
| 修改 SDK 行为或公开 API | [`sdk设计方案.md`](sdk/sdk设计方案.md) → [`sdk接口说明.md`](sdk/sdk接口说明.md) → [`../protocol/接口总览.md`](../protocol/接口总览.md)；涉及 DataGateway 同步时先读 [`../同步机制方案.md`](../同步机制方案.md) |
| 修改 UIKit 嵌入能力 | [`UIKit方案.md`](uikit/UIKit方案.md) → [`前端设计方案.md`](前端设计方案.md) → [`UI设计方案.md`](uikit/UI设计方案.md) |
| 修改主应用视图或交互 | [`UI设计方案.md`](uikit/UI设计方案.md) → [`前端设计方案.md`](前端设计方案.md) → 对应 SDK / UIKit 文档 |
| 深入理解有界消息流窗口实现 | [`有界消息流窗口设计方案.md`](uikit/有界消息流窗口设计方案.md) |
| 修改本地缓存或 持久存储 / 数据表 | [`前端设计方案.md`](前端设计方案.md) → [`../同步机制方案.md`](../同步机制方案.md) → [`sdk设计方案.md`](sdk/sdk设计方案.md) → [`sdk接口说明.md`](sdk/sdk接口说明.md) |
| 核对前端测试 | [`../测试方案.md`](../测试方案.md) → 本文 §3 |

## 2. 文档分组

### 2.1 架构与装配

| 文档 | 说明 | 主要代码依据 |
|---|---|---|
| [`前端设计方案.md`](前端设计方案.md) | 前端运行形态、分层结构、启动装配、SDK 与 UI 边界、持久存储本地数据表、构建测试入口 | `frontend/src/main.ts`、`frontend/src/home-dashboard-main.ts`、`frontend/src/uikit/app.ts`、`frontend/src/uikit/app/main-app.ts`、`frontend/src/uikit/app/app-instance.ts`、`frontend/src/worker/sqlite.worker.ts` |
| [`UIKit方案.md`](uikit/UIKit方案.md) | `YimsgUIKit.mount()`、`MountOptions`、`MountHandle`、嵌入模式、构建产物与宿主接入 | `frontend/src/uikit/index.ts`、`frontend/src/uikit/embed.ts`、`frontend/src/uikit/options.ts`、`frontend/src/uikit/mode.ts` |

### 2.2 SDK 与协议契约

| 文档 | 说明 | 主要代码依据 |
|---|---|---|
| [`sdk设计方案.md`](sdk/sdk设计方案.md) | `YimsgClient` 内核、状态机、DataGateway、SDK↔后端数据同步、事件、缓存、内存边界、协议封包 | `frontend/src/sdk/client.ts`、`frontend/src/sdk/internal/`、`frontend/src/sdk/datagateway/`、`frontend/src/sdk/state/`、`frontend/src/sdk/transport/` |
| [`sdk接口说明.md`](sdk/sdk接口说明.md) | SDK 对业务方公开 API、事件、调用前置条件、`ClientOptions` 配置项 | `frontend/src/sdk/index.ts`、`frontend/src/sdk/types.ts`、`frontend/src/sdk/client.ts`、`frontend/src/sdk/generated/actions.gen.ts`、`frontend/src/sdk/internal/action-mappers.ts` |
| [`DataGateway接口.md`](sdk/DataGateway接口.md) | `DataGateway` 内部接口、生命周期与 instant / persistent 读取差异 | `frontend/src/sdk/datagateway/interface.ts`、`frontend/src/sdk/datagateway/`、`frontend/src/sdk/client-session-runtime.ts` |
| [`DisplayInfoCache接口.md`](sdk/DisplayInfoCache接口.md) | `DisplayInfoCache` 内部对外接口、功能、必要性和精简空间 | `frontend/src/sdk/state/cache.ts`、`frontend/src/sdk/client.ts`、`frontend/src/sdk/client-session-runtime.ts`、`frontend/tests/unit/sdk/cache.test.ts` |
| [`有界集合方案.md`](sdk/有界集合方案.md) | `BoundedU64Map` / `BoundedU64Set` / `BoundedQueue` 基础设施、固定容量与淘汰策略、承载的集合、运行时统计、峰值内存估算 | `frontend/src/sdk/internal/bounded/`、`frontend/src/sdk/state/cache.ts`、`frontend/src/sdk/transport/connection.ts`、`frontend/tests/unit/sdk/bounded-u64-map.test.ts` |
| [`../同步机制方案.md`](../同步机制方案.md) | 消息、通讯录、屏蔽列表、免打扰、会话同步的服务端 / SDK 共同契约 | `frontend/src/sdk/sync-loop.ts`、`frontend/src/sdk/datagateway/`、`frontend/src/worker/sqlite.worker.ts` |

### 2.3 UI 与交互专题

| 文档 | 说明 | 主要代码依据 |
|---|---|---|
| [`UI设计方案.md`](uikit/UI设计方案.md) | 视图结构、聊天 / 通讯录 / 设置 / 会话偏好交互、有界消息流窗口、状态管理、样式系统 | `frontend/src/uikit/app/views/`、`frontend/src/uikit/app/style.css`、`frontend/src/uikit/app/bounded-stream-window.ts`、`frontend/src/uikit/app/view-refresh.ts` |
| [`有界消息流窗口设计方案.md`](uikit/有界消息流窗口设计方案.md) | 列表渲染完整设计：所有列表统一为「有界滑动窗口 + 全量渲染 + 双向翻页」，数据窗口 BoundedPageWindow（按页边界游标记账、整页裁剪）、渲染引擎 BoundedStreamWindow（单一全量渲染模式）、消息分页窗口、DOM 锚点、新数据提示条 | `frontend/src/uikit/app/bounded-stream-window.ts`、`frontend/src/uikit/app/bounded-page-window.ts`、`frontend/src/uikit/app/views/chat/message-list.ts`、`frontend/src/uikit/app/views/chat/message-page.ts`、`frontend/src/app-config.ts` |
| [`UIKit阅读指南.md`](uikit/UIKit阅读指南.md) | 面向「懂 TypeScript、不懂 HTML/CSS」读者的入门导读：浏览器心智模型、HTML/CSS/DOM 语法基础、本项目渲染套路、响应式布局、有界消息流窗口、安全防线与阅读路线 | `frontend/src/uikit/app/shell.ts`、`frontend/src/uikit/app/style.css`、`frontend/src/uikit/app/app-instance.ts`、`frontend/src/uikit/app/views/`、`frontend/src/uikit/app/bounded-stream-window.ts`、`frontend/src/uikit/app/safe-dom.ts` |

## 3. 前端验证入口

| 场景 | 命令 | 说明 |
|---|---|---|
| 主应用与 UIKit 构建 | `cd frontend && npm run build` | 先执行前端守卫与 TypeScript 检查，再构建主应用和 UIKit |
| UIKit 独立构建 | `cd frontend && npm run build:uikit` | 仅验证可嵌入 UIKit 产物 |
| 单元测试 | `cd frontend && npm run test:unit` | 覆盖 SDK、UIKit 组件、视图辅助函数与守卫 |
| SDK 集成测试 | `cd frontend && npm run test:sdk` | 需服务端可用，覆盖 WebSocket SDK 端到端调用 |
| UI 测试 | `cd frontend && npm run test:ui` | Playwright 场景，覆盖主应用、移动端与嵌入式 UIKit |
| 全量验证 | `./tools/run_all_tests.sh` | 从仓库根目录执行，包含前后端全部测试 |

## 4. 维护约定

1. `前端设计方案.md` 负责前端整体分层、运行形态和装配关系；具体 API、嵌入接口、视图细节分别维护在 SDK、UIKit、UI 文档中。
2. `sdk接口说明.md` 是业务方可见 API 的权威说明；新增或调整 SDK 公开方法、事件、`ClientOptions` 时必须同步本文档。
3. `sdk设计方案.md` 解释 SDK 内部边界；修改 DataGateway、状态机、协议校验、缓存上限、内存边界或通知处理时优先同步该文档；修改消息、通讯录、屏蔽列表、免打扰或会话同步共同规则时先同步 `../同步机制方案.md`。
4. `UIKit方案.md` 解释嵌入契约；修改 `mount()`、`MountOptions`、`MountHandle`、构建产物或宿主回调时必须同步该文档。
5. `UI设计方案.md` 解释主应用和 UIKit 视图；修改 `frontend/src/uikit/app/views/`、布局、有界消息流窗口、样式 token 或移动端交互时必须同步该文档。
6. 新增前端专题前先判断能否合并进现有“架构与装配 / SDK 与协议契约 / UI 与交互专题”分组，避免再次产生阶段性孤立文档。
7. SDK 后续所有设计必须遵守“内存严格可控”原则：新增长期状态、缓存、队列、分页、后台任务或事件载荷时，必须同步说明上限、淘汰策略或释放路径。
