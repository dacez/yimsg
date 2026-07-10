# SDK 接口说明

> 主要对照：`frontend/src/sdk/index.ts`、`frontend/src/sdk/types.ts`、`frontend/src/sdk/client.ts`、`frontend/src/sdk/generated/actions.gen.ts`、`frontend/src/sdk/internal/action-mappers.ts`。
> 最后复核：2026-07-10。
> 触发更新：SDK 公开方法、事件、类型、ClientOptions 或调用前置条件变化时同步更新。
> 入口关系：上级索引见 [`README.md`](README.md)；通用同步机制见 [`../同步机制方案.md`](../同步机制方案.md)，本文从客户端调用者视角说明 SDK 公开 API、前置条件、返回类型和事件。

## 目录

- [1. 快速接入](#1-快速接入)
- [2. 生命周期接口](#2-生命周期接口)
- [2.1 状态读取](#21-状态读取)
  - [2.1.1 状态快照](#211-状态快照)
  - [2.1.2 推荐判定方式](#212-推荐判定方式)
- [2.2 认证方法](#22-认证方法)
- [2.3 会话初始化](#23-会话初始化)
- [3. 会话与消息接口](#3-会话与消息接口)
- [3.1 会话门面](#31-会话门面)
- [3.2 消息门面](#32-消息门面)
- [3.3 未读](#33-未读)
- [4. 联系人、群组、资料、文件](#4-联系人群组资料文件)
- [4.1 联系人与显示信息](#41-联系人与显示信息)
- [4.2 联系人写操作](#42-联系人写操作)
- [4.3 会话偏好](#43-会话偏好)
- [4.4 群组](#44-群组)
- [4.5 用户、上传](#45-用户上传)
- [5. 事件接口](#5-事件接口)
- [5.1 生命周期与连接](#51-生命周期与连接)
- [5.2 数据与缓存](#52-数据与缓存)
- [6. 只读约束](#6-只读约束)
- [7. 内存可控调用约束](#7-内存可控调用约束)
- [8. 推荐用法](#8-推荐用法)
- [8.1 启动流程](#81-启动流程)
- [8.2 页面刷新恢复](#82-页面刷新恢复)
- [8.3 事件驱动 UI](#83-事件驱动-ui)
- [9. 调用前置条件](#9-调用前置条件)
- [10. 当前版本结论](#10-当前版本结论)
- [10.1 ClientOptions 主要可配置项](#101-clientoptions-主要可配置项)

## 1. 快速接入

```ts
import { YimsgClient } from './sdk';

const client = new YimsgClient();

client.on('messages:received', ({ messages }) => {
  console.log(messages);
});

await client.login('alice', 'pass123');
await client.startSession({ storage: 'memory' });
```

---

## 2. 生命周期接口

## 2.1 状态读取

状态读取统一通过 `getSessionSnapshot()` 完成。SDK 不再公开 `connected`、`currentUid`、`mode`、`sessionState`、`connectionState`、`isAuthenticated`、`isSessionInitialized` 这类快捷字段。

### 2.1.1 状态快照

| 方法 | 签名 | 说明 |
|------|------|------|
| `getSessionSnapshot()` | `() => SessionSnapshot` | 返回完整只读生命周期快照，推荐作为状态判断主入口 |
| `getClientConfig()` | `() => ClientConfig` | 返回当前 SDK 客户端配置快照；包含显示信息缓存 TTL / 条目上限、撤回时限和当前批量上限。缓存字段固定使用本地默认 / 构造初始值，登录或 token 鉴权成功后不运行期改变；撤回时限使用后端 `recall_window_seconds`，批量上限取构造参数与后端 `batch_max_limit` 的较小值 |
| `static estimateMaxMemoryBytes(options?)` | `(options?: ClientOptions) => SdkMaxMemoryEstimate` | 静态方法，纯计算，无副作用。依据 `ClientOptions` 中的上限参数，静态推导 SDK 在当前配置下的最大 JS 堆内存占用（字节上界）。返回只读的 `SdkMaxMemoryEstimate`，包含 `totalBytes` 和各分项明细 `breakdown`。可在构造实例前调用，用于容量评估或配置合理性检查。详见 [`sdk设计方案.md § 10.1`](sdk设计方案.md)。 |
| `getBoundedCollectionStats()` | `() => BoundedCollectionStats` | 返回所有长期驻留有界集合（用户/群显示信息缓存、待拉取/在飞队列、待响应请求 map）的实时运行时统计：`size`、`capacity`、`bucketCount`、`bucketCapacity`、`rejectCount`、`evictionCount`、`loadFactor`。与 `estimateMaxMemoryBytes()` 的「理论上界」互补，反映「当前实际占用」，用于 benchmark / 内存诊断。详见 [`sdk设计方案.md § 10.2`](sdk设计方案.md)。 |

`SessionSnapshot`：

```ts
interface SessionSnapshot {
  readonly sessionState: SessionState;
  readonly connectionState: ConnectionState;
  readonly mode: SessionMode;
  readonly currentUid: string;
  readonly isAuthenticated: boolean;
  readonly isSessionInitialized: boolean;
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionState` | `'idle' \| 'authenticated' \| 'initializing' \| 'ready' \| 'destroyed'` | 会话阶段 |
| `connectionState` | `'disconnected' \| 'connecting' \| 'connected' \| 'reconnecting'` | 连接阶段 |
| `mode` | `'memory' \| 'persistent'` | 当前会话模式 |
| `currentUid` | `string` | 当前认证用户 UID，未认证时为空字符串 |
| `isAuthenticated` | `boolean` | 派生字段，等价于 `sessionState` 处于 `authenticated` / `initializing` / `ready` |
| `isSessionInitialized` | `boolean` | 派生字段，等价于 `sessionState === 'ready'` |

`sessionState` 语义：

| 值 | 含义 |
|----|------|
| `idle` | 未登录 / 已登出，还没有认证身份 |
| `authenticated` | 已完成登录或 token 认证，但尚未完成 `startSession()` |
| `initializing` | 正在初始化 DataGateway 并建立会话分页游标。memory 模式建立直读 DataGateway，不维护消息游标（消息内容按累积的通知 `msg_id` 批量直读）；持久存储模式打开本地库、读取本地游标并启动后台同步；UI 仍通过分页接口读取，不常驻全量集合 |
| `ready` | 会话初始化完成，可正常读取快照和进行业务操作 |
| `destroyed` | 实例已销毁，不应再继续使用 |

`connectionState` 语义：

| 值 | 含义 |
|----|------|
| `disconnected` | 当前未连上 WebSocket |
| `connecting` | 正在建立连接 |
| `connected` | 当前连接已建立 |
| `reconnecting` | 连续重连尝试达到 `reconnectNotifyThreshold`（默认 3 次）仍未成功，正在等待或执行重连 |

### 2.1.2 推荐判定方式

| 场景 | 推荐写法 | 说明 |
|------|----------|------|
| 判断 WebSocket 是否已连通 | `client.getSessionSnapshot().connectionState === 'connected'` | 用连接状态枚举做分支判断 |
| 判断是否已登录 / 已认证 | `client.getSessionSnapshot().isAuthenticated` | 不必自己枚举 `sessionState` |
| 判断是否可安全读取会话、联系人分页 | `client.getSessionSnapshot().isSessionInitialized` | 等价于 `sessionState === 'ready'` |
| 读取当前用户 UID 或模式 | `const snapshot = client.getSessionSnapshot()` | 再从 `snapshot.currentUid` / `snapshot.mode` 读取 |
| 一次性获取完整生命周期信息 | `client.getSessionSnapshot()` | 推荐用于调试、埋点、状态对比 |

## 2.2 认证方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `register` | `(username, password, nickname) => Promise<void>` | 注册 |
| `login` | `(username, password) => Promise<AuthResult>` | 登录，未连接时自动建连 |
| `authenticate` | `(token) => Promise<AuthResult>` | 使用 token 恢复认证态 |
| `logout` | `() => Promise<void>` | 登出并断开连接 |
| `destroy` | `() => void` | 销毁实例，进入 `destroyed` |

`AuthResult`：

```ts
interface AuthResult {
  readonly uid: string;
  readonly token: string;
  readonly clientConfig?: ClientConfig;
}

interface ClientConfig {
  readonly cacheTtlSeconds: number;
  readonly cacheMaxEntries: number;
  readonly recallWindowsSeconds: number;
  readonly batchMaxLimit: number;
}
```

`login()` 的 `token` 来自服务端新建 session；`authenticate(token)` 返回的 `token` 等于调用方传入值，用于让调用方统一处理认证结果。

## 2.3 会话初始化

| 方法 | 签名 | 说明 |
|------|------|------|
| `startSession` | `(options?: { storage?, fileSystem?, resetLocalData?, instanceId? }) => Promise<SessionStartResult>` | 按业务意图启动会话；`storage` 默认 `memory`；请求持久化时可指定 `fileSystem: 'opfs' \| 'local'`；由 SDK 内部完成持久化能力判断、必要的数据重置、DataGateway 初始化、待处理联系人能力和会话分页游标初始化；persistent 模式打开本地库后即进入 ready，数据后台同步 |

`startSession` 推荐给 UI / UIKit 使用：

```ts
await client.startSession({ storage: 'persistent', instanceId: 'main' });

await client.startSession({
  storage: 'persistent',
  fileSystem: 'local',
  instanceId: 'cli-bot',
});

await client.startSession({
  storage: 'persistent',
  resetLocalData: 'current-user',
  instanceId: 'main',
});
```

`SessionStartResult` 会返回实际使用的 `mode`、`requestedFileSystem` / `actualFileSystem`、是否从持久化降级到内存模式，以及本地数据重置是否失败。未显式指定 `fileSystem` 时，SDK 会自动探测并优先选择当前环境可用后端（浏览器优先 `opfs`，Node.js 优先 `local`）；若请求持久化但无可用后端，会自动降级为内存会话。若本地持久化能力打开失败，`startSession()` 会回退到 `authenticated` 并抛 `StorageModeError`，由调用方决定是否重试 memory；本地库打开后的数据同步失败通过 `session:sync` 和 `error` 事件上报。

> `login` / `authenticate` 成功响应中的 `client_config` 字段定义、默认值和服务端硬约束见 [`../接口总览.md#15-client_config`](../接口总览.md#15-client_config)。本文只说明 SDK 如何在客户端侧应用这些配置。

---

## 3. 会话与消息接口

会话 key 与扩展消息结构都由 `YimsgClient` 统一解释。调用方不需要自己解析 `convKey`，也不需要直接 import `message_ext` 相关 helper。

## 3.1 会话门面

| 方法 | 签名 | 说明 |
|------|------|------|
| `getConversations` | `({ cursor?, backward?, limit? }) => Promise<ConversationPage>` | 按展示通道不透明 keyset 游标拉取分页（活跃→沉默），用于会话有界消息流窗口 |
| `getUnreadCount` | `() => Promise<number>` | 读取所有正常会话未读数之和，用于导航红点等全局状态 |
| `deleteConversation` | `(target) => Promise<number>` | 删除当前用户本地会话，返回服务端 tombstone seq |
| `describeConversation` | `(source: LocalConversation \| ConversationTarget \| string) => ConversationDescriptor` | 统一把会话对象、会话目标或会话 key 转成只读会话描述 |
| `describeMessageConversation` | `(message: Message) => ConversationDescriptor` | 解析一条消息所属会话 |

`ConversationPage`：

```ts
interface ConversationPage {
  readonly page: PageInfo;  // { startCursor, endCursor, hasMoreBackward, hasMoreForward, total }
  readonly conversations: ReadonlyArray<LocalConversation>;
}
```

`ConversationDescriptor`：

```ts
interface ConversationDescriptor {
  readonly key: string;
  readonly kind: 'direct' | 'group';
  readonly id: string;
  readonly target: ConversationTarget;
}
```

说明：

- `key` 仍是稳定会话标识，但对 UI 来说应视为 opaque key，不要自己切片或约定前缀。
- `target` 是调用 `getMessages()`、`clearUnread()` 等接口时应继续使用的标准目标。

## 3.2 消息门面

| 方法 | 签名 | 说明 |
|------|------|------|
| `sendMessage` | `(target, body, msgType?) => Promise<SentMessage>` | 发送强类型 `MessageBody` 消息（底层接口） |
| `sendText` | `(target, text) => Promise<SentMessage>` | 发送文本消息，内部组装 `TextBody` |
| `sendMarkdown` | `(target, markdown) => Promise<SentMessage>` | 发送 Markdown 消息，内部组装 `MarkdownBody` |
| `sendImage` | `(target, { mediaId, ... }) => Promise<SentMessage>` | 发送图片消息，媒体仅用 `media_id` 引用，组装 `ImageBody` |
| `sendFile` | `(target, { mediaId, name, ... }) => Promise<SentMessage>` | 发送文件消息，媒体仅用 `media_id` 引用，组装 `FileBody` |
| `sendQuotedTextMessage` | `(target, input) => Promise<SentMessage>` | 发送引用消息，内部组装 `QuoteBody` |
| `forwardMessages` | `(target, messages, title) => Promise<SentMessage>` | 转发消息，内部组装 `ForwardBody`（仅携带被转发的 `msg_ids` 与标题） |
| `describeMessage` | `(message) => MessageContentDescriptor` | 从强类型 `body` 派生正文、HTML、引用、转发、图片、文件和撤回展示信息 |
| `validateTextMessage` | `(content) => void` | 发送前校验文本长度 |
| `recallMessage` | `(message) => Promise<void>` | 撤回一条自己发送的消息 |
| `deleteMessage` | `(messageId) => Promise<number>` | 删除当前用户收件箱中的消息，返回服务端 tombstone seq |
| `getMessages` | `({ target, cursor?, backward?, around?, limit? }) => Promise<MessagePage>` | 拉取消息分页（旧→新；空游标+`backward` 取最新页；`around` 传 msg_id 居中定位），返回 `{ messages, page }` |
| `clearUnread` | `(target) => Promise<void>` | 清除会话未读 |

`MessageContentDescriptor`：

```ts
interface MessageContentDescriptor {
  readonly text: string;
  readonly html: string | null;
  readonly bodyKind: 'text' | 'markdown' | null;
  readonly quote: MessageQuoteInfo | null;
  readonly forward: ForwardAttachmentInfo | null;
}
```

适用场景：

- 会话列表预览：优先读 `describeMessage(message).text`
- markdown 渲染：优先读 `describeMessage(message).html`
- 引用卡片：读 `describeMessage(message).quote`
- 转发卡片：读 `describeMessage(message).forward`
- 撤回消息：SDK 不把 recall event 当成普通消息暴露给 UI，而是把它折叠成“原消息已变为占位态”的更新

## 3.3 未读

未读不维护独立 Map：每个 `LocalConversation.unreadCount` 表示该会话未读数，`getUnreadCount()` 返回所有正常会话未读数之和。会话列表角标读 `getConversations()` 的分页项，导航红点等全局状态读 `getUnreadCount()`。

---

## 4. 联系人、群组、资料、文件

## 4.1 联系人与显示信息

| 方法 | 签名 | 说明 |
|------|------|------|
| `getContacts` | `({ cursor?, backward?, around?, limit?, status?, friendUid?, groupId?, orgId?, friendUids?, groupIds?, orgIds? }) => Promise<ContactPage>` | 按 keyset 游标拉取展示分页（friend 按 sort_key、pending 按 seq 倒序），返回 `{ contacts, page }`，展示总数改用 `getContactCount`；显示资料由 UI 另行调用 `getUserInfos` / `getGroupInfos` / `getOrgInfos` 合并 |
| `getContactCount` | `(status: number) => Promise<number>` | 按联系人状态统计数量；待我处理的好友请求（驱动红点）传 `CONTACT_STATUS_PENDING_INCOMING`，我自己发出、待对方处理的传 `CONTACT_STATUS_PENDING_OUTGOING`，好友/收藏群传 `CONTACT_STATUS_FRIEND`。memory 模式调用后端 `get_contact_count`；持久存储模式查本地副本；未认证会抛错，已认证但会话未初始化或查询失败时返回 `0` |
| `getUserInfos` | `(uids) => ReadonlyMap<string, UserDisplayInfo>` | 用户显示信息只读视图；去重后超过 `getClientConfig().batchMaxLimit` 时抛 `INVALID_ARGUMENT` |
| `getGroupInfos` | `(groupIds) => ReadonlyMap<string, GroupDisplayInfo>` | 群显示信息只读视图；去重后超过 `getClientConfig().batchMaxLimit` 时抛 `INVALID_ARGUMENT` |
| `getOrgInfos` | `(orgIds) => ReadonlyMap<string, OrgDisplayInfo>` | 组织显示信息只读视图（与 `getUserInfos`/`getGroupInfos` 同构）；去重后超过 `getClientConfig().batchMaxLimit` 时抛 `INVALID_ARGUMENT` |
| `getTagInfos` | `(orgId, tagIds) => ReadonlyMap<string, TagDisplayInfo>` | tag（部门/横向分组）显示信息只读视图；去重后超过 `getClientConfig().batchMaxLimit` 时抛 `INVALID_ARGUMENT` |
| `searchUser` | `(username) => Promise<UserInfo \| null>` | 按用户名搜索；任一方向存在屏蔽列表时返回 `null` |

`ContactPage` 的公开形状：

```ts
interface ContactPage {
  readonly page: PageInfo;
  readonly contacts: ReadonlyArray<Contact>;
  readonly hasMore: boolean;

}

interface Contact {
  readonly target: ConversationTarget;
  readonly status: number;
  readonly seq: number;
  readonly remarkName?: string;
}
```

持久存储模式下，`sync_contacts` 收到联系人删除 tombstone 后会删除本地 `contacts` 行并推进 `contact_seq`；公开 `getContacts()` 只返回当前仍可见的联系人、待处理请求或群收藏。

`getUserInfos()` / `getGroupInfos()` 的调用上限来自 `getClientConfig().batchMaxLimit`。SDK 会先按字符串值去重；去重后数量超过上限时同步抛 `ValidationError`，`YimsgError.code` 为 `INVALID_ARGUMENT`，本次调用不会返回部分 Map，也不会安排后台加载。调用方应把超出部分切成多批循环调用，例如每批最多 `client.getClientConfig().batchMaxLimit` 个 key。若后台加载绕过 SDK 单次上限并被服务端拒绝，错误会通过 `error` 事件上报为 `RequestError`，`YimsgError.code` 为 `REQUEST_FAILED`，服务端错误码在 `details.serverErrorCode` 中为 `BATCH_LIMIT_EXCEEDED`。

显示信息读取是只读缓存视图：无效 key（空字符串或 `0`）与当前缓存未命中都会同步返回空显示值；调用方不应依赖返回值区分这两类情况，而应订阅 `display:updated` 后重读当前可见项。

## 4.2 联系人写操作

| 方法 | 签名 |
|------|------|
| `addFriend` | `(friendUid, remarkName?) => Promise<void>` |
| `acceptFriend` | `(friendUid) => Promise<void>`；调用者必须是该请求的接收方，否则服务端返回 `CONFLICT` |
| `rejectFriend` | `(friendUid) => Promise<void>`；调用者必须是该请求的接收方，否则服务端返回 `CONFLICT` |
| `deleteFriend` | `(friendUid) => Promise<void>` |
| `blockUser` | `(uid) => Promise<number>` |
| `unblockUser` | `(uid) => Promise<number>` |
| `getBlocklist` | `(params?) => Promise<BlocklistUserPage>` | 按分页读取屏蔽列表，支持 `uid` / `uids` 过滤，SDK 会裁剪单次 `limit` |
| `updateRemark` | `(target, remarkName) => Promise<void>` |
| `favoriteGroup` | `(groupId, remarkName?) => Promise<void>` |
| `unfavoriteGroup` | `(groupId) => Promise<void>` |

联系人状态查询统一使用 `getContacts({ friendUid?, groupId?, orgId?, status?, limit: 1 })`，通过返回页的 `contacts.length` 判断是否存在；不再提供独立检查接口。删除好友使用 `deleteFriend`，取消群收藏使用 `unfavoriteGroup(groupId)`。

## 4.3 会话偏好

| 方法 | 签名 |
|------|------|
| `muteConversation` | `(target) => Promise<number>` |
| `unmuteConversation` | `(target) => Promise<number>` |
| `getMutelist` | `(params?) => Promise<MutelistEntryPage>` | 按分页读取免打扰，支持 `toUid` / `groupId` / `toUids` / `groupIds` 过滤，SDK 会裁剪单次 `limit` |
| `getTags` | `({ orgId, tagId, cursor?, backward?, limit? }) => Promise<TagsPage>` | 展开 tags（组织关系表）某节点的直接子项（tag 与人按绝对排序混合，子项不内嵌名字）；展开组织根传 `tagId=orgId`；persistent 模式优先读本地副本，memory 模式在线展开；子项展示名另调 `getTagInfos`/`getUserInfos` |

## 4.4 群组

| 方法 | 签名 |
|------|------|
| `createGroup` | `(name, memberUids) => Promise<string>` |
| `getGroupMembers` | `(groupId, { cursor?, backward?, limit? }) => Promise<GroupMemberPage>` |
| `updateGroupInfo` | `(groupId, info) => Promise<void>` |
| `addGroupMember` | `(groupId, uid) => Promise<void>` |
| `removeGroupMember` | `(groupId, uid) => Promise<void>` |

## 4.5 用户、上传

| 方法 | 签名 |
|------|------|
| `getUserInfos` | `(uids) => ReadonlyMap<string, UserDisplayInfo>` |
| `updateUserInfo` | `(params) => Promise<void>` |
| `updatePassword` | `(oldPassword, newPassword) => Promise<void>` |
| `uploadFile` | `(file, category) => Promise<UploadResult>` |

---

## 5. 事件接口

`YimsgClient` 继承类型安全的事件接口，公开以下事件方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `on` | `(event, handler) => this` | 注册事件监听 |
| `off` | `(event, handler) => this` | 移除指定监听 |
| `once` | `(event, handler) => this` | 注册一次性监听，触发后自动移除 |
| `listenerCount` | `(event) => number` | 返回指定事件当前监听数量，主要用于排查泄漏和测试 |
| `removeAllListeners` | `(event?) => this` | 移除指定事件或全部事件监听 |

## 5.1 生命周期与连接

```ts
client.on('session:state-changed', (event) => {});
client.on('connection:connected', (event) => {});
client.on('connection:disconnected', (event) => {});
client.on('connection:reconnecting', (event) => {});
client.on('auth:authenticated', (event) => {});
client.on('session:sync', (event) => {});
client.on('session:kicked', (event) => {});
```

| 事件名 | 载荷 |
|--------|------|
| `session:state-changed` | `SessionStateChangedEvent` |
| `session:sync` | `SessionSyncEvent` |
| `connection:connected` | `ConnectionEvent` |
| `connection:disconnected` | `ConnectionEvent` |
| `connection:reconnecting` | `ConnectionEvent` |
| `auth:authenticated` | `AuthenticatedEvent` |
| `session:kicked` | `SessionKickedEvent` |

关键载荷字段：

| 类型 | 字段 |
|------|------|
| `SessionStateChangedEvent` | `from, to, reason` |
| `SessionSyncEvent` | `snapshot, domain, status, cursor?, error?`；启动后台同步和通知同步都会发送，UI 可用它展示同步中；`failed` 会同时通过 `error` 事件上报 |
| `ConnectionEvent` | `snapshot` |
| `AuthenticatedEvent` | `snapshot, uid` |
| `SessionKickedEvent` | `snapshot` |

## 5.2 数据与缓存

```ts
client.on('messages:received', (event) => {});
client.on('messages:deleted', (event) => {});
client.on('conversations:clearunread', (event) => {});
client.on('conversations:delete', (event) => {});
client.on('conversations:sent', (event) => {});
client.on('contacts:updated', (event) => {});
client.on('blocklist:updated', (event) => {});
client.on('conversations:mutelist-updated', (event) => {});
client.on('display:updated', (event) => {});
client.on('error', (event) => {});
```

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `messages:received` | `MessagesReceivedEvent` | 重绘信号；`messages` 为按累积的通知 `msg_id` 批量取到的内容（供角标/响铃，可能为空），UI 应据此调用 `getConversations()`/`getMessages()` 重绘，不要把 `messages` 当作完整增量集合 |
| `conversations:clearunread` | `ConversationsClearunreadEvent` | `keys` 中仍在数据窗口的会话 → `getConversations({ targets })` 定向拉取并更新窗口；不在窗口则忽略 |
| `conversations:delete` | `ConversationsDeleteEvent` | 定向拉取（返回空=已删）→ 从窗口移除并往上补齐 |
| `conversations:sent` | `ConversationsSentEvent` | 本端发送消息成功后触发，让该会话移动到顶部（重拉首页+滚回顶部） |
| `messages:deleted` | `MessagesDeletedEvent` | 消息窗口就地删除该消息并往上补齐；并对会话 `key` 定向刷新预览 |
| `contacts:updated` | `ContactsUpdatedEvent` | 联系人索引或服务端联系人分页已变化，UI 应重新拉取 当前页 |
| `blocklist:updated` | `BlocklistUpdatedEvent` | 收到 `blocklist:updated` 后，提示 UI 失效当前可见屏蔽列表状态 |
| `conversations:mutelist-updated` | `MutelistUpdatedEvent` | 收到 `conversations:mutelist-updated` 后，提示 UI 失效当前可见免打扰状态 |
| `display:updated` | `DisplayInfoUpdatedEvent` | 显示名缓存刷新完成 |
| `error` | `ClientErrorEvent` | SDK 内部异步错误 |

关键载荷字段：

| 类型 | 字段 |
|------|------|
| `MessagesReceivedEvent` | `messages, conversationKeys` |
| `ConversationsClearunreadEvent` / `ConversationsDeleteEvent` / `ConversationsSentEvent` | `keys`：受影响会话 key 数组（`u:<uid>` / `g:<gid>`） |
| `MessagesDeletedEvent` | `messageId`（被删消息 id）、`key`（所在会话 key，用于定向刷新预览） |
| `ContactsUpdatedEvent` | `reason`，取值包括 `notification_sync`、`display_reordered` |
| `BlocklistUpdatedEvent` | `snapshot, reason`，当前 `reason` 为 `notification` |
| `MutelistUpdatedEvent` | `snapshot, reason`，当前 `reason` 为 `notification` |
| `DisplayInfoUpdatedEvent` | `keys, scope`，`scope` 为 `user` / `group` / `mixed` |
| `ClientErrorEvent` | `error, context, snapshot` |

说明：

- `messages:received` 是重绘信号：`messages` 只承载按累积的通知 `msg_id` 批量取到的内容（用于角标/响铃，可能为空），UI 收到后用 `getConversations()` / `getMessages()` 重新拉取重绘，新消息/撤回/删除均按服务端最新态反映；对撤回消息只暴露“原消息已更新”的结果，不暴露 recall event 本身。
- `conversations:clearunread` / `conversations:delete` 是轻量定向信号，携带 `keys`：UI 对仍在数据窗口内的会话调用 `getConversations({ targets })` 拉取当前状态并更新窗口（删除态返回空 → 从窗口移除、剩余往上补齐）；不在窗口则忽略，靠后续全量刷新追平。`getConversations({ targets })` 遵守轻通知原则，按目标只读取单个/多个会话当前状态、不分页。
- `conversations:sent` 仅在本端发送消息成功时触发（`keys` 为目标会话）。默认让该会话「移动到顶部」：无论当前滚动位置都重拉首页（newest，发出的会话因 `seq` 最大落在顶部）并滚回顶部，不点亮提示条。会话列表初始渲染由 UI `renderReadyState` 负责、不发事件；他端来消息走 `messages:received`（贴顶重拉、非贴顶点亮提示条），与本端主动发送区分。
- `messages:deleted` 由 `delete_message`（本端或他端 `messages:delete` 通知）触发，携带 `messageId` 与会话 `key`；打开中的会话 UI 在消息数据窗口内就地删除该消息、剩余往上补齐，并对会话 `key` 定向刷新预览，不重拉当前会话。持久模式先同步本地再发事件。
- `blocklist:updated` / `conversations:mutelist-updated` 是轻量同步信号，业务层按当前场景调用过滤分页读取或增量同步；完整同步机制见 [`../同步机制方案.md`](../同步机制方案.md)。
- `MemoryDataGateway` 的内存增量流与 `PersistentDataGateway` 的本地消息库都遵循同一规则，避免 UI 看见一条额外的空白系统消息。

## 6. 只读约束

以下内容都视为只读：

- 所有事件载荷对象
- 事件中的数组字段
- `getConversations()`、`getContacts()`、`getMessages()`、`getGroupMembers()` 返回值
- `getUserInfos()`、`getGroupInfos()` 返回的 map 视图
- `Message`、`LocalConversation`、`Contact`、`BlocklistUser`、`MutelistEntry`、`UserInfo`、`SessionSnapshot` 等公开模型

错误示例：

```ts
client.on('messages:received', ({ messages }) => {
  // 不要这样做
  // messages.push(...)
});

const infos = client.getUserInfos(['100']);
// 不要这样做
// infos.set('100', ...)
```

正确做法：

```ts
client.on('messages:received', ({ messages }) => {
  const copied = [...messages];
  console.log(copied);
});
```

---

## 7. 内存可控调用约束

SDK 对调用方暴露的是分页化、只读和有界接口。业务方接入时也必须遵守内存严格可控原则，避免在 SDK 之外重新构造无界状态。

调用方必须遵守：

1. 会话、联系人、群成员、屏蔽列表和免打扰管理列表使用分页接口分页读取，不要循环拉取后长期保存全量数组。
2. 消息列表按当前会话分页维护，离开会话或销毁实例时释放 UI 自己保存的消息副本。
3. `messages:received`、`conversations:clearunread` / `conversations:delete` / `conversations:sent`、`contacts:updated` 等事件只作为增量或失效信号，不要把所有事件载荷无限追加到业务侧数组。
4. 消息页和管理列表的 `limit` 即使传入更大值，也会被 SDK 与服务端裁剪；批量资料查询去重后超过 `batchMaxLimit` 会直接抛错，调用方应循环分批读取。
5. 多实例嵌入时，每个实例都应在卸载时调用 `destroy()` 或 UIKit 返回的卸载句柄，释放监听器、DataGateway 和运行态缓存。

SDK 当前提供的主要内存边界包括：WebSocket pending request 上限、公开分页读取上限、资料缓存条目上限、资料后台拉取队列上限、通知队列按类型合并、持久存储读取分页化。具体默认值见下方 `ClientOptions` 和 [`sdk设计方案.md`](sdk设计方案.md) §10。

---

## 8. 推荐用法

## 8.1 启动流程

```ts
const client = new YimsgClient();

await client.login(username, password);
await client.startSession({ storage: 'memory' });
```

## 8.2 页面刷新恢复

```ts
const token = loadToken();

await client.authenticate(token);
await client.startSession({ storage: loadStorageMode() });
```

## 8.3 事件驱动 UI

```ts
client.on('conversations:sent', () => {
  void renderCurrentConversationPage();
});

client.on('display:updated', () => {
  void renderCurrentConversationPage();
  renderCurrentChat();
});
```

---

## 9. 调用前置条件

| 方法分类 | 前置条件 |
|----------|----------|
| `register` | 无 |
| `login` / `authenticate` | 无，SDK 会自动建连 |
| `startSession` | 已认证 |
| 消息 / 联系人 / 群组 / 资料写操作 | 已认证 |
| `getConversations` / `getContacts` / `getMessages` 等 DataGateway 分页读取 | 需先 `startSession()` |
| `getUnreadCount` / `getGroupMembers` / 屏蔽列表和免打扰单点或分页读取 | 已认证 |

当条件不满足时，SDK 会抛统一错误：

- `PreconditionError`
- `ValidationError`
- `AuthError`
- `ConnectionError`
- `RequestError`
- `ProtocolValidationError`
- `StorageModeError`

`YimsgError.code` 当前取值：

| code | 含义 |
|------|------|
| `AUTH_REQUIRED` | 需要先完成登录或 token 认证 |
| `SESSION_NOT_INITIALIZED` | 需要先调用 `startSession()` |
| `INVALID_ARGUMENT` | 参数不合法 |
| `AUTH_FAILED` | 认证失败 |
| `CONNECTION_FAILED` | 连接失败或请求队列已满 |
| `CONNECTION_TIMEOUT` | 建连超时 |
| `REQUEST_FAILED` | WebSocket action 或业务请求失败 |
| `INVALID_RESPONSE` | 服务端响应未通过协议 schema 校验 |
| `UPLOAD_FAILED` | HTTP 上传失败 |
| `STORAGE_UNSUPPORTED` | 持久化存储不支持 |
| `STORAGE_FAILED` | 持久化 DataGateway 初始化或读写失败 |

服务端 WebSocket 失败响应会同时返回稳定 `error_code` 与可读 `error` 文案。SDK 保持自身错误类型不变，WebSocket action 失败仍抛 `RequestError`；服务端错误码保存在 `error.details.serverErrorCode`，调用方需要区分业务失败原因时优先读取该字段，不要依赖 `error.message` 文案。

---

## 10. 当前版本结论

当前接口版本的核心特征是：

1. 单门面
2. 显式状态机
3. 细粒度只读事件
4. 会话列表、好友通讯录和待处理请求主路径都使用分页读取；本地联系人索引只保留待处理请求计数所需的最小状态
5. recall event 在 SDK / DataGateway 层被收口为“原消息更新”
6. 内部组件拆分，但对外不扩散
7. **所有 SDK 默认配置集中在 `sdk/sdk-defaults.ts`**，可通过 `ClientOptions` 构造参数提供初始值；显示信息缓存 TTL / 条目上限只在构造时生效，不随登录 / 鉴权后的 `client_config.cache_ttl_seconds` / `client_config.cache_max_entries` 运行期改变；撤回时限由服务端 `client_config.recall_window_seconds` 驱动，批量接口单次网络请求上限取构造参数 `batchMaxLimit` 与服务端 `client_config.batch_max_limit` 的较小值并硬封顶 500
8. **SDK 内存严格可控** 是对外契约的一部分；新增 API、事件、缓存或队列时必须同时说明上限、淘汰或释放策略

## 10.1 ClientOptions 主要可配置项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `wsUrl` | `string` | 根据当前 `location` 推导；无 `location` 时为 `ws://localhost:8080/ws` | WebSocket 地址 |
| `uploadUrl` | `string` | `/api/upload` | HTTP 上传地址 |
| `requestTimeout` | `number` | 15000 ms | 请求超时时间 |
| `reconnectInterval` | `number` | 2000 ms | 断连后重连间隔 |
| `reconnectNotifyThreshold` | `number` | 3 | 连续重连尝试达到该次数才触发 `connection:reconnecting`；`connection:disconnected` 不受影响，仍每次断开立即触发 |
| `heartbeatInterval` | `number` | 30000 ms | 心跳间隔（0 禁用） |
| `wsFactory` | `(url) => WebSocket` | 原生 `WebSocket` | 自定义 WebSocket 工厂，主要用于测试或宿主环境适配 |
| `maxPendingRequests` | `number` | 100 | 最大并发未响应请求数，超限立即拒绝 |
| `cacheTtlSeconds` | `number` | 604800（7 天）| 显示信息缓存 TTL |
| `cacheMaxEntries` | `number` | 10000 | 显示信息缓存最大条目数，用户和群合计计算 |
| `profileLoadQueueMaxEntries` | `number` | 2000 | 显示信息后台加载队列最大条目数，用户和群合计计算，超限时立即拒绝新 key |
| `recallWindowSeconds` | `number` | 120 | 消息撤回时限认证前初始值（0 禁用）；登录 / 鉴权成功后以后端 `client_config.recall_window_seconds` 为准 |
| `batchMaxLimit` | `number` | 500 | 认证前批量接口单次网络请求最大条数；登录 / 鉴权成功后与后端 `client_config.batch_max_limit` 取较小值 |

公开分页读取接口（会话、联系人、消息）会裁剪 `limit` 到当前批量上限与 500 硬上限中的较小值；持久存储 / 已初始化 DataGateway 路径下的屏蔽列表和免打扰分页、增量接口也使用当前批量上限。`getGroupMembers()` 以及尚未 `startSession()` 时直连后端的屏蔽列表 / 免打扰分页使用 500 硬上限。`getUserInfos()` / `getGroupInfos()` 会先把调用方传入的 key 按字符串值去重，去重后超过当前批量上限时抛 `INVALID_ARGUMENT`；调用方应按 `getClientConfig().batchMaxLimit` 循环分批调用。

所有默认值均定义于 `frontend/src/sdk/sdk-defaults.ts`，修改时应同步更新该文件注释。

如实现发生变化，应优先同步：

- `frontend/src/sdk/index.ts`
- 本文档
- `docs/frontend/sdk设计方案.md`
