// 统一分页列表视图引擎（渲染层）。
//
// 设计取舍（详见 packages/uikit/docs/有界消息流窗口设计方案.md）：
// - 所有列表共用同一种渲染模式：有界窗口全量渲染。数据窗口本身有上限
//   （bounded-page-window.ts 按整页裁剪到 maxPages），flatten 后的全部条目都进真实 DOM，
//   滚动零重建，行高永远是浏览器布局的真实值——无窗口切片、无 spacer、无行高配置、无估算校正。
// - 滚动条不要求精确反映完整数据集，滚动空间只代表「已加载窗口」；到顶 / 到底用轻量文字提示，
//   未加载数据只由 hasMoreBefore / hasMoreAfter 表达。
// - 引擎统一持有 scroll 监听、触顶 / 触底加载触发、空态 / 加载态 / 边界提示与 scrollTop
//   先读后清恢复，调用方只负责数据与单行渲染。

/** 触顶 / 触底加载触发阈值（px）。 */
const REACH_THRESHOLD_PX = 160;

export interface BoundedStreamWindowOptions {
  /** 原生滚动容器；引擎只监听 scroll，不接管 wheel/touchmove。 */
  readonly scrollElement: HTMLElement;
  /** 内容容器；未传时与 scrollElement 相同（通讯录两个 tab 共用滚动容器时分开传）。 */
  readonly contentElement?: HTMLElement;
  /** 每个滚动帧（触界检测之前）执行的回调，供「列表有更新」贴顶追平等场景使用。 */
  readonly onScroll?: () => void;
}

export interface BoundedStreamWindowRenderState<T> {
  readonly items: ReadonlyArray<T>;
  /** false 表示首屏数据尚未加载，只显示 loadingText。默认 true。 */
  readonly loaded?: boolean;
  readonly hasMoreBefore?: boolean;
  readonly hasMoreAfter?: boolean;
  readonly loadingBefore?: boolean;
  readonly loadingAfter?: boolean;
  readonly emptyText?: string;
  readonly loadingText?: string;
  /** 没有更早数据时固定显示在列表头部的边界提示。 */
  readonly topBoundaryText?: string;
  /** 没有更新数据时固定显示在列表尾部的边界提示。 */
  readonly bottomBoundaryText?: string;
  readonly loadBefore?: () => void;
  readonly loadAfter?: () => void;
  readonly renderItem: (item: T, index: number) => ReadonlyArray<HTMLElement>;
  /**
   * 每个条目的稳定标识。提供后引擎在重渲染时保持「视口顶部第一条可见条目」相对视口顶的
   * 偏移不变（双向翻页头部插入 / 尾部裁剪时画面不跳）；不提供则只做 scrollTop 数值恢复。
   */
  readonly keyOf?: (item: T, index: number) => string;
}

interface ScrollAnchor {
  readonly key: string;
  readonly delta: number;
}

const ANCHOR_KEY_ATTR = 'data-bsw-key';

export function createFrameScheduler(callback: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      callback();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => run());
      return;
    }
    run();
  };
}

export function getOrCreateBoundedStreamWindow<TOwner extends object, T>(
  cache: WeakMap<TOwner, BoundedStreamWindow<T>>,
  owner: TOwner,
  factory: () => BoundedStreamWindow<T>,
): BoundedStreamWindow<T> {
  let view = cache.get(owner);
  if (!view) {
    view = factory();
    cache.set(owner, view);
  }
  return view;
}

function createBoundaryHint(ownerDocument: Document, text: string, kind: 'top' | 'bottom'): HTMLElement {
  const hint = ownerDocument.createElement('div');
  hint.className = `list-boundary-hint list-boundary-hint-${kind}`;
  hint.textContent = text;
  return hint;
}

export class BoundedStreamWindow<T> {
  private lastState: BoundedStreamWindowRenderState<T> | null = null;
  // 指针是否正按在列表上（按下到抬起期间为 true）。
  private pointerActive = false;
  // 指针按下期间是否积压了未应用的重渲染请求。
  private pendingRender = false;
  private readonly flushPending: () => void;

  constructor(private readonly options: BoundedStreamWindowOptions) {
    const onScrollFrame = createFrameScheduler(() => {
      this.options.onScroll?.();
      this.checkReach();
    });
    options.scrollElement.addEventListener('scroll', onScrollFrame);

    // 指针按下期间不重建 DOM：整列表 innerHTML 重建会销毁鼠标按下的那一行节点，
    // 使 mouseup 落到新节点上，浏览器因「按下与抬起不在同一节点」而不再派发 click，
    // 点击被「吃掉」。初始同步阶段后台刷新频繁重建列表时尤为明显（表现为「刚打开点不动，
    // 过一会儿才行」）。这里把按下期间请求的重渲染积压下来，待指针抬起后的下一帧再应用：
    // click 在 pointerup 之后、下一帧之前同步派发，因此仍落在存活的原节点上，点击不再失效。
    this.flushPending = createFrameScheduler(() => {
      if (this.pendingRender && this.lastState) this.applyRender(this.lastState);
    });
    options.scrollElement.addEventListener('pointerdown', () => { this.pointerActive = true; });
    const release = () => {
      if (!this.pointerActive) return;
      this.pointerActive = false;
      if (this.pendingRender) this.flushPending();
    };
    options.scrollElement.addEventListener('pointerup', release);
    options.scrollElement.addEventListener('pointercancel', release);
    // 指针可能在列表之外抬起：在 window 上兜底监听释放（fake DOM 无 defaultView 时跳过）。
    const view = options.scrollElement.ownerDocument?.defaultView;
    view?.addEventListener?.('pointerup', release);
    view?.addEventListener?.('pointercancel', release);
  }

