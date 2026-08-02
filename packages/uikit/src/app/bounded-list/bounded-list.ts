// BoundedList 组件外壳：编排数据窗口、渲染引擎、选中态、提示条与事件。
// 接口口径单一事实源：packages/uikit/docs/boundedlist/组件设计.md。
//
// 两项容易被误改的语义决策：
// 1. `state.loaded` 不直接用 PageWindow.loaded：PageWindow 对「真实为空的首页」和
//    「尚未加载」都表现为 pages.length===0，无法区分「还在转圈」与「确认没有数据」。
//    这里改用组件自己的 firstLoadDone（reset 发出的首次请求落定即置 true，无论
//    结果是否为空），空态与加载态才能被渲染引擎正确区分。
// 2. 多选无论从复选框还是行内其他区域触发，都统一走 SelectionStore.toggle 的上限
//    检查，不能让点击区域差异绕过 `max`。

import { PageWindow } from './page-window';
import { SelectionStore } from './selection';
import { createUpdatePill, type UpdatePillHandle } from './update-pill';
import { BoundedStreamWindow, DEFAULT_REACH_PX } from './stream-window';
import { frameScheduler, nextFrame } from './frame';
import { valuesEquivalent } from './deep-equal';
import type {
  BoundedListOptions,
  BoundedListState,
  Edge,
  ErrorPhase,
  FetchPageRequest,
  PageLoadResult,
  RenderItemContext,
} from './types';

const A11Y_ATTRS = ['tabindex', 'role', 'aria-multiselectable'] as const;

/**
 * 尚未被权威页确认的本地最终态，按 identity 索引。三个 kind 各有唯一来源：
 *
 * - 'upsert'（来自 `upsertLocal`）是本端新增，依赖「自己和已加载内容的相邻关系」，
 *   **只重放进权威窗口**：权威首页按构造就是新鲜端那一页（该端 `hasMore` 必为
 *   `false`），相邻关系在那里天然确定。记它的唯一目的是让本端并入活过一次权威窗口
 *   替换——并入本身在 `upsertLocal` 里已经同步做完、立刻可见，overlay 只负责它不要
 *   在权威响应落地时消失。
 * - 'replace'（来自 `patch`，以及 `fetchByIdentity` 落地时仍有旧分页在飞）与 'remove'
 *   （来自 `removeLocal`，以及 refresh 判定该身份已不存在）与位置无关：幂等、与重放
 *   顺序无关、命中不到就是空操作，可以重放到任何窗口上（分页并入后也重放）。
 */
type LocalMutation<T> =
  | { readonly kind: 'upsert'; readonly item: T }
  | { readonly kind: 'replace'; readonly item: T }
  | { readonly kind: 'remove' };

export class BoundedList<T, Q = void> {
  private window: PageWindow<T>;
  private readonly stream: BoundedStreamWindow<T>;
  private readonly pill: UpdatePillHandle;
  private readonly selection?: SelectionStore;
  private readonly unsubscribeSelection?: () => void;
  private readonly unregister: () => void;
  /**
   * 新鲜端派生出来的全部常量，构造期算一次。
   *
   * 「新数据从哪一端进来」会派生出贴边阈值、贴边校正帧数、贴边时 scrollTop 取 0
   * 还是 scrollHeight 等一串取值。全部在这里定死，改新鲜端语义只改这一处；别在
   * 方法里重新写 `edge.at === 'head' ? … : …`。
   *
   * 没有单独的 `toward` 字段：Direction/FreshEdge 合并成 Edge 之前，`toward`（朝新鲜端
   * 走的方向）和 `at`（新鲜端本身）是两个不同类型、需要互相换算的值；合并之后两者
   * 恒相等，直接用 `at` 即可。
   */
  private readonly edge: {
    /** 新鲜端。 */
    readonly at: Edge;
    /** 非新鲜端，即容量裁剪发生的那一端。 */
    readonly away: Edge;
    /** 距新鲜端多少像素以内算贴边。 */
    readonly stickyPx: number;
    /** 贴边时连续校正多少帧（tail 端内容会异步增高，需要多帧）。 */
    readonly settleFrames: number;
  };
  private readonly reachPx: number;
  private readonly scheduleInvalidateFlush: (() => void) & { cancel: () => void };
  private readonly scheduleCapacityReconcile: (() => void) & { cancel: () => void };
  private readonly originalA11yAttributes = new Map<(typeof A11Y_ATTRS)[number], string | null>();
  /** 尚未被权威页确认的本地最终态，按 identity 合并；语义见 LocalMutation。 */
  private readonly pendingMutations = new Map<string, LocalMutation<T>>();
  /**
   * 当前在飞的权威首页请求（cursor=undefined 的那一类）。
   *
   * 'reset' 清空窗口重建，'reconcile' 保留 capped DOM 直到响应落地才原子替换；
   * `promise` 供重入合并使用（多个入口同时要求追平时共享同一次请求，两种 kind 一视同仁，
   * 见 `startAuthoritativePage`）。三个字段必须一起改，所以合成一个对象整体赋值。
   * 普通分页的在飞状态另见 `edges[edge].loading`，两者不会互相顶替。
   */
  private authoritative: { kind: 'reset' | 'reconcile'; promise: Promise<void> | null } | null = null;

