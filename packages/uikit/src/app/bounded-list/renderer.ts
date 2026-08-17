// 渲染引擎：把一份「该显示成什么样」的快照落到真实 DOM 上，并把用户交互抛回上层。
//
// 只做三件事，不认识分页、通知、选中态：
// 1. 有键协调：按 identity 复用行 DOM，只插入 / 移动 / 删除真正变化的节点；
// 2. 滚动保持：协调前后按锚点行校正 scrollTop，头部插页时内容不跳；
// 3. 事件：滚动帧、触界检测、点击激活、内容异步增高。
//
// 本层自持全部 DOM 监听（scroll / pointer* / click / load），调用方不要再挂；
// dispose() 必须注销**全部**监听，尤其是 window 级的 pointerup / pointercancel 兜底
// （指针可能在列表之外抬起），漏掉会让每开一次弹窗就永久泄漏两个监听。

import { frameScheduler } from './frame';
import { valuesEquivalent } from './deep-equal';
import type { Edge } from './types';

/** 距某一端多少像素以内算「触界」的默认阈值。 */
export const DEFAULT_REACH_PX = 160;

export interface ListRendererOptions {
  readonly scrollElement: HTMLElement;
  /**
   * 触界阈值；负值等价于「关掉自动补页」（没有任何距端距离能落进负的范围）。
   * 由上层解析好默认值后传入，本层不再兜第二次底。
   */
  readonly reachPx: number;
  /** 原生 scroll 事件到达时同步执行，供上层在下一帧前缓存用户是否仍贴边。 */
  readonly onScrollImmediate?: () => void;
  /** 每个滚动帧（触界检测之前）执行的回调。 */
  readonly onScroll?: () => void;
  /** 用户点击某一行（事件委托）。 */
  readonly onInteract?: (identity: string, ev: Event) => void;
  /** 列表内部任意元素 load 事件（捕获阶段），用于图片异步增高后的贴边校正。 */
  readonly onContentLoad?: () => void;
}

export interface ListRenderState<T> {
  readonly items: readonly T[];
  /** false = 首屏还没落定，显示加载文案而不是空态。 */
  readonly loaded: boolean;
  /** 该端还能不能续翻：同时驱动触界自动补页和「没有更多了」边界提示。 */
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly loadingBackward: boolean;
  readonly loadingForward: boolean;
  readonly emptyText?: string;
  /** 首屏加载失败时代替 emptyText 显示。 */
  readonly errorText?: string;
  readonly loadingText?: string;
  readonly backwardBoundaryText?: string;
  readonly forwardBoundaryText?: string;
  readonly loadMore: (edge: Edge) => void;
  readonly renderItem: (item: T, index: number) => readonly HTMLElement[];
  readonly keyOf: (item: T) => string;
  /** 内部数据更新可跳过未变化行的 renderItem；宿主显式重绘时传 false。 */
  readonly reuseUnchangedRows: boolean;
  /** 会影响 renderItem 输出、但不在 item 本身里的上下文签名。 */
  readonly revisionOf: (item: T, index: number) => unknown;
}

interface ScrollAnchor {
  readonly key: string;
  readonly delta: number;
}

interface RenderedRow<T> {
  readonly item: T;
  readonly elements: readonly HTMLElement[];
  readonly revision: unknown;
}

// 两个属性名只在本模块内写入 DOM，不对外导出：调用方（含测试）通过属性选择器
// `[data-bsw-key]` 定位节点，从不 import 常量本身。
const ANCHOR_KEY_ATTR = 'data-bsw-key';
const INTERACTION_KEY_ATTR = 'data-bsw-interact-key';

