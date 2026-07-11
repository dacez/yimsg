# UIKit 方案

> 主要对照：`frontend/src/uikit/index.ts`、`frontend/src/uikit/embed.ts`、`frontend/src/uikit/options.ts`、`frontend/src/uikit/mode.ts`。
> 最后复核：2026-07-11。
> 触发更新：`mount()`、`MountOptions`、`MountHandle`、嵌入模式、构建产物或宿主回调变化时同步更新。
> 入口关系：上级索引见 [`../README.md`](../README.md)；本文是 UIKit 设计、公开接口、构建产物和宿主接入的单一事实源。

## 目录

- [1. 定位](#1-定位)
- [2. 目录结构](#2-目录结构)
- [3. `mount()` 与 `mountApp()` 的职责差异](#3-mount-与-mountapp-的职责差异)
- [4. 嵌入能力矩阵](#4-嵌入能力矩阵)
- [5. 构建与产物](#5-构建与产物)
- [6. 快速接入](#6-快速接入)
  - [6.1 ESM 嵌入](#61-esm-嵌入)
  - [6.2 复用外部已认证 client](#62-复用外部已认证-client)
- [7. 公开 API](#7-公开-api)
  - [7.1 `mount(target, options?)`](#71-mounttarget-options)
  - [7.2 `MountOptions`](#72-mountoptions)
  - [7.3 `MountHandle`](#73-mounthandle)
- [8. `mode` 语义](#8-mode-语义)
  - [8.1 `viewMode` 语义](#81-viewmode-语义)
- [9. 核心设计约束](#9-核心设计约束)
- [10. 测试覆盖](#10-测试覆盖)
- [11. 已知边界](#11-已知边界)
- [12. 相关文档](#12-相关文档)

## 1. 定位

UIKit 是 Yimsg 前端的统一 UI 装配层。它对上提供完整聊天界面和嵌入能力，对下只通过 UI 无关的 `YimsgClient` 访问业务能力。

当前前端不是两套 UI，而是一套完整 UIKit、三种运行形态：

| 运行形态 | 入口 | 宿主 | 说明 |
|---|---|---|---|
| 单实例完整应用 | `frontend/src/main.ts` -> `mountApp()` | Light DOM | 项目自身默认 Web / Web 应用 |
| 九宫格控制台 | `frontend/src/home-dashboard-main.ts` -> `mountHomeDashboard()` | Light DOM 控制台 + 多个 Shadow DOM 实例 | 控制台提供多个宿主容器，每格独立调用 `mount()` |
| 嵌入式 UIKit | `frontend/src/uikit/embed.ts` -> `mount()` | Shadow DOM | 可嵌入第三方页面的完整聊天 UI |

核心原则：**单套完整 UIKit，双宿主挂载**。`mountApp()` 与 `mount()` 共享 `frontend/src/uikit/app/**` 中的视图、状态和事件装配逻辑，只在宿主环境、存储作用域、主题注入和外部回调上做差异化处理。

## 2. 目录结构

```text
frontend/src/uikit/
├── index.ts               — 嵌入包公开入口，导出 mount、YimsgClient 与类型
├── embed.ts               — Shadow DOM 挂载入口，复用完整 UIKit
├── options.ts             — MountOptions / MountHandle / UIKitMode 等公开类型
├── theme.ts               — 主题 token、预设、系统主题监听
├── i18n.ts                — 嵌入侧 locale / messages 类型与基础词典
├── responsive-layout.ts   — 容器宽度与布局模式判定
├── app.ts                 — 主应用入口：mountApp()
└── app/
    ├── shell.ts           — Light DOM / Shadow DOM 共用应用骨架与样式重写
    ├── app-instance.ts    — AppInstance、DOM scope、存储 scope、运行时回调上下文
    ├── main-app.ts        — 统一装配逻辑：setup、事件订阅、首屏路由、认证后初始化
    ├── router.ts          — hash 路由与深链解析
    ├── bounded-stream-window.ts    — 统一分页列表引擎 BoundedStreamWindow（窗口切片 / 全量渲染）
    ├── safe-dom.ts        — URL allowlist、SafeHtml、统一转义
    ├── storage-base.ts    — 浏览器存储回退、seeded memory 与 StorageScope
    ├── session-storage.ts — 可切换存储适配器
    ├── i18n.ts            — 运行时语言切换、静态文案应用、覆盖合并
    ├── layout.ts          — 桌面 / 移动布局切换
    ├── view-refresh.ts    — 可见视图刷新编排
    ├── startup-mode.ts    — mode 与布局决策
    ├── utils.ts           — DOM、modal、toast、status 辅助
    ├── style.css          — 主应用完整样式
    └── views/             — auth / chat / contacts / settings / session-preferences
```

## 3. `mount()` 与 `mountApp()` 的职责差异

| 维度 | `mount()`（嵌入包） | `mountApp()`（项目主应用） |
|---|---|---|
| 调用者 | 第三方站点、内部自服务页、九宫格控制台 tile | `frontend/src/main.ts` |
| DOM 模型 | Shadow DOM，样式隔离 | Light DOM，启动时注入 `shell.ts` 骨架 |
| UI 覆盖 | 认证、会话、联系人、群、设置完整能力 | 同左 |
| 事件语义 | 桥接 `authenticated` / `logout` / `message` / `conversation:open` / `error` | SDK 事件 + 页面级事件 |
| 模式支持 | `memory` / `persistent` / `persistent-cleardata` 由挂载参数指定 | 登录前模式选择 + localStorage 记忆 |
| 存储 | 默认隔离存储适配器，可按 `instanceId` 隔离 | 浏览器 `localStorage` |
| 打包配置 | `vite.uikit.config.ts` | `vite.config.ts` |

## 4. 嵌入能力矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| ESM 嵌入 | 支持 | `import { mount } from '/uikit/yimsg-uikit.js'` |
| 选择器挂载 | 支持 | `mount('#chat', options)` 接受 CSS 选择器或 HTMLElement |
| 登录 / 注册 | 支持 | 内置认证表单；也支持 `token` / `getToken()` 自动鉴权 |
| 外部已认证 client | 支持 | `client` 已 ready 时跳过登录页 |
| 会话与消息 | 支持 | 会话分页、分页、未读、详情、免打扰、Markdown、引用、转发、撤回、多选 |
| 联系人 / 群 | 支持 | 好友请求、搜索、备注、删除、屏蔽列表、建群、群详情与成员管理 |
| 设置 | 支持 | 资料、头像、密码、语言、登出 |
| 主题 | 支持 | `light` / `dark` / `auto`，支持 token 覆盖和运行期切换 |
| 国际化 | 支持 | 内置 `zh-CN` / `en`，支持 `messages` 覆盖 |
| 连接状态 | 支持 | 断开、重连、同步中通过会话列表顶部状态条提示（灰色，每次断线立即提示） |
| 运行期控制 | 支持 | `setTheme` / `setLocale` / `openConversation` / `logout` / `on` |
| 存储模式 | 支持 | `memory` / `persistent` / `persistent-cleardata`，具体持久化能力由 SDK 判断 |

## 5. 构建与产物

```bash
cd frontend && npm run build        # 构建主应用 web/ 与 UIKit web/uikit/
cd frontend && npm run build:uikit  # 仅构建 UIKit ESM 包
```

构建配置：

| 目标 | 配置 | 产物 |
|---|---|---|
| 主应用 | `frontend/vite.config.ts` | `web/` |
| UIKit 嵌入包 | `frontend/vite.uikit.config.ts` | `web/uikit/yimsg-uikit.js` |

UIKit 当前只发布 ESM 产物。构建时 `EMPTY_IMPORT_META` 等高风险 warning 会被视为失败，避免重新引入不可运行产物。

示例页面位于 `frontend/public/demo/embed.html` 与 `frontend/public/demo/embed-multi.html`；官网营销向体验 demo（含六宫格客服工作台）位于 `frontend/public/demo/` 下的其余页面。

## 6. 快速接入

### 6.1 ESM 嵌入

```html
<div id="chat" style="height:640px"></div>
<script type="module">
  import { mount } from '/uikit/yimsg-uikit.js';

  const handle = mount('#chat', {
    token: localStorage.getItem('yimsg_token') ?? undefined,
    theme: { preset: 'light', primary: '#6d4aff', radius: '12px' },
    locale: 'en',
    mode: 'persistent',
    onAuthenticated: ({ token }) => localStorage.setItem('yimsg_token', token),
    onLogout: () => localStorage.removeItem('yimsg_token'),
  });
</script>
```

### 6.2 复用外部已认证 client

```ts
const client = new YimsgClient({ wsUrl });
await client.authenticate(savedToken);
await client.startSession({ storage: 'persistent' });

mount('#chat', { client });
```

接入约束：

- 宿主容器应显式给出高度；UIKit 根节点使用 `height: 100%`。
- 硬性最小宿主尺寸为 `320 x 360 px`；低于该尺寸显示“容器太小”提示。
- 建议最小舒适尺寸为 `360 x 420 px`。
- 卡片或网格等窄容器推荐使用 `layout: 'auto'`。
- `onReady` 只表示 UIKit 已挂载并完成事件绑定，不代表已登录。
- 传入已完成 `startSession()` 的 `client` 时，`mode` 参数不再生效。

## 7. 公开 API

### 7.1 `mount(target, options?)`

```ts
function mount(target: HTMLElement | string, options?: MountOptions): MountHandle;
```

执行流程：

1. 解析并校验宿主容器。
2. 创建或复用 `shadowRoot`，清空旧内容。
3. 注入完整 UIKit 应用骨架与重写后的主应用样式。
4. 创建独立 `AppInstance`，绑定 DOM、存储、主题、语言、回调桥接。
5. 复用 `app/main-app.ts#startApp()` 启动完整 UIKit。
6. 若已有 ready client，直接进入主界面；否则显示认证页，并按 `token` / `getToken()` 自动鉴权。
7. 认证成功后按 `options.mode` 调用 SDK 的业务会话启动接口。
8. 返回 `MountHandle`。

每次 `mount()` 都创建独立 UIKit 运行时。同页多实例必须视为互相隔离：memory / 持久存储两种模式下的语言、布局、当前会话、联系人分页状态和本地存储都不跨实例共享。

### 7.2 `MountOptions`

| 字段 | 类型 / 语义 |
|---|---|
| `wsUrl`、`uploadUrl` | 透传给 `YimsgClient` 的服务地址 |
| `requestTimeout`、`reconnectInterval`、`reconnectNotifyThreshold`、`heartbeatInterval` | UIKit 自建 `YimsgClient` 时透传给 SDK 的连接参数 |
| `recallWindowSeconds` | `MountOptions` 类型保留该字段；当前 `mount()` 自建 client 不透传它，宿主如需认证前自定义撤回时限，应自行创建已配置的 `YimsgClient` 并通过 `client` 传入。登录 / 鉴权成功后仍以后端 `client_config.recall_window_seconds` 为准 |
| `instanceId` | 当前挂载实例唯一标识，用于运行时和 持久存储本地库隔离；同时也是 hash 路由的命名空间前缀（同页多开多个 widget 时避免路由互相串扰，详见 [`UI设计方案.md`](UI设计方案.md) §3.2） |
| `token` | 宿主已有 token，UIKit 挂载后自动 authenticate |
| `getToken()` | 异步 token 提供者，挂载时调用一次 |
| `client` | 复用宿主已有 `YimsgClient`；若已 ready 则跳过登录页 |
| `layout` | `desktop` / `mobile` / `auto`，默认根据容器宽度判断 |
| `mode` | `memory` / `persistent` / `persistent-cleardata`，默认 `memory` |
| `viewMode` | `full` / `chat-only` / `contacts-only`，默认 `full`；`chat-only` 隐藏底部导航栏只保留会话列表 + 聊天视图，`contacts-only` 隐藏底部导航栏只保留通讯录视图（好友 + 组织架构） |
| `theme` | `light` / `dark` / `auto` 或 token 覆盖对象 |
| `locale` | `zh-CN` / `en` / `auto` |
| `messages` | 内置文案局部覆盖；公开 `Messages` 类型覆盖嵌入包基础 key，运行时会按字符串 key 合并到完整应用词典 |
| `onReady(client)` | 挂载和事件绑定完成 |
| `onAuthenticated(info)` | 登录或鉴权成功，载荷含 token、uid、SDK auth event |
| `onLogout()` | 主动登出或被踢下线 |
| `onMessages(messages)` | 新消息批次事件，包含自己发送和收到的消息；一次合并的多条会一起回调 |
| `onConversationOpen(descriptor)` | 用户在 UI 中打开会话 |
| `onError(error, context)` | 用户可见错误或模式降级提示 |

### 7.3 `MountHandle`

| 字段 / 方法 | 说明 |
|---|---|
| `client` | 当前 UIKit 使用的 `YimsgClient` |
| `shadowRoot` | 宿主 ShadowRoot，便于调试或测试 |
| `unmount()` | 销毁 UIKit、解绑事件、清空 ShadowRoot；若 UIKit 自建 client，会登出并销毁 |
| `setTheme(theme)` | 运行期切换主题 |
| `setLocale(locale, messages?)` | 运行期切换语言和文案覆盖 |
| `openConversation({ friendUid?, groupId? })` | 程序化打开会话；直聊会自动确保会话存在 |
| `logout()` | 程序化登出并回到认证页 |
| `on(event, handler)` | 监听 widget 级事件，返回解绑函数 |

Widget 事件：

| 事件 | 载荷 |
|---|---|
| `authenticated` | `{ token, uid, event }` |
| `logout` | 无 |
| `message` | `Message` |
| `conversation:open` | `ConversationDescriptor` |
| `error` | `(error, context)` |

## 8. `mode` 语义

`UIKitMode = 'memory' | 'persistent' | 'persistent-cleardata'`。

| mode | 映射到 SDK | 行为 |
|---|---|---|
| `memory` | `startSession({ storage: 'memory' })` | 内存会话，所有环境可用，刷新即丢失 |
| `persistent` | `startSession({ storage: 'persistent' })` | 请求持久化会话；浏览器持久化能力预检查不可用时 SDK 降级为内存会话，并通过 `onError(err, 'mode:persistent-fallback')` 通知宿主；本地持久化能力初始化失败会作为错误抛出 |
| `persistent-cleardata` | `startSession({ storage: 'persistent', resetLocalData: 'current-user' })` | 先重置当前用户当前实例本地会话数据，再启动持久化会话；重置失败通过 `onError(err, 'mode:reset-local-data')` 通知但不阻断启动 |

UIKit 只表达业务意图，不直接判断本地持久化能力、持久存储 Worker 或浏览器存储能力。

## 8.1 `viewMode` 语义

`UIKitViewMode = 'full' | 'chat-only' | 'contacts-only'`，默认 `full`。

| viewMode | 行为 |
|---|---|
| `full` | 完整应用：底部导航含聊天 / 联系人 / 设置三个入口 |
| `chat-only` | 隐藏底部导航栏，只保留会话列表 + 聊天视图；用户无法通过 UI 或宿主页面 hash 路由切到联系人 / 设置页，`switchView` 会强制落回 `chat` |
| `contacts-only` | 隐藏底部导航栏，只保留通讯录视图（好友 + 组织架构）；用户无法通过 UI 或宿主页面 hash 路由切到聊天 / 设置页，`switchView` 会强制落回 `contacts`；联系人详情面板的"聊天"操作按钮隐藏 |

`chat-only` 适合宿主只需要嵌入会话能力的场景（例如网站客服组件），不需要联系人管理或个人设置入口。`contacts-only` 适合宿主只需要展示通讯录 / 组织架构的场景，不需要聊天或设置入口。两种收窄模式下，其余视图仍会被创建但始终不可见，不影响其内部状态；`switchView` 用同一张 `viewMode → 强制视图` 映射表统一处理，新增收窄模式只需扩展该映射。

## 9. 核心设计约束

- **宿主抽象**：`AppDomScope` 将 `document` / `shadowRoot` 统一成查询上下文，视图模块不直接写死全局 DOM。
- **运行时隔离**：每个 `AppInstance` 拥有自己的 client、存储、DOM scope、聊天状态和联系人分页状态。
- **事件桥接**：嵌入态通过 `AppRuntimeContext` 暴露稳定 widget 回调，不要求宿主理解 SDK 内部事件流。
- **主题隔离**：`theme.ts` 输出 `--mc-*` 变量并映射到应用 CSS 变量；`unmount()` 只清理 UIKit 自己注入的变量。
- **安全渲染**：外部 URL 必须经过 `safe-dom.ts` allowlist；普通文本默认走 `textContent` 或统一转义；HTML 只能通过显式 `SafeHtml`。
- **大列表**：会话、消息、好友、好友请求、群成员、转发候选、建群候选均使用分页读取或有界窗口渲染。
- **路由**：支持 `#/chat`、`#/contacts`、`#/settings`、`#/chat/u/:uid`、`#/chat/g/:groupId`。

## 10. 测试覆盖

| 层级 | 位置 | 覆盖点 |
|---|---|---|
| 单元测试 | `frontend/tests/unit/uikit-mount.test.ts` | `mount()` 公开面、参数校验、Shadow DOM 句柄 |
| 单元测试 | `frontend/tests/unit/uikit-theme-i18n.test.ts` | 主题变量、locale 覆盖、运行期切换 |
| 单元测试 | `frontend/tests/unit/uikit-mode.test.ts`、`session-storage.test.ts`、`startup-mode.test.ts` | mode 分支、存储适配器、布局决策 |
| 单元测试 | `frontend/tests/unit/uikit-navigation.test.ts` | `switchView` 在 `chat-only` / `contacts-only` 显示范围下强制落回对应视图、不推送非法路由 |
| 单元测试 | `frontend/tests/unit/uikit-bounded-stream-window.test.ts` | 分页列表引擎：窗口切片、全量渲染、边界提示、触界加载 |
| 单元测试 | `frontend/tests/unit/uikit-security.test.ts` | URL allowlist、SafeHtml、转义约束 |
| 单元测试 | `frontend/tests/unit/uikit-router.test.ts` | hash 路由与会话深链 |
| UI 测试 | `frontend/tests/ui/uikit-embed.spec.ts` | ESM 挂载、Shadow DOM、认证、句柄、主题、卸载、`viewMode: 'chat-only'` 隐藏底部导航栏 |
| UI 测试 | `frontend/tests/ui/security.spec.ts` | 恶意输入不执行、不生成危险 DOM |
| UI 测试 | `frontend/tests/ui/*.spec.ts` | 主应用持久存储全量能力 |

## 11. 已知边界

- 嵌入态请求 `persistent` / `persistent-cleardata` 但浏览器持久化能力预检查不可用时，会自动降级为 `memory`；若本地持久化能力初始化阶段失败，则通过错误流程交给宿主处理。
- UIKit 目前提供完整聊天 UI、`viewMode: 'chat-only'`、`viewMode: 'contacts-only'` 三种形态，不提供只读迷你浮窗或只渲染单会话（不含消息面板）的轻量组件。
- 宿主若长期保留 `MountHandle` 并自行注册事件，需要在卸载时调用返回的 disposer 或 `unmount()`。

## 12. 相关文档

- 前端总览：[`前端设计方案.md`](前端设计方案.md)
- UI 视图与有界消息流窗口：[`UI设计方案.md`](UI设计方案.md)
- SDK 内核：[`sdk设计方案.md`](sdk设计方案.md)
- SDK 对外接口：[`sdk接口说明.md`](sdk接口说明.md)
- 测试口径：[`../测试方案.md`](../测试方案.md)
