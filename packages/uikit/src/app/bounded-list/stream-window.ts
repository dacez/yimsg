// BoundedList 的渲染引擎：有界窗口内真实 DOM + 有键协调（设计方案 §2.4、§7.3）。
//
// 相比旧版 packages/uikit/src/app/bounded-stream-window.ts，本版补齐了设计方案 §4.6 / §4.3
// 要求、但旧版完全缺失的能力：
// - dispose()：注销全部监听（含 window 级 pointerup/pointercancel 兜底），修掉 §3.4 ①
//   「弹窗每开一次泄漏两个 window 级监听」的内存泄漏；
// - 事件委托 click 与 keydown 键盘导航（↑/↓ 移动焦点、Enter/Space 激活、到达窗口边缘触发翻页），
//   统一走 onInteract 回调，业务语义（onActivate / onSelectionChange 的判定）由上层 BoundedList 决定；
// - contentElement 上的 load 捕获监听（图片等异步增高内容加载完成的回调），由上层决定要不要贴底。
//
// 其余渲染语义（先读后改、锚点保持、边界提示、指针按下期间推迟协调）与旧版一致，
// 原理与宿主约束见 packages/uikit/docs/boundedlist/生产集成.md。

export const DEFAULT_REACH_PX = 160;

export interface BoundedStreamWindowOptions {
  readonly scrollElement: HTMLElement;
  readonly contentElement?: HTMLElement;
  readonly reachPx?: number;
  /** 原生 scroll 事件到达时同步执行，供上层在下一帧前缓存用户是否仍贴边。 */
  readonly onScrollImmediate?: () => void;
  /** 每个滚动帧（触界检测之前）执行的回调。 */
  readonly onScroll?: () => void;
  /**
   * 用户「激活」某一行：点击（事件委托）或键盘 Enter/Space。
   * identity 由 keyOf 提供；viaKeyboard 区分来源，供上层判断是否需要 preventDefault 之外的行为。
   */
  readonly onInteract?: (identity: string, ev: Event, viaKeyboard: boolean) => void;
  /** contentElement 内部任意元素 load 事件（捕获阶段），用于图片异步增高时的贴底判断。 */
  readonly onContentLoad?: () => void;
}

export interface BoundedStreamWindowRenderState<T> {
  readonly items: ReadonlyArray<T>;
  readonly loaded?: boolean;
  readonly hasMoreBefore?: boolean;
  readonly hasMoreAfter?: boolean;
  readonly loadingBefore?: boolean;
  readonly loadingAfter?: boolean;
  readonly emptyText?: string;
  /** 首屏加载失败时代替空态显示；提供时优先于 emptyText。 */
  readonly errorText?: string;
  readonly loadingText?: string;
  readonly topBoundaryText?: string;
  readonly bottomBoundaryText?: string;
  readonly loadBefore?: () => void;
  readonly loadAfter?: () => void;
  readonly renderItem: (item: T, index: number) => ReadonlyArray<HTMLElement>;
  readonly keyOf: (item: T, index: number) => string;
  /** 内部数据更新可跳过未变化行的 renderItem；显式重绘时保持 false。 */
  readonly reuseUnchangedRows?: boolean;
  /** 会影响 renderItem 输出、但不在 item 本身里的上下文签名。 */
  readonly revisionOf?: (item: T, index: number) => unknown;
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

export const ANCHOR_KEY_ATTR = 'data-bsw-key';
export const INTERACTION_KEY_ATTR = 'data-bsw-interact-key';
const FOCUS_CLASS = 'bsw-row-focused';

function valuesEquivalent(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const remembered = seen.get(left);
  if (remembered) return remembered === right;
  seen.set(left, right);

  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    if (left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return leftBytes.every((value, index) => value === rightBytes[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => valuesEquivalent(value, right[index], seen));
  }
  const prototype = Object.getPrototypeOf(left);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key)
      && valuesEquivalent(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        seen,
      ));
}

