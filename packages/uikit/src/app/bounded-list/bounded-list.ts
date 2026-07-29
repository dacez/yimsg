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
  Direction,
  ErrorPhase,
  FetchPageRequest,
  FreshEdge,
  PageLoadResult,
  RenderItemContext,
} from './types';

const A11Y_ATTRS = ['tabindex', 'role', 'aria-multiselectable'] as const;

/**
 * 尚未被权威页确认的本地最终态，按 identity 索引。
 *
 * 只保留与位置无关的两种：'replace'（该身份若在窗口里就改成这个值）和 'remove'
 * （该身份从窗口里去掉）。两者都幂等、与重放顺序无关、命中不到就是空操作，
 * 因此可以无条件重放到任何窗口上。
 *
 * 曾经还有第三种 'upsert'（本端新增的条目要在权威响应后重新并入）。它和另外两种
 * 根本不同：新增必须知道自己和已加载内容的相邻关系，于是牵出「目标窗口是否已追平
 * 新鲜端」的逐条判定、Map 顺序即重放顺序的隐式契约、以及 replace 撞上 upsert 要
 * 降级回 upsert 的合并规则——占了整个 overlay 的绝大部分复杂度。现在不再猜位置：
 * 无法确定相邻关系时直接点亮提示条，由下一次追平从服务端拿回真实顺序。
 */
