# Yimsg

https://www.yimsg.im

## 目录

- [官网](#官网)
- [产品定位](#产品定位)
- [核心优势](#核心优势)
- [应用场景](#应用场景)
- [当前实现概览](#当前实现概览)
- [核心目录](#核心目录)
- [已实现能力](#已实现能力)
  - [服务端](#服务端)
  - [前端](#前端)
- [快速开始](#快速开始)
  - [1. 准备环境](#1-准备环境)
  - [2. 安装前端依赖并构建](#2-安装前端依赖并构建)
  - [3. 准备服务端配置](#3-准备服务端配置)
  - [4. 启动服务端](#4-启动服务端)
  - [5. 执行全量验证](#5-执行全量验证)
- [常用命令](#常用命令)
- [文档导航](#文档导航)
- [维护约定](#维护约定)

Yimsg 是一套**极简单机部署、数据完全自主**的私有化即时通讯系统：一台机器几分钟即可上线，所有聊天数据都留在你自己的机器上，不经过任何第三方云。同一套聊天能力，既可以一行代码嵌入官网或后台系统做在线客服组件，也可以作为独立的网页 IM 应用直接使用。

## 官网

- 官网源码：[`website/`](website/)（纯静态营销站，用浏览器直接打开 `website/index.html` 即可本地预览）
- 生产部署时官网默认挂载在服务端根路径 `/` 作为首页，真正需要注册登录的聊天 App 挂载在 `/app/`：访客打开域名先看到产品介绍页，点击「打开应用」再进入聊天界面（挂载路径由 [`config.toml`](config.toml) 的 `[website]` / `[frontend]` 配置）
- 部署到自己服务器的完整步骤见 [`docs/部署方案.md`](docs/部署方案.md)

## 产品定位

- **面向对象**：需要私有化部署即时通讯能力、且不希望数据经过第三方云的团队或产品
- **交付形态**：一个 Go 单进程服务端 + 一套 TypeScript SDK / UIKit，单机即可完整运行，无外部中间件依赖
- **核心心智**：数据主权（数据只在自己的机器上）+ 极简部署（一台机器几分钟上线）+ 可嵌入（一行代码接入已有产品）

## 核心优势

- **数据自主可控**：所有数据集中存放在自己的机器里，不经过任何第三方云，完全自主可控，需要时可一键清空
- **极简部署**：一台机器即可上线，无需复杂运维；无论是否拥有域名或公网 IP，都有对应的接入方式
- **极致性能**：2 核 4G 单机即可支撑百人同时聊天，部署包不到 32MB，客户端内存占用可控（见下文「内存保证」），天然适合资源受限的嵌入式场景

## 应用场景

- **客服组件**：把 Yimsg UIKit 一行代码嵌入官网或后台系统，几分钟内拥有一个完整的在线客服入口
- **独立网页应用**：作为一套独立完整的网页 IM 应用直接使用，登录即可收发消息、管理联系人与群组
- **本地持久化**：客户端支持本地持久化缓存，刷新页面或断网重连不丢会话；也可以选择纯内存模式，不在本地留任何数据

## 当前实现概览

- **服务端**：Go 1.24，主入口为 `cmd/server/main.go`，核心模块位于 `internal/`
- **主协议**：WebSocket 二进制帧，`internal/protocol/yimsg.proto` 是单一事实源；帧头使用 `codec(bitfield) + size:uint16 + request_id:uint64 + type:uint16`，整包上限 `0xffff` 字节，HTTP 仅用于静态资源、文件上传与媒体访问
- **存储模型**：SQLite 分片，按 `uid` / `username` / `group_id` / `token` 四类路由键访问
- **前端形态**：同一套 SDK + UIKit，支持 Lite 模式（UIKit API 中对应 `mode: 'memory'`，纯内存）与持久存储模式（`mode: 'persistent'`，持久存储后端 + SQLite；设置页可随时「清除数据」重新全量追平）
- **可选能力**：消息撤回、消息扩展（引用 / 转发 / Markdown / @）、会话免打扰、屏蔽列表、媒体上传、插件化扩展机制
- **测试体系**：后端单测、后端 E2E、前端 unit、SDK integration、Playwright UI，全量入口为 `./tools/run_all_tests.sh`

## 核心目录

```text
.
├── cmd/server/                # 服务端入口
├── internal/                  # 服务端实现（config / dal / protocol / service / ws / plugin ...）
├── frontend/                  # 前端源码、SDK、UIKit、测试与构建配置
├── website/                   # 官网（纯静态营销站，服务端默认挂载在根路径作为首页）
├── tests/e2e/                 # 后端端到端测试
├── tools/scripts/             # 仓库级脚本实现
├── tools/cmd/                 # Go 工具命令（协议生成、文档校验、seed、调试）
├── docs/                      # 设计文档与接口文档
└── web/                       # 本地前端构建产物输出目录
```

## 已实现能力

### 服务端
- 用户注册、登录、基于 token 的鉴权与多端会话管理
- 好友、群组、联系人增量同步
- 单聊 / 群聊消息收发、会话列表、未读统计、已读清理
- 屏蔽列表、会话免打扰、消息撤回
- HTTP 文件上传与媒体静态资源访问
- 插件化扩展机制，当前不内置业务插件

### 前端
- `YimsgClient`：UI 无关的 IM SDK
- `YimsgUIKit.mount()`：可嵌入宿主页面的 Shadow DOM 组件
- `mountApp()`：项目自用完整 Web/Web 应用入口
- Lite（`mode: 'memory'`）/ 持久存储双模式，本地缓存、事件桥接、Profile/Group display info 缓存
- 主题、i18n、响应式布局、手动挂载与宿主回调能力

## 内存保证（Memory Guarantees）

Yimsg SDK 所有长期驻留集合均为**有界集合**：容量在构造时确定、运行期不再增长，禁止无界 Map / Set / Queue 长期增长，因此 SDK 峰值内存静态可估算。详见 [`docs/frontend/有界集合方案.md`](docs/frontend/有界集合方案.md)。

关键上界：

- 最大网络协议整包：**64KB**（协议帧硬上限）。
- 最大待响应请求（pending request）：`maxPendingRequests`（默认 100），达到上限的新请求立即被拒绝。
- 显示信息缓存最大条数：`cacheMaxEntries`（默认 10000），用户与群各自独立、FIFO 淘汰。
- 显示信息加载队列最大长度：`profileLoadQueueMaxEntries`（默认 2000），用户与群上限独立，满则拒绝。
- 增量同步单批上限：`DEFAULT_SYNC_BATCH_SIZE`（200），派发后立即释放。
- **Message 不长期驻留内存**：不存在 `msg_id -> Message` 全局缓存；长期消息存储依赖持久层（SQLite / IndexedDB / OPFS）。

### Bounded Collections

基础设施位于 `frontend/src/sdk/internal/bounded/`，提供真正固定容量、固定 bucket、固定 slot 的结构，开放寻址 + 桶内线性扫描，无链表 / 无动态 chaining / 无堆碎片，易于跨语言（Rust/Go/C）复刻：

- `BoundedU64Map<V>`：uint64（`keysHi`/`keysLo` 两段 uint32）-> V 映射，`bucketCount` 为 2 的幂、`bucketCapacity` 默认 8，支持 `reject` / `fifo` / `lru` 淘汰。
- `BoundedU64Set`：固定容量 uint64 去重集合，reject 策略，承载「待拉取 / 在飞」队列。
- `BoundedQueue<V>`：固定容量环形缓冲 FIFO 队列，支持 `reject` / `overwrite_oldest`。

每个集合都暴露 `size` / `capacity` / `bucketCount` / `bucketCapacity` / `rejectCount` / `evictionCount` / `loadFactor` 统计，可通过 `client.getBoundedCollectionStats()` 获取，用于 benchmark / debug。

### Peak Memory Estimation

`YimsgClient.estimateMaxMemoryBytes(options)` 把所有有界集合（缓存、队列、待响应请求、同步批次、基线）纳入理论峰值估算，纯静态、无副作用，可在构造实例前调用。各分项均静态可计算，详见 [`docs/frontend/sdk设计方案.md`](docs/frontend/sdk设计方案.md) §11。

## 快速开始

### 1. 准备环境

- Go **1.24+**
- Node.js **20+**（建议配合 npm）
- Linux / macOS / Windows（仓库脚本兼容常见开发环境）

### 2. 安装前端依赖并构建

```bash
cd /home/runner/work/yimsg/yimsg/frontend
npm ci
npm run build
npm run build:uikit
```

### 3. 准备服务端配置

仓库内置 `config.toml` 模板文件，所有配置项都带有注释并保持注释状态；服务端会使用 `internal/config/config.go` 中的默认值启动。需要覆盖配置时，复制为不会提交的 `config.local.toml` 并显式指定：

```bash
go run ./cmd/server config.local.toml
```

配置项含义、默认值和示例以 [`config.toml`](config.toml) 与 [`docs/server/服务器架构方案.md`](docs/server/服务器架构方案.md) 为准，根 README 不重复维护完整配置表。

### 4. 启动服务端

```bash
cd /home/runner/work/yimsg/yimsg
go run ./cmd/server /path/to/config.toml
```

启动后：
- WebSocket：`ws://127.0.0.1:38081/ws`
- 上传接口：`POST http://127.0.0.1:38081/api/upload`
- 媒体访问：`GET  http://127.0.0.1:38081/media/...`
- 前端页面：`http://127.0.0.1:38081/`

### 5. 执行全量验证

```bash
cd /home/runner/work/yimsg/yimsg
./tools/run_all_tests.sh
```

该脚本会自动：
- 安装前端依赖与 Playwright 浏览器
- 构建前端与 UIKit
- 启动服务端
- 运行 Go 单测、Go E2E、前端 unit / sdk / ui 测试

## 常用命令

- 全量验证：`./tools/run_all_tests.sh`
- 文档一致性校验：`./tools/check_docs_consistency.sh`
- 协议生成物刷新：`go run ./tools/cmd/protocolgen`（刷新 `yimsg.pb.go`、`frontend/src/sdk/generated/yimsg.ts`，以及 Go/TS 协议机械映射 `internal/ws/*_gen.go`、`frontend/src/sdk/generated/{actions,notifications}.gen.ts` 与 `docs/generated/`）
- 协议生成物校验：`go run ./tools/cmd/protocolgen --check`（重新生成并逐字节比对全部生成物）
- 后端构建：`go build ./cmd/server`
- 前端构建：`cd frontend && npm run build`

更多分层测试命令和执行前置条件见 [`docs/测试方案.md`](docs/测试方案.md)。

## 文档导航

- 总索引：[`docs/README.md`](docs/README.md)
- 前端文档索引：[`docs/frontend/README.md`](docs/frontend/README.md)
- 服务端架构：[`docs/server/服务器架构方案.md`](docs/server/服务器架构方案.md)
- 数据库总览：[`docs/server/db/数据库设计总览.md`](docs/server/db/数据库设计总览.md)
- 接口总览：[`docs/接口总览.md`](docs/接口总览.md)
- 协议治理：[`docs/protocol/README.md`](docs/protocol/README.md)
- 同步机制：[`docs/同步机制方案.md`](docs/同步机制方案.md)
- 前端架构：[`docs/frontend/前端设计方案.md`](docs/frontend/前端设计方案.md)
- SDK 设计与接口：[`docs/frontend/sdk设计方案.md`](docs/frontend/sdk设计方案.md)、[`docs/frontend/sdk接口说明.md`](docs/frontend/sdk接口说明.md)
- UIKit 方案：[`docs/frontend/UIKit方案.md`](docs/frontend/UIKit方案.md)
- 测试方案：[`docs/测试方案.md`](docs/测试方案.md)
- 插件架构：[`docs/插件架构方案.md`](docs/插件架构方案.md)

## 维护约定

- 仓库内所有说明、注释、提交信息统一使用中文。
- 文档以 `docs/` 为主；后续若代码结构、接口字段、配置项、测试入口发生变化，请同步更新对应设计文档。
- 项目当前处于研发阶段，不做 migration、旧数据兼容或历史 schema 升级逻辑。