function nodesEquivalent(left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean {
  return left.length === right.length
    && left.every((node, index) => node.isEqualNode?.(right[index]) ?? false);
}

export function createFrameScheduler(callback: () => void): (() => void) & { cancel: () => void } {
  let scheduled = false;
  // token 而非直接 cancelAnimationFrame：一旦 cancel 递增 token，即使已经排队的
  // rAF 回调后续真的触发，run() 发现 token 已经不匹配也会安全地跳过，不依赖
  // 环境是否真正支持取消（fake DOM 测试环境里 rAF 只是把回调塞进数组，并不
  // 响应 cancelAnimationFrame）。
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
      return;
    }
    run();
  };
  schedule.cancel = () => {
    scheduled = false;
    token += 1;
  };
  return schedule;
}

/**
 * 「背景有更新 + 贴边缘追平」的统一契约（设计方案 §5.3 路径①）。
 */
export function catchUpAtEdge(
  hasPendingUpdate: () => boolean,
  isAtEdge: () => boolean,
  catchUp: () => void | Promise<void>,
): void {
  if (hasPendingUpdate() && isAtEdge()) void catchUp();
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

export class BoundedStreamWindow<T> {
  private lastState: BoundedStreamWindowRenderState<T> | null = null;
  private renderedRows = new Map<string, RenderedRow<T>>();
  private pointerActive = false;
  private pendingRender = false;
  private disposed = false;
  private focusedIndex = -1;
  private focusedKey: string | null = null;

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
    const content = this.contentElement();
    const key = findKeyFromTarget(ev.target, content);
    if (key) this.options.onInteract?.(key, ev, false);
  };
  private readonly handleKeydown = (ev: KeyboardEvent) => this.onKeydown(ev);
  private readonly handleContentLoad = () => this.options.onContentLoad?.();

  private readonly windowRef: (Window & typeof globalThis) | undefined;

  constructor(private readonly options: BoundedStreamWindowOptions) {
    this.onScrollFrame = createFrameScheduler(() => {
      if (this.disposed) return;
      this.options.onScroll?.();
      this.checkReach();
    });
    options.scrollElement.addEventListener('scroll', this.handleScroll);

    // 指针按下期间不重建 DOM：整列表 innerHTML 重建会销毁鼠标按下的那一行节点，
    // 使 mouseup 落到新节点上，浏览器因「按下与抬起不在同一节点」而不再派发 click，
    // 点击被「吃掉」。这里把按下期间请求的重渲染积压下来，待指针抬起后的下一帧再应用。
    this.flushPending = createFrameScheduler(() => {
      if (this.disposed || !this.pendingRender || !this.lastState) return;
      this.applyRender(this.lastState);
    });
    options.scrollElement.addEventListener('pointerdown', this.handlePointerDown);
    options.scrollElement.addEventListener('pointerup', this.handlePointerRelease);
    options.scrollElement.addEventListener('pointercancel', this.handlePointerRelease);
    // 指针可能在列表之外抬起：在 window 上兜底监听释放（fake DOM 无 defaultView 时跳过）。
    // 这两个监听必须在 dispose() 里移除，否则每次开关弹窗都会永久保留一个实例（§3.4 ①）。
    this.windowRef = options.scrollElement.ownerDocument?.defaultView ?? undefined;
    this.windowRef?.addEventListener?.('pointerup', this.handlePointerRelease);
    this.windowRef?.addEventListener?.('pointercancel', this.handlePointerRelease);

    this.contentElement().addEventListener('click', this.handleClick);
    options.scrollElement.addEventListener('keydown', this.handleKeydown as EventListener);
    this.contentElement().addEventListener('load', this.handleContentLoad, true);
  }

  private contentElement(): HTMLElement {
    return this.options.contentElement ?? this.options.scrollElement;
  }

  render(state: BoundedStreamWindowRenderState<T>): void {
    if (this.disposed) return;
    this.lastState = state;
    if (this.pointerActive) { this.pendingRender = true; return; }
    this.applyRender(state);
  }

  private applyRender(state: BoundedStreamWindowRenderState<T>): void {
    this.pendingRender = false;
    const scroller = this.options.scrollElement;
    const content = this.contentElement();
    const doc = content.ownerDocument;
    const scrollOffset = scroller.scrollTop;
    const anchor = this.captureAnchor(content);
    if (this.focusedKey !== null) {
      const identityIndex = state.items.findIndex(
        (item, index) => state.keyOf(item, index) === this.focusedKey,
      );
      if (identityIndex >= 0) {
        this.focusedIndex = identityIndex;
      } else {
        // 原身份已被裁掉时才退化为最近的合法下标，避免整帧丢失键盘高亮。
        this.focusedIndex = Math.min(this.focusedIndex, state.items.length - 1);
        this.focusedKey = this.focusedIndex >= 0
          ? state.keyOf(state.items[this.focusedIndex], this.focusedIndex)
          : null;
      }
    } else if (this.focusedIndex >= state.items.length) {
      this.focusedIndex = state.items.length - 1;
    }
    if (!(state.loaded ?? true)) {
      this.renderedRows.clear();
      this.reconcileNodes(
        content,
        state.loadingText ? [createBoundaryHint(doc, state.loadingText, 'bottom')] : [],
      );
      return;
    }
    if (state.items.length === 0) {
      const placeholderText = state.errorText ?? state.emptyText;
      const nextElements: HTMLElement[] = [];
      if (placeholderText) {
        const placeholder = doc.createElement('div');
        placeholder.className = state.errorText !== undefined ? 'list-error-state' : 'empty-state';
        placeholder.textContent = placeholderText;
        nextElements.push(placeholder);
      }
      this.renderedRows.clear();
      this.reconcileNodes(content, nextElements);
      this.focusedIndex = -1;
      this.focusedKey = null;
      // 空列表同样要做触界检测：服务端可能返回「空页但还有更多」（around 锚点加载
      // 的乐观策略、全过滤命中为空等），不检测就会永久定格在空态。
      this.checkReach();
      return;
    }

    const desiredElements: HTMLElement[] = [];
    const nextRenderedRows = new Map<string, RenderedRow<T>>();
    if (!state.hasMoreBefore && state.topBoundaryText) {
      desiredElements.push(createBoundaryHint(doc, state.topBoundaryText, 'top'));
    } else if (state.loadingBefore && state.loadingText) {
      desiredElements.push(createBoundaryHint(doc, state.loadingText, 'top'));
    }

    for (let index = 0; index < state.items.length; index++) {
      const item = state.items[index];
      const key = state.keyOf(item, index);
      const revision = state.revisionOf?.(item, index);
      const previous = this.renderedRows.get(key);
      const previousAttached = previous
        && previous.elements.every((element) => element.parentElement === content);
      if (
        state.reuseUnchangedRows
        && previousAttached
        && valuesEquivalent(previous.item, item)
        && valuesEquivalent(previous.revision, revision)
      ) {
        desiredElements.push(...previous.elements);
        nextRenderedRows.set(key, { item, elements: previous.elements, revision });
        continue;
      }
      const candidateElements = [...state.renderItem(item, index)];
      if (candidateElements.length > 0) {
        candidateElements[0].setAttribute(ANCHOR_KEY_ATTR, key);
        if (key === this.focusedKey) candidateElements[0].classList?.add(FOCUS_CLASS);
      }
      for (const element of candidateElements) {
        element.setAttribute(INTERACTION_KEY_ATTR, key);
      }
      const canReuse = previous
        && previousAttached
        // BoundedList 的内部数据更新统一通过身份键委托交互；即使服务端快照含有
        // UI 不使用的字段差异，只要候选 DOM 完全一致，就不能把整行换掉。
        // 显式 render() 仍保留更保守的条目等价检查，供宿主刷新行内自有监听。
        && (state.reuseUnchangedRows || valuesEquivalent(previous.item, item))
        && nodesEquivalent(previous.elements, candidateElements);
      const elements = canReuse ? previous.elements : candidateElements;
      desiredElements.push(...elements);
      nextRenderedRows.set(key, { item, elements, revision });
    }

    if (!state.hasMoreAfter && state.bottomBoundaryText) {
      desiredElements.push(createBoundaryHint(doc, state.bottomBoundaryText, 'bottom'));
    } else if (state.loadingAfter && state.loadingText) {
      desiredElements.push(createBoundaryHint(doc, state.loadingText, 'bottom'));
    }

    this.reconcileNodes(content, desiredElements);
    this.renderedRows = nextRenderedRows;
    if (scroller.scrollTop !== scrollOffset) scroller.scrollTop = scrollOffset;
    if (anchor) this.restoreAnchor(content, anchor);
    this.checkReach();
  }

  private reconcileNodes(content: HTMLElement, desired: readonly HTMLElement[]): void {
    for (let index = 0; index < desired.length; index++) {
      const current = content.children[index] as HTMLElement | undefined;
      if (current === desired[index]) continue;
      content.insertBefore(desired[index], current ?? null);
    }
    while (content.children.length > desired.length) {
      content.removeChild(content.children[content.children.length - 1]);
    }
  }

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

  /** 把某个身份的行滚进视口；返回是否找到该行。 */
  scrollToKey(key: string, block: 'center' | 'nearest' = 'nearest'): boolean {
    const content = this.contentElement();
    const scroller = this.options.scrollElement;
    for (const child of Array.from(content.children) as HTMLElement[]) {
      if (child.getAttribute?.(ANCHOR_KEY_ATTR) !== key) continue;
      if (typeof child.getBoundingClientRect !== 'function') return true;
      const rowRect = child.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (block === 'center') {
        scroller.scrollTop += (rowRect.top - scrollerRect.top) - (scroller.clientHeight / 2 - (rowRect.bottom - rowRect.top) / 2);
      } else if (rowRect.top < scrollerRect.top) {
        scroller.scrollTop -= scrollerRect.top - rowRect.top;
      } else if (rowRect.bottom > scrollerRect.bottom) {
        scroller.scrollTop += rowRect.bottom - scrollerRect.bottom;
      }
      return true;
    }
    return false;
  }

  /** 用户是否贴在 edge 一端（stickyPx 阈值内）。 */
  isAtEdge(edge: 'head' | 'tail', stickyPx: number): boolean {
    const el = this.options.scrollElement;
    if (edge === 'head') return el.scrollTop <= stickyPx;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    return maxScrollTop - el.scrollTop <= stickyPx;
  }

  private checkReach(): void {
    const state = this.lastState;
    if (!state || !(state.loaded ?? true)) return;
    const el = this.options.scrollElement;
    const reachPx = this.options.reachPx ?? DEFAULT_REACH_PX;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop <= reachPx && state.hasMoreBefore) state.loadBefore?.();
    if (maxScrollTop - el.scrollTop <= reachPx && state.hasMoreAfter) state.loadAfter?.();
  }

  private onKeydown(ev: KeyboardEvent): void {
    const state = this.lastState;
    if (!state || state.items.length === 0) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const dir = ev.key === 'ArrowDown' ? 1 : -1;
      const next = this.focusedIndex < 0 ? (dir > 0 ? 0 : state.items.length - 1) : this.focusedIndex + dir;
      if (next < 0) {
        state.loadBefore?.();
        return;
      }
      if (next >= state.items.length) {
        state.loadAfter?.();
        return;
      }
      this.focusedIndex = next;
      this.focusedKey = state.keyOf(state.items[next], next);
      ev.preventDefault?.();
      this.updateFocusClass();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      if (this.focusedIndex < 0 || this.focusedIndex >= state.items.length) return;
      ev.preventDefault?.();
      const key = this.focusedKey
        ?? state.keyOf(state.items[this.focusedIndex], this.focusedIndex);
      this.options.onInteract?.(key, ev, true);
    }
  }

  private updateFocusClass(): void {
    for (const [key, row] of this.renderedRows) {
      const first = row.elements[0];
      if (!first?.classList) continue;
      if (key === this.focusedKey) first.classList.add(FOCUS_CLASS);
      else first.classList.remove(FOCUS_CLASS);
    }
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
    scroller.removeEventListener('keydown', this.handleKeydown as EventListener);
    this.windowRef?.removeEventListener?.('pointerup', this.handlePointerRelease);
    this.windowRef?.removeEventListener?.('pointercancel', this.handlePointerRelease);
    const content = this.contentElement();
    content.removeEventListener('click', this.handleClick);
    content.removeEventListener('load', this.handleContentLoad, true);
    this.lastState = null;
    this.renderedRows.clear();
    this.pendingRender = false;
    this.focusedIndex = -1;
    this.focusedKey = null;
  }
}
