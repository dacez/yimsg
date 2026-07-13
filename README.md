<div align="center">
  <a href="https://www.yimsg.im">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="">
      <img alt="yimsg" src="" width="160">
    </picture>
  </a>
  <h1 style="border-bottom: none; margin-top: 12px;">yimsg</h1>
  <p>
    <strong>Self-hosted instant messaging — one machine, your data.</strong>
  </p>
  <p>
    <a href="https://github.com/dacez/yimsg"><img src="https://img.shields.io/github/stars/dacez/yimsg?style=social" alt="GitHub stars"></a>
  </p>
  <p>
    <a href="https://www.yimsg.im">Website</a> ·
    <a href="https://www.yimsg.im/demo/responsive.html">Live Demo</a> ·
    <a href="#quick-start">Quick Start</a>
  </p>
</div>

<details open>
<summary><strong>🇬🇧 English</strong> (click for 中文)</summary>

<br>

**yimsg** is a minimalist self-hosted instant messaging system. Deploy on a single machine in minutes — all chat data stays on your own hardware, never touching any third-party cloud.

The same chat engine works three ways: embed it into your website with one line of code as a customer-service widget, run it as a standalone web IM app, or integrate it into your own product via TypeScript SDK.

## Highlights

- **Data sovereignty** — All data lives on your own machine. You own it, you control it. One-click purge when needed.
- **One-minute deploy** — Single Go binary + static frontend. No Docker, no Kubernetes, no external database required.
- **Extreme efficiency** — Supports 100+ concurrent users on a 2-core 4GB machine. Deployment package under 32MB. Client memory is statically bounded.
- **Embed anywhere** — `YimsgUIKit.mount()` in one line. Shadow DOM isolation. Works as customer-service widget, team chat, or any chat-enabled component.
- **Binary WebSocket protocol** — Custom compact binary framing with CRC-8 integrity checks. ~10x smaller payloads vs JSON-based protocols.
- **Bounded collections** — Every long-lived SDK collection has a fixed capacity, set at construction time and never grows. Peak memory is statically estimable before you create an instance.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Go 1.24, single binary |
| Protocol | WebSocket binary frames, Protobuf schemas |
| Storage | SQLite sharded by `uid` / `username` / `group_id` / `token` |
| Frontend | TypeScript SDK + UIKit, dual mode (memory / persistent with OPFS SQLite) |
| Testing | Go unit tests, E2E, frontend unit + integration + Playwright UI |

## Architecture at a Glance

```text
┌──────────────────────────────────────────────────────┐
│                     yimsg Server                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │   WS     │  │  HTTP    │  │   Task Queue     │   │
│  │ (binary) │  │ (upload  │  │ (fanout, retry)  │   │
│  │ dispatch │  │  /media) │  │                  │   │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
│       │              │                │              │
│  ┌────┴──────────────┴────────────────┴──────────┐   │
│  │              Service Layer                     │   │
│  │  (auth, message, contact, group, sync, ...)    │   │
│  └──────────────────────┬────────────────────────┘   │
│                         │                            │
│  ┌──────────────────────┴────────────────────────┐   │
│  │            DAL (sharded SQLite)                │   │
│  │  user.db  │  contact.db  │  group.db  │  ...   │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│                   yimsg Frontend                      │
│  ┌──────────────────────────────────────────────────┐│
│  │                 YimsgClient (SDK)                ││
│  │  transport  │  sync runtime  │  data gateway     ││
│  └──────────────────────┬───────────────────────────┘│
│                         │                            │
│  ┌──────────────────────┴───────────────────────────┐│
│  │            YimsgUIKit (Shadow DOM)               ││
│  │  chat view  │  contact list  │  settings  │  ... ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

## Features

### Server
- [x] User registration, login, token-based auth, multi-device session management
- [x] Friend, group, and contact incremental sync
- [x] Direct & group messaging, conversation list, unread counts, read receipts
- [x] Block list, mute conversations, message recall
- [x] Message extensions: quote, forward, Markdown, @mention
- [x] HTTP file upload & media static serving
- [x] Plugin extension system
- [x] Async task queue with crash recovery

### Frontend
- [x] `YimsgClient` — UI-agnostic IM SDK
- [x] `YimsgUIKit.mount()` — embeddable Shadow DOM chat component
- [x] `mountApp()` — standalone full-featured web app
- [x] Lite mode (`memory`) / persistent mode (OPFS SQLite)
- [x] Themes, i18n, responsive layout
- [x] Bounded collections with static peak memory estimation

## Quick Start

### Prerequisites

- **Go 1.24+**
- **Node.js 20+** (with npm)

### 1. Build Frontend

```bash
cd frontend
npm ci
npm run build
npm run build:uikit
```

### 2. Start Server

```bash
go run ./cmd/server config.toml
```

### 3. Open in Browser

- Chat app: `http://127.0.0.1:38081/app/`
- Website: `http://127.0.0.1:38081/`
- WebSocket endpoint: `ws://127.0.0.1:38081/ws`
- Upload endpoint: `POST http://127.0.0.1:38081/api/upload`
- Media access: `GET http://127.0.0.1:38081/media/...`

