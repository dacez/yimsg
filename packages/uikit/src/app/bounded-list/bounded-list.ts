// BoundedList 组件外壳：把「远端窗口 + 本地层 + 渲染引擎 + 提示条 + 选中态」编排起来。
// 接口口径单一事实源：packages/uikit/docs/boundedlist/组件设计.md，先读 ../../docs/boundedlist/导读.md。
//
// 三条贯穿全文件的规则，改动前请先确认没有破坏它们：
//
// 1. **窗口只被服务端响应修改，本地写入只进 overlay。** 因此没有任何「本地改动被响应
//    覆盖后要重放回去」的机制——渲染时叠加一次就够了。
// 2. **同一时刻只有一个分页请求在飞（单飞）。** `loading` 既是状态也是锁：首页请求
//    抢占并作废在飞的续翻，续翻在有请求在飞时直接放弃（触界检测每帧都会重来）。
// 3. **只有 `decide()` 会点亮 / 熄灭提示条。** 「正在追平」不是「有没看到的更新」，
//    在请求在飞时提前点亮，就会在响应落地后立刻熄灭，用户看到的是闪一下。

import { PageWindow } from './page-window';
import { LocalOverlay } from './overlay';
import { SelectionStore } from './selection';
import { createUpdatePill, type UpdatePillHandle } from './update-pill';
import { ListRenderer, DEFAULT_REACH_PX } from './renderer';
import { frameScheduler, nextFrame, type FrameScheduler } from './frame';
import type {
  BoundedListOptions,
  BoundedListState,
  Edge,
  ErrorPhase,
  RegisterBoundedList,
  RenderItemContext,
} from './types';

/** 距新鲜端多少像素以内算贴边。forward 端（消息）行高差异大，阈值放宽。 */
const STICKY_PX: Record<Edge, number> = { backward: 4, forward: 50 };
/** 贴边时连续校正多少帧。forward 端内容会异步增高，需要多帧。 */
const SETTLE_FRAMES: Record<Edge, number> = { backward: 1, forward: 4 };

/**
 * 显式声明「本列表不接入宿主的重连广播」。
 *
 * 用于模态框内的一次性候选列表：它们随弹窗创建、随弹窗 dispose，生命周期比一次重连
 * 还短，被广播追平没有意义。写成具名常量而不是省略 `register`，是为了让「不注册」
 * 成为可 grep、可复核的显式决定，而不是漏写参数的副作用。
 */
export const standaloneList: RegisterBoundedList = () => () => {};

export class BoundedList<T, Q = void> {
  /** 远端事实：只被服务端响应修改。 */
  private window: PageWindow<T>;
  /** 本地事实：本端写入，渲染时叠加在窗口之上。 */
  private readonly overlay: LocalOverlay<T>;
  private readonly renderer: ListRenderer<T>;
  private readonly pill: UpdatePillHandle;
  private readonly selection?: SelectionStore;
  private readonly unsubscribeSelection?: () => void;
  private readonly unregister: () => void;
  private readonly scheduleDecide: FrameScheduler;

  /**
   * 新鲜端：新数据从哪一端进来。它决定了贴边阈值、贴边校正帧数，以及贴边时
   * scrollTop 取 0 还是 scrollHeight。展示序只在构造期转换成它这一次。
   */
  private readonly edge: Edge;
  private readonly reachPx: number;

  private query: Q;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 在飞请求（单飞）：'first' 是首页请求，'backward'/'forward' 是该端续翻，null 是空闲。
   * 既是状态也是锁，见文件头规则 2。
   */
  private loading: 'first' | Edge | null = null;
  /** 在飞的首页请求，供多个入口共享同一次追平。 */
  private firstPageRun: Promise<void> | null = null;
  /**
   * 在飞的首页请求落地后要不要贴回新鲜端。
   *
   * 不能只看发起那次请求时的参数：一次不贴边的自动追平在飞时，用户点了提示条
   * （要求贴边），这次点击会被合并进在飞请求，贴边意图必须跟着并进来。
   */
  private pinOnSettle = false;
  /**
   * 窗口世代：每次首页请求发出时 +1。**所有**在飞响应都在发出时捕获它、落地时比对，
   * 不相等就整体丢弃、不触发任何回调。这是让旧响应失效的唯一机制。
   */
  private generation = 0;
  /**
   * 自动续翻被暂停的端：该端请求失败后加入，防止「失败 → 重渲 → 触界 → 立刻重试」
   * 在微任务里死循环。用户把该端滚离触界范围、显式调用 loadMore 或重新拉首页后解除。
   */
  private readonly blocked = new Set<Edge>();