  render(state: BoundedStreamWindowRenderState<T>): void {
    this.lastState = state;
    // 指针按下期间推迟 DOM 重建，避免销毁正被点击的行节点（见构造函数注释）。
    if (this.pointerActive) { this.pendingRender = true; return; }
    this.applyRender(state);
  }

  private applyRender(state: BoundedStreamWindowRenderState<T>): void {
    this.pendingRender = false;
    const scroller = this.options.scrollElement;
    const content = this.options.contentElement ?? scroller;
    const doc = content.ownerDocument;
    // 先读后清：innerHTML='' 会把 scrollTop 夹回 0，必须先保存再恢复；
    // 提供 keyOf 时还要在清空前记录锚点（视口顶部第一条可见条目）。
    const scrollOffset = scroller.scrollTop;
    const anchor = state.keyOf ? this.captureAnchor(content) : null;
    content.innerHTML = '';

    if (!(state.loaded ?? true)) {
      if (state.loadingText) content.appendChild(createBoundaryHint(doc, state.loadingText, 'bottom'));
      return;
    }
    if (state.items.length === 0) {
      if (state.emptyText) {
        const empty = doc.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = state.emptyText;
        content.appendChild(empty);
      }
      return;
    }

    if (!state.hasMoreBefore && state.topBoundaryText) {
      content.appendChild(createBoundaryHint(doc, state.topBoundaryText, 'top'));
    } else if (state.loadingBefore && state.loadingText) {
      content.appendChild(createBoundaryHint(doc, state.loadingText, 'top'));
    }

    for (let index = 0; index < state.items.length; index++) {
      const elements = state.renderItem(state.items[index], index);
      if (state.keyOf && elements.length > 0) {
        elements[0].setAttribute(ANCHOR_KEY_ATTR, state.keyOf(state.items[index], index));
      }
      for (const element of elements) {
        content.appendChild(element);
      }
    }

    if (!state.hasMoreAfter && state.bottomBoundaryText) {
      content.appendChild(createBoundaryHint(doc, state.bottomBoundaryText, 'bottom'));
    } else if (state.loadingAfter && state.loadingText) {
      content.appendChild(createBoundaryHint(doc, state.loadingText, 'bottom'));
    }

    if (scroller.scrollTop !== scrollOffset) scroller.scrollTop = scrollOffset;
    if (anchor) this.restoreAnchor(content, anchor);
    this.checkReach();
  }

  // 记录视口顶部第一条可见条目相对视口顶的偏移；全量渲染下 DOM 位置即真实布局，单次读取即可。
  private captureAnchor(content: HTMLElement): ScrollAnchor | null {
    if (typeof content.getBoundingClientRect !== 'function') return null;
    const top = this.options.scrollElement.getBoundingClientRect().top;
    for (const child of Array.from(content.children) as HTMLElement[]) {
      const key = child.getAttribute?.(ANCHOR_KEY_ATTR);
      if (!key) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > top) return { key, delta: rect.top - top };
    }
    return null;
  }

  private restoreAnchor(content: HTMLElement, anchor: ScrollAnchor): void {
    if (typeof content.getBoundingClientRect !== 'function') return;
    for (const child of Array.from(content.children) as HTMLElement[]) {
      if (child.getAttribute?.(ANCHOR_KEY_ATTR) !== anchor.key) continue;
      const scroller = this.options.scrollElement;
      scroller.scrollTop += child.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.delta;
      return;
    }
  }

  /**
   * 触顶 / 触底检测：距边界 REACH_THRESHOLD_PX 内且仍有更多时触发加载。
   * 内容不足一屏时也会触发（链式补页直到填满视窗或没有更多）。
   * 这里只用 hasMore 快照粗滤；并发与终止守卫由加载回调自身的实时
   * loading / hasMore 状态承担（快照在回调修改状态后、下次 render 前会过期）。
   */
  private checkReach(): void {
    const state = this.lastState;
    if (!state || !(state.loaded ?? true)) return;
    const el = this.options.scrollElement;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop <= REACH_THRESHOLD_PX && state.hasMoreBefore) {
      state.loadBefore?.();
    }
    if (maxScrollTop - el.scrollTop <= REACH_THRESHOLD_PX && state.hasMoreAfter) {
      state.loadAfter?.();
    }
  }
}