### 4. Run Tests

```bash
./tools/run_all_tests.sh
```

Runs Go unit tests, E2E, frontend unit, SDK integration, and Playwright UI tests.

## Command Reference

| Command | Description |
|---------|-------------|
| `./tools/run_all_tests.sh` | Full test suite |
| `go run ./tools/cmd/protocolgen` | Regenerate protocol codegen |
| `go run ./tools/cmd/protocolgen --check` | Verify codegen matches proto |
| `go build ./cmd/server` | Build server binary |
| `cd frontend && npm run build` | Build frontend |

## Memory Guarantees

Every long-lived collection in the SDK is **bounded** — capacity is fixed at construction and never grows. No unbounded Maps, Sets, or Queues. Peak memory is statically estimable via `client.estimateMaxMemoryBytes(options)` before creating an instance.

| Bound | Limit |
|-------|-------|
| Max network frame | 64KB (protocol hard limit) |
| Pending requests | `maxPendingRequests` (default 100) |
| Display info cache | `cacheMaxEntries` (default 10,000 per type, FIFO eviction) |
| Display info load queue | `profileLoadQueueMaxEntries` (default 2,000) |
| Sync batch size | `DEFAULT_SYNC_BATCH_SIZE` (200) |
| Message global cache | None — messages only live in SQLite/IndexedDB/OPFS |

Bounded collection infrastructure at `frontend/src/sdk/internal/bounded/`:
- `BoundedU64Map<V>` — fixed-capacity uint64→V map with configurable eviction
- `BoundedU64Set` — fixed-capacity dedup set
- `BoundedQueue<V>` — fixed-capacity ring buffer FIFO queue

See [Bounded Collections Design](docs/frontend/有界集合方案.md) (Chinese).

## Documentation

- **Index**: [`docs/README.md`](docs/README.md)
- **Server Architecture**: [`docs/server/服务器架构方案.md`](docs/server/服务器架构方案.md)
- **Database Overview**: [`docs/server/db/数据库设计总览.md`](docs/server/db/数据库设计总览.md)
- **API Reference**: [`docs/接口总览.md`](docs/接口总览.md)
- **Protocol Governance**: [`docs/protocol/README.md`](docs/protocol/README.md)
- **Sync Mechanism**: [`docs/同步机制方案.md`](docs/同步机制方案.md)
- **Frontend Architecture**: [`docs/frontend/前端设计方案.md`](docs/frontend/前端设计方案.md)
- **SDK Design & API**: [`docs/frontend/sdk设计方案.md`](docs/frontend/sdk设计方案.md), [`docs/frontend/sdk接口说明.md`](docs/frontend/sdk接口说明.md)
- **UIKit Design**: [`docs/frontend/UIKit方案.md`](docs/frontend/UIKit方案.md)
- **Testing**: [`docs/测试方案.md`](docs/测试方案.md)
- **Plugin Architecture**: [`docs/插件架构方案.md`](docs/插件架构方案.md)

> Documentation is primarily in Chinese. English translations are in progress.

## Deployment