  private loaded = false;
  private failure: { readonly error: unknown } | null = null;

  /** 收到过通知、还没做追平决策（输入）。 */
  private dirty = false;
  /** 需要定向刷新的身份（输入）。 */
  private readonly dirtyIds = new Set<string>();
  /** 提示条该不该亮（输出）。只有 decide() / setStale() 写它，见文件头规则 3。 */
  private stale = false;

  /**
   * 缓存的贴边状态，只有两个写入者：原生 scroll 事件（同步，早于本帧任何重排）与
   * 加载 / 贴边路径。图片异步增高之后不能现算——内容已经变高，现算必然误判成不贴边。
   */
  private stuck = true;

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

    // order='desc'（默认，新→旧，如会话）→ 新鲜端是 backward 端；order='asc'（旧→新，
    // 如消息）→ 新鲜端是 forward 端。展示序与新鲜端是同一个比特的两种说法，只转换这一次。
    this.edge = (opts.order ?? 'desc') === 'desc' ? 'backward' : 'forward';
    this.reachPx = opts.reachPx ?? DEFAULT_REACH_PX;
    this.query = opts.initialQuery as Q;
    this.window = this.createWindow();
    this.overlay = new LocalOverlay<T>(opts.pageSize);

    if (opts.selection) {
      this.selection = opts.selection.store ?? new SelectionStore(opts.selection.max);
      this.unsubscribeSelection = this.selection.subscribe(() => {
        if (this.disposed) return;
        const items = this.visibleItems();
        // 选中态影响每一行的勾选框与禁用态，所以整表重绘。
        this.paint(true, items);
        this.emitSelectionChange(items);
      });
    }

    const pillHost = opts.pillHost === undefined ? (opts.scrollElement.parentElement ?? false) : opts.pillHost;
    this.pill = createUpdatePill(pillHost, () => this.catchUp());

    this.renderer = new ListRenderer<T>({
      scrollElement: opts.scrollElement,
      reachPx: this.reachPx,
      onScrollImmediate: () => { this.stuck = this.atFreshEdge(); },
      onScroll: () => this.onScrollFrame(),
      onInteract: (identity, ev) => this.onInteract(identity, ev),
      onContentLoad: () => this.onContentLoad(),
    });