function nodesEquivalent(left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean {
  return left.length === right.length
    && left.every((node, index) => node.isEqualNode?.(right[index]) ?? false);
}

function createBoundaryHint(ownerDocument: Document, text: string, kind: 'top' | 'bottom'): HTMLElement {
  const hint = ownerDocument.createElement('div');
  hint.className = `list-boundary-hint list-boundary-hint-${kind}`;
  hint.textContent = text;
  return hint;
}

function findKeyFromTarget(target: EventTarget | null, boundary: HTMLElement): string | null {
  let node = target as (HTMLElement & { parentElement?: HTMLElement | null }) | null;
  while (node && node !== boundary) {
    const attr = (node as unknown as { getAttribute?: (name: string) => string | null }).getAttribute;
    const key = attr ? attr.call(node, INTERACTION_KEY_ATTR) : null;
    if (key) return key;
    node = node.parentElement ?? null;
  }
  return null;
}

export class ListRenderer<T> {
  private lastState: ListRenderState<T> | null = null;
  private renderedRows = new Map<string, RenderedRow<T>>();
  private pointerActive = false;
  private pendingRender = false;
  private disposed = false;

  private readonly flushPending: (() => void) & { cancel: () => void };
  private readonly onScrollFrame: (() => void) & { cancel: () => void };
  private readonly handleScroll = () => {
    if (this.disposed) return;
    this.options.onScrollImmediate?.();
    this.onScrollFrame();
  };
  private readonly handlePointerDown = () => { this.pointerActive = true; };
  private readonly handlePointerRelease = () => {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.pendingRender) this.flushPending();
  };
  private readonly handleClick = (ev: Event) => {
    const key = findKeyFromTarget(ev.target, this.options.scrollElement);
    if (key) this.options.onInteract?.(key, ev);
  };
  private readonly handleContentLoad = () => this.options.onContentLoad?.();

  private readonly windowRef: (Window & typeof globalThis) | undefined;

  constructor(private readonly options: ListRendererOptions) {
    this.onScrollFrame = frameScheduler(() => {
      if (this.disposed) return;
      this.options.onScroll?.();
      this.checkReach();
    });
    // 指针按下期间不重建 DOM：整列表重建会销毁鼠标按下的那一行节点，使 mouseup 落到
    // 新节点上，浏览器因「按下与抬起不在同一节点」而不再派发 click，点击被吃掉。
    // 这里把按下期间请求的重渲染积压下来，待指针抬起后的下一帧再应用。
    this.flushPending = frameScheduler(() => {
      if (this.disposed || !this.pendingRender || !this.lastState) return;
      this.applyRender(this.lastState);
    });

    const scroller = options.scrollElement;
    scroller.addEventListener('scroll', this.handleScroll);
    scroller.addEventListener('pointerdown', this.handlePointerDown);
    scroller.addEventListener('pointerup', this.handlePointerRelease);
    scroller.addEventListener('pointercancel', this.handlePointerRelease);
    scroller.addEventListener('click', this.handleClick);
    scroller.addEventListener('load', this.handleContentLoad, true);
    // 指针可能在列表之外抬起：在 window 上兜底监听释放（fake DOM 无 defaultView 时跳过）。
    this.windowRef = scroller.ownerDocument?.defaultView ?? undefined;
    this.windowRef?.addEventListener?.('pointerup', this.handlePointerRelease);
    this.windowRef?.addEventListener?.('pointercancel', this.handlePointerRelease);
  }

  render(state: ListRenderState<T>): void {
    if (this.disposed) return;
    this.lastState = state;
    if (this.pointerActive) {
      this.pendingRender = true;
      return;
    }
    this.applyRender(state);
  }

  /**
   * 当前滚动位置距 edge 一端还有多少像素（贴住该端时为 0）。
   * 列表自上而下按展示序渲染，所以 backward 端就是视觉上的顶部、forward 端是底部。
   *
   * 「贴边」「触界」都只是拿这个距离与不同阈值比较，所以滚动几何在整个组件里只有这
   * 一处公式；上层要判贴边就用它比 STICKY_PX，本层要判触界就用它比 reachPx。
   */
  distanceTo(edge: Edge): number {
    const el = this.options.scrollElement;
    if (edge === 'backward') return el.scrollTop;
    return Math.max(0, el.scrollHeight - el.clientHeight) - el.scrollTop;
  }

  /** 注销全部监听（含 window 级 pointer 兜底）、清空状态；调用后其它方法均为空操作。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onScrollFrame.cancel();
    this.flushPending.cancel();
    const scroller = this.options.scrollElement;
    scroller.removeEventListener('scroll', this.handleScroll);
    scroller.removeEventListener('pointerdown', this.handlePointerDown);
    scroller.removeEventListener('pointerup', this.handlePointerRelease);
    scroller.removeEventListener('pointercancel', this.handlePointerRelease);
    scroller.removeEventListener('click', this.handleClick);
    scroller.removeEventListener('load', this.handleContentLoad, true);
    this.windowRef?.removeEventListener?.('pointerup', this.handlePointerRelease);
    this.windowRef?.removeEventListener?.('pointercancel', this.handlePointerRelease);
    this.lastState = null;
    this.renderedRows.clear();
    this.pendingRender = false;
  }

  private applyRender(state: ListRenderState<T>): void {
    this.pendingRender = false;
    const scroller = this.options.scrollElement;
    const doc = scroller.ownerDocument;
    const scrollOffset = scroller.scrollTop;
    const anchor = this.captureAnchor();

    if (!state.loaded) {
      this.renderedRows.clear();
      this.reconcileNodes(state.loadingText ? [createBoundaryHint(doc, state.loadingText, 'bottom')] : []);
      return;
    }
    if (state.items.length === 0) {
      const placeholderText = state.errorText ?? state.emptyText;
      const next: HTMLElement[] = [];
      if (placeholderText) {
        const placeholder = doc.createElement('div');
        placeholder.className = state.errorText !== undefined ? 'list-error-state' : 'empty-state';
        placeholder.textContent = placeholderText;
        next.push(placeholder);
      }
      this.renderedRows.clear();
      this.reconcileNodes(next);
      // 空列表同样要做触界检测：服务端可能返回「空页但还有更多」（锚点加载的乐观策略、
      // 全过滤命中为空等），不检测就会永久定格在空态。
      this.checkReach();
      return;
    }

    const desired: HTMLElement[] = [];
    const nextRows = new Map<string, RenderedRow<T>>();
    if (!state.hasMoreBackward && state.backwardBoundaryText) {
      desired.push(createBoundaryHint(doc, state.backwardBoundaryText, 'top'));
    } else if (state.loadingBackward && state.loadingText) {
      desired.push(createBoundaryHint(doc, state.loadingText, 'top'));
    }

    for (let index = 0; index < state.items.length; index++) {
      const item = state.items[index];
      const key = state.keyOf(item);
      const revision = state.revisionOf(item, index);
      const previous = this.renderedRows.get(key);
      const attached = previous?.elements.every((element) => element.parentElement === scroller) ?? false;
      if (
        state.reuseUnchangedRows
        && attached
        && valuesEquivalent(previous!.item, item)
        && valuesEquivalent(previous!.revision, revision)
      ) {
        desired.push(...previous!.elements);
        nextRows.set(key, { item, elements: previous!.elements, revision });
        continue;
      }
      const candidates = [...state.renderItem(item, index)];
      if (candidates.length > 0) candidates[0].setAttribute(ANCHOR_KEY_ATTR, key);
      for (const element of candidates) element.setAttribute(INTERACTION_KEY_ATTR, key);
      // 内部数据更新统一按身份键委托交互；即使数据里含有 UI 不使用的字段差异，只要候选
      // DOM 完全一致就不换行。显式重绘保留更保守的条目等价检查，供宿主刷新行内自有监听。
      const canReuse = attached
        && (state.reuseUnchangedRows || valuesEquivalent(previous!.item, item))
        && nodesEquivalent(previous!.elements, candidates);
      const elements = canReuse ? previous!.elements : candidates;
      desired.push(...elements);
      nextRows.set(key, { item, elements, revision });
    }

    if (!state.hasMoreForward && state.forwardBoundaryText) {
      desired.push(createBoundaryHint(doc, state.forwardBoundaryText, 'bottom'));
    } else if (state.loadingForward && state.loadingText) {
      desired.push(createBoundaryHint(doc, state.loadingText, 'bottom'));
    }

    this.reconcileNodes(desired);
    this.renderedRows = nextRows;
    // 滚动位置只由一套机制负责，两者是「精确」与「兜底」的关系，不叠加：
    // - 有锚点：按锚点行的真实位移校正。头部插页时这是唯一正确的做法，恢复渲染前的
    //   绝对 scrollTop 反而会让内容整体跳动。
    // - 没有锚点（空列表、首屏、宿主 DOM 不支持 getBoundingClientRect）：退回绝对值，
    //   把 DOM 协调过程中被浏览器夹回 0 的 scrollTop 还原。
    if (anchor) this.restoreAnchor(anchor);
    else if (scroller.scrollTop !== scrollOffset) scroller.scrollTop = scrollOffset;
    this.checkReach();
  }

  private reconcileNodes(desired: readonly HTMLElement[]): void {
    const content = this.options.scrollElement;
    for (let index = 0; index < desired.length; index++) {
      const current = content.children[index] as HTMLElement | undefined;
      if (current === desired[index]) continue;
      content.insertBefore(desired[index], current ?? null);
    }
    while (content.children.length > desired.length) {
      content.removeChild(content.children[content.children.length - 1]);
    }
  }

  private captureAnchor(): ScrollAnchor | null {
    const scroller = this.options.scrollElement;
    if (typeof scroller.getBoundingClientRect !== 'function') return null;
    const top = scroller.getBoundingClientRect().top;
    for (const child of Array.from(scroller.children) as HTMLElement[]) {
      const key = child.getAttribute?.(ANCHOR_KEY_ATTR);
      if (!key) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > top) return { key, delta: rect.top - top };
    }
    return null;
  }

  private restoreAnchor(anchor: ScrollAnchor): void {
    const scroller = this.options.scrollElement;
    if (typeof scroller.getBoundingClientRect !== 'function') return;
    for (const child of Array.from(scroller.children) as HTMLElement[]) {
      if (child.getAttribute?.(ANCHOR_KEY_ATTR) !== anchor.key) continue;
      scroller.scrollTop += child.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.delta;
      return;
    }
  }

  private checkReach(): void {
    const state = this.lastState;
    if (!state || !state.loaded) return;
    const reachPx = this.options.reachPx;
    if (state.hasMoreBackward && this.distanceTo('backward') <= reachPx) state.loadMore('backward');
    if (state.hasMoreForward && this.distanceTo('forward') <= reachPx) state.loadMore('forward');
  }
}
