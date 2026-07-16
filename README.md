# Yimsg

**English** | [简体中文](README.zh-CN.md)

https://www.yimsg.im

## Table of Contents

- [Website](#website)
- [Product Positioning](#product-positioning)
- [Core Advantages](#core-advantages)
- [Use Cases](#use-cases)
- [Current Implementation Overview](#current-implementation-overview)
- [Core Directory Layout](#core-directory-layout)
- [Implemented Capabilities](#implemented-capabilities)
  - [Server](#server)
  - [Frontend](#frontend)
- [Quick Start](#quick-start)
  - [1. Prepare the Environment](#1-prepare-the-environment)
  - [2. Install Frontend Dependencies and Build](#2-install-frontend-dependencies-and-build)
  - [3. Prepare the Server Configuration](#3-prepare-the-server-configuration)
  - [4. Start the Server](#4-start-the-server)
  - [5. Run the Full Verification Suite](#5-run-the-full-verification-suite)
- [Common Commands](#common-commands)
- [Documentation Index](#documentation-index)
- [Maintenance Conventions](#maintenance-conventions)

Yimsg is a **minimal, single-machine, fully data-sovereign** private instant messaging system: one machine goes live in minutes, and all chat data stays on your own machine — never passing through any third-party cloud. The same chat capability can be embedded into your website or admin panel with one line of code as a customer-service widget, or used directly as a standalone web IM app.

## Website

- Website source: [`website/`](website/) (a pure static marketing site — open `website/index.html` directly in a browser for a local preview)
- In production, the website is mounted at the server's root path `/` as the home page by default, while the chat app that requires sign-up/login is mounted at `/app/`: visitors see the product landing page first, then click "Open App" to enter the chat UI (the mount paths are configured under `[website]` / `[frontend]` in [`config.toml`](config.toml))
- For the full steps to deploy on your own server, see [`docs/deployment/部署方案.md`](docs/deployment/部署方案.md) (Chinese)

## Product Positioning

- **Target users**: teams or products that need private, self-hosted instant messaging capability and don't want their data passing through a third-party cloud
- **Delivery form**: a single Go server process + a TypeScript SDK / UIKit, fully runnable on one machine with no external middleware dependencies
- **Core mindset**: data sovereignty (data lives only on your own machine) + minimal deployment (one machine, live in minutes) + embeddable (one line of code into an existing product)

## Core Advantages

- **Full data sovereignty**: all data is centralized on your own machine, with no third-party cloud involved, fully under your control — wipe it clean with one click whenever you need to
- **Minimal deployment**: goes live on one machine in minutes, with no complex operations; there's a matching connection path whether or not you have a domain or a public IP
- **Top performance**: a 2-core, 4GB machine easily supports a hundred concurrent chatters, the deployment package is under 32MB, and client-side memory usage is bounded (see "Memory Guarantees" below) — naturally suited to resource-constrained embedded scenarios

## Use Cases

- **Customer service widget**: embed the Yimsg UIKit into your website or admin panel with one line of code and have a complete live-chat support entry point within minutes
- **Standalone web app**: use it directly as a complete, standalone web IM app — log in to send messages and manage contacts and groups
- **Local persistence**: the client supports local persistent caching so refreshing the page or reconnecting after a dropped connection never loses your conversations; an instant mode (pure in-memory) is also available that leaves no data on the local machine

## Current Implementation Overview

- **Server**: Go 1.24, main entry point at `server/cmd/yimsg-server/main.go`, with core modules under `server/internal/`
- **Primary protocol**: WebSocket binary frames; `protocol/yimsg.proto` is the single source of truth. The frame header uses `codec(bitfield) + size:uint16 + request_id:uint64 + type:uint16`, the whole packet is capped at `0xffff` bytes, and HTTP is used only for static assets, file uploads, and media access
- **Storage model**: SQLite shards, accessed via four routing keys — `uid` / `username` / `group_id` / `token`
- **Frontend form**: a single SDK + UIKit that supports a Lite mode (`mode: 'instant'` in the UIKit API, pure in-memory) and a persistent-storage mode (`mode: 'persistent'`, backed by a persistent storage layer + SQLite; the settings page lets you "Clear Data" and resync from scratch at any time)
- **Optional capabilities**: message recall, message extensions (quote / forward / Markdown / @mentions), conversation mute, block list, media upload, a pluggable extension mechanism
- **Test suite**: backend unit tests, backend E2E tests, frontend unit tests, SDK integration tests, and Playwright UI tests — the full entry point is `./tools/run_all_tests.sh`

## Core Directory Layout

```text
.
├── server/                    # Go server, server tests, tools, and docs
├── protocol/                  # Protocol source, cross-language generated files, and docs
├── packages/sdk/              # UI-agnostic TypeScript SDK
├── packages/uikit/            # Embeddable UIKit and examples
├── apps/web/                  # Official Web application
├── website/                   # Static marketing website
├── docs/                      # Cross-component architecture, deployment, and development docs
├── tools/                     # Repository generation, validation, build, and test tools
└── web/                       # Local frontend build output (not committed)
```

## Implemented Capabilities

### Server
- User registration, login, token-based authentication, and multi-device session management
- Incremental sync for friends, groups, and contacts
- One-on-one / group message send and receive, conversation list, unread counters, read-state cleanup
- Block list, conversation mute, message recall
- HTTP file upload and media static-asset access
- A pluggable extension mechanism, with no business plugins bundled by default

### Frontend
- `YimsgClient`: a UI-agnostic IM SDK
- `YimsgUIKit.mount()`: a Shadow DOM component embeddable into a host page
- `mountApp()`: the entry point for the project's own full Web app
- Lite (`mode: 'instant'`) / persistent-storage dual modes, local caching, event bridging, and profile/group display-info caching
- Theming, i18n, responsive layout, manual mounting, and host callback capabilities

## Memory Guarantees

Every long-lived collection in the Yimsg SDK is a **bounded collection**: capacity is fixed at construction time and never grows at runtime — unbounded Map / Set / Queue growth is prohibited — so the SDK's peak memory footprint is statically estimable. See [`packages/sdk/docs/有界集合方案.md`](packages/sdk/docs/有界集合方案.md) (Chinese) for details.

Key upper bounds:

- Maximum network protocol packet size: **64KB** (a hard limit of the protocol frame).
- Maximum pending requests: `maxPendingRequests` (default 100) — new requests are rejected immediately once the limit is reached.
- Maximum display-info cache entries: `cacheMaxEntries` (default 10000) — users and groups have independent caches with FIFO eviction.
- Maximum display-info load-queue length: `profileLoadQueueMaxEntries` (default 2000) — independent limits for users and groups; new entries are rejected once full.
- Per-batch cap for incremental sync: `DEFAULT_SYNC_BATCH_SIZE` (200), released immediately after dispatch.
- **Messages are not kept in memory long-term**: there is no global `msg_id -> Message` cache; long-term message storage relies on the persistence layer (SQLite / IndexedDB / OPFS).

### Bounded Collections

The infrastructure lives under `packages/sdk/src/internal/bounded/` and provides structures with truly fixed capacity, fixed bucket count, and fixed slot count — open addressing plus in-bucket linear scanning, no linked lists, no dynamic chaining, no heap fragmentation, making it easy to port across languages (Rust/Go/C):

- `BoundedU64Map<V>`: a uint64 (split into `keysHi`/`keysLo` uint32 pairs) -> V map, with `bucketCount` a power of two, `bucketCapacity` defaulting to 8, and support for `reject` / `fifo` / `lru` eviction.
- `BoundedU64Set`: a fixed-capacity uint64 dedup set with a reject policy, used for "pending / in-flight" queues.
- `BoundedQueue<V>`: a fixed-capacity ring-buffer FIFO queue supporting `reject` / `overwrite_oldest`.

Each collection exposes `size` / `capacity` / `bucketCount` / `bucketCapacity` / `rejectCount` / `evictionCount` / `loadFactor` statistics, retrievable via `client.getBoundedCollectionStats()`, for benchmarking and debugging.

### Peak Memory Estimation

`YimsgClient.estimateMaxMemoryBytes(options)` rolls every bounded collection (caches, queues, pending requests, sync batches, baseline) into a theoretical peak-memory estimate. It's purely static with no side effects and can be called before an instance is even constructed. Each component is statically computable — see §11 of [`packages/sdk/docs/sdk设计方案.md`](packages/sdk/docs/sdk设计方案.md) (Chinese) for details.

## Quick Start

### 1. Prepare the Environment

- Go **1.24+**
- Node.js **20+** (npm recommended)
- Linux / macOS / Windows (the repository scripts are compatible with common development environments)

### 2. Install Frontend Dependencies and Build

```bash
cd /home/runner/work/yimsg/yimsg
npm ci
npm run build
```

### 3. Prepare the Server Configuration

The repository ships a `config.toml` template with every option commented and left in its commented-out state; the server starts with the defaults from `server/internal/config/config.go`. To override any settings, copy it to a `config.local.toml` (not committed) and specify it explicitly:

```bash
go run ./server/cmd/yimsg-server config.local.toml
```

For the meaning, defaults, and examples of each config option, see [`config.toml`](config.toml) and [`server/docs/服务器架构方案.md`](server/docs/服务器架构方案.md) (Chinese) — the root README does not duplicate the full config reference.

### 4. Start the Server

```bash
cd /home/runner/work/yimsg/yimsg
go run ./server/cmd/yimsg-server /path/to/config.toml
```

Once started:
- WebSocket: `ws://127.0.0.1:38081/ws`
- Upload endpoint: `POST http://127.0.0.1:38081/api/upload`
- Media access: `GET  http://127.0.0.1:38081/media/...`
- Frontend page: `http://127.0.0.1:38081/`

### 5. Run the Full Verification Suite

```bash
cd /home/runner/work/yimsg/yimsg
./tools/run_all_tests.sh
```

This script automatically:
- Installs frontend dependencies and the Playwright browser
- Builds the frontend and the UIKit
- Starts the server
- Runs Go unit tests, Go E2E tests, and frontend unit / SDK / UI tests

## Common Commands

- Full verification: `./tools/run_all_tests.sh`
- Doc consistency check: `./tools/check_docs_consistency.sh`
- Refresh protocol-generated artifacts: `go run ./tools/cmd/protocolgen` (refreshes `yimsg.pb.go`, `protocol/generated/typescript/yimsg.ts`, and the Go/TS protocol mechanical mappings `server/internal/ws/*_gen.go`, `packages/sdk/src/generated/{actions,notifications}.gen.ts`, and `protocol/generated/`)
- Verify protocol-generated artifacts: `go run ./tools/cmd/protocolgen --check` (regenerates everything and compares byte-for-byte)
- Backend build: `go build ./server/cmd/yimsg-server`
- Frontend build: `npm run build`

See [`docs/development/测试方案.md`](docs/development/测试方案.md) (Chinese) for more layered test commands and their prerequisites.

## Licensing and Trademarks

The Server and official Web App use `AGPL-3.0-only`; the Protocol, SDK, UIKit, and website code use `Apache-2.0`. See [`LICENSING.md`](LICENSING.md) for the exact scope, contribution terms, and commercial-licensing information, and [`TRADEMARKS.md`](TRADEMARKS.md) for trademark-use boundaries.

## Documentation Index

Most in-depth design documents are currently maintained in Chinese only.

- Master index: [`docs/README.md`](docs/README.md)
- Frontend doc index: [`docs/architecture/前端文档索引.md`](docs/architecture/前端文档索引.md)
- Server architecture: [`server/docs/服务器架构方案.md`](server/docs/服务器架构方案.md)
- Database overview: [`server/docs/db/数据库设计总览.md`](server/docs/db/数据库设计总览.md)
- Interface overview: [`protocol/docs/接口总览.md`](protocol/docs/接口总览.md)
- Protocol governance: [`protocol/docs/README.md`](protocol/docs/README.md)
- Sync mechanism: [`docs/architecture/同步机制方案.md`](docs/architecture/同步机制方案.md)
- Frontend architecture: [`docs/architecture/前端设计方案.md`](docs/architecture/前端设计方案.md)
- SDK design and interface: [`packages/sdk/docs/sdk设计方案.md`](packages/sdk/docs/sdk设计方案.md), [`packages/sdk/docs/sdk接口说明.md`](packages/sdk/docs/sdk接口说明.md)
- UIKit design: [`packages/uikit/docs/UIKit方案.md`](packages/uikit/docs/UIKit方案.md)
- Test plan: [`docs/development/测试方案.md`](docs/development/测试方案.md)
- Plugin architecture: [`server/docs/插件架构方案.md`](server/docs/插件架构方案.md)

## Maintenance Conventions

- The homepage (`website/`) and this root README are bilingual (English default, Chinese available via a language switcher); everything else in the repository — docs, code comments, and commit messages — is maintained in Chinese.
- Documentation mainly lives under `docs/`; when code structure, interface fields, config options, or test entry points change, update the corresponding design docs accordingly.
- The project is currently in active development: no migrations, no legacy-data compatibility, and no historical schema upgrade logic.
