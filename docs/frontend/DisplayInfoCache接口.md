# DisplayInfoCache 接口说明

> 主要对照：`frontend/src/sdk/state/cache.ts`、`frontend/src/sdk/client.ts`、`frontend/src/sdk/client-session-runtime.ts`、`frontend/tests/unit/sdk/cache.test.ts`。  
> 最后复核：2026-05-30。
> 触发更新：`DisplayInfoCache` 构造参数、公开方法、回调字段或缓存协作语义变化时同步更新。  
> 入口关系：上级索引见 [`README.md`](README.md)；SDK 整体设计见 [`sdk设计方案.md`](sdk设计方案.md)；`DataGateway` 协作接口见 [`DataGateway接口.md`](DataGateway接口.md)。

---

## 概述

`DisplayInfoCache` 是 SDK 内部的用户 / 群显示信息缓存，不是业务方直接调用的公开 SDK API。它对 `YimsgClient` 和 `ClientSessionRuntime` 暴露同步读、写入、生命周期和回调接口，并通过构造参数拿到当前 `DataGateway` 访问函数。

当前对外接口共 **9 个**：

- 1 个构造函数；
- 2 个公开回调字段；
- 6 个公开方法（含 `stats()` 运行时统计）。

核心语义：

1. 读取接口永远同步返回：先读内存缓存，命中返回当前值，过期返回旧值，未命中先放空值。
2. 过期 / 未命中 key 立即进入有界队列；`DisplayInfoCache` 按短时间窗口合并相邻同类 key 后调用 `DataGateway.get_user_infos()` / `get_group_infos()`。
3. 缓存 TTL、条目上限、队列上限、批量上限和请求合并窗口只在构造时注入，认证后不再运行期改变。
4. `DataGateway.get_user_infos()` / `get_group_infos()` 会接收本次缓存 TTL 与更新回调；persistent 模式先返回本地 `displayinfo` 数据，再异步刷新过期 / 未命中项；memory 模式先返回空数组，再异步请求服务端。
5. `DataGateway` 异步拿到服务端最新资料后通过参数回调让 `DisplayInfoCache` 写入内存缓存；缓存过期时间按本次写入时间加 TTL 计算，不使用服务端资料的业务 `updated_at`。
6. `DisplayInfoCache` 写入后发 `display:updated` 通知 UI 重读。

---

## 1. 构造与配置入口

| 接口 | 功能说明 |
|---|---|
| `constructor(options: { dataGateway: () => DataGateway \| null; ttlSeconds?: number; maxEntries?: number; queueMaxEntries?: number; batchMaxLimit?: number; loadMergeWindowMs?: number })` | 创建缓存实例并注入当前 `DataGateway` 访问函数、TTL、条目上限、后台队列上限、单批请求上限和请求合并窗口。配置只在构造时生效，运行期不可修改；`loadMergeWindowMs` 默认 8ms，测试可设为 0 走即时 flush。 |

已删除的运行期配置 / 反查接口：

- `setBatchMaxLimit()`：单批请求上限改为构造注入。
- `setCacheConfig()`：TTL 和条目上限改为构造注入，不能运行期改变。
- `getCacheTtlMs()`：需要 TTL 的 `DataGateway` 读取由 `DisplayInfoCache` 调用时通过参数传入。
- `getCacheMaxEntries()`：`YimsgClient` 自己保存构造生效配置并用于 `getClientConfig()`。

---

## 2. DataGateway 绑定与生命周期

| 接口 | 功能说明 |
|---|---|
| `clear(): void` | 登出、切换账号或销毁运行态时清空所有缓存条目、待加载队列和加载中队列。 |
| `stats(): DisplayInfoCacheStats` | 返回用户 / 群两套有界集合（`cache` / `pending` / `loading`）的运行时统计（`size`、`capacity`、`bucketCount`、`bucketCapacity`、`rejectCount`、`evictionCount`、`loadFactor`），用于 benchmark / 内存诊断。由 `YimsgClient.getBoundedCollectionStats()` 聚合对外暴露。 |

`setDataGateway()` 已删除。缓存实例不再保存可变 `DataGateway` 引用，而是在构造时注入 `dataGateway()` 函数；会话切换后后台回调会校验当前 `DataGateway` 是否仍一致，避免旧会话结果污染新会话。

---

## 3. 同步读取接口

| 接口 | 功能说明 |
|---|---|
| `getUserInfos(uids: string[]): Map<string, { username: string; nickname: string; avatar: string; remark: string }>` | 同步读取用户显示信息。无效 UID（空字符串或 `0`）直接返回空值；命中返回缓存；过期或未命中时入队，短窗口内相邻 UID 合并后调用 DataGateway。 |
| `getGroupInfos(groupIds: string[]): Map<string, { name: string; avatar: string; remark: string }>` | 同步读取群显示信息。语义与 `getUserInfos()` 一致，使用独立的群缓存（纯 uint64 `group_id` key），并按群接口独立合并请求。 |

