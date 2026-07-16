# DataGateway 接口说明

> 主要对照：`packages/sdk/src/datagateway/interface.ts`、`base.ts`、`instant.ts`、`persistent.ts`、`packages/sdk/src/state/cache.ts`。
> 最后复核：2026-07-16。
> 触发更新：DataGateway 接口、同步事件、显示信息本地缓存接口或 instant / persistent 数据来源变化时同步更新。
> 入口关系：上级索引见 [`README.md`](../README.md)；SDK 整体设计见 [`sdk设计方案.md`](sdk设计方案.md)；公开 API 见 [`sdk接口说明.md`](sdk接口说明.md)。

## 1. 定位

`DataGateway` 是 SDK 内部的数据访问抽象，只负责屏蔽 `instant` 与 `persistent` 两种模式的读模型差异、接收服务端通知并派发同步结果。UI 和 SDK 调用方只使用 `YimsgClient` 公开 API，不直接接触 DataGateway。

当前接口共 **22 个方法**：2 个生命周期方法、9 个数据读取 / 缓存协作方法、10 个事件回调注册方法和 1 个通知分发方法。不再包含运行期批量上限设置、联系人写后刷新入口、显示信息本地缓存读写或外部消息游标推进方法。批量上限通过构造参数注入；联系人写成功后统一走 `handleNotification({ type: 'contacts:updated' })` 的通知链路；显示信息本地落盘收敛在 `get_user_infos()` / `get_group_infos()` 内部；消息游标由 DataGateway 在 `init()` 内自行确定。

## 2. 生命周期

| 方法 | 说明 |
|---|---|
| `init(uid)` | 初始化网关并返回 `{ lastMsgSeq, lastContactSeq }`。instant 模式不维护游标，直接沿用 `BaseDataGateway` 的基线默认返回当前游标（均为 0）；persistent 模式打开本地库、清理过期显示缓存、读取 meta 游标，然后立即返回并在后台同步各域。 |
| `clear()` | 释放运行态、回调和本地 DB 连接；切换账号、登出或销毁时调用。 |

## 3. 数据读取

| 方法 | instant 模式 | persistent 模式 |
|---|---|---|
| `get_conversations(params)` | 直连 `get_conversations`（`params.targets` 非空时按目标读取当前状态、忽略分页） | 读本地 `conversations`（keyset 游标）并组合最后消息；`params.targets` 非空时按目标读取本地仍活跃会话、忽略分页 |
| `get_unread_count()` | 直连 `get_unread_count` | 汇总本地有效会话未读数 |
| `get_messages(params)` | 直连 `get_messages`，`params` 支持 `msg_ids`（按 id 批量取，与 seq 游标互斥） | 读本地 `messages` 分页；`msg_ids` 走本地 `msg_id IN (...)` 查询 |
| `get_contacts(params)` | 直连 `get_contacts` | 读本地 `contacts` 分页 / 过滤 |
| `get_contact_count(status)` | 直连 `get_contact_count` | 按显式非 0 联系人状态统计本地联系人 |
| `get_blocklist(params)` | 直连 `get_blocklist`，返回 `{ users, page }` | 读本地 `blocklist`（keyset 游标），返回同样的 `page` 元数据 |
| `get_mutelist(params)` | 直连 `get_mutelist`，返回 `{ mutes, page }` | 读本地 `mutelist`（keyset 游标），返回同样的 `page` 元数据 |
| `get_user_infos(uids, options)` | 立即返回空数组，并异步直连 `get_user_infos`，完成后调用 `options.updateDisplayInfos` | 立即返回本地 `displayinfo` 中已有的数据（不因过期过滤），并异步请求过期 / 未命中的 UID，写回本地后调用 `options.updateDisplayInfos` |
| `get_group_infos(groupIds, options)` | 立即返回空数组，并异步直连 `get_group_infos`，完成后调用 `options.updateDisplayInfos` | 立即返回本地 `displayinfo` 中已有的数据（不因过期过滤），并异步请求过期 / 未命中的 group_id，写回本地后调用 `options.updateDisplayInfos` |

### 3.1 persistent 本地 keyset 索引

persistent 模式的展示通道读取与服务端一致，使用本地自产自销的不透明 keyset 游标（`page-cursor.ts`，与服务端 `server/internal/service/page.go` 同一 base64url 方案，因此两模式游标可互相解码、切换模式时可透传）。本地 SQLite 索引按展示序对齐 keyset 查询，避免全表排序：

| 本地表 | 展示序 | 支撑索引 |
|---|---|---|
| `conversations` | `seq` 倒序（活跃→沉默） | `idx_conversations_seq(seq)` |
| `messages` | `seq` 升序（旧→新），群 / 单聊分别按目标过滤 | `idx_messages_group(group_id, seq)`、`idx_messages_to(to_uid, seq)`、`idx_messages_from(from_uid, seq)` |
| `contacts`（friend/默认） | `(sort_key, type, id)` 升序 | `idx_contacts_sort(status, sort_key, type, id)` |
| `contacts`（pending） | `seq` 倒序 | `idx_contacts_seq(status, seq)` |
| `blocklist` | `seq` 倒序 | `idx_blocklist_seq(status, seq)` |
| `mutelist` | `seq` 倒序 | `idx_mutelist_seq(status, seq)` |

研发阶段不做 migration：schema / 索引变更时本地库直接重建并重新同步。

## 4. 显示信息缓存协作

