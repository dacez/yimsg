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
import { BoundedStreamWindow, DEFAULT_REACH_PX, catchUpAtEdge, createFrameScheduler } from './stream-window';
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
 * 查询条件比较：只看结构不看引用，也不看对象键的书写顺序
 * （JSON.stringify 对 `{a:1,b:2}` 与 `{b:2,a:1}` 会给出不同结果，据此判断会误判成「已过滤」）。
 * 深度上限兼作环引用兜底：同一引用会先被 Object.is 命中，其余超深结构一律视为不相等。
 */
function queryEquals(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 8) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a as object);
  if (keys.length !== Object.keys(b as object).length) return false;
  return keys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key)
    && queryEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1));
}

function createDeferredFrameScheduler(callback: () => void): (() => void) & { cancel: () => void } {
  let scheduled = false;
  let token = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const myToken = ++token;
    const run = () => {
      if (myToken !== token) return;
      scheduled = false;
      callback();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => run());
    } else {
      globalThis.queueMicrotask(run);
    }
  };
  schedule.cancel = () => {
    scheduled = false;
    token += 1;
  };
  return schedule;
}

type LocalMutation<T> =
  | { readonly kind: 'upsert'; readonly item: T }
  | { readonly kind: 'replace'; readonly identity: string; readonly item: T }
  | { readonly kind: 'remove'; readonly identity: string };

export class BoundedList<T, Q = void> {
  private window: PageWindow<T>;
  private readonly stream: BoundedStreamWindow<T>;
  private readonly pill: UpdatePillHandle;
  private readonly selection?: SelectionStore;
  private readonly unsubscribeSelection?: () => void;
  private readonly unregister: () => void;
  private readonly freshEdgeValue: FreshEdge;
  private readonly stickyPx: number;
  private readonly reachPx: number;
  private readonly settleFrames: number;
  private readonly scheduleInvalidateFlush: (() => void) & { cancel: () => void };
  private readonly scheduleCapacityReconcile: (() => void) & { cancel: () => void };
  private readonly originalA11yAttributes = new Map<(typeof A11Y_ATTRS)[number], string | null>();
  /**
   * 尚未被权威页确认的本地最终态。按 identity 合并，既不会因重复操作挤掉较早的 remove，
   * 也不会把每次操作都永久留在内存里。
   */
  private readonly pendingMutations = new Map<string, LocalMutation<T>>();
  /** clearWindow=true 的权威首页请求（reset）是否在飞；容量 reconcile 见 capacityReconciling。 */
  private resetInFlight = false;
  private capacityReconciling = false;
  private capacityReconcilePromise: Promise<void> | null = null;

  private query: Q;
  private firstLoadDone = false;
  private resetError: unknown;
  private hasResetError = false;
  private stale = false;
  private pendingCount = 0;
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

    this.freshEdgeValue = opts.freshEdge ?? 'head';
    this.stickyPx = opts.stickyPx ?? (this.freshEdgeValue === 'head' ? 4 : 50);
    this.reachPx = opts.reachPx ?? DEFAULT_REACH_PX;
    this.settleFrames = opts.settleFrames ?? (this.freshEdgeValue === 'head' ? 1 : 4);
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
    this.scheduleInvalidateFlush = createFrameScheduler(() => this.flushInvalidate());
    this.scheduleCapacityReconcile = createDeferredFrameScheduler(() => {
      if (!this.disposed) void this.reconcileCapacity();
    });

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
    this.capacityReconciling = false;
    this.capacityReconcilePromise = null;
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
    const hasMore = dir === 'backward' ? this.window.hasMoreBefore : this.window.hasMoreAfter;
    const alreadyLoading = this.dir[dir].loading;
    if (!hasMore || alreadyLoading) return;

    const cursor = dir === 'backward' ? this.window.backwardCursor : this.window.forwardCursor;
    // 空游标意味着窗口里没有任何可用的续翻锚点（例如只有本端并入的条目）。
    // 空串不是 reset 语义，发出去只会让服务端按未定义行为处理，这里直接放弃。
    if (cursor === '') return;