type LocalMutation<T> =
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
   * 「新数据从哪一端进来」会派生出方向、贴边阈值、贴边校正帧数、贴边时 scrollTop
   * 取 0 还是 scrollHeight 等一串取值。它们原本以 `freshEdgeValue === 'head' ? … : …`
   * 的形式散落在构造函数和七个方法里，改新鲜端语义要同时改七处。
   */
  private readonly edge: {
    /** 新鲜端本身；只有需要区分「哪一端」而非「哪个方向」时才用它。 */
    readonly at: FreshEdge;
    /** 朝新鲜端走的方向。 */
    readonly toward: Direction;
    /** 背离新鲜端的方向，即容量裁剪发生的那一端。 */
    readonly away: Direction;
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
   * `promise` 供 reconcile 的重入合并使用（多个入口同时要求追平时共享同一次请求）。
   * 三者原本是 resetInFlight / capacityReconciling / capacityReconcilePromise 三个
   * 互相约束的散装字段，在六个位置分别赋值，漏改一处就是竞态。
   * 普通分页的在飞状态另见 `dir[dir].loading`，两者不会互相顶替。
   */
  private authoritative: { kind: 'reset' | 'reconcile'; promise: Promise<void> | null } | null = null;

  private query: Q;
  private firstLoadDone = false;
  private resetError: unknown;
  private hasResetError = false;
  /**
   * 「背景有更新」提示条的全部状态。合成一个对象是为了让「何时点亮、何时清零」只有
   * 三个入口（add / clear / restoreAfterFailure），而不是在八处分别用 `=`、`+=`、
   * `Math.max(a,b)`、`Math.max(1,a)` 四种写法各改一半——那正是提示条不消失、
   * 计数残留到下一次点亮这类缺陷的来源。
   */
  private readonly pending = {
    stale: false,
    count: 0,
    /** 收到 n 条待处理更新：点亮提示条并累加计数。 */
    add(n: number): void {
      this.stale = true;
      this.count += n;
    },
    /** 已经追平：熄灭提示条并清零。两个字段必须一起清，否则残留会带到下一次点亮。 */
    clear(): void {
      this.stale = false;
      this.count = 0;
    },
    /** 首屏刷新失败但窗口里还有旧数据：至少点亮一次，已有计数不被压低。 */
    markFailure(): void {
      this.stale = true;
      this.count = Math.max(1, this.count);
    },
  };
  private requestId = 0;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 加载前缓存的贴边状态：图片异步增高后不能现算（内容已变高，必然误判成不贴边）。 */
  private stickToFreshEdge = true;
  /**
   * 按方向索引的续翻状态，取代原先 `xxxBefore`/`xxxAfter` 四对散装字段：
   * - `loading`：该方向的普通分页是否在飞。
   * - `autoBlocked`：触界检测驱动的自动续翻在该方向上是否被暂停——某方向请求
   *   失败后置真，防止「失败 → 重渲 → 触界 → 立刻重试」在微任务里死循环；
   *   用户把该端滚离触界范围、显式调用 loadMore、或 reset 之后解除。
   * - `cursorInvalid`：live 硬裁剪发生后，被裁一端的服务端边界游标已不再可信。
   * 用 `this.dir[dir].xxx` 按方向读写，消除一大批 `dir === 'backward' ? … : …` 三元式。
   */
  private readonly dir: Record<Direction, { loading: boolean; autoBlocked: boolean; cursorInvalid: boolean }> = {
    backward: { loading: false, autoBlocked: false, cursorInvalid: false },
    forward: { loading: false, autoBlocked: false, cursorInvalid: false },
  };

  private pendingInvalidate = false;
  private pendingIdentities = new Set<string>();
  private pendingInvalidateCount = 0;
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

    const at = opts.freshEdge ?? 'head';
    const head = at === 'head';
    this.edge = {
      at,
      toward: head ? 'backward' : 'forward',
      away: head ? 'forward' : 'backward',
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
    this.pendingInvalidate = false;
    this.pendingIdentities.clear();
    this.pendingInvalidateCount = 0;
    if (optsIn && Object.prototype.hasOwnProperty.call(optsIn, 'query')) this.query = optsIn.query as Q;
    await this.loadAuthoritativePage({ clearWindow: true, pinEdge: optsIn?.pinEdge ?? true });
  }

  async loadMore(dir: Direction): Promise<void> {
    if (this.disposed) return;
    // 显式调用视为「用户主动重试」，解除该方向的自动续翻暂停。
    this.dir[dir].autoBlocked = false;
    await this.loadMoreInternal(dir);
  }

  // 两个调用点都已经挡住了 disposed：公开的 loadMore 自带守卫，autoLoadMore 只在
  // render 里被渲染引擎回调，而 render 在 dispose 之后是空操作。
  private async loadMoreInternal(dir: Direction): Promise<void> {
    if (this.dir[dir].cursorInvalid) {
      await this.reconcileCapacity();
      return;
    }
    const hasMore = dir === 'backward' ? this.window.hasMoreBackward : this.window.hasMoreForward;
    const alreadyLoading = this.dir[dir].loading;
    if (!hasMore || alreadyLoading) return;

    const cursor = dir === 'backward' ? this.window.backwardCursor : this.window.forwardCursor;
    // 空游标意味着窗口里没有任何可用的续翻锚点（例如只有本端并入的条目）。
    // 空串不是 reset 语义，发出去只会让服务端按未定义行为处理，这里直接放弃。
    if (cursor === '') return;

    this.dir[dir].loading = true;
    this.emitLoadState();
    this.repaint();

    const myRequestId = this.requestId;
    try {
      const page = await this.opts.source.fetch({
        cursor,
        backward: dir === 'backward',
        limit: this.opts.pageSize,
        query: this.query,
      });
      if (myRequestId !== this.requestId || this.disposed) return;
      if (dir === 'backward') this.window.prependBackward(page);
      else this.window.appendForward(page);
      this.dir[dir].loading = false;
      this.dir[dir].autoBlocked = false;
      // replace / remove 只会改写或删除已有身份，不会让窗口变大，因此不需要在这里
      // 处理硬预算裁剪、游标失效或额外追平。
      this.replayPendingMutations(this.window);
      this.emitItemsChanged();
      this.settleFreshEdgeBoundary(dir);
      this.emitLoadState();
      this.repaint();
      this.flushDeferredInvalidate();
    } catch (err) {
      if (myRequestId !== this.requestId || this.disposed) return;
      this.dir[dir].loading = false;
      this.dir[dir].autoBlocked = true;
      this.reportError(err, dir);
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

  /** 轻通知唯一入口；同一帧内多次调用只跑一次决策（设计文档 §13.1）。 */
  invalidate(opts?: { identities?: readonly string[]; count?: number }): void {
    if (this.disposed) return;
    this.pendingInvalidate = true;
    this.pendingInvalidateCount += opts?.count ?? 0;
    for (const id of opts?.identities ?? []) this.pendingIdentities.add(id);
    this.scheduleInvalidateFlush();
  }

  upsertLocal(item: T): void {
    if (this.disposed) return;
    this.invalidateRefresh(this.opts.identityOf(item));
    if (!this.reachesFreshEdge()) {
      // 窗口内容还没追平新鲜端：这条本端新增和已加载内容之间的真实相邻关系无法确定，
      // 硬并入只会把它错误地拼在一段旧历史后面，还会顺带关掉真正的续翻。不猜位置，
      // 点亮一次提示条，由用户 / 贴边追平从服务端拿回真实顺序。
      this.invalidate({ count: 1 });
      return;
    }
    const wasAtFreshEdge = this.atFreshEdge();
    this.stickToFreshEdge = wasAtFreshEdge;
    // 追平了新鲜端就无条件并入：本端发送要立即可见，这是乐观显示的全部意义。
    const evicted = this.window.mergeLive(item, this.edge.at);
    // 权威请求在飞时，它的响应会整体替换窗口，这条并入会被一起替换掉。不再用 overlay
    // 把它搬进新窗口——那需要逐条判定「目标窗口是否已追平新鲜端」并维护重放顺序，
    // 是整个 overlay 复杂度的来源。改为点亮提示条：先乐观显示，权威响应落地后以
    // 服务端顺序为准，用户一次追平即可对齐。
    if (this.isAuthoritativeRequestInFlight()) this.invalidate({ count: 1 });
    if (evicted > 0) {
      this.dir[this.edge.away].cursorInvalid = true;
      this.cancelOrdinaryPageLoads();
    }
    this.emitItemsChanged();
    this.emitLoadState();
    this.repaint();
    if (evicted > 0) {
      // live 条目没有可重建的服务端游标：先同步裁剪保证硬有界，再按用户原贴边状态
      // 选择权威 reset 或提示稍后追平，避免用失真的旧边界继续分页。
      if (wasAtFreshEdge) this.scheduleCapacityReconcile();
      else this.invalidate({ count: evicted });
    }
  }

  patch(id: string, update: (item: T) => T): boolean {
    if (this.disposed) return false;
    const changed = this.window.updateMatching((item) => this.opts.identityOf(item) === id, update);
    if (!changed) return false;
    this.invalidateRefresh(id);
    if (this.shouldDeferToOverlay()) {
      const current = this.window.items.find((item) => this.opts.identityOf(item) === id);
      if (current) this.rememberPendingMutation(id, { kind: 'replace', item: current });
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
    const pinned = this.opts.pinnedItems?.() ?? [];
    const windowItems = this.window.items;
    const items = pinned.length ? [...pinned, ...windowItems] : windowItems;
    const text = this.opts.text;
    const filtered = this.isQueryActive();
    const errorText = items.length === 0 && this.hasResetError ? text.error?.(this.resetError) : undefined;
    const emptyText = items.length === 0
      ? (filtered ? (text.emptyFiltered?.() ?? text.empty?.()) : text.empty?.())
      : undefined;
    // loaded/hasMoreBackward/hasMoreForward/loadingBackward/loadingForward 与 getState() 是同一份口径，
    // 复用而不是各写一遍，避免以后改判定条件时漏改其中一处。
    const state = this.getState();

    this.stream.render({
      items,
      loaded: state.loaded,
      hasMoreBackward: state.hasMoreBackward,
      hasMoreForward: state.hasMoreForward,
      loadingBackward: state.loadingBackward,
      loadingForward: state.loadingForward,
      emptyText,
      errorText,
      loadingText: text.loading?.(),
      backwardBoundaryText: text.backwardBoundary?.(),
      forwardBoundaryText: text.forwardBoundary?.(),
      loadBackward: () => this.autoLoadMore('backward'),
      loadForward: () => this.autoLoadMore('forward'),
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
    this.pendingInvalidate = false;
    this.pendingIdentities.clear();
    this.pendingInvalidateCount = 0;
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
    return {
      loaded: this.firstLoadDone,
      loading: this.dir.backward.loading || this.dir.forward.loading || this.authoritative?.kind === 'reconcile',
      loadingBackward: this.dir.backward.loading,
      loadingForward: this.dir.forward.loading,
      hasMoreBackward: this.window.hasMoreBackward && !this.dir.backward.cursorInvalid,
      hasMoreForward: this.window.hasMoreForward && !this.dir.forward.cursorInvalid,
      count: this.window.count,
      total: this.window.total,
      stale: this.pending.stale,
      pendingCount: this.pending.count,
      atFreshEdge: this.atFreshEdge(),
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

  private atFreshEdge(): boolean {
    return this.stream.isAtEdge(this.edge.at, this.edge.stickyPx);
  }

  /** 窗口内容（而非滚动位置）是否已经追到新鲜端尽头：该端 hasMore 已收敛为 false。 */
  private reachesFreshEdge(): boolean {
    return this.edge.toward === 'forward' ? !this.window.hasMoreForward : !this.window.hasMoreBackward;
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

  private autoLoadMore(dir: Direction): void {
    if (this.dir[dir].autoBlocked) return;
    void this.loadMoreInternal(dir);
  }

  private catchUp(): Promise<void> {
    this.stickToFreshEdge = true;
    if (!this.firstLoadDone) return this.reset({ pinEdge: true });
    return this.reconcileCapacity();
  }

  private hasInvalidCapacityCursor(): boolean {
    return this.dir.backward.cursorInvalid || this.dir.forward.cursorInvalid;
  }

  private onScrollFrame(): void {
    const el = this.opts.scrollElement;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // 用户把某一端滚离触界范围，说明他离开了那个失败现场：解除该方向的自动续翻暂停，
    // 再滚回去时可以自然重试，既不会死循环也不需要额外的重试按钮。
    if (el.scrollTop > this.reachPx) this.dir.backward.autoBlocked = false;
    if (maxScrollTop - el.scrollTop > this.reachPx) this.dir.forward.autoBlocked = false;
    this.stickToFreshEdge = this.atFreshEdge();

    // 提示条自动消失路径①：用户自己滚回新鲜端时自动追平（设计文档 §13.2）。
    const canCatchUp = this.pending.stale && !this.dir.backward.loading && !this.dir.forward.loading;
    if (canCatchUp && this.atFreshEdge()) void this.catchUp();
  }

  /** 图片等异步增高内容加载完成：此前贴在尾部新鲜端的话重新贴回底部。 */
  private onContentLoad(): void {
    if (this.disposed || this.edge.at !== 'tail' || !this.stickToFreshEdge) return;
    this.pinToFreshEdge();
  }

  /**
   * 提示条自动消失路径②：新鲜端方向已经翻到尽头（该端 hasMore 收敛为 false）。
   * 判定条件是「hasMore 变 false」而不是「拿到空页」——非空的最后一页同样意味着
   * 新鲜端之后再无未加载数据，提示条必须一起消失。两个字段必须一起清零，
   * 否则残留计数会带到下一次提示条亮起。
   */
  private settleFreshEdgeBoundary(dir: Direction): void {
    if (dir !== this.edge.toward) return;
    const stillHasMore = dir === 'backward' ? this.window.hasMoreBackward : this.window.hasMoreForward;
    if (stillHasMore || (!this.pending.stale && this.pending.count === 0)) return;
    this.pending.clear();
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
    const started = this.loadAuthoritativePage({ clearWindow: false, pinEdge: false });
    // loadAuthoritativePage 已经同步把 authoritative 置成 reconcile；补上 promise 供重入合并。
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
    const myRequestId = ++this.requestId;
    if (clearWindow) {
      this.authoritative = { kind: 'reset', promise: null };
      this.stickToFreshEdge = pinEdge ? true : this.atFreshEdge();
      this.window.reset();
      this.firstLoadDone = false;
      this.dir.backward.autoBlocked = false;
      this.dir.forward.autoBlocked = false;
      this.dir.backward.cursorInvalid = false;
      this.dir.forward.cursorInvalid = false;
      this.pending.clear();
    } else {
      this.authoritative = { kind: 'reconcile', promise: null };
    }
    this.dir.backward.loading = false;
    this.dir.forward.loading = false;
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
      if (myRequestId !== this.requestId || this.disposed) return;
      const nextWindow = this.buildAuthoritativeWindow(page);

      this.window = nextWindow;
      this.authoritative = null;
      this.scheduleCapacityReconcile.cancel();
      this.firstLoadDone = true;
      this.applyAuthoritativeState();
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
      if (myRequestId !== this.requestId || this.disposed) return;
      this.authoritative = null;
      this.scheduleCapacityReconcile.cancel();
      // 不清空 pendingMutations：本次失败期间发生的本地写入仍要等下一次成功的
      // reset/reconcile 把窗口带到新鲜端时被重放，不能因为这次失败就丢掉。
      this.firstLoadDone = true;
      this.resetError = err;
      this.hasResetError = true;
      if (this.window.count > 0) {
        this.pending.markFailure();
      }
      this.reportError(err, 'reset');
      this.repaint();
      this.emitLoadState();
      this.flushDeferredInvalidate();
    }
  }

  private buildAuthoritativeWindow(page: PageLoadResult<T>): PageWindow<T> {
    // normalize、超页校验和本地最终态重放全部在独立窗口完成，成功后才能替换可见窗口。
    const nextWindow = new PageWindow<T>(
      this.opts.maxPages,
      this.opts.normalize,
      this.opts.identityOf,
      this.opts.pageSize,
    );
    nextWindow.setInitial(page);
    this.replayPendingMutations(nextWindow);
    return nextWindow;
  }

  /**
   * 把 overlay 里的本地最终态重放到 target 上，然后整体清空。
   *
   * 两种 mutation 都与位置无关：'replace' 改写命中的身份，'remove' 摘掉命中的身份，
   * 没命中就是空操作。所以重放无条件、与顺序无关，也不会让窗口变大——调用方不需要
   * 处理裁剪、游标失效或二次追平。
   */
  private replayPendingMutations(target: PageWindow<T>): void {
    for (const [identity, mutation] of this.pendingMutations) {
      const matches = (item: T): boolean => this.opts.identityOf(item) === identity;
      if (mutation.kind === 'replace') target.updateMatching(matches, () => mutation.item);
      else target.removeMatching(matches);
    }
    this.pendingMutations.clear();
  }

  /** 权威页落地后的提示条状态：只剩「期间是否积压了未处理的 invalidate」一个来源。 */
  private applyAuthoritativeState(): void {
    this.dir.backward.cursorInvalid = false;
    this.dir.forward.cursorInvalid = false;
    if (this.pendingInvalidate) this.pending.stale = true;
    else this.pending.clear();
  }

  private isAuthoritativeRequestInFlight(): boolean {
    return this.authoritative !== null;
  }

  private hasDataRequestInFlight(): boolean {
    return this.isAuthoritativeRequestInFlight() || this.dir.backward.loading || this.dir.forward.loading;
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
    if (this.isAuthoritativeRequestInFlight() || (!this.dir.backward.loading && !this.dir.forward.loading)) return;
    // live 裁剪后，所有基于旧窗口边界发出的普通分页响应都已失去上下文。
    this.requestId += 1;
    this.dir.backward.loading = false;
    this.dir.forward.loading = false;
    this.refreshTokenByIdentity.clear();
  }

  private flushDeferredInvalidate(): void {
    if (!this.disposed && this.pendingInvalidate && !this.hasDataRequestInFlight()) {
      this.scheduleInvalidateFlush();
    }
  }

  /**
   * 记一条待重放的本地最终态。同一身份后写覆盖先写即可：两种 mutation 都与位置和
   * 顺序无关，不需要「保持 Map 顺序 = 保持重放顺序」这类隐式契约。
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
    if (this.disposed || !this.pendingInvalidate) return;
    if (this.hasDataRequestInFlight()) {
      // reset / staged reconcile 的响应会整体替换窗口。期间到达的 identity 通知不能在旧
      // 窗口上执行后被覆盖，也不能拿旧结果修改新窗口；保留 identity，权威请求落定后重发。
      const deferredCount = this.pendingInvalidateCount;
      this.pendingInvalidateCount = 0;
      this.pending.add(deferredCount);
      this.repaint();
      return;
    }
    const identities = [...this.pendingIdentities];
    const count = this.pendingInvalidateCount;
    this.pendingInvalidate = false;
    this.pendingIdentities.clear();
    this.pendingInvalidateCount = 0;

    if (!(this.opts.isActive?.() ?? true)) {
      this.pending.add(count);
      // 仍然重渲一次：宿主切回可见时提示条要已经是最新状态，不能等下一次 render。
      this.repaint();
      return;
    }
    if (this.atFreshEdge()) {
      void this.catchUp();
      return;
    }

    this.pending.add(count);
    // 先同步一次提示条再发定向请求：否则请求慢时提示条要等几百毫秒才亮。
    this.repaint();

    const hits = identities.filter((id) => this.window.hasIdentity(id));
    const fetchByIdentity = this.opts.fetchByIdentity;
    if (hits.length === 0 || !fetchByIdentity) return;

    const refreshTokens = new Map(hits.map((id) => [id, Symbol(id)] as const));
    for (const [id, token] of refreshTokens) this.refreshTokenByIdentity.set(id, token);
    const myRequestId = this.requestId;
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
      if (!this.disposed && myRequestId === this.requestId && hasCurrentIdentity) {
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
        if (this.disposed || myRequestId !== this.requestId) return;
        const fetchedMap = new Map(fetched.map((item) => [this.opts.identityOf(item), item] as const));
        // refresh 可能先于一个更早快照的普通分页返回。此时刚接受的远端最终态也要
        // 暂存进 overlay，让晚到分页在并入后重放；否则新值会回退，删除项会复活。
        const pageRequestInFlight = this.dir.backward.loading || this.dir.forward.loading;
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
        if (this.disposed || myRequestId !== this.requestId) return;
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
    const pinned = this.opts.pinnedItems?.() ?? [];
    for (const item of pinned) if (this.opts.identityOf(item) === identity) return item;
    for (const item of this.window.items) if (this.opts.identityOf(item) === identity) return item;
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
    const text = this.opts.text.updatePill?.(this.pending.count);
    // 没有提供文案就不该出现一个空白提示条。
    this.pill.setVisible(this.pending.stale && text !== undefined, text);
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
    const pinned = this.opts.pinnedItems?.() ?? [];
    // 顺序与渲染保持一致：pinnedItems 在前，窗口条目在后。
    const items = [...pinned, ...this.window.items].filter((item) => ids.has(this.opts.identityOf(item)));
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