  private query: Q;
  private firstLoadDone = false;
  private resetError: unknown;
  private hasResetError = false;
  /** 「背景有更新」提示条的状态：一个布尔，语义见 `BoundedListState.stale`。 */
  private readonly pillState = {
    stale: false,
    /** 有未追平的变化：点亮提示条。 */
    mark(): void {
      this.stale = true;
    },
    /** 已经追平：熄灭提示条。 */
    clear(): void {
      this.stale = false;
    },
  };
  /**
   * 窗口世代。**所有**在飞响应（权威首页、普通分页、定向刷新）都在发出时捕获它，
   * 落地时比对；不相等就整体丢弃，不触发任何回调。
   *
   * 只有一个操作会推进它：`discardInFlightResponses()`。「开始一次权威首页请求」和
   * 「live 裁剪后作废所有基于旧边界的分页」表面上是两件事，实质都是「此前发出的响应
   * 从现在起都不再适用于当前窗口」，所以共用同一个推进入口，而不是各写一次 `+= 1`。
   */
  private windowGeneration = 0;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 加载前缓存的贴边状态：图片异步增高后不能现算（内容已变高，必然误判成不贴边）。 */
  private stickToFreshEdge = true;
  /**
   * 按端索引的续翻状态。按端索引（而不是 `xxxHead` / `xxxTail` 两套字段）是为了让
   * `this.edges[edge].xxx` 直接可用，消掉一大批 `edge === 'head' ? … : …`：
   * - `loading`：该端的普通分页是否在飞。
   * - `autoBlocked`：触界检测驱动的自动续翻在该端上是否被暂停——该端请求失败后
   *   置真，防止「失败 → 重渲 → 触界 → 立刻重试」在微任务里死循环；用户把该端
   *   滚离触界范围、显式调用 loadMore、或 reset 之后解除。
   * - `cursorInvalid`：live 硬裁剪发生后，被裁一端的服务端边界游标已不再可信。它只封锁
   *   「能否续翻」，**不表示该端没有数据了**——边界提示另看 `PageWindow.hasMoreX`
   *   （`BL-BUG-015`）。
   */
  private readonly edges: Record<Edge, { loading: boolean; autoBlocked: boolean; cursorInvalid: boolean }> = {
    head: { loading: false, autoBlocked: false, cursorInvalid: false },
    tail: { loading: false, autoBlocked: false, cursorInvalid: false },
  };

  /**
   * `invalidate()` 的同帧合并缓冲：本帧收到的通知先攒在这里，`flushInvalidate` 跑一次决策。
   *
   * 与 `pillState` 是两件不同的事，不要混：这里是**输入缓冲**（还没做决策的通知），
   * `pillState` 是**输出状态**（提示条该不该亮）。
   */
  private readonly invalidateBuffer = {
    /** 本帧是否收到过 invalidate（决策尚未跑）。 */
    armed: false,
    /** 本帧累计的、需要定向刷新的身份。 */
    identities: new Set<string>(),
    /** 决策跑完 / reset / dispose 后清空。 */
    clear(): void {
      this.armed = false;
      this.identities.clear();
    },
  };
  /** 只保存当前实际在飞的定向刷新 token；成功、失败或本地更新后立即释放。 */
  private readonly refreshTokenByIdentity = new Map<string, symbol>();

  constructor(private readonly opts: BoundedListOptions<T, Q>) {
    if (!Number.isSafeInteger(opts.pageSize) || opts.pageSize < 1) {
      throw new RangeError(`[BoundedList:${opts.id}] pageSize 必须是不小于 1 的整数，收到 ${String(opts.pageSize)}`);
    }
    if (!Number.isSafeInteger(opts.maxPages) || opts.maxPages < 1) {
      throw new RangeError(`[BoundedList:${opts.id}] maxPages 必须是不小于 1 的整数，收到 ${String(opts.maxPages)}`);
    }
    if (!Number.isSafeInteger(opts.pageSize * opts.maxPages)) {
      throw new RangeError(`[BoundedList:${opts.id}] pageSize×maxPages 必须是安全整数`);
    }
    if (opts.selection?.store && opts.selection.max !== undefined) {
      throw new TypeError(`[BoundedList:${opts.id}] selection.store 与 selection.max 互斥：共享 store 的上限由该 store 自己决定`);
    }

    // order='desc'（默认，新→旧，如会话）→ 新鲜端在头部；order='asc'（旧→新，如消息）
    // → 新鲜端在尾部。展示序与新鲜端是同一个比特的两种说法，这里只转换这一次。
    const at: Edge = (opts.order ?? 'desc') === 'desc' ? 'head' : 'tail';
    const head = at === 'head';
    this.edge = {
      at,
      away: head ? 'tail' : 'head',
      stickyPx: opts.stickyPx ?? (head ? 4 : 50),
      settleFrames: opts.settleFrames ?? (head ? 1 : 4),
    };
    this.reachPx = opts.reachPx ?? DEFAULT_REACH_PX;
    this.query = (opts.initialQuery as Q) ?? (undefined as Q);
    this.window = new PageWindow<T>(opts.maxPages, opts.normalize, opts.identityOf, opts.pageSize);

    if (opts.selection) {
      this.selection = opts.selection.store ?? new SelectionStore(opts.selection.max);
      this.unsubscribeSelection = this.selection.subscribe(() => {
        if (this.disposed) return;
        this.render();
        this.emitSelectionChange();
      });
    }

    const pillHost = opts.pillHost === undefined ? (opts.scrollElement.parentElement ?? false) : opts.pillHost;
    this.pill = createUpdatePill(pillHost, () => void this.catchUp());

    this.stream = new BoundedStreamWindow<T>({
      scrollElement: opts.scrollElement,
      contentElement: opts.contentElement,
      reachPx: opts.reachPx,
      onScrollImmediate: () => {
        this.stickToFreshEdge = this.atFreshEdge();
      },
      onScroll: () => this.onScrollFrame(),
      onInteract: (identity, ev) => this.onInteract(identity, ev),
      onContentLoad: () => this.onContentLoad(),
    });

    this.applyA11yAttributes();
    this.scheduleInvalidateFlush = frameScheduler(() => this.flushInvalidate());
    // 'microtask' 兜底：触发容量追平的调用方（upsertLocal）在调用之后还要继续改窗口
    // 状态，同步跑会读到中间态。
    this.scheduleCapacityReconcile = frameScheduler(() => {
      if (!this.disposed) void this.reconcileCapacity();
    }, 'microtask');

    // 多 AppInstance 共存时同名列表必须各自登记到宿主的注册表，所以 register 是必填的。
    this.unregister = opts.register(this);
  }

  get id(): string {
    return this.opts.id;
  }

  // ---- 命令式接口（设计文档 §5） ----

  async reset(optsIn?: { query?: Q; pinEdge?: boolean }): Promise<void> {
    if (this.disposed) return;
    this.scheduleCapacityReconcile.cancel();
    this.scheduleInvalidateFlush.cancel();
    this.authoritative = null;
    // reset 代表全新的查询世代（首次加载 / setQuery）：上一世代未追平的本地写入
    // 不再适用于新世代的窗口，在这里整体丢弃；同一世代内失败重试见共享辅助方法的
    // catch 分支，那里刻意不清空，好让失败期间的本地写入等到下次成功时被重放。
    this.pendingMutations.clear();
    this.invalidateBuffer.clear();
    if (optsIn && Object.prototype.hasOwnProperty.call(optsIn, 'query')) this.query = optsIn.query as Q;
    await this.startAuthoritativePage({ clearWindow: true, pinEdge: optsIn?.pinEdge ?? true });
  }

