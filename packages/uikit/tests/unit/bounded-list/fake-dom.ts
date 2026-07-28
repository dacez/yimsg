// bounded-list 测试专用的最小化 fake DOM：仓库测试环境是 vitest 的 node 环境（无 jsdom），
// 所有列表渲染测试都靠手写的 fake element 驱动（与 uikit-bounded-stream-window.test.ts 一致）。
// 这里补上 bounded-list 需要的能力：classList、parentElement、事件的增删（用于验证 dispose
// 真的移除了监听，不只是「不再触发」）、getBoundingClientRect（锚点/滚动测试）、fake window。

export interface FakeRect {
  top: number;
  bottom: number;
}

interface ListenerEntry {
  handler: (ev: any) => void;
  capture: boolean;
}

export class FakeClassList {
  constructor(private readonly el: FakeElement) {}

  private tokens(): string[] {
    return this.el.className.split(' ').filter(Boolean);
  }

  add(cls: string): void {
    const set = new Set(this.tokens());
    set.add(cls);
    this.el.className = [...set].join(' ');
  }

  remove(cls: string): void {
    const set = new Set(this.tokens());
    set.delete(cls);
    this.el.className = [...set].join(' ');
  }

  toggle(cls: string, force?: boolean): void {
    const has = this.contains(cls);
    const want = force === undefined ? !has : force;
    if (want) this.add(cls); else this.remove(cls);
  }

  contains(cls: string): boolean {
    return this.tokens().includes(cls);
  }
}

export class FakeElement {
  className = '';
  private text = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 120;
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ListenerEntry[]>();
  readonly classList = new FakeClassList(this);
  rect: FakeRect = { top: 0, bottom: 0 };

  constructor(public readonly ownerDocument: FakeDocument) {}

  get innerHTML(): string {
    return this.children.length ? '<rendered>' : '';
  }

  set innerHTML(value: string) {
    if (value !== '') return;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentElement = null;
    return child;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, handler: (ev: any) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this.listeners.get(type) ?? [];
    list.push({ handler, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (ev: any) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((entry) => entry.handler !== handler || entry.capture !== capture));
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, ...extra };
    for (const entry of [...(this.listeners.get(type) ?? [])]) entry.handler(ev);
  }

  getBoundingClientRect() {
    return { top: this.rect.top, bottom: this.rect.bottom, left: 0, right: 0, height: this.rect.bottom - this.rect.top, width: 0 };
  }
}

export class FakeWindow {
  readonly listeners = new Map<string, ListenerEntry[]>();

  addEventListener(type: string, handler: (ev: any) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this.listeners.get(type) ?? [];
    list.push({ handler, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (ev: any) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((entry) => entry.handler !== handler || entry.capture !== capture));
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  dispatch(type: string): void {
    for (const entry of [...(this.listeners.get(type) ?? [])]) entry.handler({ type });
  }
}

export class FakeDocument {
  readonly defaultView: FakeWindow | null;

  /** withView=false 模拟 `ownerDocument.defaultView` 为 null 的宿主（detached document / 某些嵌入环境）。 */
  constructor(options: { withView?: boolean } = {}) {
    this.defaultView = options.withView === false ? null : new FakeWindow();
  }

  createElement(_tag?: string): FakeElement {
    return new FakeElement(this);
  }
}

/** 取 fake window（默认构造的 FakeDocument 一定有；withView:false 的文档不应调用本函数）。 */
export function viewOf(doc: FakeDocument): FakeWindow {
  if (!doc.defaultView) throw new Error('该 FakeDocument 没有 defaultView');
  return doc.defaultView;
}

/**
 * 去掉元素的 getBoundingClientRect，模拟「拿不到布局信息」的宿主环境
 * （渲染引擎的锚点、scrollToKey 都对此有显式降级分支）。
 */
export function stripBoundingRect(el: FakeElement): FakeElement {
  Object.defineProperty(el, 'getBoundingClientRect', { value: undefined, configurable: true });
  return el;
}

/** 取出某个元素上已注册的某类监听器（用于「注销之后仍被残留调用」这类白盒断言）。 */
export function capturedListeners(el: FakeElement, type: string): Array<(ev: any) => void> {
  return (el.listeners.get(type) ?? []).map((entry) => entry.handler);
}

export function createScroller(doc: FakeDocument = new FakeDocument()): FakeElement {
  return doc.createElement();
}

export function asElement<T = HTMLElement>(fake: FakeElement): T {
  return fake as unknown as T;
}

export function asDoc(fake: FakeDocument): Document {
  return fake as unknown as Document;
}

export function row(doc: FakeDocument, className = 'row'): FakeElement {
  const el = doc.createElement();
  el.className = className;
  return el;
}