    this.dir[dir].loading = true;
    this.emitLoadState();
    this.render(false);

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
      const overlayEvicted = this.replayPendingMutations(this.window);
      if (overlayEvicted > 0) {
        this.dir[this.nonFreshDirection()].cursorInvalid = true;
        this.cancelOrdinaryPageLoads();
        this.stale = true;
        this.pendingCount = Math.max(this.pendingCount, overlayEvicted);
        if (this.atFreshEdge()) this.scheduleCapacityReconcile();
      }
      this.emitItemsChanged();
      this.settleFreshEdgeBoundary(dir);
      this.emitLoadState();
      this.render(false);
      this.flushDeferredInvalidate();
    } catch (err) {
      if (myRequestId !== this.requestId || this.disposed) return;
      this.dir[dir].loading = false;
      this.dir[dir].autoBlocked = true;
      this.reportError(err, dir);
      this.emitLoadState();
      this.render(false);
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
    const identity = this.opts.identityOf(item);
    this.invalidateRefresh(identity);
    if (!this.reachesFreshEdge()) {
      // 窗口还没追平新鲜端：这条本端新增和已加载内容之间的真实相邻关系无法确定，
      // 硬并入只会把它错误地拼在一段旧历史后面，还会顺带关掉真正的续翻。
      // 不猜顺序：记入 overlay，等真正追平新鲜端的下一次 reset / reconcile / 续翻
      // 由 replayPendingMutations 带回真实位置，同时点亮一次待处理提示。
      this.rememberPendingMutation({ kind: 'upsert', item });
      this.invalidate({ count: 1 });
      return;
    }
    const wasAtFreshEdge = this.atFreshEdge();
    this.stickToFreshEdge = wasAtFreshEdge;
    const rememberBeforeMerge = this.shouldDeferToOverlay();
    if (rememberBeforeMerge) {
      this.rememberPendingMutation({ kind: 'upsert', item });
    }
    const evicted = this.window.mergeLive(item, this.freshEdgeValue);
    if (evicted > 0) {
      this.dir[this.nonFreshDirection()].cursorInvalid = true;
      this.cancelOrdinaryPageLoads();
      if (!rememberBeforeMerge) {
        this.rememberPendingMutation({ kind: 'upsert', item });
      }
    }
    this.emitItemsChanged();
    this.emitLoadState();
    this.render(false);
    if (evicted > 0) {
      // live 条目没有可重建的服务端游标：先同步裁剪保证硬有界，再按用户原贴边状态
      // 选择权威 reset 或提示稍后追平，避免用失真的旧边界继续分页。
      if (!this.isAuthoritativeRequestInFlight()) {
        if (wasAtFreshEdge) {
          this.scheduleCapacityReconcile();
        } else {
          this.invalidate({ count: evicted });
        }
      }
    }
  }

  patch(id: string, update: (item: T) => T): boolean {
    if (this.disposed) return false;
    const changed = this.window.updateMatching((item) => this.opts.identityOf(item) === id, update);
    if (changed) {
      this.invalidateRefresh(id);
      if (this.shouldDeferToOverlay()) {
        const current = this.window.items.find((item) => this.opts.identityOf(item) === id);
        if (current) {
          this.rememberPendingMutation({ kind: 'replace', identity: id, item: current });
        }
      }
      this.emitItemsChanged();
      this.render(false);
      return true;
    }
    // 窗口里没有，但可能是一条还没追平新鲜端、只存在于 overlay 里的本端 upsert
    // （见 upsertLocal 的 reachesFreshEdge 守卫）：直接改写这条待重放的最终态。
    const pending = this.pendingMutations.get(id);
    if (pending?.kind === 'upsert') {
      this.rememberPendingMutation({ kind: 'upsert', item: update(pending.item) });
      return true;
    }
    return false;
  }

  removeLocal(id: string): boolean {
    if (this.disposed) return false;
    const changed = this.window.removeMatching((item) => this.opts.identityOf(item) === id);
    if (changed) {
      this.invalidateRefresh(id);
      if (this.shouldDeferToOverlay()) {
        this.rememberPendingMutation({ kind: 'remove', identity: id });
      }
      // 只精确摘掉被删的这一个身份：共享 store 时其它实例（以及 pinnedItems、
      // 已被裁剪出窗口）的选中项与本次删除无关，不能一并清掉。
      this.selection?.delete(id);
      this.emitItemsChanged();
      this.emitLoadState();
      this.render(false);
      return true;
    }
    // 窗口里没有，但可能是一条还没追平新鲜端的 pending upsert：仍然要记一条
    // 'remove'，而不是直接撤销待办——权威页在途时可能碰巧携带同一身份的旧记录，
    // 只有留下 remove 才能在重放时把它一并挡住。
    if (this.pendingMutations.get(id)?.kind === 'upsert') {
      this.rememberPendingMutation({ kind: 'remove', identity: id });
      this.selection?.delete(id);
      return true;
    }
    return false;
  }

  render(forceRows = true): void {
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
    // loaded/hasMoreBefore/hasMoreAfter/loadingBefore/loadingAfter 与 getState() 是同一份口径，
    // 复用而不是各写一遍，避免以后改判定条件时漏改其中一处。
    const state = this.getState();

    this.stream.render({
      items,
      loaded: state.loaded,
      hasMoreBefore: state.hasMoreBefore,
      hasMoreAfter: state.hasMoreAfter,
      loadingBefore: state.loadingBefore,
      loadingAfter: state.loadingAfter,
      emptyText,
      errorText,
      loadingText: text.loading?.(),
      topBoundaryText: text.headBoundary?.(),
      bottomBoundaryText: text.tailBoundary?.(),
      loadBefore: () => this.autoLoadMore('backward'),
      loadAfter: () => this.autoLoadMore('forward'),
      renderItem: (item, index) => this.renderItemWithContext(item, index, items),
      keyOf: (item) => this.opts.identityOf(item),
      reuseUnchangedRows: !forceRows,
      revisionOf: (item, index) => this.rowRevision(item, index, items),
    });
    this.syncPill();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduleInvalidateFlush.cancel();
    this.scheduleCapacityReconcile.cancel();
    this.resetInFlight = false;
    this.capacityReconciling = false;
    this.capacityReconcilePromise = null;
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
      loading: this.dir.backward.loading || this.dir.forward.loading || this.capacityReconciling,
      loadingBefore: this.dir.backward.loading,
      loadingAfter: this.dir.forward.loading,
      hasMoreBefore: this.window.hasMoreBefore && !this.dir.backward.cursorInvalid,
      hasMoreAfter: this.window.hasMoreAfter && !this.dir.forward.cursorInvalid,
      count: this.window.count,
      total: this.window.total,
      stale: this.stale,
      pendingCount: this.pendingCount,
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

  private freshDirection(): Direction {
    return this.freshEdgeValue === 'head' ? 'backward' : 'forward';
  }

  private nonFreshDirection(): Direction {
    return this.freshEdgeValue === 'head' ? 'forward' : 'backward';
  }

  private atFreshEdge(): boolean {
    return this.stream.isAtEdge(this.freshEdgeValue, this.stickyPx);
  }

  /** 窗口内容（而非滚动位置）是否已经追到新鲜端尽头：该端 hasMore 已收敛为 false。 */
  private reachesFreshEdge(): boolean {
    return this.freshEdgeValue === 'tail' ? !this.window.hasMoreAfter : !this.window.hasMoreBefore;
  }

  private isQueryActive(): boolean {
    return !queryEquals(this.query, this.opts.initialQuery);
  }

  private clearResetError(): void {
    this.resetError = undefined;
    this.hasResetError = false;
  }

  private pinToFreshEdge(): void {
    const el = this.opts.scrollElement;
    let remaining = this.settleFrames;
    const settle = () => {
      if (this.disposed) return; // dispose 之后不再触碰宿主 DOM
      el.scrollTop = this.freshEdgeValue === 'head' ? 0 : el.scrollHeight;
      this.stickToFreshEdge = true;
      remaining -= 1;
      if (remaining > 0) this.scheduleFrame(settle);
    };
    settle();
  }

  private scheduleFrame(cb: () => void): void {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => cb());
      return;
    }
    cb();
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
    catchUpAtEdge(
      () => this.stale && !this.dir.backward.loading && !this.dir.forward.loading,
      () => this.atFreshEdge(),
      () => this.catchUp(),
    );
  }

  /** 图片等异步增高内容加载完成：此前贴在尾部新鲜端的话重新贴回底部。 */
  private onContentLoad(): void {
    if (this.disposed || this.freshEdgeValue !== 'tail' || !this.stickToFreshEdge) return;
    this.pinToFreshEdge();
  }

  /**
   * 提示条自动消失路径②：新鲜端方向已经翻到尽头（该端 hasMore 收敛为 false）。
   * 判定条件是「hasMore 变 false」而不是「拿到空页」——非空的最后一页同样意味着
   * 新鲜端之后再无未加载数据，提示条必须一起消失。两个字段必须一起清零，
   * 否则残留计数会带到下一次提示条亮起。
   */
  private settleFreshEdgeBoundary(dir: Direction): void {
    if (dir !== this.freshDirection()) return;
    const stillHasMore = dir === 'backward' ? this.window.hasMoreBefore : this.window.hasMoreAfter;
    if (stillHasMore || (!this.stale && this.pendingCount === 0)) return;
    this.stale = false;
    this.pendingCount = 0;
  }

  private reconcileCapacity(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // 显式 loadMore / 提示条追平可能先于已经排队的自动帧任务到达；一旦任何入口
    // 开始接管本轮 reconcile，就取消旧帧，避免首个请求很快完成后旧帧再发一次 reset。
    this.scheduleCapacityReconcile.cancel();
    if (this.capacityReconcilePromise) return this.capacityReconcilePromise;
    // pinEdge 恒为 false：容量 reconcile 不清空窗口，是否贴边完全交给共享辅助方法
    // 在响应落地那一刻实时读 `stickToFreshEdge`（可能在请求期间被滚动事件改写），
    // 而不是像 reset 那样在调用时就固定调用方意图。
    const running = this.loadAuthoritativePage({ clearWindow: false, pinEdge: false });
    this.capacityReconcilePromise = running;
    void running.then(
      () => {
        if (this.capacityReconcilePromise === running) this.capacityReconcilePromise = null;
      },
      () => {
        if (this.capacityReconcilePromise === running) this.capacityReconcilePromise = null;
      },
    );
    return running;
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
      this.resetInFlight = true;
      this.stickToFreshEdge = pinEdge ? true : this.atFreshEdge();
      this.window.reset();
      this.firstLoadDone = false;
      this.dir.backward.autoBlocked = false;
      this.dir.forward.autoBlocked = false;
      this.dir.backward.cursorInvalid = false;
      this.dir.forward.cursorInvalid = false;
      this.stale = false;
      this.pendingCount = 0;
    } else {
      this.resetInFlight = false;
      this.capacityReconciling = true;
    }
    this.dir.backward.loading = false;
    this.dir.forward.loading = false;
    this.refreshTokenByIdentity.clear();
    this.clearResetError();
    this.emitLoadState();
    // clearWindow=false（容量 reconcile）时保留当前有界窗口，只更新 loading / pill；
    // 权威响应落地前不清空 DOM。
    this.render(false);

    const request: FetchPageRequest<Q> = {
      cursor: undefined,
      backward: false,
      limit: this.opts.pageSize,
      query: this.query,
    };

    try {
      const page = await this.opts.source.fetch(request);
      if (myRequestId !== this.requestId || this.disposed) return;
      const { window: nextWindow, evicted: overlayEvicted } = this.buildAuthoritativeWindow(page);

      this.window = nextWindow;
      this.resetInFlight = false;
      this.capacityReconciling = false;
      this.scheduleCapacityReconcile.cancel();
      this.firstLoadDone = true;
      this.applyAuthoritativeOverlayState(overlayEvicted);
      this.emitItemsChanged();
      this.render(false);
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
      this.resetInFlight = false;
      this.capacityReconciling = false;
      this.scheduleCapacityReconcile.cancel();
      // 不清空 pendingMutations：本次失败期间发生的本地写入仍要等下一次成功的
      // reset/reconcile 把窗口带到新鲜端时被重放，不能因为这次失败就丢掉。
      this.firstLoadDone = true;
      this.resetError = err;
      this.hasResetError = true;
      if (this.window.count > 0) {
        this.stale = true;
        this.pendingCount = Math.max(1, this.pendingCount);
      }
      this.reportError(err, 'reset');
      this.render(false);
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
    return { window: nextWindow, evicted: this.replayPendingMutations(nextWindow) };
  }

  /**
   * 把有界 overlay 里已经能确定归宿的最终态重放到 target 上，并就地摘掉已重放的条目。
   *
   * 'upsert' 只有在 target 已经追平新鲜端（该端 hasMore 已为 false）时才重放：
   * 否则这条本端新增和 target 已有内容之间的真实相邻关系仍然不确定，重放只会把
   * 它错误地拼接在半程历史后面。不满足条件的 'upsert' 原样留在 overlay 里，
   * 等下一次真正追平新鲜端的请求（reset / reconcile，或续翻终于翻到底）时再重放，
   * 不会被这次调用悄悄丢弃。'replace' / 'remove' 不涉及相邻关系，随时可以重放，
   * target 里没有命中的身份时就是无操作。
   */
  private replayPendingMutations(target: PageWindow<T>): number {
    const targetReachesFreshEdge = this.freshEdgeValue === 'tail' ? !target.hasMoreAfter : !target.hasMoreBefore;
    let evicted = 0;
    for (const [identity, mutation] of [...this.pendingMutations]) {
      if (mutation.kind === 'upsert') {
        if (!targetReachesFreshEdge) continue;
        evicted += target.mergeLive(mutation.item, this.freshEdgeValue);
      } else if (mutation.kind === 'replace') {
        target.updateMatching(
          (item) => this.opts.identityOf(item) === mutation.identity,
          () => mutation.item,
        );
      } else {
        target.removeMatching(
          (item) => this.opts.identityOf(item) === mutation.identity,
        );
      }
      this.pendingMutations.delete(identity);
    }
    return evicted;
  }

  private applyAuthoritativeOverlayState(overlayEvicted: number): void {
    const hasDeferredInvalidate = this.pendingInvalidate;
    this.dir[this.nonFreshDirection()].cursorInvalid = overlayEvicted > 0;
    this.dir[this.freshDirection()].cursorInvalid = false;
    this.stale = overlayEvicted > 0 || hasDeferredInvalidate;
    if (overlayEvicted > 0) {
      this.pendingCount = Math.max(this.pendingCount, overlayEvicted);
    } else if (!hasDeferredInvalidate) {
      this.pendingCount = 0;
    }
  }

  private isAuthoritativeRequestInFlight(): boolean {
    return this.resetInFlight || this.capacityReconciling;
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

  private rememberPendingMutation(mutation: LocalMutation<T>): void {
    const identity = mutation.kind === 'upsert'
      ? this.opts.identityOf(mutation.item)
      : mutation.identity;
    const previous = this.pendingMutations.get(identity);
    // upsert 后的 patch 仍然是“若权威页没有该 identity 也要新增”，不能降级成 replace。
    const finalMutation = mutation.kind === 'replace' && previous?.kind === 'upsert'
      ? { kind: 'upsert' as const, item: mutation.item }
      : mutation;
    // patch 不改变真实窗口里的相对顺序；只有 upsert/remove 这类在时间线上重新发生的
    // 操作才移动到 Map 尾部。否则 C→D→patch(C) 会被错误重放成 D→C。
    if (mutation.kind !== 'replace') this.pendingMutations.delete(identity);
    this.pendingMutations.set(identity, finalMutation);
    // 硬预算兜底：这个数量级需要在一次权威请求的在飞窗口内发生 pageSize×maxPages
    // 个不同 identity 的本地写入，现实中不会发生。到这里就静默丢最旧的一条，
    // 用一次可忽略的极端退化换掉一整套「显式失败 + 强制新快照」的复杂度。
    const hardBudget = this.opts.pageSize * this.opts.maxPages;
    if (this.pendingMutations.size > hardBudget) {
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
      this.stale = true;
      this.pendingCount += deferredCount;
      this.render(false);
      return;
    }
    const identities = [...this.pendingIdentities];
    const count = this.pendingInvalidateCount;
    this.pendingInvalidate = false;
    this.pendingIdentities.clear();
    this.pendingInvalidateCount = 0;

    if (!(this.opts.isActive?.() ?? true)) {
      this.stale = true;
      this.pendingCount += count;
      // 仍然重渲一次：宿主切回可见时提示条要已经是最新状态，不能等下一次 render。
      this.render(false);
      return;
    }
    if (this.atFreshEdge()) {
      void this.catchUp();
      return;
    }

    this.stale = true;
    this.pendingCount += count;
    // 先同步一次提示条再发定向请求：否则请求慢时提示条要等几百毫秒才亮。
    this.render(false);

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
        this.render(false);
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
            if (found) {
              this.rememberPendingMutation({ kind: 'replace', identity: id, item: found });
            } else {
              this.rememberPendingMutation({ kind: 'remove', identity: id });
            }
          } else {
            // 这份 refresh 是在该 identity 最后一次本地 mutation 之后发出且 token
            // 仍有效；没有更早分页在飞时可直接淘汰旧 overlay。
            this.pendingMutations.delete(id);
          }
        }
        if (!changed) return;
        this.emitItemsChanged();
        this.emitLoadState();
        this.render(false);
      })
      .catch((err) => {
        if (this.disposed || myRequestId !== this.requestId) return;
        const hasCurrentIdentity = hits.some(
          (id) => this.refreshTokenByIdentity.get(id) === refreshTokens.get(id),
        );
        if (!hasCurrentIdentity) return;
        this.reportError(err, 'refresh');
        this.render(false);
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
    const text = this.opts.text.updatePill?.(this.pendingCount);
    // 没有提供文案就不该出现一个空白提示条。
    this.pill.setVisible(this.stale && text !== undefined, text);
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