  async loadMore(edge: Edge): Promise<void> {
    if (this.disposed) return;
    // 显式调用视为「用户主动重试」，解除该端的自动续翻暂停。
    this.edges[edge].autoBlocked = false;
    await this.loadMoreInternal(edge);
  }

  // 两个调用点都已经挡住了 disposed：公开的 loadMore 自带守卫，autoLoadMore 只在
  // render 里被渲染引擎回调，而 render 在 dispose 之后是空操作。
  private async loadMoreInternal(edge: Edge): Promise<void> {
    if (this.edges[edge].cursorInvalid) {
      await this.reconcileCapacity();
      return;
    }
    const hasMore = edge === 'head' ? this.window.hasMoreHead : this.window.hasMoreTail;
    const alreadyLoading = this.edges[edge].loading;
    if (!hasMore || alreadyLoading) return;

    const cursor = this.window.cursorFor(edge);
    // 空游标意味着窗口里没有任何可用的续翻锚点（例如只有本端并入的条目）。
    // 空串不是 reset 语义，发出去只会让服务端按未定义行为处理，这里直接放弃。
    if (cursor === '') return;

    this.edges[edge].loading = true;
    this.emitLoadState();
    this.repaint();

    const myGeneration = this.windowGeneration;
    try {
      // backward 是 wire 协议自己的方向词汇（见 FetchPageRequest），与本组件内部
      // 统一使用的 Edge 只在这一处转换：head 端续翻恒等于 backward 请求。
      const page = await this.opts.source.fetch({
        cursor,
        backward: edge === 'head',
        limit: this.opts.pageSize,
        query: this.query,
      });
      if (this.isObsolete(myGeneration)) return;
      if (edge === 'head') this.window.prependHead(page);
      else this.window.appendTail(page);
      this.edges[edge].loading = false;
      this.edges[edge].autoBlocked = false;
      // 只重放与位置无关的最终态：它们不会让窗口变大，因此不需要在这里处理硬预算
      // 裁剪、游标失效或额外追平。
      this.replayOverlay(this.window, false);
      this.emitItemsChanged();
      this.settleFreshEdgeBoundary(edge);
      this.emitLoadState();
      this.repaint();
      this.flushDeferredInvalidate();
    } catch (err) {
      if (this.isObsolete(myGeneration)) return;
      this.edges[edge].loading = false;
      this.edges[edge].autoBlocked = true;
      this.reportError(err, edge);
      this.emitLoadState();
      this.repaint();
      this.flushDeferredInvalidate();
    }
  }