`DataGateway` 只保留显示信息读取方法 `get_user_infos()` / `get_group_infos()`，返回类型允许 `T[] | Promise<T[]>`，签名包含：

- `cacheTtlMs`：由 `DisplayInfoCache` 按构造配置传入，persistent 模式用它结合本地 `displayinfo.updated_at`（本地缓存写入时间）判断是否需要后台刷新。
- `updateDisplayInfos(entries)`：DataGateway 异步拿到服务端最新资料后调用，DisplayInfoCache 通过该回调更新内存缓存并发送 `display:updated`。

`DisplayInfoCache` 的当前流程：

1. `getUserInfos()` / `getGroupInfos()` 先同步读取 DisplayInfoCache 内存命中、过期旧值或空值。
2. miss / 过期 key 进入有界队列，并立即调用 DataGateway。
3. instant 模式下 DataGateway 立即返回空数组，并异步请求服务端。
4. persistent 模式下 DataGateway 立即返回本地 `displayinfo` 已有数据（即使已过期），DisplayInfoCache 会按本地 `displayinfo.updated_at` 计算内存过期时间并合并到本次返回 Map；DataGateway 同时异步请求过期和未命中的 key。
5. 后端返回的数据由 persistent DataGateway 写回 `displayinfo`，其中 `updated_at` 写入本地缓存刷新时间，然后通过 `updateDisplayInfos` 回调交给 `DisplayInfoCache`。
6. `DisplayInfoCache` 处理 `updateDisplayInfos` 回调时按本次写入时间加 TTL 计算内存过期时间，再发 `display:updated`，UI 重新读取当前可见页并刷新显示。

## 5. 同步与通知

`handleNotification(n)` 接收服务端 WebSocket Notification，并按通知类型进入有界队列。同类型通知在队列中最多保留一个待处理任务；处理期间再次到达只标记“需要再跑一轮”，防止通知风暴造成无界 Promise 链。

| 通知 | instant 模式 | persistent 模式 |
|---|---|---|
| `messages:received` | 不维护游标、不扫描会话：把累积的通知 `msg_id` 去重后一次 `get_messages(msg_ids=[...])` 批量读内容供 `onMessages`，并始终派发重绘信号（内容为空也派发） | 先 `syncMessages` 写本地 `messages`、`syncConversations` 写会话（同步阶段不派发内容），再按累积的 `msg_id` 批量读本地内容供 `onMessages` 并派发重绘信号；后台同步只派发空重绘信号 |
| `contacts:updated` | 只发联系人失效事件，UI 重读服务端分页和待处理计数 | `syncContacts` → `applyContactSyncBatch` 更新本地 `contacts`，必要时重建本地表 |
| `conversations:clearunread` | 无本地副本，仅回调 `onUnreadCleared(convKey)`（UI 再 `getConversations({targets})` 定向刷新） | `clearLocalUnread` 把本地会话 `unread_count` 置 0（sync-first），再回调 `onUnreadCleared(convKey)` |
| `conversations:delete` | 无本地副本，仅回调 `onConversationDeleted(convKey)`（UI 定向拉取后移除） | `deleteLocalConversation` 删本地会话行（sync-first），再回调 `onConversationDeleted(convKey)` |
| `messages:delete` | 无本地副本，仅回调 `onMessageDeleted(messageId, convKey)` | `deleteLocalMessage` 删本地消息行（sync-first），再回调 `onMessageDeleted(messageId, convKey)` |
| `blocklist:updated` | 发屏蔽列表失效事件 | `syncBlocklist` → `applyBlocklistSyncBatch` 更新本地表 |
| `conversations:mutelist-updated` | 发免打扰失效事件 | `syncMutelist` → `applyMutelistSyncBatch` 更新本地表 |
| `session:kicked` | 直接派发踢下线回调 | 同 instant |

## 6. 同步事件

`onSync(cb)` 注册内部同步事件回调，`YimsgClient` 会转成公开 `session:sync` 事件。事件结构为 `{ snapshot, domain, status, cursor?, error? }`，其中：

| 字段 | 说明 |
|---|---|
| `domain` | `storage` / `messages` / `conversations` / `contacts` / `blocklist` / `mutelist` |
| `status` | `started` / `success` / `failed` / `reset` |
| `cursor` | 当前同步域游标，可选 |
| `error` | 失败时的错误对象，可选 |

`session:sync` **只由持久存储模式发射**。基类 `BaseDataGateway.syncDomain()` 默认返回 `null`，因此 instant 模式处理任何通知都不进入 `session:sync` 包装、不发射该事件（instant 模式没有"同步"概念，只做 `get_*` 直读或失效派发）；只有 `PersistentDataGateway` 覆盖 `syncDomain()` 返回真实域，因为只有它会把变更同步进本地副本。

`session:sync` 不只表示启动阶段。持久存储首次打开本地库后会立即进入主界面，后续后台同步和通知触发的同步都会持续发送该事件；UI 用它在会话表顶部或全局状态栏展示“同步中”，同步完成后再隐藏提示。

## 7. 当前边界

- DataGateway 是 SDK 内部接口，不属于公开 SDK API。
- `sync_*` action 与 `session:sync` 事件都是 persistent 实现细节，instant 模式既不调用 `sync_*`、也不发射 `session:sync`。
- 本地副本可重建，不做 migration、ALTER TABLE 或旧数据兼容。
- 本地显示缓存只用于加速显示信息读取；服务端仍是最终真相。
