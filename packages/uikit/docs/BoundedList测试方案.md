# BoundedList 测试方案

> 主要对照：`packages/uikit/tests/unit/bounded-list/`、`packages/uikit/src/app/bounded-list/`、`apps/web/tests/component/bounded-list.spec.ts`、`apps/web/tests/performance/bounded-list.performance.spec.ts` 与 `apps/web/tests/support/bounded-list/`。
> 最后复核：2026-07-29。
> 触发更新：`bounded-list/` 源码行为变化、测试用例增删、覆盖率口径调整，或 §6 缺陷清单新增条目时同步更新。
> 入口关系：上级索引见 [`../../../docs/architecture/前端文档索引.md`](../../../docs/architecture/前端文档索引.md)；接口口径见 [`BoundedList组件设计.md`](BoundedList组件设计.md)，仓库整体测试分层见 [`../../../docs/development/测试方案.md`](../../../docs/development/测试方案.md)。

## 目录

- [1. 范围与目标](#1-范围与目标)
- [2. 测试环境](#2-测试环境)
  - [2.1 为什么是手写 fake DOM](#21-为什么是手写-fake-dom)
  - [2.2 fake DOM 能力清单](#22-fake-dom-能力清单)
  - [2.3 共用测试数据源](#23-共用测试数据源)
  - [2.4 三个容易踩的环境陷阱](#24-三个容易踩的环境陷阱)
- [3. 被测不变量](#3-被测不变量)
- [4. 用例分类](#4-用例分类)
  - [4.1 PageWindow 数据窗口](#41-pagewindow-数据窗口)
  - [4.2 PageSource 数据源](#42-pagesource-数据源)
  - [4.3 SelectionStore 选中态](#43-selectionstore-选中态)
  - [4.4 registry 注册表](#44-registry-注册表)
  - [4.5 update-pill 提示条](#45-update-pill-提示条)
  - [4.6 BoundedStreamWindow 渲染引擎](#46-boundedstreamwindow-渲染引擎)
  - [4.7 BoundedList 组件外壳](#47-boundedlist-组件外壳)
  - [4.8 大数据量与长序列压力](#48-大数据量与长序列压力)
- [5. 覆盖率口径与结果](#5-覆盖率口径与结果)
- [6. 缺陷清单与回归归属](#6-缺陷清单与回归归属)
  - [6.1 P0](#61-p0)
  - [6.2 P1](#62-p1)
  - [6.3 P2](#63-p2)
- [7. 执行方式](#7-执行方式)

---

## 1. 范围与目标

被测对象是 `packages/uikit/src/app/bounded-list/` 下的**全部 9 个文件**（含只有类型的 `types.ts` 与只有再导出的 `index.ts`）。

目标有三个，按优先级排列：

1. **锁住不变量**（§3）。列表组件的价值就在这几条：窗口有界、DOM 有界、身份唯一、游标只来自保留页、可完全释放。任何改动破坏其中一条都必须让测试变红。
2. **用高覆盖率守住行为分支**。边界组合（裁剪 + 去重 + 锚点 + 提示条 + 并发丢弃）是这个组件出错最多的地方；当前准确覆盖率与未覆盖行见 §5，不用“100%”口号代替真实结果。
3. **把缺陷变成可执行的事实**（§6）。首轮评审确认的 25 条缺陷已全部修复，每条都在对应的正式测试文件里留下了守着修复结果的回归用例——再犯必然变红。

不在本方案范围内：

- 真实浏览器里的布局、重绘、滚动惯性 —— 由 Playwright 组件与性能测试覆盖（`apps/web/tests/component/`、`apps/web/tests/performance/`）。
- 具体宿主视图（会话列表、消息列表、通讯录）如何使用组件 —— 由各自的视图测试覆盖。
- SDK 分页接口本身 —— 由 SDK 单测与服务端 E2E 覆盖。

## 2. 测试环境

### 2.1 为什么是手写 fake DOM

仓库的 vitest 跑在 node 环境，没有装 jsdom。列表组件的绝大多数行为（清空重建、锚点、监听注销、触界检测、指针期间推迟重建）只需要**可控的**元素与事件模型，不需要真实布局引擎——反而是「布局可以由测试精确编排」让锚点公式这类断言变得可能。因此 `fake-dom.ts` 手写了一套最小 DOM。

代价是必须显式模拟真实浏览器会自动做的事：`scrollHeight` 不随内容增长、`innerHTML = ''` 不会把 `scrollTop` 夹回 0、`getBoundingClientRect()` 返回测试写死的矩形。相关陷阱见 §2.4。

### 2.2 fake DOM 能力清单

| 导出 | 能力 |
|---|---|
| `FakeElement` | `className` / `classList`（add / remove / toggle / contains）、`textContent`、`innerHTML = ''` 清空、`appendChild` / `removeChild` / `remove`、`parentElement`、`children`、`setAttribute` / `getAttribute` / `removeAttribute`、`scrollTop` / `scrollHeight` / `clientHeight`、可写的 `rect` + `getBoundingClientRect()` |
| | `addEventListener` / `removeEventListener`（区分 capture）、`listenerCount(type)`、`dispatch(type, extra)` |
| `FakeWindow` | 同上的监听增删与 `listenerCount` / `dispatch`，用于验证 window 级 pointer 兜底监听被注销 |
| `FakeDocument` | `createElement()`；`new FakeDocument({ withView: false })` 模拟 `ownerDocument.defaultView` 为 `null` 的宿主 |
| `stripBoundingRect(el)` | 抽掉元素的 `getBoundingClientRect`，落到锚点 / `scrollToKey` 的降级分支 |
| `capturedListeners(el, type)` | 取出已注册的监听器本体，用于「注销之后仍被残留调用」这类白盒断言 |
| `viewOf(doc)` | 取 `defaultView`（断言用，`withView: false` 的文档上调用会抛错） |
| `asElement` / `asDoc` / `row` | 类型桥接与快捷行构造 |

**`listenerCount` 是关键能力**：内存泄漏回归不能只断言「不再触发」，必须断言监听器真的被移除了。

### 2.3 共用测试数据源

`test-sources.ts` 提供五种数据源，分别对应不同的分页语义：

| 工厂 | 语义 | 典型用途 |
|---|---|---|
| `createInstantSource(getAll, { withTotal })` | 每次 fetch 都重读 `getAll()`，`hasMore` 按真实剩余量精确判定 | 常规分页、模拟「服务端数据会变」 |
| `createAnchoredSource(getAll, anchorIndex)` | 首页从 `anchorIndex` 起切，两端都可能还有更多 | 双向续翻、双向裁剪、`around` 锚点加载 |
| `createOptimisticSource(getAll)` | 满页时**乐观**认为还有更多，只有真拿到空页才收敛 | 「触界续翻拿到空页」这条路径（提示条路径②） |
| `createControllableSource()` | 手动控制每一次 fetch 的 resolve / reject 时机 | 并发丢弃、错误处理、loading 标志的精确断言 |
| `createControllableFetcher()` | 手动控制 `fetchByIdentity` 的 resolve / reject | 定向刷新的竞态与失败路径 |

真实 keyset 分页在拿到一整页之前无法确定是否已到末尾，所以 `createOptimisticSource` 才是更贴近服务端行为的那一个；`createInstantSource` 的精确判定是为了让与分页无关的用例写起来简单。

### 2.4 三个容易踩的环境陷阱

**① `scrollHeight` 不随内容增长。** 默认 host 把它设成 `100000`（远大于 `clientHeight`），否则「内容不足一屏 → 双端都判定贴边 → 链式补页」会在与分页无关的用例里意外触发。需要验证链式补页的用例才显式把两者设成相等。

**② `reset` 默认 `pinEdge: true` 会把 `scrollTop` 摁到新鲜端。** 摁到顶之后，只要 `hasMoreBefore` 为 `true`，之后的每一次渲染都会触发 `backward` 续翻。所以只想观察某个单点行为的用例一律用 `reset({ pinEdge: false })` 再显式设置 `scrollTop = 500`。

**③ `withFrames` 的 stub 会在第一个 `await` 处失效。** `vi.stubGlobal` 配 `try/finally` 时，如果回调是 async 而外层没有 await，`finally` 会在回调刚进入第一个 `await` 时就执行、提前解除 stub。异步用例必须用 `withFramesAsync`。

## 3. 被测不变量

| # | 不变量 | 主要守护用例 |
|---|---|---|
| I1 | 每个 source 页经 normalize 后不超过 `pageSize`，窗口与 DOM 始终 ≤ `pageSize × maxPages`；live 超预算同步裁剪 | `page-window` B5/E7/E8、`stress` A1/A2/A3/A5/C2 |
| I2 | DOM 条目节点数 == `state.count`，与数据总量无关 | `stress` A1/A5/D3 |
| I3 | 提供 `identityOf` 时，窗口内同一身份至多出现一次 | `page-window` C1–C5、`stress` A1/D2 |
| I4 | 正常续翻只使用可信保留页游标；live eviction 使被裁端游标失效后立即封锁该端，后续追平只能发 `cursor: undefined` 的权威请求 | `page-window` B1/B2/C3/C5、`bounded-list` C6/G3b、`stress` B2 |
| I5 | `reset` / `loadMore` 返回的 Promise 永远 resolve，不产生未处理拒绝 | `bounded-list` K1/K6 |
| I6 | `dispose()` 之后组件挂的监听数全部归 0，提示条 DOM 与 a11y 属性还原，已排队的定位帧不再触碰 DOM，注册表不含该实例 | `bounded-list` L1/L8/L11、`stream-window` K1–K10、`stress` E1/E2 |
| I7 | 过期分页请求由 `requestId` 丢弃；live eviction 会作废基于旧边界的在飞普通分页并释放同世代 refresh token；定向刷新按 identity generation/token 隔离并及时释放，已接受 refresh 在旧分页（含 backward / forward 双向并发）在飞时把 found / absent 最终态写入 overlay，首个方向落定后继续保留、全部落定后再清理；无旧分页时淘汰同 identity 旧 overlay | `bounded-list` B9/B10/C10/E12b–E12j/K2/K5/L4–L7 及数据请求竞态回归 |
| I8 | 同一帧内多次 `invalidate` 只跑一次决策，`count` 累加、`identities` 去重合并 | `bounded-list` E10/E11、`stress` C1 |
| I9 | 多选上限没有绕过路径 | `bounded-list` I7 |
| I10 | 自动加载在**任何**服务端行为下都必然终止（空页强制收敛 + 失败退避 + 空游标短路） | `bounded-list` C8/C13–C19、`page-window` A11、`stress` B1 |
| I11 | 选中态只被自己那一条身份的删除影响，共享 store 的其它实例不受牵连 | `bounded-list` G8/G8b/G8c |
| I12 | reset / loadMore / reconcile 都按 identity 重放在飞本地最终态：容量 reconcile 在飞 / 失败时保留当前有界 DOM；overlay 超预算时拒绝不完整响应且绝不自动循环——reset / reconcile 进入 `failed + stale`，普通 loadMore 封锁两端游标并进入 stale / 显式 staged reconcile | `bounded-list` B13/B14/C21/G3c/G3d/G3f/G3i–G3l |

## 4. 用例分类

八个测试文件、共 **441 个用例**。每个文件内部按字母段分类，用例 id（`A1`、`C7`…）写在用例名开头，便于在文档与代码之间互相指认。

| 文件 | 用例数 | 覆盖对象 |
|---|---|---|
| `page-window.test.ts` | 53 | 数据窗口层 |
| `page-source.test.ts` | 28 | 数据源层 |
| `selection.test.ts` | 25 | 选中态 |
| `registry.test.ts` | 15 | 实例注册表 |
| `update-pill.test.ts` | 12 | 提示条 |
| `stream-window.test.ts` | 100 | 渲染引擎 |
| `bounded-list.test.ts` | 190 | 组件外壳 |
| `stress.test.ts` | 18 | 大数据量与长序列 |

### 4.1 PageWindow 数据窗口

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 基础记账（14 例） | `setInitial` 的空页 / 非空页、重复调用等价于重建、`total` 的透传与保留、空页续翻只收敛 `hasMore` 不动游标、`normalize` 作用于每一页、`hasMore*` 无 setter、`reset` 后可直接续翻式重建、**空页强制收敛该端 hasMore**、**空首页保留 fallback 游标**、`reset` 清 fallback、`maxPages < 1` 被夹到 1 |
| B | 整页裁剪（6 例） | 双向裁剪与对端 `hasMore` 置真、`maxPages=1` 每次整页替换、连续超额逐次裁到位、正常 source 页下的条目数上界 |
| C | 跨页去重（10 例） | 双向去重、旧页被清空仍保留有效游标、§7.2 的「裁剪后回滚 + 并发重排」四步路径、空页占名额的已知取舍、未提供 `identityOf` 时不去重、页内重复不由去重负责、`hasIdentity` 跨页查找与删除后失效 |
| D | 就地增删改（7 例） | `updateMatching` / `removeMatching` 的命中与未命中、跨页多命中、删空整页后游标仍有效、删光全部条目后 `loaded` 仍为 `true` |
| E | 实时并入 `mergeLive`（12 例） | 双端并入与对应 `hasMore` 置 `false`、空窗口自建页、`normalize`、**跨页去重与幂等**、未提供 `identityOf` 时不去重、连续 500 次并入仍受 `pageSize×maxPages` 硬预算约束、超量 source / normalize 快速失败、非空 source 页被 normalize 为空后仍推进可信游标 |
| F | 大数据量与长序列（4 例） | 1000 次 `appendForward`、400 步交替 append/prepend、每页与相邻页重叠一半的极端形态、1000 条窗口内的逐条精确增删改 |

### 4.2 PageSource 数据源

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | `serverPageSource`（6 例） | 请求原样透传、`cursor: undefined` 不被替换、不透明游标原样搬运、`fetch` 与 `map` 的错误都不吞、`map` 内做过滤 |
| B | `localPageSource`（11 例） | reset 重新 `loadAll`、续翻只切片、`setQuery` 重新过滤排序、全过滤为空、`compare` 不污染原数组、缓存快照不受原数组后续修改影响、`loadAll` 抛错透传、**`onProgress` 透传与不重复上报**、并发 reset 只发布最新世代的缓存和进度 |
| C | 边界与非法输入（8 例） | 两端越界夹紧、远超长度的游标、负游标、`limit=0`、空集合、backward 的 limit 超剩余量、reload 之后旧下标游标被夹紧、**非法游标按 0 处理（不产出 `"NaN"`）** |
| D | 大数据量（3 例） | 1000 条配 `PageWindow` 的有界性、50000 条 + `compare` 翻遍全集只 `loadAll` 一次、50000 选 1 的极低命中率过滤 |

### 4.3 SelectionStore 选中态

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 基础语义（9 例） | `toggle` 增删、`replaceSingle` 替换且不受 `max` 约束、`snapshotIds` 是拷贝、`clear` 只在非空时通知、`retainOnly` 只在实际删除时通知、`retainOnly(∅)` 等价清空、**`delete` 精确摘一个身份且不影响其它** |
| B | 上限（5 例） | `isExceeded` 三种情形、`max=0`、`max=1` 反复 toggle、被拒绝不通知、`retainOnly` 腾名额 |
| C | 订阅通知（7 例） | 多订阅者全量通知、取消函数幂等、同一函数重复订阅只登记一份、订阅者内部再改 store 不崩、订阅者在通知过程中取消自己、**快照语义**（本轮新增不通知 / 本轮注销仍通知） |
| D | 边界与大规模（4 例） | 空串 / 10KB 超长 id、转发上限 500 的真实规模、50000 身份的 `retainOnly` 只通知一次、200 个订阅者 |

### 4.4 registry 注册表

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 注册与注销（5 例） | 注册 / 注销的可见性、未注册实例的 unregister 空操作、重复注册同一实例只占一位、`registeredBoundedListIds` 是快照 |
| B | 广播（6 例） | 全量广播各一次且不带参数、Promise 返回值 fire-and-forget、空注册表、200 实例广播、**异步拒绝与同步抛错都被兜住且不中断整轮广播** |
| C | 边界（4 例） | 同 id 互相覆盖、unregister 不误删覆盖它的新实例、广播过程中注销自己、空 id 是合法 key |

用例统一用 `afterEach` 清理注册表——它是模块级单例，不清会跨用例污染广播断言。

### 4.5 update-pill 提示条

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 挂载与显隐（5 例） | 默认隐藏、`setVisible` 显隐与文案、初始 class、传空串真的清空文案、50 次反复显隐不重复挂载、同一 host 下多个提示条互不干扰 |
| B | 点击（3 例） | 触发 `onClick`、隐藏状态下同样触发、连续点击每次都回调 |
| C | 释放（3 例） | `dispose` 摘节点 + 注销监听、之后 `setVisible` 不影响 host、幂等 |
| D | `host=false`（1 例） | 不创建 DOM，全部方法空操作 |

### 4.6 BoundedStreamWindow 渲染引擎

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 全量渲染（7 例） | 无 spacer、锚点只打在首元素、一行多元素、返回空数组、每次都清空重建（不 diff）、`scrollTop` 先读后清恢复、被夹回 0 时显式恢复、1000 行一次性渲染 |
| B | 状态与边界提示（10 例） | 未加载 / 空态 / 边界 / 加载四种提示的**全部组合**（含文案缺失时什么都不渲染、未加载分支优先于空态、边界提示优先于加载提示）、三段式渲染顺序、**errorText 代替空态**（含空串与「有条目时不参与渲染」） |
| C | 触界检测（9 例） | `reachPx` 可配置与默认 160 的边界值（160 触发 / 161 不触发）、没有更多时不触发、内容不足一屏时双端都触发、未加载不检测、**空列表仍然检测**（避免定格在空态）、空列表且两端没有更多时不触发、滚动帧合并、从未 render 就滚动、回调缺失时空操作 |
| D | 锚点（7 例） | 头部插入后偏移不变、尾部裁剪不动、锚点选取规则（第一条底边仍在视口顶以下）、锚点消失时不校正、没有锚点节点时不校正、捕获阶段与恢复阶段各自的布局能力降级 |
| E | `scrollToKey`（6 例） | 下方 / 上方 / 已完整可见三种 nearest 情形、center 居中、拿不到布局信息仍返回 `true`、边界提示不会被误当成目标 |
| F | 贴边判定（5 例） | head / tail 的阈值边界、`stickyPx=0`、内容不足一屏时两端都贴边、`dispose` 后仍可查询 |
| G | 指针期间推迟重建（8 例） | 推迟与抬起后下一帧应用、多次 render 只应用最后一次、window 级兜底、无积压时不安排冲刷、未按下就收到抬起、抬起后又正常渲染导致冲刷退化为空操作、一次按下多次抬起只冲刷一次、未按下时立即重建 |
| H | 事件委托（8 例） | 嵌套元素上溯（含 5 层深）、`contentElement` 分离、无锚点祖先、点边界提示、`target` 为 `null`、路径中夹着没有 `getAttribute` 的节点、未提供 `onInteract` |
| I | 键盘导航（15 例） | 方向键移动与高亮、首次上下的起点、`preventDefault`、`Enter`/`Space` 激活与 `viaKeyboard`、无焦点时不激活、两端越界触发翻页且不移焦点、回调缺失、无条目 / 从未 render、其它按键不消费、焦点按 identity 保持、原身份消失时钳制、清空后归位、首元素无 `classList` 的降级 |
| J | 内容 `load`（3 例） | 触发 `onContentLoad`、未提供时空操作、监听确实注册在捕获阶段 |
| K | 释放（10 例） | `scrollElement` / `window` / `contentElement` 三处监听全清、无 `defaultView` 的宿主、`dispose` 后 render 空操作 / `scrollToKey` 仍可查询、幂等、已排队的下一帧不触碰 DOM、**注销后残留调度被触发**（白盒）、200 实例压力 |
| L | 辅助导出（12 例） | `getOrCreateBoundedStreamWindow` 复用与区分、`catchUpAtEdge` 三态 + 短路 + fire-and-forget、`createFrameScheduler` 的合并 / 重排 / cancel / cancel 后重排 / 未调度时 cancel / 无 rAF 时同步执行 |

### 4.7 BoundedList 组件外壳

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 构造与默认值（15 例） | 提示条宿主组合、`freshEdge` 默认值、显式 `stickyPx`、注册表、内部 selection、**参数校验抛错**（正安全整数、乘积安全、`store+max` 互斥）、**a11y 属性设置与精确还原宿主原值**、宿主 `register`、目录入口 |
| B | reset 首屏（14 例） | 首屏加载、空首页、加载中文案、`pinEdge` 双端行为、`pinEdge: false`、`settleFrames` 多帧与单帧、`reset({ query })` 四种传参组合（含显式 `undefined`）、并发丢弃、10 次乱序落地、切换后不残留旧数据、请求参数透传、**普通 reset 在飞期间按 identity 重放 upsert / patch / remove 最终态**、**overlay 溢出时拒绝旧响应且不自动循环、不清空当前本地窗口** |
| C | 双向续翻（22 例） | forward / backward 的裁剪、backward 到头收敛、无更多时不发请求、同方向并发守卫与反方向并发、裁剪后游标正确、触界自动续翻、链式补页终止（4 次请求）、按 normalize 后 accepted count 回调空页但继续使用已前进游标、`loadMore` 期间 reset、跨页去重、`normalize`、**在飞期间的本地最终态在返回页并入后重放**、**失败后不自动重试**、**显式 loadMore 与滚离触界都能解除暂停**、**空页报还有更多也会收敛**、**空首页继续补页**、**无可用游标时不发空游标请求**、**空首页的真实游标仍可用** |
| D | setQuery 防抖与进度（9 例） | `debounceMs=0` 同步、默认 300ms 的**边界值**（299 不触发 / 300 触发）、自定义值、负数等价 0、`dispose` 取消计时器、`dispose` 后空操作、`setQuery` 触发的 reset 回到新鲜端（1000 条 `localPageSource`）、**`onLoadProgress` 透传**与未配置时请求形状不变 |
| E | invalidate 决策树（28 例） | `isActive=false` 的两种情形（含贴边时也不追平）、贴边追平、不贴边点亮、`pendingCount` 累加与归零、命中 / 未命中 / 无 `fetchByIdentity` 三条分支、定向刷新不动游标、同帧合并、身份去重、定向刷新失败、定向刷新返回 / 失败时已 dispose、无参 invalidate、首屏未加载时 invalidate、`onStaleChange`、**不可见时仍重渲同步提示条**、**定向刷新期间提示条立即亮起**、requestId 与**按 identity generation/token** 丢弃守卫、不同 identity 并发互不淘汰、本地 patch / remove / upsert 使同 identity 在飞刷新失效、token 只为真实命中的在飞 identity 存活且落定后释放、同步抛错也释放 token、已接受 refresh 无旧分页时淘汰同 identity 旧 overlay、有 backward / forward 旧分页并发时把 found / absent 最终态写入 overlay并保留到两端都落定、防止晚到旧页回退或复活、live 裁剪作废请求世代时同步释放 refresh token |
| F | 提示条三条路径（11 例） | 路径①及其 loading 守卫、路径②（tail）与只认新鲜端方向（head）、路径③、点击提示条、文案随计数变化、无待追平时贴边不发请求、**无 `updatePill` 文案时不显示提示条**、**非空末页也清提示条**、**非新鲜端方向到尽头不清** |
| G | 本端增删改（25 例） | 双端 `upsertLocal`、达到硬预算后从非新鲜端同步裁剪并保留新条目、失效游标立即封锁、无游标 staged reconcile、请求在飞保留有界 DOM、重放期间本地变更、失败保留数据并暴露 retry、显式追平取消已排队的自动帧、mutation 按 identity 合并而不以 FIFO 截断语义、**overlay overflow 保留窗口并失败，绝不自动循环；一次显式追平建立新快照**、**显式追平撞上已溢出的在途 reconcile 时立即以 requestId 作废旧请求并新发无游标请求**、**权威请求在飞时的 live eviction 只进入 overlay，不额外安排第二次追平**、patch 继承既有 upsert 的重放顺序、`pinEdge=false` 后按真实几何判断是否贴边、reconcile 在飞时延后定向刷新到新窗口提交之后、`normalize` 去重、事件触发、`patch` / `removeLocal`、共享 store / pinnedItems 不被误删、`upsertLocal` 幂等与跨页去重 |
| H | 渲染与文案（17 例） | `pinnedItems` 参与渲染不计数、只有 pinned 时不显示空态、`RenderItemContext` 全字段、未开启 selection 的默认值、pinned 参与 `previous` 链、`emptyFiltered` 与回退、循环引用查询、**结构比较不看键顺序**、**查询比较的各类不等形态**、边界文案、`text` 全缺省、`render()` 反映外部状态且不发请求不动滚动、**首屏失败的错误态与重试入口**（含无 `error` 文案的向后兼容、有条目时不显示错误态） |
| I | 交互与选中态（13 例） | 点击 / 键盘激活、点击 pinned（含遍历过不匹配的 pinned）、点到已不存在的身份、single 的双重语义、multi 的翻转、**上限无绕过**、共享 store 双实例、`onSelectionChange` 载荷、无回调时不崩、`selectable` 语义、外部改 store 触发重渲、**`onSelectionChange` 的 items 顺序与渲染一致** |
| J | `scrollToIdentity`（4 例） | 命中 / 未命中、pinned 身份、center、身份在窗口但没有渲染节点 |
| K | 错误处理（8 例） | reset / forward / backward 三个阶段、过期失败被丢弃（reset 与 loadMore 各一）、无 `onError` 时 `console.warn` 且带 id 前缀、失败后可重新 reset、非 Error 拒绝值 |
| L | 释放（11 例） | 全部监听清零 + 注册表注销 + 提示条摘除、dispose 后所有命令空操作、`getState` 仍可读、在飞的 reset / loadMore 的成功与失败四种组合、50 实例压力、共享 store 取消订阅、同 id 重建、**已排队的定位帧不再触碰滚动位置** |
| M | 只读状态（10 例） | 初始快照全字段、`total` 透传与未知、`loading` 是并集、`onLoadStateChange`、`getState` 是新快照、`atFreshEdge` 实时、**内容异步增高后重新贴底**（head 端不受影响）、**`failed` 字段的置位与清零** |
| N | 防御性守卫（3 例，白盒） | dispose 后残留的选中订阅回调、dispose 后残留的 invalidate 帧回调、无待处理 invalidate 时的帧回调 |

> N 段是**白盒用例**：这三个守卫在当前公开 API 下走不到（`dispose()` 已经取消了订阅与帧调度），但它们是防止将来调度实现变化后漏保护的安全网。用例通过子类捕获订阅回调、直接调用私有方法来验证守卫本身，并在注释里写明了这一点。

### 4.8 大数据量与长序列压力

| 段 | 主题 | 覆盖要点 |
|---|---|---|
| A | 有界性不变量（5 例） | 10000 条翻到尾、4000 条从中间双向翻 60 次、`maxPages=1` 翻 50 次、`localPageSource` 50000 条翻遍全集只 `loadAll` 一次；`PageWindow` 直接构造的兼容路径与生产 `BoundedList` 强制传入 `pageSize` 的硬预算路径分开验证 |
| B | 长序列滚动（2 例） | 触界驱动的 200 次来回滚动（每轮必然拉到该端尽头且必然终止）、长序列翻页后仍能正确翻回起点 |
| C | 高频事件（5 例） | 同帧 1000 次 `invalidate`、2000 次 `upsertLocal`、1000 次 `patch` + 1000 次 `removeLocal`、500 个共享选中项、1000 次 `render()` 不发请求 |
| D | 极端形态数据（4 例） | 10KB 身份键、全部条目身份相同、每行 5 个节点、`normalize` 把整页压成 1 条 |
| E | 生命周期（2 例） | 200 次「打开 → 翻页 → 关闭」循环、100 实例共享一个 store 后全部释放 |

每个用例的断言都是**不变量**而不是具体数值：`count ≤ pageSize × maxPages`、DOM 节点数 == `count`、锚点键集合无重复。

## 5. 覆盖率口径与结果

覆盖率用 vitest 自带的 v8 provider 统计，范围限定在 `src/app/bounded-list/**`：

```bash
cd packages/uikit
npx vitest run --config vitest.config.ts \
  --coverage.enabled --coverage.provider=v8 \
  --coverage.include='src/app/bounded-list/**' \
  --coverage.reporter=text \
  tests/unit/bounded-list
```

2026-07-29 使用本文命令实测结果：

| 指标 | 结果 |
|---|---|
| Statements | **96.45%**（1116 / 1157） |
| Branches | **94.83%**（680 / 717） |
| Functions | **98.91%**（183 / 185） |
| Lines | **96.8%**（969 / 1001） |

同轮结果为 8 个文件、441 项全部通过。未覆盖行集中在 staged reconcile / overlay 的少量防御分支、极端裁剪分支和运行时降级路径；不能沿用“逐文件 100%”的旧结论。`index.ts` 与 `types.ts` 没有可执行语句（纯再导出 / 纯类型）。

两处「公开 API 走不到」的分支是靠白盒手段覆盖的，代码与用例里都写明了理由：

| 位置 | 分支 | 覆盖手段 |
|---|---|---|
| `bounded-list.ts` 选中订阅回调的 `disposed` 守卫 | dispose 后回调仍被调用 | 子类重写 `subscribe` 捕获回调，dispose 后直接调用（`bounded-list` N1） |
| `bounded-list.ts` `flushInvalidate` 的 `disposed` / `!pendingInvalidate` 守卫 | dispose 后 / 无待处理时的帧回调 | 直接调用私有方法（`bounded-list` N2/N3） |
| `stream-window.ts` 滚动帧回调的 `disposed` 守卫 | 注销后残留调度被触发 | `capturedListeners` 取出监听器本体，dispose 后手动调用（`stream-window` K9） |

`mergeLive` 现在有真实可达的硬预算裁剪与容量追平路径：同步裁剪保证 DOM 绝不越界，并立即封锁被裁端的失效游标、作废基于旧窗口边界的在飞普通分页。后续由 BoundedList 发起无游标 staged 权威 reconcile；请求在飞或失败时保留当前 capped DOM，成功前在独立窗口按 identity 重放这段时间的 upsert / patch / remove，再原子替换。普通 reset 与 loadMore 也使用同一套最终态重放，避免远端响应覆盖在飞 live。唯一 identity 超过 overlay 预算时，reset / reconcile 拒绝无法完整重放的响应、保留当前有界窗口并进入 `failed + stale`；普通 loadMore 丢弃该页、封锁两端游标并进入 stale / 显式 staged reconcile，沿用普通分页错误模型而不把 `state.failed` 置真。三条路径都绝不自动循环拉取。用户或调用方一次显式 `loadMore` / 提示条重试即可建立新快照；若它撞上已溢出的在途 reconcile，组件立即递增 `requestId` 作废旧响应并新发无游标请求，无需第二次点击。该路径不能退化成拿旧游标续翻，也不能先清空当前 DOM。

**维护要求**：新增分支必须同步新增用例。CI 的质量趋势任务（`YIMSG_QUALITY_GATES=1`）会记录覆盖率，出现回落要在合并前补齐。

## 6. 缺陷清单与回归归属

首轮评审确认的 25 条缺陷**已全部修复**。下表保留编号与成因，便于回溯讨论；「回归用例」一列是现在守着这条修复的用例，改坏了必然变红。

优先级口径：**P0 = 会导致页面卡死或用户数据丢失；P1 = 功能不正确或契约未兑现；P2 = 健壮性、一致性与可维护性。**

### 6.1 P0

| 编号 | 缺陷 | 修复方式 | 回归用例 |
|---|---|---|---|
| BL-BUG-01 | 翻页失败后立即重试：贴边且窗口不足一屏时，「失败 → 重渲 → 触界 → 立刻重试」全在微任务里跑，宏任务被饿死，**页面完全卡住**并对服务端形成风暴式重试 | 两道闸门：① 续翻拿到空页时窗口**强制**把该端 `hasMore` 收敛为 `false`（服务端违反契约也停得下来）；② 某方向失败后暂停该方向的**自动**续翻，滚离触界范围 / 显式 `loadMore` / `reset` 三者之一解除，显式调用不受暂停影响 | `bounded-list` C13/C14/C15/C16、`page-window` A11 |
| BL-BUG-02 | `removeLocal` 用「本实例窗口内的身份」做 `retainOnly`，把共享 `SelectionStore` 里属于另一个 tab、`pinnedItems`、以及已被裁剪出窗口的选中项一并清掉——**用户选好的转发目标被静默清空** | 新增 `SelectionStore.delete(id)`，`removeLocal` 只精确摘掉被删的那一个身份 | `bounded-list` G8/G8b/G8c、`selection` A8/A9 |
| BL-BUG-03 | 定向刷新回调只有 `disposed` 守卫，`reset` 后的旧结果会污染新窗口；若用全局刷新序号修正，又会误淘汰不同 identity 的并发结果 | `requestId` 隔离窗口世代；只为实际命中的在飞 identity 建独立 token，同 identity 后发刷新或本地写入胜出，不同 identity 响应可分别落地；接受结果时按旧分页是否在飞决定写入或淘汰 overlay，完成或世代作废时释放 token | `bounded-list` E12b–E12j |

### 6.2 P1

| 编号 | 缺陷 | 修复方式 | 回归用例 |
|---|---|---|---|
| BL-BUG-04 | 提示条路径② 只认「空页」，非空的最后一页把 `hasMore` 收敛为 `false` 时提示条不消失 | 判定改为「新鲜端 `hasMore` 由真变假」；`onEmptyPage` 仍只在真的空页时回调 | `bounded-list` F10/F11 |
| BL-BUG-05 | 未提供 `text.updatePill` 时 `?? ''` 让提示条以空文案显示出来 | 文案缺省即不显示提示条 | `bounded-list` F9 |
| BL-BUG-06 | 组件没把 `onContentLoad` 接给渲染引擎，图片异步增高后不会重新贴底 | 接线并用**加载前缓存的贴边状态**判断（现算必然误判成不贴边） | `bounded-list` M8/M9 |
| BL-BUG-07 | `isActive() === false` 分支不重渲，切回可见时提示条与状态脱节 | 该分支末尾补一次 `render()` | `bounded-list` E1b |
| BL-BUG-08 | 渲染引擎在「列表为空」分支 early return，不做触界检测，空首页 + `hasMore=true` 会定格在空态 | 空态分支返回前也做一次 `checkReach()` | `stream-window` C5/C5b、`bounded-list` C17 |
| BL-BUG-09 | `mergeLive` 不做身份去重，重复 `upsertLocal` 会渲染两遍；条目已在别的页时也会重复 | `mergeLive` 并入前先跨页去重 | `page-window` E6/E6b/E6c、`bounded-list` G11/G12 |
| BL-BUG-10 | `mergeLive` 在空窗口自建页时游标为空串，后续续翻带着空游标去请求服务端 | `setInitial` 把空首页的边界游标留作 fallback；自建页继承 fallback，连 fallback 都没有时两端 `hasMore` 一并置假；`loadMore` 对空游标短路 | `page-window` A12/A13/E3/E3b、`bounded-list` C18/C19/C20 |
| BL-BUG-24 | 组件登记在进程级注册表，而 `main-app` 重连时广播的是 `AppInstance` 自己那份，迁移后的列表收不到广播 | 新增构造参数 `register`，让宿主把实例登记进自己的注册表；`AppInstance` 的按实例隔离保持不变（多格子场景必需） | `bounded-list` A13 |

### 6.3 P2

| 编号 | 缺陷 | 修复方式 | 回归用例 |
|---|---|---|---|
| BL-BUG-11 | `localPageSource` 对非法游标不设防，产出 `"NaN"` 且此后永远翻不动 | `Number.isFinite` 校验，非法按 `0` 处理 | `page-source` C8 |
| BL-BUG-12 | `isQueryActive` 用 `JSON.stringify` 比较，键顺序不同即误判为「已过滤」 | 改为结构比较（深度上限 8 层兼作环引用兜底） | `bounded-list` H8/H8b/H8c |
| BL-BUG-13 | 定向刷新期间 `render()` 被推迟到请求返回之后，提示条延迟亮起 | 发请求前先 `render()` 一次 | `bounded-list` E11b |
| BL-BUG-14 | `dispose()` 后 `pinToFreshEdge` 已排队的帧仍写 `scrollTop` | `settle` 回调加 `disposed` 守卫 | `bounded-list` L11 |
| BL-BUG-15 | 焦点钳制发生在渲染末尾，窗口变短那一次渲染整帧丢失高亮 | 钳制提前到取焦点键之前 | `stream-window` I13 |
| BL-BUG-16 | `reset` 失败后显示「暂无数据」，无法区分「没有数据」与「加载失败」 | 新增 `text.error` / `text.retry` 与 `state.failed`；失败时渲染 `.list-error-state`，提示条位置复用为重试入口 | `bounded-list` H13/H14/H15、`stream-window` B8/B9/B10、`bounded-list` M10 |
| BL-BUG-17 | `maxPages=0` 时 `setInitial` 不裁剪、`mergeLive` 却裁，一次并入把窗口连同新条目裁光 | `PageWindow` 把 `maxPages` 夹到 ≥ 1，构造参数层面直接拒绝 < 1 | `page-window` A14、`bounded-list` A9 |
| BL-BUG-18 | `onSelectionChange` 的 `items` 顺序（窗口在前）与渲染顺序（pinned 在前）不一致 | 统一成 `[...pinned, ...window.items]` | `bounded-list` I9b |
| BL-BUG-19 | `localPageSource.loadAll` 的 `onProgress` 无法从 `fetch` 透传，进度能力实际不可用 | `FetchPageRequest` 增加可选 `onProgress`，组件在 `reset` 时按 `onLoadProgress` 注入 | `page-source` B8/B9/B10、`bounded-list` D8/D9 |
| BL-BUG-20 | 构造参数不做任何校验：`pageSize`/`maxPages` 传 0 退化成空窗口，`store` 与 `max` 同时给出时 `max` 被静默忽略 | 构造期校验，违者抛 `RangeError` / `TypeError` | `bounded-list` A9/A10 |
| BL-BUG-21 | 组件不设置 `tabindex` / `role`，键盘导航实际不可达 | 构造时补 `tabindex` / `role=listbox` / `aria-multiselectable`，行上补 `role=option` / `aria-selected`，`dispose` 还原 | `bounded-list` A11/A12/L1 |
| BL-BUG-22 | `SelectionStore.notify()` 直接遍历 `Set`，订阅者增删订阅时行为未定义 | 先快照再遍历，语义确定 | `selection` C6/C7 |
| BL-BUG-23 | `invalidateAllBoundedLists` 用 `void` 丢弃返回值，异步实现拒绝会变成未处理拒绝 | 同步调用但兜住同步抛错与异步拒绝，降级为 `console.warn`，且不中断整轮广播 | `registry` B5/B6 |
| BL-BUG-25 | `src/app/bounded-list.ts` 与 `bounded-list/` 同名，`.ts` 优先导致组件公开入口被遮蔽 | 删除旧文件，`BoundedListController` 并入 `registry.ts`，`app-instance.ts` 改从新路径导入 | `bounded-list` A14 |

## 7. 执行方式

```bash
# 只跑 bounded-list 相关用例
cd packages/uikit && npx vitest run --config vitest.config.ts tests/unit/bounded-list

# 带覆盖率
cd packages/uikit && npx vitest run --config vitest.config.ts \
  --coverage.enabled --coverage.provider=v8 \
  --coverage.include='src/app/bounded-list/**' \
  --coverage.reporter=text tests/unit/bounded-list

# UIKit 全量单测（从仓库根目录）
npm run test:uikit

# BoundedList 真实 Chromium 功能测试（从仓库根目录）
./tools/run_component_tests.sh
# 等价 npm 分类入口：npm run test:component

# BoundedList 独立性能测试（从仓库根目录）
./tools/run_performance_tests.sh
# 等价 npm 分类入口：npm run test:performance

# 仓库全量正确性测试（从仓库根目录）
./tools/run_all_tests.sh
```

仓库全量脚本按 unit → integration → E2E → component 调用公开分类入口；`chromium-component` 以零重试运行 BoundedList 功能 spec，且不会发现 `apps/web/tests/performance/`，因此同一批功能用例不会重复执行。性能分类保持独立，由 `run_performance_tests.sh` 以 `chromium-performance`、单 worker、零重试执行。性能阈值与结果口径见 [`测试方案.md` §7](../../../docs/development/测试方案.md#7-boundedlist-playwright-与性能专项)。

用例数与整体统计以 `tools/scripts/check_docs_consistency.sh` 的输出为准；本文 §4 的分项数量在用例增删时同步更新。当前通过 Vitest 列举与实际执行核对为 441 项，其中 `bounded-list.test.ts` 为 190 项、`page-window.test.ts` 为 53 项。

修改 `bounded-list/` 源码后至少要跑定向单元、浏览器组件和性能三个入口，再以 `./tools/run_all_tests.sh` 收口；改动涉及宿主接线（`app-instance.ts` / `main-app.ts`）时，E2E 分类会同时覆盖真实 Web 宿主。