See [`docs/部署方案.md`](docs/部署方案.md) (Chinese) for full deployment guide. Works on any Linux/macOS machine with or without a public IP.

## Project Status

Active development. No migration scripts or backward-compatibility shims — schema changes prefer clean rebuilds.

</details>

<details>
<summary><strong>🇨🇳 中文</strong> (click for English)</summary>

<br>

**yimsg** 是一套极简单机部署、数据完全自主的私有化即时通讯系统：一台机器几分钟即可上线，所有聊天数据都留在你自己的机器上，不经过任何第三方云。同一套聊天能力，既可以一行代码嵌入官网或后台系统做在线客服组件，也可以作为独立的网页 IM 应用直接使用。

## 核心优势

- **数据自主可控** — 所有数据集中存放在自己的机器里，不经过任何第三方云，完全自主可控，需要时可一键清空
- **极简部署** — 一台机器即可上线，无需复杂运维；无论是否拥有域名或公网 IP，都有对应的接入方式
- **极致性能** — 2 核 4G 单机即可支撑百人同时聊天，部署包不到 32MB，客户端内存占用可控
- **可嵌入** — `YimsgUIKit.mount()` 一行代码接入，Shadow DOM 隔离，可作为客服组件、团队聊天或任意聊天组件
- **二进制 WebSocket 协议** — 紧凑二进制帧格式，CRC-8 校验，比 JSON 协议 payload 小约 10 倍
- **有界集合** — SDK 所有长期驻留集合均为固定容量，构造时确定、运行期不再增长，峰值内存静态可估算

## 技术栈

| 层级 | 技术 |
|------|------|
| 服务端 | Go 1.24，单进程 |
| 协议 | WebSocket 二进制帧，Protobuf |
| 存储 | SQLite 分片，按 `uid` / `username` / `group_id` / `token` 路由 |
| 前端 | TypeScript SDK + UIKit，双模式（memory / persistent OPFS SQLite） |
| 测试 | Go 单测、E2E、前端 unit + integration + Playwright UI |

## 架构概览

```text
┌──────────────────────────────────────────────────────┐
│                     yimsg Server                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │   WS     │  │  HTTP    │  │   Task Queue     │   │
│  │ (binary) │  │ (upload  │  │ (fanout, retry)  │   │
│  │ dispatch │  │  /media) │  │                  │   │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
│       │              │                │              │
│  ┌────┴──────────────┴────────────────┴──────────┐   │
│  │              Service Layer                     │   │
│  │  (auth, message, contact, group, sync, ...)    │   │
│  └──────────────────────┬────────────────────────┘   │
│                         │                            │
│  ┌──────────────────────┴────────────────────────┐   │
│  │            DAL (sharded SQLite)                │   │
│  │  user.db  │  contact.db  │  group.db  │  ...   │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│                   yimsg Frontend                      │
│  ┌──────────────────────────────────────────────────┐│
│  │                 YimsgClient (SDK)                ││
│  │  transport  │  sync runtime  │  data gateway     ││
│  └──────────────────────┬───────────────────────────┘│
│                         │                            │
│  ┌──────────────────────┴───────────────────────────┐│
│  │            YimsgUIKit (Shadow DOM)               ││
│  │  chat view  │  contact list  │  settings  │  ... ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

## 已实现能力

### 服务端
- [x] 用户注册、登录、基于 token 的鉴权与多端会话管理
- [x] 好友、群组、联系人增量同步
- [x] 单聊 / 群聊消息收发、会话列表、未读统计、已读清理
- [x] 屏蔽列表、会话免打扰、消息撤回
- [x] 消息扩展：引用、转发、Markdown、@提及
- [x] HTTP 文件上传与媒体静态资源访问
- [x] 插件化扩展机制
- [x] 异步任务队列与崩溃后重放

### 前端
- [x] `YimsgClient` — UI 无关的 IM SDK
- [x] `YimsgUIKit.mount()` — 可嵌入的 Shadow DOM 聊天组件
- [x] `mountApp()` — 独立完整功能 Web 应用
- [x] Lite（`mode: 'memory'`）/ 持久存储双模式
- [x] 主题、i18n、响应式布局
- [x] 有界集合与静态峰值内存估算

## 快速开始

### 准备环境

- **Go 1.24+**
- **Node.js 20+**（建议配合 npm）

### 1. 安装前端依赖并构建

```bash
cd frontend
npm ci
npm run build
npm run build:uikit
```

### 2. 启动服务端

```bash
go run ./cmd/server config.toml
```

### 3. 打开浏览器

- 聊天应用：`http://127.0.0.1:38081/app/`
- 官网首页：`http://127.0.0.1:38081/`
- WebSocket：`ws://127.0.0.1:38081/ws`
- 上传：`POST http://127.0.0.1:38081/api/upload`
- 媒体：`GET http://127.0.0.1:38081/media/...`

