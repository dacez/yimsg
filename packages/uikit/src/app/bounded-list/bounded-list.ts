// BoundedList 组件外壳：编排数据窗口、渲染引擎、选中态、提示条与事件。
// 接口口径单一事实源：packages/uikit/docs/BoundedList组件设计.md。
//
// 两处对《有界消息流窗口设计方案》§4 的刻意偏离（均属「不合理之处可以修改」范畴）：
// 1. `state.loaded` 不直接用 PageWindow.loaded：PageWindow 对「真实为空的首页」和
//    「尚未加载」都表现为 pages.length===0，无法区分「还在转圈」与「确认没有数据」。
//    这里改用组件自己的 firstLoadDone（reset 发出的首次请求落定即置 true，无论
//    结果是否为空），空态与加载态才能被渲染引擎正确区分。
// 2. §4.5 决策图里「多选点击复选框才检查上限」被统一成「无论点在行的哪个区域都检查
//    上限」：按原图，点击复选框以外的区域会绕开 S3 的上限判断直接翻转选中，等于
//    允许点几下行内空白就能突破 `max`——这是竞态之外的一个真实可利用的上限绕过，
//    不是有意的产品行为，因此统一走 SelectionStore.toggle 内置的上限检查。

import { PageWindow } from './page-window';
import { SelectionStore } from './selection';
import { createUpdatePill, type UpdatePillHandle } from './update-pill';
import { registerBoundedList, unregisterBoundedList } from './registry';
import { BoundedStreamWindow, DEFAULT_REACH_PX, catchUpAtEdge, createFrameScheduler } from './stream-window';
import type {
  BoundedListOptions,
  BoundedListState,
  Direction,
  ErrorPhase,
  FetchPageRequest,
  FreshEdge,
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

export class BoundedList<T, Q = void> {
  private readonly window: PageWindow<T>;
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

  private query: Q;
  private firstLoadDone = false;
  private resetError: unknown;
  private hasResetError = false;
  private loadingBefore = false;
  private loadingAfter = false;
  private stale = false;
  private pendingCount = 0;
  private requestId = 0;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 加载前缓存的贴边状态：图片异步增高后不能现算（内容已变高，必然误判成不贴边）。 */
  private stickToFreshEdge = true;
  /**
   * 触界检测驱动的自动续翻在该方向上是否被暂停。
   * 某方向请求失败后置真，防止「失败 → 重渲 → 触界 → 立刻重试」在微任务里死循环；
   * 用户把该端滚离触界范围、显式调用 loadMore、或 reset 之后解除。
   */
  private autoLoadBlockedBefore = false;
  private autoLoadBlockedAfter = false;

  private pendingInvalidate = false;
  private pendingIdentities = new Set<string>();
  private pendingInvalidateCount = 0;

  constructor(private readonly opts: BoundedListOptions<T, Q>) {
    if (!Number.isInteger(opts.pageSize) || opts.pageSize < 1) {
      throw new RangeError(`[BoundedList:${opts.id}] pageSize 必须是不小于 1 的整数，收到 ${String(opts.pageSize)}`);
    }
    if (!Number.isInteger(opts.maxPages) || opts.maxPages < 1) {
      throw new RangeError(`[BoundedList:${opts.id}] maxPages 必须是不小于 1 的整数，收到 ${String(opts.maxPages)}`);
    }
    if (opts.selection?.store && opts.selection.max !== undefined) {
      throw new TypeError(`[BoundedList:${opts.id}] selection.store 与 selection.max 互斥：共享 store 的上限由该 store 自己决定`);
    }

    this.freshEdgeValue = opts.freshEdge ?? 'head';
    this.stickyPx = opts.stickyPx ?? (this.freshEdgeValue === 'head' ? 4 : 50);
    this.reachPx = opts.reachPx ?? DEFAULT_REACH_PX;
    this.settleFrames = opts.settleFrames ?? (this.freshEdgeValue === 'head' ? 1 : 4);
    this.query = (opts.initialQuery as Q) ?? (undefined as Q);
    this.window = new PageWindow<T>(opts.maxPages, opts.normalize, opts.identityOf);

    if (opts.selection) {
      this.selection = opts.selection.store ?? new SelectionStore(opts.selection.max);
      this.unsubscribeSelection = this.selection.subscribe(() => {
        if (this.disposed) return;
        this.render();
        this.emitSelectionChange();
      });
    }

    const pillHost = opts.pillHost === undefined ? (opts.scrollElement.parentElement ?? false) : opts.pillHost;
    this.pill = createUpdatePill(pillHost, () => void this.reset({ pinEdge: true }));

    this.stream = new BoundedStreamWindow<T>({
      scrollElement: opts.scrollElement,
      contentElement: opts.contentElement,
      reachPx: opts.reachPx,
      onScroll: () => this.onScrollFrame(),
      onInteract: (identity, ev) => this.onInteract(identity, ev),
      onContentLoad: () => this.onContentLoad(),
    });

    this.applyA11yAttributes();
    this.scheduleInvalidateFlush = createFrameScheduler(() => this.flushInvalidate());

    // 多 AppInstance 共存时必须登记到宿主自己的注册表，否则同名列表会互相覆盖。
    if (opts.register) {
      this.unregister = opts.register(this);
    } else {
      registerBoundedList(this);
      this.unregister = () => unregisterBoundedList(this);
    }
  }

  get id(): string {
    return this.opts.id;
  }

  // ---- 命令式接口（设计文档 §5） ----

  async reset(optsIn?: { query?: Q; pinEdge?: boolean }): Promise<void> {
    if (this.disposed) return;
    if (optsIn && Object.prototype.hasOwnProperty.call(optsIn, 'query')) this.query = optsIn.query as Q;
    const pinEdge = optsIn?.pinEdge ?? true;
    const myRequestId = ++this.requestId;

    this.window.reset();
    this.firstLoadDone = false;
    this.clearResetError();
    this.loadingBefore = false;
    this.loadingAfter = false;
    this.autoLoadBlockedBefore = false;
    this.autoLoadBlockedAfter = false;
    this.stale = false;
    this.pendingCount = 0;
    this.emitStaleChange();
    this.emitLoadState();
    this.render();

    const request: FetchPageRequest<Q> = {
      cursor: undefined,
      backward: false,
      limit: this.opts.pageSize,
      query: this.query,
      // 只有配置了进度回调才带上 onProgress，避免无谓地改变请求对象形状。
      ...(this.opts.onLoadProgress ? { onProgress: (loaded: number) => this.opts.onLoadProgress?.(loaded) } : {}),
    };

    try {
      const page = await this.opts.source.fetch(request);
      if (myRequestId !== this.requestId || this.disposed) return;
      this.window.setInitial(page);
      this.firstLoadDone = true;
      this.emitItemsChanged();
      this.render();
      if (pinEdge) this.pinToFreshEdge();
      this.emitLoadState();
    } catch (err) {
      if (myRequestId !== this.requestId || this.disposed) return;
      this.firstLoadDone = true;
      this.resetError = err;
      this.hasResetError = true;
      this.reportError(err, 'reset');
      this.render();
      this.emitLoadState();
    }
  }

  async loadMore(dir: Direction): Promise<void> {
    if (this.disposed) return;
    // 显式调用视为「用户主动重试」，解除该方向的自动续翻暂停。
    if (dir === 'backward') this.autoLoadBlockedBefore = false; else this.autoLoadBlockedAfter = false;
    await this.loadMoreInternal(dir);
  }

  // 两个调用点都已经挡住了 disposed：公开的 loadMore 自带守卫，autoLoadMore 只在
  // render 里被渲染引擎回调，而 render 在 dispose 之后是空操作。
  private async loadMoreInternal(dir: Direction): Promise<void> {
    const hasMore = dir === 'backward' ? this.window.hasMoreBefore : this.window.hasMoreAfter;
    const alreadyLoading = dir === 'backward' ? this.loadingBefore : this.loadingAfter;
    if (!hasMore || alreadyLoading) return;

    const cursor = dir === 'backward' ? this.window.backwardCursor : this.window.forwardCursor;
    // 空游标意味着窗口里没有任何可用的续翻锚点（例如只有本端并入的条目）。
    // 空串不是 reset 语义，发出去只会让服务端按未定义行为处理，这里直接放弃。
    if (cursor === '') return;

    if (dir === 'backward') this.loadingBefore = true; else this.loadingAfter = true;
    this.emitLoadState();
    this.render();

    const myRequestId = this.requestId;
    try {
      const page = await this.opts.source.fetch({
        cursor,
        backward: dir === 'backward',
        limit: this.opts.pageSize,
        query: this.query,
      });
      if (myRequestId !== this.requestId || this.disposed) return;
      if (dir === 'backward') {
        this.window.prependBackward(page);
        this.loadingBefore = false;
        this.autoLoadBlockedBefore = false;
      } else {
        this.window.appendForward(page);
        this.loadingAfter = false;
        this.autoLoadBlockedAfter = false;
      }
      this.emitItemsChanged();
      if (page.items.length === 0) this.opts.onEmptyPage?.(dir);
      this.settleFreshEdgeBoundary(dir);
      this.emitLoadState();
      this.render();
    } catch (err) {
      if (myRequestId !== this.requestId || this.disposed) return;
      if (dir === 'backward') {
        this.loadingBefore = false;
        this.autoLoadBlockedBefore = true;
      } else {
        this.loadingAfter = false;
        this.autoLoadBlockedAfter = true;
      }
      this.reportError(err, dir);
      this.emitLoadState();
      this.render();
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
    this.window.mergeLive(item, this.freshEdgeValue);
    this.emitItemsChanged();
    this.emitLoadState();
    this.render();
  }

  patch(id: string, update: (item: T) => T): boolean {
    if (this.disposed) return false;
    const changed = this.window.updateMatching((item) => this.opts.identityOf(item) === id, update);
    if (changed) {
      this.emitItemsChanged();
      this.render();
    }
    return changed;
  }

  removeLocal(id: string): boolean {
    if (this.disposed) return false;
    const changed = this.window.removeMatching((item) => this.opts.identityOf(item) === id);
    if (changed) {
      // 只精确摘掉被删的这一个身份：共享 store 时其它实例（以及 pinnedItems、
      // 已被裁剪出窗口）的选中项与本次删除无关，不能一并清掉。
      this.selection?.delete(id);
      this.emitItemsChanged();
      this.emitLoadState();
      this.render();
    }
    return changed;
  }

  render(): void {
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

    this.stream.render({
      items,
      loaded: this.firstLoadDone,
      hasMoreBefore: this.window.hasMoreBefore,
      hasMoreAfter: this.window.hasMoreAfter,
      loadingBefore: this.loadingBefore,
      loadingAfter: this.loadingAfter,
      emptyText,
      errorText,
      loadingText: text.loading?.(),
      topBoundaryText: text.headBoundary?.(),
      bottomBoundaryText: text.tailBoundary?.(),
      loadBefore: () => this.autoLoadMore('backward'),
      loadAfter: () => this.autoLoadMore('forward'),
      renderItem: (item, index) => this.renderItemWithContext(item, index, items),
      keyOf: (item) => this.opts.identityOf(item),
    });
    this.syncPill();
  }

  scrollToIdentity(id: string, opts?: { block?: 'center' | 'nearest' }): boolean {
    if (this.disposed) return false;
    const pinned = this.opts.pinnedItems?.() ?? [];
    const inWindow = this.window.hasIdentity(id) || pinned.some((item) => this.opts.identityOf(item) === id);
    if (!inWindow) return false;
    return this.stream.scrollToKey(id, opts?.block ?? 'nearest');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduleInvalidateFlush.cancel();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.removeA11yAttributes();
    this.stream.dispose();
    this.pill.dispose();
    this.unsubscribeSelection?.();
    this.unregister();
  }

  // ---- 只读状态（设计文档 §6） ----

  getState(): BoundedListState {
    return {
      loaded: this.firstLoadDone,
      loading: this.loadingBefore || this.loadingAfter,
      loadingBefore: this.loadingBefore,
      loadingAfter: this.loadingAfter,
      hasMoreBefore: this.window.hasMoreBefore,
      hasMoreAfter: this.window.hasMoreAfter,
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
    el.setAttribute?.('tabindex', '0');
    el.setAttribute?.('role', 'listbox');
    if (this.opts.selection?.mode === 'multi') el.setAttribute?.('aria-multiselectable', 'true');
  }

  private removeA11yAttributes(): void {
    const el = this.opts.scrollElement as HTMLElement & { removeAttribute?: (name: string) => void };
    for (const name of A11Y_ATTRS) el.removeAttribute?.(name);
  }

  private freshDirection(): Direction {
    return this.freshEdgeValue === 'head' ? 'backward' : 'forward';
  }

  private atFreshEdge(): boolean {
    return this.stream.isAtEdge(this.freshEdgeValue, this.stickyPx);
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
    if (dir === 'backward' ? this.autoLoadBlockedBefore : this.autoLoadBlockedAfter) return;
    void this.loadMoreInternal(dir);
  }

  private onScrollFrame(): void {
    const el = this.opts.scrollElement;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // 用户把某一端滚离触界范围，说明他离开了那个失败现场：解除该方向的自动续翻暂停，
    // 再滚回去时可以自然重试，既不会死循环也不需要额外的重试按钮。
    if (el.scrollTop > this.reachPx) this.autoLoadBlockedBefore = false;
    if (maxScrollTop - el.scrollTop > this.reachPx) this.autoLoadBlockedAfter = false;
    this.stickToFreshEdge = this.atFreshEdge();

    // 提示条自动消失路径①：用户自己滚回新鲜端时自动追平（设计文档 §13.2）。
    catchUpAtEdge(
      () => this.stale && !this.loadingBefore && !this.loadingAfter,
      () => this.atFreshEdge(),
      () => this.reset({ pinEdge: true }),
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
    this.emitStaleChange();
  }

  private flushInvalidate(): void {
    if (this.disposed || !this.pendingInvalidate) return;
    const identities = [...this.pendingIdentities];
    const count = this.pendingInvalidateCount;
    this.pendingInvalidate = false;
    this.pendingIdentities.clear();
    this.pendingInvalidateCount = 0;

    if (!(this.opts.isActive?.() ?? true)) {
      this.stale = true;
      this.pendingCount += count;
      this.emitStaleChange();
      // 仍然重渲一次：宿主切回可见时提示条要已经是最新状态，不能等下一次 render。
      this.render();
      return;
    }
    if (this.atFreshEdge()) {
      void this.reset({ pinEdge: true });
      return;
    }

    this.stale = true;
    this.pendingCount += count;
    this.emitStaleChange();
    // 先同步一次提示条再发定向请求：否则请求慢时提示条要等几百毫秒才亮。
    this.render();

    const hits = identities.filter((id) => this.window.hasIdentity(id));
    if (hits.length === 0 || !this.opts.fetchByIdentity) return;

    const myRequestId = this.requestId;
    void this.opts.fetchByIdentity(hits)
      .then((fetched) => {
        // 与 reset / loadMore 同样的丢弃守卫：期间发生过 reset 的话，
        // 这份结果描述的是已经作废的窗口，套到新窗口上会误删条目。
        if (this.disposed || myRequestId !== this.requestId) return;
        const fetchedMap = new Map(fetched.map((item) => [this.opts.identityOf(item), item] as const));
        for (const id of hits) {
          const found = fetchedMap.get(id);
          if (found) this.window.updateMatching((item) => this.opts.identityOf(item) === id, () => found);
          else this.window.removeMatching((item) => this.opts.identityOf(item) === id);
        }
        this.emitItemsChanged();
        this.emitLoadState();
        this.render();
      })
      .catch((err) => {
        if (this.disposed || myRequestId !== this.requestId) return;
        this.reportError(err, 'refresh');
        this.render();
      });
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

  private renderItemWithContext(item: T, index: number, items: readonly T[]): readonly HTMLElement[] {
    const identity = this.opts.identityOf(item);
    const selected = this.selection?.has(identity) ?? false;
    const selectable = this.selection ? !this.selection.isExceeded(identity) : true;
    const previous = index > 0 ? items[index - 1] : undefined;
    const ctx: RenderItemContext<T> = { index, identity, selected, selectable, previous };
    const elements = this.opts.renderItem(item, ctx);
    if (elements.length > 0) {
      elements[0].setAttribute?.('role', 'option');
      if (this.selection) elements[0].setAttribute?.('aria-selected', String(selected));
    }
    return elements;
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

  private emitStaleChange(): void {
    this.opts.onStaleChange?.(this.stale, this.pendingCount);
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
