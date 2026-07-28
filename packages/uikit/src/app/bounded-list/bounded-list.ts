// BoundedList 组件外壳：编排数据窗口、渲染引擎、选中态、提示条与事件（设计方案 §4）。
//
// 两处对设计方案的刻意偏离（均属「不合理之处可以修改」范畴，原因见注释）：
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
import { BoundedStreamWindow, catchUpAtEdge, createFrameScheduler } from './stream-window';
import type {
  BoundedListOptions,
  BoundedListState,
  Direction,
  ErrorPhase,
  FreshEdge,
  RenderItemContext,
} from './types';

export class BoundedList<T, Q = void> {
  private readonly window: PageWindow<T>;
  private readonly stream: BoundedStreamWindow<T>;
  private readonly pill: UpdatePillHandle;
  private readonly selection?: SelectionStore;
  private readonly unsubscribeSelection?: () => void;
  private readonly freshEdgeValue: FreshEdge;
  private readonly stickyPx: number;
  private readonly settleFrames: number;
  private readonly scheduleInvalidateFlush: (() => void) & { cancel: () => void };

  private query: Q;
  private firstLoadDone = false;
  private loadingBefore = false;
  private loadingAfter = false;
  private stale = false;
  private pendingCount = 0;
  private requestId = 0;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingInvalidate = false;
  private pendingIdentities = new Set<string>();
  private pendingInvalidateCount = 0;

  constructor(private readonly opts: BoundedListOptions<T, Q>) {
    this.freshEdgeValue = opts.freshEdge ?? 'head';
    this.stickyPx = opts.stickyPx ?? (this.freshEdgeValue === 'head' ? 4 : 50);
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
    });

    this.scheduleInvalidateFlush = createFrameScheduler(() => this.flushInvalidate());

    registerBoundedList(this);
  }

  get id(): string {
    return this.opts.id;
  }

  // ---- 命令式接口（设计方案 §4.3） ----

  async reset(optsIn?: { query?: Q; pinEdge?: boolean }): Promise<void> {
    if (this.disposed) return;
    if (optsIn && Object.prototype.hasOwnProperty.call(optsIn, 'query')) this.query = optsIn.query as Q;
    const pinEdge = optsIn?.pinEdge ?? true;
    const myRequestId = ++this.requestId;

    this.window.reset();
    this.firstLoadDone = false;
    this.loadingBefore = false;
    this.loadingAfter = false;
    this.stale = false;
    this.pendingCount = 0;
    this.emitStaleChange();
    this.emitLoadState();
    this.render();

    try {
      const page = await this.opts.source.fetch({
        cursor: undefined,
        backward: false,
        limit: this.opts.pageSize,
        query: this.query,
      });
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
      this.reportError(err, 'reset');
      this.render();
      this.emitLoadState();
    }
  }

  async loadMore(dir: Direction): Promise<void> {
    if (this.disposed) return;
    const hasMore = dir === 'backward' ? this.window.hasMoreBefore : this.window.hasMoreAfter;
    const alreadyLoading = dir === 'backward' ? this.loadingBefore : this.loadingAfter;
    if (!hasMore || alreadyLoading) return;

    if (dir === 'backward') this.loadingBefore = true; else this.loadingAfter = true;
    this.emitLoadState();
    this.render();

    const myRequestId = this.requestId;
    const cursor = dir === 'backward' ? this.window.backwardCursor : this.window.forwardCursor;
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
      } else {
        this.window.appendForward(page);
        this.loadingAfter = false;
      }
      this.emitItemsChanged();
      if (page.items.length === 0) this.handleEmptyPage(dir);
      this.emitLoadState();
      this.render();
    } catch (err) {
      if (myRequestId !== this.requestId || this.disposed) return;
      if (dir === 'backward') this.loadingBefore = false; else this.loadingAfter = false;
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

  /** 轻通知唯一入口；同一帧内多次调用只跑一次决策（§5.1）。 */
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
      this.selection?.retainOnly(new Set(this.window.items.map((item) => this.opts.identityOf(item))));
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
      loadingText: text.loading?.(),
      topBoundaryText: text.headBoundary?.(),
      bottomBoundaryText: text.tailBoundary?.(),
      loadBefore: () => void this.loadMore('backward'),
      loadAfter: () => void this.loadMore('forward'),
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
    this.stream.dispose();
    this.pill.dispose();
    this.unsubscribeSelection?.();
    unregisterBoundedList(this);
  }

  // ---- 只读状态（§4.4） ----

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
    };
  }

  // ---- 内部实现 ----

  private freshDirection(): Direction {
    return this.freshEdgeValue === 'head' ? 'backward' : 'forward';
  }

  private atFreshEdge(): boolean {
    return this.stream.isAtEdge(this.freshEdgeValue, this.stickyPx);
  }

  private isQueryActive(): boolean {
    try {
      return JSON.stringify(this.query) !== JSON.stringify(this.opts.initialQuery);
    } catch {
      return this.query !== this.opts.initialQuery;
    }
  }

  private pinToFreshEdge(): void {
    const el = this.opts.scrollElement;
    let remaining = this.settleFrames;
    const settle = () => {
      el.scrollTop = this.freshEdgeValue === 'head' ? 0 : el.scrollHeight;
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

  private onScrollFrame(): void {
    // 提示条自动消失路径①：用户自己滚回新鲜端时自动追平（§5.3）。
    catchUpAtEdge(
      () => this.stale && !this.loadingBefore && !this.loadingAfter,
      () => this.atFreshEdge(),
      () => this.reset({ pinEdge: true }),
    );
  }

  private handleEmptyPage(dir: Direction): void {
    this.opts.onEmptyPage?.(dir);
    // 提示条自动消失路径②：翻页翻到了新鲜端的尽头（§5.3、§3.4 ③ 的修复——
    // 两个字段必须一起清零，否则残留计数会带到下一次提示条亮起）。
    if (dir === this.freshDirection()) {
      this.stale = false;
      this.pendingCount = 0;
      this.emitStaleChange();
    }
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
      return;
    }
    if (this.atFreshEdge()) {
      void this.reset({ pinEdge: true });
      return;
    }

    this.stale = true;
    this.pendingCount += count;
    this.emitStaleChange();

    const hits = identities.filter((id) => this.window.hasIdentity(id));
    if (hits.length > 0 && this.opts.fetchByIdentity) {
      void this.opts.fetchByIdentity(hits)
        .then((fetched) => {
          if (this.disposed) return;
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
          if (this.disposed) return;
          this.reportError(err, 'refresh');
          this.render();
        });
      return;
    }
    this.render();
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
    return this.opts.renderItem(item, ctx);
  }

  private syncPill(): void {
    const text = this.opts.text.updatePill?.(this.pendingCount) ?? '';
    this.pill.setVisible(this.stale, text);
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
    const items = [...this.window.items, ...pinned].filter((item) => ids.has(this.opts.identityOf(item)));
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