  setQuery(query: Q, opts?: { debounceMs?: number }): void {
    if (this.disposed) return;
    const debounceMs = opts?.debounceMs ?? 300;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (debounceMs <= 0) {
      void this.reset({ query });
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reset({ query });
    }, debounceMs);
  }

  /**
   * 轻通知唯一入口；同一帧内多次调用只跑一次决策（设计文档 §13.1）。
   *
   * 不接受数量：提示条只表达「有 / 没有」，见 `BoundedListState.stale`。给出
   * `identities` 时，落在当前窗口里的那些会走 `fetchByIdentity` 定向刷新。
   */
  invalidate(opts?: { identities?: readonly string[] }): void {
    if (this.disposed) return;
    this.invalidateBuffer.armed = true;
    for (const id of opts?.identities ?? []) this.invalidateBuffer.identities.add(id);
    this.scheduleInvalidateFlush();
  }

  upsertLocal(item: T): void {
    if (this.disposed) return;
    const identity = this.opts.identityOf(item);
    this.invalidateRefresh(identity);
    if (!this.reachesFreshEdge()) {
      // 窗口内容还没追平新鲜端：这条本端新增和已加载内容之间的真实相邻关系无法确定，
      // 硬并入只会把它错误地拼在一段旧历史后面，还会顺带关掉真正的续翻。不猜位置，
      // 点亮一次提示条，由用户 / 贴边追平从服务端拿回真实顺序。
      this.invalidate();
      return;
    }
    const wasAtFreshEdge = this.atFreshEdge();
    this.stickToFreshEdge = wasAtFreshEdge;
    // 追平了新鲜端就无条件并入：本端发送要立即可见，这是乐观显示的全部意义。
    const evicted = this.window.mergeLive(item, this.edge.at);
    if (evicted > 0) {
      this.edges[this.edge.away].cursorInvalid = true;
      this.cancelOrdinaryPageLoads();
    }
    // 这一刻起会有一次权威请求整体替换窗口（已经在飞，或者下面因 eviction 排一次），
    // 这条并入会被一起替换掉。记入 overlay，由那次响应在新窗口上重放，用户看不到闪动。
    // 判定放在 mergeLive 之后：eviction 刚把被裁端游标置为失效，也要算进来。
    if (this.shouldDeferToOverlay()) {
      // 重放顺序必须跟着 mergeLive 走到最后，否则 C→D→再 upsert C 会被重放成 C→D。
      this.pendingMutations.delete(identity);
      this.rememberPendingMutation(identity, { kind: 'upsert', item });
    }
    this.emitItemsChanged();
    this.emitLoadState();
    this.repaint();
    if (evicted > 0) {
      // live 条目没有可重建的服务端游标：先同步裁剪保证硬有界，再按用户原贴边状态
      // 选择权威 reset 或提示稍后追平，避免用失真的旧边界继续分页。
      if (wasAtFreshEdge) this.scheduleCapacityReconcile();
      else this.invalidate();
    }
  }

  patch(id: string, update: (item: T) => T): boolean {
    if (this.disposed) return false;
    const changed = this.window.updateMatching((item) => this.opts.identityOf(item) === id, update);
    if (!changed) return false;
    this.invalidateRefresh(id);
    if (this.shouldDeferToOverlay()) {
      const current = this.window.items.find((item) => this.opts.identityOf(item) === id);
      if (current) {
        // overlay 里已有这条身份的 upsert 时保持 upsert：它的语义是「权威页没有也要新增」，
        // 降级成 replace 会让这条本端新增在重放时找不到目标而丢失。位置不变。
        const pendingKind = this.pendingMutations.get(id)?.kind === 'upsert' ? 'upsert' : 'replace';
        this.rememberPendingMutation(id, { kind: pendingKind, item: current });
      }
    }
    this.emitItemsChanged();
    this.repaint();
    return true;
  }

  removeLocal(id: string): boolean {
    if (this.disposed) return false;
    const changed = this.window.removeMatching((item) => this.opts.identityOf(item) === id);
    // 无论窗口里当前有没有命中，只要有请求在飞就要记一条 remove：在飞的权威页或
    // 分页可能携带这个身份的旧记录，只有留下 remove 才能在重放时把它挡住。
    if (this.shouldDeferToOverlay()) this.rememberPendingMutation(id, { kind: 'remove' });
    if (changed) {
      this.invalidateRefresh(id);
      // 只精确摘掉被删的这一个身份：共享 store 时其它实例（以及 pinnedItems、
      // 已被裁剪出窗口）的选中项与本次删除无关，不能一并清掉。
      this.selection?.delete(id);
      this.emitItemsChanged();
      this.emitLoadState();
      this.repaint();
      return true;
    }
    return false;
  }

  /**
   * 宿主显式重绘：每一行都重跑 `renderItem`。
   *
   * 宿主在行内挂了自己的监听 / 读了组件不知道的外部状态（展示名缓存、选中模式等）
   * 时需要它。组件内部的数据更新走 `repaint()`，只重建真正变化的行。
   */
  render(): void {
    this.paint(true);
  }

  /** 组件内部重绘：未变化的行复用已有 DOM，不重跑 renderItem。 */
  private repaint(): void {
    this.paint(false);
  }

  private paint(rebuildRows: boolean): void {
    if (this.disposed) return;
    const items = this.visibleItems();
    const text = this.opts.text;
    const filtered = this.isQueryActive();
    const errorText = items.length === 0 && this.hasResetError ? text.error?.(this.resetError) : undefined;
    const emptyText = items.length === 0
      ? (filtered ? (text.emptyFiltered?.() ?? text.empty?.()) : text.empty?.())
      : undefined;
    // loaded/hasMoreHead/hasMoreTail/loadingHead/loadingTail 与 getState() 是同一份口径，
    // 复用而不是各写一遍，避免以后改判定条件时漏改其中一处。
    // 贴边几何在这里只读一次：紧接着的 stream.render 会写 DOM，读写交替会强制同步重排。
    const state = this.buildState(this.atFreshEdge());

    this.stream.render({
      items,
      loaded: state.loaded,
      hasMoreHead: state.hasMoreHead,
      hasMoreTail: state.hasMoreTail,
      // 边界提示只看窗口自己的账。`state.hasMoreX` 还叠加了「游标是否失效」，
      // 拿它判边界会在 live 硬裁剪后（游标不可信但数据确实还有）错报「没有更多了」，
      // 而且那之后 reconcile 一旦失败就再也没有东西把它改回来。
      atHeadEnd: !this.window.hasMoreHead,
      atTailEnd: !this.window.hasMoreTail,
      loadingHead: state.loadingHead,
      loadingTail: state.loadingTail,
      emptyText,
      errorText,
      loadingText: text.loading?.(),
      headBoundaryText: text.headBoundary?.(),
      tailBoundaryText: text.tailBoundary?.(),
      loadHead: () => this.autoLoadMore('head'),
      loadTail: () => this.autoLoadMore('tail'),
      renderItem: (item, index) => this.renderItemWithContext(item, index, items),
      keyOf: (item) => this.opts.identityOf(item),
      reuseUnchangedRows: !rebuildRows,
      revisionOf: (item, index) => this.rowRevision(item, index, items),
    });
    this.syncPill();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduleInvalidateFlush.cancel();
    this.scheduleCapacityReconcile.cancel();
    this.authoritative = null;
    this.pendingMutations.clear();
    this.refreshTokenByIdentity.clear();
    this.invalidateBuffer.clear();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.restoreA11yAttributes();
    this.stream.dispose();
    this.pill.dispose();
    this.unsubscribeSelection?.();
    this.unregister();
  }

  // ---- 只读状态（设计文档 §6） ----

  getState(): BoundedListState {
    return this.buildState(this.atFreshEdge());
  }

  /**
   * `getState()` 的实现。`atFreshEdge` 由调用方传入而不是在这里现算，是因为它要**读 DOM**
   * （`scrollTop` / `scrollHeight` / `clientHeight`），而 `paint()` 紧接着就要写 DOM——
   * 在一次「读 → 写」之间再插一次读会强制浏览器同步重排。`paint()` 因此自己读一次几何、
   * 把结果同时用于状态和后续判断，公开的 `getState()` 才现算。
   */
  private buildState(atFreshEdge: boolean): BoundedListState {
    return {
      loaded: this.firstLoadDone,
      loading: this.edges.head.loading || this.edges.tail.loading || this.authoritative?.kind === 'reconcile',
      loadingHead: this.edges.head.loading,
      loadingTail: this.edges.tail.loading,
      hasMoreHead: this.window.hasMoreHead && !this.edges.head.cursorInvalid,
      hasMoreTail: this.window.hasMoreTail && !this.edges.tail.cursorInvalid,
      count: this.window.count,
      total: this.window.total,
      stale: this.pillState.stale,
      atFreshEdge,
      failed: this.hasResetError,
    };
  }

  // ---- 内部实现 ----

  private applyA11yAttributes(): void {
    const el = this.opts.scrollElement;
    for (const name of A11Y_ATTRS) {
      this.originalA11yAttributes.set(name, el.getAttribute?.(name) ?? null);
    }
    el.setAttribute?.('tabindex', '0');
    el.setAttribute?.('role', 'listbox');
    if (this.opts.selection?.mode === 'multi') {
      el.setAttribute?.('aria-multiselectable', 'true');
    } else {
      el.removeAttribute?.('aria-multiselectable');
    }
  }

  private restoreA11yAttributes(): void {
    const el = this.opts.scrollElement as HTMLElement & { removeAttribute?: (name: string) => void };
    for (const [name, value] of this.originalA11yAttributes) {
      if (value === null) el.removeAttribute?.(name);
      else el.setAttribute?.(name, value);
    }
  }

  /**
   * 当前该渲染出来的条目序列：`pinnedItems` 在前、窗口条目在后，且**按身份去重**。
   *
   * 去重必须在组件里做。渲染引擎按身份键协调 DOM，同一个身份出现两次会让
   * `renderedRows` 只记住后一条、而 desired 列表里同一个节点出现两次，`insertBefore`
   * 把它搬走之后行数静默少一行，缓存与真实 DOM 从此失配。
   *
   * 窗口是权威：pinned 里凡是窗口已有的身份一律让位（例如占位会话在真实条目落库后
   * 就不该继续钉在头部）。pinned 自身重复也在这里挡掉。
   *
   * 渲染、`findItem`、`onSelectionChange` 三处共用它，保证「看到的」「点到的」
   * 「报出去的」是同一份序列和同一个顺序。
   */
  private visibleItems(): readonly T[] {
    const windowItems = this.window.items;
    const pinned = this.opts.pinnedItems?.() ?? [];
    if (pinned.length === 0) return windowItems;
    const seen = new Set(windowItems.map((item) => this.opts.identityOf(item)));
    const uniquePinned: T[] = [];
    for (const item of pinned) {
      const identity = this.opts.identityOf(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      uniquePinned.push(item);
    }
    return uniquePinned.length === 0 ? windowItems : [...uniquePinned, ...windowItems];
  }

  private atFreshEdge(): boolean {
    return this.stream.isAtEdge(this.edge.at, this.edge.stickyPx);
  }

  /** 窗口内容（而非滚动位置）是否已经追到新鲜端尽头：该端 hasMore 已收敛为 false。 */
  private reachesFreshEdge(): boolean {
    return this.edge.at === 'tail' ? !this.window.hasMoreTail : !this.window.hasMoreHead;
  }

  private isQueryActive(): boolean {
    return !valuesEquivalent(this.query, this.opts.initialQuery);
  }

  private clearResetError(): void {
    this.resetError = undefined;
    this.hasResetError = false;
  }

  private pinToFreshEdge(): void {
    const el = this.opts.scrollElement;
    let remaining = this.edge.settleFrames;
    const settle = () => {
      if (this.disposed) return; // dispose 之后不再触碰宿主 DOM
      el.scrollTop = this.edge.at === 'head' ? 0 : el.scrollHeight;
      this.stickToFreshEdge = true;
      remaining -= 1;
      if (remaining > 0) nextFrame(settle);
    };
    settle();
  }

  private autoLoadMore(edge: Edge): void {
    if (this.edges[edge].autoBlocked) return;
    void this.loadMoreInternal(edge);
  }

  private catchUp(): Promise<void> {
    this.stickToFreshEdge = true;
    if (!this.firstLoadDone) return this.reset({ pinEdge: true });
    return this.reconcileCapacity();
  }

  private hasInvalidCapacityCursor(): boolean {
    return this.edges.head.cursorInvalid || this.edges.tail.cursorInvalid;
  }

  private onScrollFrame(): void {
    // 滚动几何在本帧只读一次：下面三处判断都用这一份快照。逐处现算会重复触发布局，
    // 而且 `atFreshEdge()` 在同一帧里被问两次本来就该给同一个答案。
    const el = this.opts.scrollElement;
    const scrollTop = el.scrollTop;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const atFreshEdge = this.edge.at === 'head'
      ? scrollTop <= this.edge.stickyPx
      : maxScrollTop - scrollTop <= this.edge.stickyPx;

    // 用户把某一端滚离触界范围，说明他离开了那个失败现场：解除该端的自动续翻暂停，
    // 再滚回去时可以自然重试，既不会死循环也不需要额外的重试按钮。
    if (scrollTop > this.reachPx) this.edges.head.autoBlocked = false;
    if (maxScrollTop - scrollTop > this.reachPx) this.edges.tail.autoBlocked = false;
    this.stickToFreshEdge = atFreshEdge;

    // 提示条自动消失路径①：用户自己滚回新鲜端时自动追平（设计文档 §13.2）。
    const canCatchUp = this.pillState.stale && !this.edges.head.loading && !this.edges.tail.loading;
    if (canCatchUp && atFreshEdge) void this.catchUp();
  }

  /** 图片等异步增高内容加载完成：此前贴在尾部新鲜端的话重新贴回底部。 */
  private onContentLoad(): void {
    if (this.disposed || this.edge.at !== 'tail' || !this.stickToFreshEdge) return;
    this.pinToFreshEdge();
  }

  /**
   * 提示条自动消失路径②：新鲜端方向已经翻到尽头（该端 hasMore 收敛为 false）。
   * 判定条件是「hasMore 变 false」而不是「拿到空页」——非空的最后一页同样意味着
   * 新鲜端之后再无未加载数据，提示条必须一起消失。
   */
  private settleFreshEdgeBoundary(edge: Edge): void {
    if (edge !== this.edge.at) return;
    const stillHasMore = edge === 'head' ? this.window.hasMoreHead : this.window.hasMoreTail;
    if (stillHasMore || !this.pillState.stale) return;
    this.pillState.clear();
  }

  private reconcileCapacity(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // 显式 loadMore / 提示条追平可能先于已经排队的自动帧任务到达；一旦任何入口
    // 开始接管本轮 reconcile，就取消旧帧，避免首个请求很快完成后旧帧再发一次 reset。
    this.scheduleCapacityReconcile.cancel();
    const running = this.authoritative?.promise;
    if (running) return running;
    // pinEdge 恒为 false：容量 reconcile 不清空窗口，是否贴边完全交给共享辅助方法
    // 在响应落地那一刻实时读 `stickToFreshEdge`（可能在请求期间被滚动事件改写），
    // 而不是像 reset 那样在调用时就固定调用方意图。
    return this.startAuthoritativePage({ clearWindow: false, pinEdge: false });
  }

  /**
   * 权威首页请求的唯一入口：发起之后立刻把 promise 登记进 `authoritative`，
   * 好让 `reconcileCapacity` 的重入合并对 reset 和 reconcile 一视同仁。
   *
   * `reset` 与 reconcile 的 promise 必须都登记：漏登记 reset 会让在飞期间的一次容量
   * 追平（在飞时的 live 裁剪、排队的自动帧任务）误判「没有请求在飞」，推进世代把
   * 正在飞的 reset 打掉再发一个——既多打一次请求，也违反「权威请求已在飞时的 live
   * eviction 由当前请求重放、不额外安排第二次追平」这条约定（见缺陷列表 BL-BUG-010
   * 第 8 条）。
   */
  private startAuthoritativePage(opts: { clearWindow: boolean; pinEdge: boolean }): Promise<void> {
    const started = this.loadAuthoritativePage(opts);
    // loadAuthoritativePage 的同步段已经把 authoritative 置好，这里补 promise。
    // 同步段内不会有人读到还是 null 的 promise：唯一的重入路径是
    // repaint → checkReach → 触界 → cursorInvalid → reconcileCapacity，而那一刻
    // 该端「能否续翻」必为 false（reset 刚清空窗口，reconcile 的失效游标本就不允许
    // 续翻），触界检测不会触发。
    if (this.authoritative) this.authoritative.promise = started;
    return started;
  }

  /**
   * `reset` 与容量 reconcile 共用的权威首页拉取逻辑：两者唯一的区别是是否清空当前
   * 窗口（`clearWindow`）——reset 清空重建，reconcile 保留 capped DOM 直到响应落地
   * 才原子替换。`pinEdge` 只在 `clearWindow` 时生效，体现调用方在 reset 那一刻的
   * 贴边意图；reconcile 场景固定传 `false`，改为在响应落地时检查实时的
   * `stickToFreshEdge`（见下方 `else if`）。
   */
  private async loadAuthoritativePage(opts: { clearWindow: boolean; pinEdge: boolean }): Promise<void> {
    const { clearWindow, pinEdge } = opts;
    const myGeneration = this.discardInFlightResponses();
    if (clearWindow) {
      this.authoritative = { kind: 'reset', promise: null };
      this.stickToFreshEdge = pinEdge ? true : this.atFreshEdge();
      this.window.reset();
      this.firstLoadDone = false;
      this.edges.head.autoBlocked = false;
      this.edges.tail.autoBlocked = false;
      this.edges.head.cursorInvalid = false;
      this.edges.tail.cursorInvalid = false;
      this.pillState.clear();
    } else {
      this.authoritative = { kind: 'reconcile', promise: null };
    }
    this.edges.head.loading = false;
    this.edges.tail.loading = false;
    this.refreshTokenByIdentity.clear();
    this.clearResetError();
    this.emitLoadState();
    // clearWindow=false（容量 reconcile）时保留当前有界窗口，只更新 loading / pill；
    // 权威响应落地前不清空 DOM。
    this.repaint();

    const request: FetchPageRequest<Q> = {
      cursor: undefined,
      backward: false,
      limit: this.opts.pageSize,
      query: this.query,
    };

    try {
      const page = await this.opts.source.fetch(request);
      if (this.isObsolete(myGeneration)) return;
      const { window: nextWindow, evicted: replayEvicted } = this.buildAuthoritativeWindow(page);

      this.window = nextWindow;
      this.authoritative = null;
      this.scheduleCapacityReconcile.cancel();
      this.firstLoadDone = true;
      this.applyAuthoritativeState(replayEvicted);
      this.emitItemsChanged();
      this.repaint();
      if (pinEdge) {
        this.pinToFreshEdge();
      } else if (clearWindow) {
        this.stickToFreshEdge = this.atFreshEdge();
      } else if (this.stickToFreshEdge) {
        this.pinToFreshEdge();
      }
      this.emitLoadState();
      this.flushDeferredInvalidate();
    } catch (err) {
      if (this.isObsolete(myGeneration)) return;
      this.authoritative = null;
      this.scheduleCapacityReconcile.cancel();
      // 不清空 pendingMutations：本次失败期间发生的本地写入仍要等下一次成功的
      // reset/reconcile 把窗口带到新鲜端时被重放，不能因为这次失败就丢掉。
      this.firstLoadDone = true;
      this.resetError = err;
      this.hasResetError = true;
      if (this.window.count > 0) {
        this.pillState.mark();
      }
      this.reportError(err, 'reset');
      this.repaint();
      this.emitLoadState();
      this.flushDeferredInvalidate();
    }
  }

  private buildAuthoritativeWindow(page: PageLoadResult<T>): { window: PageWindow<T>; evicted: number } {
    // normalize、超页校验和本地最终态重放全部在独立窗口完成，成功后才能替换可见窗口。
    const nextWindow = new PageWindow<T>(
      this.opts.maxPages,
      this.opts.normalize,
      this.opts.identityOf,
      this.opts.pageSize,
    );
    nextWindow.setInitial(page);
    return { window: nextWindow, evicted: this.replayOverlay(nextWindow, true) };
  }

  /**
   * 把 overlay 重放到某个窗口上，应用成功的逐条摘除。返回重放本身撑破硬预算而裁掉的
   * 条目数（只有真正并入新鲜端的 `upsert` 会触发）。
   *
   * 两个调用场景只差一件事，就是这个参数：**目标窗口的新鲜端是否确定**。
   *
   * - `freshEdgeSettled=true`（权威首页）：首页按构造就是新鲜端那一页（该端 `hasMore`
   *   必为 `false`），相邻关系天然确定，所以 `upsert` 可以真的并入，overlay 整体清空。
   * - `freshEdgeSettled=false`（普通分页并入后）：新鲜端不确定，`upsert` 只在窗口里
   *   **已经有这个身份**时才应用——那等价于一次 `replace`，位置由窗口自己决定，不存在
   *   相邻关系问题；典型场景是返回页带回同一身份的旧值，必须被本地最终态盖住
   *   （`BL-BUG-012`）。窗口里没有这个身份时留在 overlay 里等权威响应。
   *
   * `replace` / `remove` 与位置无关，两种场景下都直接应用。
   */
  private replayOverlay(target: PageWindow<T>, freshEdgeSettled: boolean): number {
    let evicted = 0;
    for (const [identity, mutation] of [...this.pendingMutations]) {
      const matches = (item: T): boolean => this.opts.identityOf(item) === identity;
      if (mutation.kind === 'remove') {
        target.removeMatching(matches);
      } else if (mutation.kind === 'replace') {
        target.updateMatching(matches, () => mutation.item);
      } else if (freshEdgeSettled) {
        evicted += target.mergeLive(mutation.item, this.edge.at);
      } else if (target.hasIdentity(identity)) {
        target.updateMatching(matches, () => mutation.item);
      } else {
        continue; // 新鲜端未确定且窗口里没有这个身份：留在 overlay 等权威响应
      }
      this.pendingMutations.delete(identity);
    }
    return evicted;
  }

  /** 权威页落地后的提示条与游标状态。 */
  private applyAuthoritativeState(replayEvicted: number): void {
    this.edges.head.cursorInvalid = false;
    this.edges.tail.cursorInvalid = false;
    if (replayEvicted > 0) {
      // 重放本端条目又撑破了硬预算：被裁那一端的服务端边界不再可信，等下一次追平。
      this.edges[this.edge.away].cursorInvalid = true;
      this.pillState.mark();
      return;
    }
    if (this.invalidateBuffer.armed) this.pillState.mark();
    else this.pillState.clear();
  }

  /**
   * 推进窗口世代，使此前发出的所有在飞响应作废，并返回新世代供本次请求捕获。
   * 这是「让旧响应失效」的唯一机制——不要在别处直接改 `windowGeneration`。
   */
  private discardInFlightResponses(): number {
    return ++this.windowGeneration;
  }

  /** 某次请求的结果是否已经不适用于当前窗口（世代已推进，或组件已销毁）。 */
  private isObsolete(generation: number): boolean {
    return this.disposed || generation !== this.windowGeneration;
  }

  private isAuthoritativeRequestInFlight(): boolean {
    return this.authoritative !== null;
  }

  private hasDataRequestInFlight(): boolean {
    return this.isAuthoritativeRequestInFlight() || this.edges.head.loading || this.edges.tail.loading;
  }

  /**
   * 本地写入此刻是否只能记入 overlay、不能直接改真实窗口：要么有数据请求在飞
   * （其响应落地时会整体替换/并入窗口，直接改当前窗口会被覆盖或对不上），要么
   * 某一端游标已经因为 live 裁剪失效（旧边界不可信，必须等下一次权威 reconcile）。
   */
  private shouldDeferToOverlay(): boolean {
    return this.hasDataRequestInFlight() || this.hasInvalidCapacityCursor();
  }

  private cancelOrdinaryPageLoads(): void {
    if (this.isAuthoritativeRequestInFlight() || (!this.edges.head.loading && !this.edges.tail.loading)) return;
    // live 裁剪后，所有基于旧窗口边界发出的普通分页响应都已失去上下文。
    this.discardInFlightResponses();
    this.edges.head.loading = false;
    this.edges.tail.loading = false;
    this.refreshTokenByIdentity.clear();
  }

  private flushDeferredInvalidate(): void {
    if (!this.disposed && this.invalidateBuffer.armed && !this.hasDataRequestInFlight()) {
      this.scheduleInvalidateFlush();
    }
  }

  /**
   * 记一条待重放的本地最终态。同一身份后写覆盖先写，`Map.set` 对已存在的键保持原插入
   * 位置——也就是保持原重放顺序。需要「这次写入在时间线上重新发生、重放顺序也要跟着
   * 移到最后」的调用方（只有 `upsertLocal`，因为 `mergeLive` 会把该身份移到新鲜端）
   * 自己先把旧记录 delete 掉，不再通过参数表达这个差异。
   */
  private rememberPendingMutation(identity: string, mutation: LocalMutation<T>): void {
    this.pendingMutations.set(identity, mutation);
    // 硬预算兜底：这个数量级需要在一次请求的在飞窗口内发生 pageSize×maxPages 个不同
    // identity 的本地写入，现实中不会发生。到这里就静默丢最旧的一条，用一次可忽略的
    // 极端退化换掉一整套「显式失败 + 强制新快照」的复杂度。
    if (this.pendingMutations.size > this.opts.pageSize * this.opts.maxPages) {
      const oldest = this.pendingMutations.keys().next().value as string | undefined;
      if (oldest !== undefined) this.pendingMutations.delete(oldest);
    }
  }

  private flushInvalidate(): void {
    if (this.disposed || !this.invalidateBuffer.armed) return;
    if (this.hasDataRequestInFlight()) {
      // reset / staged reconcile 的响应会整体替换窗口。期间到达的 identity 通知不能在旧
      // 窗口上执行后被覆盖，也不能拿旧结果修改新窗口；保留 identity，权威请求落定后重发。
      this.pillState.mark();
      this.repaint();
      return;
    }
    const identities = [...this.invalidateBuffer.identities];
    this.invalidateBuffer.clear();

    if (!(this.opts.isActive?.() ?? true)) {
      this.pillState.mark();
      // 仍然重渲一次：宿主切回可见时提示条要已经是最新状态，不能等下一次 render。
      this.repaint();
      return;
    }
    if (this.atFreshEdge()) {
      void this.catchUp();
      return;
    }

    this.pillState.mark();
    // 先同步一次提示条再发定向请求：否则请求慢时提示条要等几百毫秒才亮。
    this.repaint();

    const hits = identities.filter((id) => this.window.hasIdentity(id));
    const fetchByIdentity = this.opts.fetchByIdentity;
    if (hits.length === 0 || !fetchByIdentity) return;

    const refreshTokens = new Map(hits.map((id) => [id, Symbol(id)] as const));
    for (const [id, token] of refreshTokens) this.refreshTokenByIdentity.set(id, token);
    const myGeneration = this.windowGeneration;
    const clearRefreshTokens = (): void => {
      for (const [id, token] of refreshTokens) {
        if (this.refreshTokenByIdentity.get(id) === token) {
          this.refreshTokenByIdentity.delete(id);
        }
      }
    };
    let refreshRequest: Promise<readonly T[]>;
    try {
      // 保持调用时机同步：dispose/reset 必须能确认是否已经发出外部请求，同时仍兜住
      // 违反返回类型约定的同步 throw，避免 token 永久残留。
      refreshRequest = fetchByIdentity(hits);
    } catch (err) {
      const hasCurrentIdentity = hits.some(
        (id) => this.refreshTokenByIdentity.get(id) === refreshTokens.get(id),
      );
      if (!this.isObsolete(myGeneration) && hasCurrentIdentity) {
        this.reportError(err, 'refresh');
        this.repaint();
      }
      clearRefreshTokens();
      return;
    }
    void Promise.resolve(refreshRequest)
      .then((fetched) => {
        // 与 reset / loadMore 同样的丢弃守卫：期间发生过 reset 的话，
        // 这份结果描述的是已经作废的窗口，套到新窗口上会误删条目。
        if (this.isObsolete(myGeneration)) return;
        const fetchedMap = new Map(fetched.map((item) => [this.opts.identityOf(item), item] as const));
        // refresh 可能先于一个更早快照的普通分页返回。此时刚接受的远端最终态也要
        // 暂存进 overlay，让晚到分页在并入后重放；否则新值会回退，删除项会复活。
        const pageRequestInFlight = this.edges.head.loading || this.edges.tail.loading;
        let changed = false;
        for (const id of hits) {
          if (this.refreshTokenByIdentity.get(id) !== refreshTokens.get(id)) continue;
          const found = fetchedMap.get(id);
          if (found) {
            changed = this.window.updateMatching(
              (item) => this.opts.identityOf(item) === id,
              () => found,
            ) || changed;
          } else {
            changed = this.window.removeMatching(
              (item) => this.opts.identityOf(item) === id,
            ) || changed;
          }
          if (pageRequestInFlight) {
            this.rememberPendingMutation(id, found ? { kind: 'replace', item: found } : { kind: 'remove' });
          } else {
            // 这份 refresh 是在该 identity 最后一次本地 mutation 之后发出且 token
            // 仍有效；没有更早分页在飞时可直接淘汰旧 overlay。
            this.pendingMutations.delete(id);
          }
        }
        if (!changed) return;
        this.emitItemsChanged();
        this.emitLoadState();
        this.repaint();
      })
      .catch((err) => {
        if (this.isObsolete(myGeneration)) return;
        const hasCurrentIdentity = hits.some(
          (id) => this.refreshTokenByIdentity.get(id) === refreshTokens.get(id),
        );
        if (!hasCurrentIdentity) return;
        this.reportError(err, 'refresh');
        this.repaint();
      })
      .finally(clearRefreshTokens);
  }

  private invalidateRefresh(identity: string): void {
    this.refreshTokenByIdentity.delete(identity);
  }

  private onInteract(identity: string, ev: Event): void {
    const item = this.findItem(identity);
    if (!item) return;
    if (!this.selection) {
      this.opts.onActivate?.(item, ev);
      return;
    }
    if (this.opts.selection!.mode === 'single') {
      this.selection.replaceSingle(identity);
      this.opts.onActivate?.(item, ev);
      return;
    }
    const result = this.selection.toggle(identity);
    if (result === 'rejected') this.opts.selection!.onExceed?.();
  }

  private findItem(identity: string): T | undefined {
    // 走 visibleItems：点击命中的一定是当前真的渲染出来的那一条。
    for (const item of this.visibleItems()) {
      if (this.opts.identityOf(item) === identity) return item;
    }
    return undefined;
  }

  /** 某个身份当前的选中态：renderItemWithContext 与 rowRevision 共用同一份判定，避免各改一半。 */
  private selectionFlags(identity: string): { selected: boolean; selectable: boolean } {
    return {
      selected: this.selection?.has(identity) ?? false,
      selectable: this.selection ? !this.selection.isExceeded(identity) : true,
    };
  }

  private renderItemWithContext(item: T, index: number, items: readonly T[]): readonly HTMLElement[] {
    const identity = this.opts.identityOf(item);
    const { selected, selectable } = this.selectionFlags(identity);
    const previous = index > 0 ? items[index - 1] : undefined;
    const ctx: RenderItemContext<T> = { index, identity, selected, selectable, previous };
    const elements = this.opts.renderItem(item, ctx);
    if (elements.length > 0) {
      elements[0].setAttribute?.('role', 'option');
      if (this.selection) elements[0].setAttribute?.('aria-selected', String(selected));
    }
    return elements;
  }

  private rowRevision(item: T, index: number, items: readonly T[]): string {
    const identity = this.opts.identityOf(item);
    const previousIdentity = index > 0 ? this.opts.identityOf(items[index - 1]) : '';
    const { selected, selectable } = this.selectionFlags(identity);
    // 只记「是否首行」而非精确 index：renderItem 唯一依赖 index 的地方是 index===0
    // 的判定（首行批量预取），精确下标一旦入 revision，任何头部插入都会让每一行的
    // revision 一起变化，导致整窗口跳过复用、重跑 renderItem。
    return `${index === 0 ? 1 : 0}\u0000${previousIdentity}\u0000${selected ? 1 : 0}\u0000${selectable ? 1 : 0}`;
  }

  private syncPill(): void {
    // 首屏失败时提示条充当重试入口（点击即 reset）；否则才是「有更新」提示。
    if (this.hasResetError) {
      const retryText = this.opts.text.retry?.();
      this.pill.setVisible(retryText !== undefined, retryText);
      return;
    }
    const text = this.opts.text.updatePill?.();
    // 没有提供文案就不该出现一个空白提示条。
    this.pill.setVisible(this.pillState.stale && text !== undefined, text);
  }

  private emitLoadState(): void {
    this.opts.onLoadStateChange?.(this.getState());
  }

  private emitItemsChanged(): void {
    this.opts.onItemsChanged?.(this.window.items);
  }

  private emitSelectionChange(): void {
    if (!this.selection || !this.opts.onSelectionChange) return;
    const ids = this.selection.snapshotIds();
    // 顺序与去重都与渲染保持一致：同一份 visibleItems 序列。
    const items = this.visibleItems().filter((item) => ids.has(this.opts.identityOf(item)));
    this.opts.onSelectionChange({ ids, count: ids.size, items });
  }

  private reportError(err: unknown, phase: ErrorPhase): void {
    if (this.opts.onError) this.opts.onError(err, phase);
    else console.warn(`[BoundedList:${this.opts.id}] ${phase} 失败`, err);
  }
}

export function createBoundedList<T, Q = void>(options: BoundedListOptions<T, Q>): BoundedList<T, Q> {
  return new BoundedList(options);
}