### 4. 执行全量验证

```bash
./tools/run_all_tests.sh
```

自动运行 Go 单测、E2E、前端 unit / sdk / ui 测试。

## 常用命令

| 命令 | 说明 |
|------|------|
| `./tools/run_all_tests.sh` | 全量测试 |
| `go run ./tools/cmd/protocolgen` | 刷新协议生成物 |
| `go run ./tools/cmd/protocolgen --check` | 校验生成物一致性 |
| `go build ./cmd/server` | 构建服务端 |
| `cd frontend && npm run build` | 构建前端 |

## 内存保证

SDK 所有长期驻留集合均为**有界集合**：容量在构造时确定、运行期不再增长，禁止无界 Map / Set / Queue 长期增长。峰值内存可通过 `client.estimateMaxMemoryBytes(options)` 在构造实例前静态估算。

| 上界 | 限制 |
|------|------|
| 最大网络协议整包 | 64KB（协议帧硬上限） |
| 待响应请求 | `maxPendingRequests`（默认 100） |
| 显示信息缓存 | `cacheMaxEntries`（默认 10000，FIFO 淘汰） |
| 显示信息加载队列 | `profileLoadQueueMaxEntries`（默认 2000） |
| 增量同步单批上限 | `DEFAULT_SYNC_BATCH_SIZE`（200） |
| Message 全局缓存 | 无 — 消息只在 SQLite/IndexedDB/OPFS 中 |

有界集合基础设施位于 `frontend/src/sdk/internal/bounded/`：
- `BoundedU64Map<V>` — 固定容量 uint64→V 映射，支持 reject/fifo/lru 淘汰
- `BoundedU64Set` — 固定容量去重集合
- `BoundedQueue<V>` — 固定容量环形缓冲 FIFO 队列

详见[有界集合方案](docs/frontend/有界集合方案.md)。

## 文档导航

- **总索引**: [`docs/README.md`](docs/README.md)
- **服务端架构**: [`docs/server/服务器架构方案.md`](docs/server/服务器架构方案.md)
- **数据库总览**: [`docs/server/db/数据库设计总览.md`](docs/server/db/数据库设计总览.md)
- **接口总览**: [`docs/接口总览.md`](docs/接口总览.md)
- **协议治理**: [`docs/protocol/README.md`](docs/protocol/README.md)
- **同步机制**: [`docs/同步机制方案.md`](docs/同步机制方案.md)
- **前端架构**: [`docs/frontend/前端设计方案.md`](docs/frontend/前端设计方案.md)
- **SDK 设计与接口**: [`docs/frontend/sdk设计方案.md`](docs/frontend/sdk设计方案.md)、[`docs/frontend/sdk接口说明.md`](docs/frontend/sdk接口说明.md)
- **UIKit 方案**: [`docs/frontend/UIKit方案.md`](docs/frontend/UIKit方案.md)
- **测试方案**: [`docs/测试方案.md`](docs/测试方案.md)
- **插件架构**: [`docs/插件架构方案.md`](docs/插件架构方案.md)

## 部署

完整部署方案见 [`docs/部署方案.md`](docs/部署方案.md)。支持任意 Linux/macOS 机器，有无公网 IP 均可。

## 维护约定

- 仓库内所有说明、注释、提交信息统一使用中文
- 文档以 `docs/` 为主
- 项目当前处于研发阶段，不做 migration、旧数据兼容或历史 schema 升级逻辑

</details>