合并规则：

- 默认 `loadMergeWindowMs = 8`。窗口内多次 `getUserInfos()` 合并为一次 `get_user_infos()`；多次 `getGroupInfos()` 合并为一次 `get_group_infos()`。
- 用户和群使用不同协议接口，不跨 scope 合并。
- 合并后仍按 `batchMaxLimit` 分批，队列仍受 `queueMaxEntries` 约束。
- 已在 `loading` 的 key 不会重复入队；`clear()` 会清空队列并取消未触发的合并定时器。

---

## 4. 写入接口

| 接口 | 功能说明 |
|---|---|
| `setUserInfos(entries: Array<{ uid: string; username?: string; nickname: string; avatar: string; remark?: string }>): void` | 将已知用户显示信息写入内存缓存。用于资料更新、联系人备注等已知新值场景，避免等待后台刷新。 |
| `setGroupInfos(entries: Array<{ group_id: string; name: string; avatar: string; remark?: string }>): void` | 将已知群显示信息写入内存缓存。用于群资料更新、群备注等已知新值场景。 |

原 `setUids()` 和 `setGroups()` 已分别重命名为 `setUserInfos()` 和 `setGroupInfos()`。

---

## 5. 回调字段

| 接口 | 功能说明 |
|---|---|
| `onDisplayUpdated: ((keys: string[], scope: DisplayInfoScope) => void) \| null` | DataGateway 同步返回本地数据、异步返回本地数据或异步刷新更新缓存后按批触发，`keys` 为更新的 UID 或 group_id，`scope` 区分 `user` / `group`。`YimsgClient` 将其转为公开 `display:updated` 事件。 |
| `onError: ((error: Error, context: string) => void) \| null` | 后台加载、批量读取或远端请求异常时上报错误；断开连接、连接关闭、未连接等会话切换常见错误会被忽略。 |

---

## 6. 设计决策：用户 / 群拆分的有界集合

### 6.1 当前方案

`DisplayInfoCache` 内部维护**两套结构完全独立**的有界集合 `userStore` / `groupStore`，各自包含：

```
userStore.cache:   BoundedU64Map<DisplayCacheEntry>   key = uid (uint64)
userStore.pending: BoundedU64Set                       key = uid (uint64)
userStore.loading: BoundedU64Set                       key = uid (uint64)
groupStore.*:      同上                                 key = group_id (uint64)
```

key 永远是纯 uint64，不再使用 `user:<uid>` / `group:<groupId>` 字符串前缀。每套缓存固定容量、FIFO 淘汰，`size` 永不超过 `capacity`；待拉取 / 在飞队列为 reject 策略的固定容量集合。详见 [`有界集合方案.md`](有界集合方案.md)。

### 6.2 备选方案（已否决）

user 和 group 共享同一个 `Map<string, DisplayCacheEntry>`，用 `user:` / `group:` key 前缀区分，单一 `maxEntries` 统一池、全局 FIFO 淘汰。

### 6.3 决策理由

| 维度 | 拆分有界集合（当前） | 统一池（否决） |
|------|-------------|-------------|
| key 表达 | 纯 uint64，hi/lo 两段 uint32，无需 tagged union / packed key | 需要字符串前缀，禁止的无界 object/string key 路线 |
| 跨语言一致性 | **高**：固定 bucket/slot 布局可直接在 C/Rust/Go 复刻 | 低：依赖 JS 字符串 Map，难以跨语言复刻 |
| 冲突风险 | 无：uid 与 group_id 各自独立命名空间，绝不冲突 | 需靠前缀人为隔离 |
| 内存可预测性 | **高**：容量构造期固定，峰值静态可估算 | 依赖 JS Map 动态增长，峰值不可静态估算 |
| 代价 | 用户与群各自预留容量，存在少量容量浪费 | 总量竞争同一池，利用率略高 |

核心逻辑：项目目标不是极限内存利用率，而是**极致可控内存、可预测行为、跨语言一致性与嵌入式友好**。拆分后允许少量容量浪费，换取极简结构、纯 uint64 key 和峰值可估算能力。

### 6.4 注意事项

- 合并请求仍按 scope 分开（`get_user_infos` 与 `get_group_infos` 是不同协议接口）。
- `queueMaxEntries` 对用户与群分别生效，两个域的队列上限相互独立。
- 缓存满时按 FIFO 自动淘汰本域最旧条目；后台拉取批次内顺序由有界集合 slot 顺序决定，与插入顺序无关。

---

## 7. 当前结论

当前实现是合理且可行的：运行期可变配置已收敛到构造注入，`DataGateway` 不再通过独立本地缓存读写接口暴露 `displayinfo`，而是在 `get_user_infos()` / `get_group_infos()` 中完成本地读取、远端刷新和回调更新；`DisplayInfoCache` 负责有界队列、短窗口合并、内存缓存写入和 `display:updated` 通知。