    // 'microtask' 兜底：决策必须晚于触发它的那段同步代码（调用方往往还要继续改状态）。
    this.scheduleDecide = frameScheduler(() => this.decide(), 'microtask');
    // 多 AppInstance 共存时同名列表必须各自登记到宿主的注册表，所以 register 是必填的。
    this.unregister = opts.register(this);
  }

  get id(): string {
    return this.opts.id;
  }

  // ---- 命令式接口（设计文档 §5） ----

  /** 清空窗口与本地层，重新拉首页。切换查询条件、切换会话、首次加载都走它。 */
  async reset(optsIn?: { query?: Q; pinEdge?: boolean }): Promise<void> {
    if (this.disposed) return;
    if (optsIn && Object.prototype.hasOwnProperty.call(optsIn, 'query')) this.query = optsIn.query as Q;
    await this.loadFirstPage({ clear: true, pinEdge: optsIn?.pinEdge ?? true });
  }

  /**
   * 显式续翻一页：视为用户主动重试，解除该端的自动续翻暂停。
   *
   * 生产里的续翻都由触界检测自动驱动，这个方法留给两类调用方：需要「加载更多」按钮的
   * 宿主，以及需要确定性地推进一页、不依赖滚动几何的测试。
   */
  async loadMore(edge: Edge): Promise<void> {
    if (this.disposed) return;
    this.blocked.delete(edge);
    await this.loadPage(edge);
  }

  /** 改查询条件并重拉首页；默认防抖 300ms（搜索框直接接上即可）。 */
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
   * 轻通知唯一入口：只说「有变化」，怎么追平由 `decide()` 决定。
   * 同一帧内多次调用只跑一次决策。给出 `identities` 时，落在窗口内的那些会走
   * `fetchByIdentity` 定向刷新（不重排）。
   */
  invalidate(opts?: { identities?: readonly string[] }): void {
    if (this.disposed) return;
    this.dirty = true;
    const limit = this.opts.pageSize * this.opts.maxPages;
    for (const id of opts?.identities ?? []) {
      if (this.dirtyIds.size >= limit) break;
      this.dirtyIds.add(id);
    }
    this.scheduleDecide();
  }

  /**
   * 本端写入一条：立刻以本地值渲染，并把它放到新鲜端。
   * 窗口里已有同身份时等价于「移到新鲜端并改内容」——发消息后会话置顶就是这条语义。
   */
  upsertLocal(item: T): void {
    if (this.disposed) return;
    const identity = this.opts.identityOf(item);
    // 贴边判定必须在写入之前：写入会让渲染引擎按锚点保持可见内容不动，新条目插进新鲜端
    // 之后现算必然判成「已离开新鲜端」。
    const wasAtEdge = this.atFreshEdge();
    this.overlay.put(identity, item);
    // 本地值就是最新值，不必再为它发定向刷新。
    this.dirtyIds.delete(identity);
    this.emitAll();
    // 用户本来就在新鲜端：本端写入要跟着可见，而不是把画面停在原处让新条目留在视口外。
    if (wasAtEdge) this.pinToFreshEdge();
    else this.stuck = false;
  }

  /** 本端删除一条：立刻从渲染序列消失。返回删除前它是否可见。 */
  removeLocal(id: string): boolean {
    if (this.disposed) return false;
    const visible = this.visibleItems().some((item) => this.opts.identityOf(item) === id);
    this.overlay.drop(id);
    this.dirtyIds.delete(id);
    if (visible) {
      // 只精确摘掉被删的这一个身份：共享 store 时其它实例的选中项与本次删除无关。
      this.selection?.delete(id);
    }
    this.emitAll();
    return visible;
  }

  /**
   * 宿主显式重绘：每一行都重跑 `renderItem`。
   * 宿主在行内挂了自己的监听 / 读了组件不知道的外部状态（展示名缓存、选中模式等）时
   * 需要它。组件内部的数据更新只重建真正变化的行，不重跑未变化行的 `renderItem`。
   */
  render(): void {
    this.paint(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduleDecide.cancel();
    this.overlay.clear();
    this.dirtyIds.clear();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.renderer.dispose();
    this.pill.dispose();
    this.unsubscribeSelection?.();
    this.unregister();
  }

  // ---- 只读状态（设计文档 §6） ----

  getState(): BoundedListState {
    return this.buildState(this.visibleItems());
  }

  /**
   * 渲染序列由调用方传进来，不在这里重算：一次操作往往要连着「上报序列 + 上报状态 +
   * 重绘」三件事，各自现算就是把同一份序列拼三遍（含 pinned 去重）。
   */
  private buildState(items: readonly T[]): BoundedListState {
    return {
      loaded: this.loaded,
      loading: this.loading !== null,
      loadingBackward: this.loading === 'backward',
      loadingForward: this.loading === 'forward',
      hasMoreBackward: this.window.hasMoreBackward,
      hasMoreForward: this.window.hasMoreForward,
      count: items.length,
      total: this.window.total,
      stale: this.stale,
      atFreshEdge: this.atFreshEdge(),
      failed: this.failure !== null,
    };
  }

  // ---- 数据加载 ----

  private createWindow(): PageWindow<T> {
    return new PageWindow<T>({
      maxPages: this.opts.maxPages,
      pageSize: this.opts.pageSize,
      identityOf: this.opts.identityOf,
      normalize: this.opts.normalize,
    });
  }

  /** 追平：保留当前窗口拉一次首页，落地时原子替换，所以不会闪空。重入合并。 */
  private refresh(pinEdge = false): Promise<void> {
    if (!this.firstPageRun) return this.loadFirstPage({ clear: false, pinEdge });
    // 合并到在飞的那次请求，但贴边意图要并进去，不能被它原来的参数吞掉。
    if (pinEdge) this.pinOnSettle = true;
    return this.firstPageRun;
  }

  private loadFirstPage(opts: { clear: boolean; pinEdge: boolean }): Promise<void> {
    const run = this.runFirstPage(opts);
    this.firstPageRun = run;
    return run;
  }

  /**
   * 首页请求：`reset`（clear=true，清空重建）与追平（clear=false，原地替换）唯一的
   * 区别就是这个参数。请求发出时推进世代，所以在飞的续翻会被一起作废。
   */
  private async runFirstPage({ clear, pinEdge }: { clear: boolean; pinEdge: boolean }): Promise<void> {
    const generation = ++this.generation;
    const overlayMark = this.overlay.mark();
    this.loading = 'first';
    this.pinOnSettle = pinEdge;
    this.blocked.clear();
    this.dirty = false;
    this.dirtyIds.clear();
    if (clear) {
      this.window.reset();
      this.overlay.clear();
      this.loaded = false;
      this.stale = false;
    }
    this.stuck = pinEdge || this.atFreshEdge();
    this.failure = null;
    this.emitStatus();

    try {
      const page = await this.opts.source.fetch({
        cursor: undefined,
        backward: false,
        limit: this.opts.pageSize,
        query: this.query,
      });
      if (this.isObsolete(generation)) return;
      // 先在独立窗口上落地：normalize 与超页校验都可能抛错，成功了才替换可见窗口。
      const next = this.createWindow();
      next.setFirstPage(page);
      this.window = next;
      // 这次请求之前的本地记账已被这一页覆盖，整体作废。
      this.overlay.settle(overlayMark);
      this.settleFirstPage(null);
      this.emitAll();
      if (this.pinOnSettle || this.stuck) this.pinToFreshEdge();
      else this.stuck = this.atFreshEdge();
    } catch (err) {
      if (this.isObsolete(generation)) return;
      this.settleFirstPage({ error: err });
      this.reportError(err, 'reset');
      this.emitStatus();
      // 刻意不自动重试：此刻提示条就是重试入口，等用户点击或下一次 invalidate。
    }
  }

  /** 首页请求落定：成功与失败的全部状态写入都收敛在这里，不在调用点各写一半。 */
  private settleFirstPage(failure: { readonly error: unknown } | null): void {
    this.loading = null;
    this.firstPageRun = null;
    // 失败也是一种「首屏已落定」：空态 / 错误态要能显示出来，不能永远转圈。
    this.loaded = true;
    this.failure = failure;
    // 请求期间到达的通知此前被 decide() 挡在「有请求在飞」那一支，现在重新决策一次；
    // 成功与失败走同一条路，否则失败那次会把这段时间的通知永久吞掉。
    if (this.dirty) this.scheduleDecide();
    else this.stale = false;
  }

  private async loadPage(edge: Edge): Promise<void> {
    if (this.disposed || this.loading !== null) return;
    if (!this.window.hasMore(edge)) return;
    const cursor = this.window.cursorFor(edge);
    // 空游标意味着没有可用的续翻锚点。空串不是首页语义，发出去只会让服务端按未定义
    // 行为处理，这里直接放弃。
    if (cursor === '') return;

    this.loading = edge;
    const generation = this.generation;
    this.emitStatus();

    let extended = false;
    try {
      // 组件与 wire 用的是同一套方向词汇，这里只是把 Edge 写成 SDK 的布尔参数形式。
      const page = await this.opts.source.fetch({
        cursor,
        backward: edge === 'backward',
        limit: this.opts.pageSize,
        query: this.query,
      });
      if (this.isObsolete(generation)) return;
      this.window.extend(edge, page);
      this.loading = null;
      this.blocked.delete(edge);
      extended = true;
    } catch (err) {
      if (this.isObsolete(generation)) return;
      this.loading = null;
      this.blocked.add(edge);
      this.reportError(err, edge);
    }
    if (extended) this.emitAll();
    else this.emitStatus();
    // 请求期间到达的通知在这里重新决策（此前 decide() 因为有请求在飞而直接返回）。
    if (this.dirty) this.scheduleDecide();
  }

  /**
   * 定向刷新：只把窗口内这些身份换成最新值（或删掉），不重排、不动游标。
   * 不需要任何防覆盖记账——本地写入在 overlay 里，渲染时永远盖在窗口之上。
   */
  private async refreshIdentities(): Promise<void> {
    const fetchByIdentity = this.opts.fetchByIdentity;
    const ids = [...this.dirtyIds].filter((id) => this.window.has(id));
    this.dirtyIds.clear();
    if (!fetchByIdentity || ids.length === 0) return;

    const generation = this.generation;
    try {
      const fetched = await fetchByIdentity(ids);
      if (this.isObsolete(generation)) return;
      const byIdentity = new Map(fetched.map((item) => [this.opts.identityOf(item), item] as const));
      let changed = false;
      for (const id of ids) {
        const found = byIdentity.get(id);
        // 拉不到 = 已删除。
        changed = (found ? this.window.replace(id, found) : this.window.remove(id)) || changed;
      }
      if (!changed) return;
      this.emitAll();
    } catch (err) {
      if (this.isObsolete(generation)) return;
      this.reportError(err, 'refresh');
    }
  }

  /** 某次请求的结果是否已经不适用于当前窗口（世代已推进，或组件已销毁）。 */
  private isObsolete(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  // ---- 追平决策 ----

  /**
   * 收到通知之后做什么，全组件只有这一个决策点（文件头规则 3）。
   *
   *   有请求在飞 → 什么都不做（它落地时会再叫一次），尤其不点亮提示条；
   *   列表不可见 → 只点亮提示条，等用户回来；
   *   贴着新鲜端 → 直接重拉首页追平；
   *   其它       → 点亮提示条，同时定向刷新窗口内受影响的条目（不重排，不打断浏览）。
   */
  private decide(): void {
    if (this.disposed || !this.dirty) return;
    if (this.loading !== null) return;
    if (!(this.opts.isActive?.() ?? true)) {
      this.setStale(true);
      return;
    }
    if (this.atFreshEdge()) {
      void this.refresh();
      return;
    }
    this.setStale(true);
    void this.refreshIdentities();
  }

  private setStale(value: boolean): void {
    if (this.stale === value) return;
    this.stale = value;
    this.syncPill();
    this.opts.onLoadStateChange?.(this.getState());
  }

  /** 提示条点击：贴回新鲜端并立刻追平；首屏还没成功过时提示条是重试入口。 */
  private catchUp(): void {
    if (!this.loaded) void this.reset({ pinEdge: true });
    else void this.refresh(true);
  }

  private syncPill(): void {
    // 首屏失败时提示条充当重试入口（点击即重拉）；否则才是「有更新」提示。
    if (this.failure) {
      const retryText = this.opts.text.retry?.();
      this.pill.setVisible(retryText !== undefined, retryText);
      return;
    }
    const text = this.opts.text.updatePill?.();
    // 没有提供文案就不该出现一个空白提示条。
    this.pill.setVisible(this.stale && text !== undefined, text);
  }

  // ---- 滚动与几何 ----

  /**
   * 是否贴在新鲜端。滚动几何的公式只在 `ListRenderer.distanceTo` 一处，这里只负责
   * 拿它与阈值比较；已经读过距离的调用方把值传进来，避免同一帧里重复读布局。
   */
  private atFreshEdge(distance: number = this.renderer.distanceTo(this.edge)): boolean {
    return distance <= STICKY_PX[this.edge];
  }

  private onScrollFrame(): void {
    const backwardDistance = this.renderer.distanceTo('backward');
    const forwardDistance = this.renderer.distanceTo('forward');

    // 用户把某一端滚离触界范围，说明他离开了那个失败现场：解除该端的自动续翻暂停，
    // 再滚回去时可以自然重试，既不会死循环也不需要额外的重试按钮。
    if (backwardDistance > this.reachPx) this.blocked.delete('backward');
    if (forwardDistance > this.reachPx) this.blocked.delete('forward');

    // 提示条自动消失：用户自己滚回新鲜端时重新决策，决策的结果就是追平。
    // `stuck` 不在这里写：它由原生 scroll 事件同步更新（见 onScrollImmediate），
    // 同一次滚动写两遍只会多一份「哪个才算数」的疑问。
    if (this.atFreshEdge(this.edge === 'backward' ? backwardDistance : forwardDistance) && this.dirty) {
      this.scheduleDecide();
    }
  }

  /** 图片等异步增高内容加载完成：此前贴在 forward 端（底部）新鲜端的话重新贴回去。 */
  private onContentLoad(): void {
    if (this.disposed || this.edge !== 'forward' || !this.stuck) return;
    this.pinToFreshEdge();
  }

  private pinToFreshEdge(): void {
    const el = this.opts.scrollElement;
    let remaining = SETTLE_FRAMES[this.edge];
    const settle = (): void => {
      if (this.disposed) return; // dispose 之后不再触碰宿主 DOM
      el.scrollTop = this.edge === 'backward' ? 0 : el.scrollHeight;
      this.stuck = true;
      remaining -= 1;
      if (remaining > 0) nextFrame(settle);
    };
    settle();
  }

  /**
   * 触界检测驱动的自动补页。它只有一个目的：把视口填满。
   *
   * 内容撑不满视口（含列表被隐藏、行高为 0 的宿主）时两端会被同时判定为触界；此时
   * 若窗口已经装满，补进来的一页只会把另一端等量裁掉，两端来回补页永远停不下来。
   * 这种情况直接不补——能显示的都已经显示了。用户显式 loadMore 不受此限制。
   */
  private autoLoadMore(edge: Edge): void {
    if (this.blocked.has(edge)) return;
    const el = this.opts.scrollElement;
    const full = this.window.count >= this.opts.pageSize * this.opts.maxPages;
    if (full && el.scrollHeight <= el.clientHeight) return;
    void this.loadPage(edge);
  }

  // ---- 渲染 ----

  /**
   * 当前该渲染出来的序列：`pinnedItems` 在前、权威窗口叠加本地层在后，且按身份去重。
   *
   * 去重必须在组件里做：渲染引擎按身份键协调 DOM，同一个身份出现两次会让行缓存与真实
   * DOM 静默失配。窗口是权威，pinned 里凡是已经出现过的身份一律让位（占位会话在真实
   * 条目落库后就不该继续钉在头部）。
   *
   * 渲染、点击命中、选中快照、`onItemsChanged` 共用它，保证「看到的」「点到的」
   * 「报出去的」是同一份序列和同一个顺序。
   */
  private visibleItems(): readonly T[] {
    const items = this.overlay.apply(this.window.items, this.edge, this.opts.identityOf);
    const pinned = this.opts.pinnedItems?.() ?? [];
    if (pinned.length === 0) return items;
    const seen = new Set(items.map((item) => this.opts.identityOf(item)));
    const unique: T[] = [];
    for (const item of pinned) {
      const identity = this.opts.identityOf(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      unique.push(item);
    }
    return unique.length === 0 ? items : [...unique, ...items];
  }

  private paint(rebuildRows: boolean, items: readonly T[] = this.visibleItems()): void {
    if (this.disposed) return;
    const text = this.opts.text;
    const empty = items.length === 0;
    // 没有行要渲染时不调用：beforeRender 是「为这批条目做准备」，空批次没什么可准备的。
    if (!empty) this.opts.beforeRender?.(items);
    this.renderer.render({
      items,
      loaded: this.loaded,
      hasMoreBackward: this.window.hasMoreBackward,
      hasMoreForward: this.window.hasMoreForward,
      loadingBackward: this.loading === 'backward',
      loadingForward: this.loading === 'forward',
      emptyText: empty ? text.empty?.() : undefined,
      errorText: empty && this.failure ? text.error?.(this.failure.error) : undefined,
      loadingText: text.loading?.(),
      backwardBoundaryText: text.backwardBoundary?.(),
      forwardBoundaryText: text.forwardBoundary?.(),
      loadMore: (edge) => this.autoLoadMore(edge),
      renderItem: (item, index) => this.renderRow(item, index, items),
      keyOf: (item) => this.opts.identityOf(item),
      reuseUnchangedRows: !rebuildRows,
      revisionOf: (item, index) => this.rowRevision(item, index, items),
    });
    this.syncPill();
  }

  private renderRow(item: T, index: number, items: readonly T[]): readonly HTMLElement[] {
    const identity = this.opts.identityOf(item);
    const ctx: RenderItemContext<T> = {
      identity,
      ...this.selectionFlags(identity),
      previous: index > 0 ? items[index - 1] : undefined,
    };
    return this.opts.renderItem(item, ctx);
  }

  /**
   * 会影响 renderItem 输出、但不在条目自身数据里的上下文签名。
   *
   * 刻意不含行下标：下标会随头部插页整体平移，一旦入签名，插一页就让整窗口失去复用、
   * 每一行都重跑 renderItem。需要在渲染前按整批数据做一次准备的调用方用 `beforeRender`。
   *
   * 分隔符用 `\u0000`：身份串里可能含任何可打印字符，只有 NUL 一定不会出现，
   * 拼接后不会有两组不同取值撞成同一个签名。
   */
  private rowRevision(item: T, index: number, items: readonly T[]): string {
    const previousIdentity = index > 0 ? this.opts.identityOf(items[index - 1]) : '';
    const { selected, selectable } = this.selectionFlags(this.opts.identityOf(item));
    return `${previousIdentity}\u0000${selected ? 1 : 0}\u0000${selectable ? 1 : 0}`;
  }

  /** 某个身份当前的选中态：渲染与 revision 共用同一份判定，避免各改一半。 */
  private selectionFlags(identity: string): { selected: boolean; selectable: boolean } {
    return {
      selected: this.selection?.has(identity) ?? false,
      selectable: this.selection ? !this.selection.isExceeded(identity) : true,
    };
  }

  // ---- 交互与事件 ----

  private onInteract(identity: string, ev: Event): void {
    const item = this.visibleItems().find((candidate) => this.opts.identityOf(candidate) === identity);
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
    // 多选无论从复选框还是行内其它区域触发，都统一走 toggle 的上限检查，
    // 不能让点击区域差异绕过 max。
    if (this.selection.toggle(identity) === 'rejected') this.opts.selection!.onExceed?.();
  }

  // ---- 对外上报 ----
  //
  // 渲染序列只在这里算一次，然后串给「上报序列 / 上报状态 / 重绘」三件事。
  // 它们本来就该看到同一份序列，各自现算既慢又给了三者不一致的机会。

  /** 序列变了：上报序列 + 上报状态 + 重绘。 */
  private emitAll(items: readonly T[] = this.visibleItems()): void {
    this.opts.onItemsChanged?.(items);
    this.emitStatus(items);
  }

  /** 序列没变、只是加载态变了：上报状态 + 重绘。 */
  private emitStatus(items: readonly T[] = this.visibleItems()): void {
    this.opts.onLoadStateChange?.(this.buildState(items));
    this.paint(false, items);
  }

  private emitSelectionChange(items: readonly T[]): void {
    if (!this.selection || !this.opts.onSelectionChange) return;
    const ids = this.selection.snapshotIds();
    // 顺序与去重都与渲染保持一致：同一份渲染序列。
    const selected = items.filter((item) => ids.has(this.opts.identityOf(item)));
    this.opts.onSelectionChange({ ids, count: ids.size, items: selected });
  }

  private reportError(err: unknown, phase: ErrorPhase): void {
    if (this.opts.onError) this.opts.onError(err, phase);
    else console.warn(`[BoundedList:${this.opts.id}] ${phase} 失败`, err);
  }
}

export function createBoundedList<T, Q = void>(options: BoundedListOptions<T, Q>): BoundedList<T, Q> {
  return new BoundedList(options);
}
