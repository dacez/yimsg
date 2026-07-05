import { describe, expect, it, vi } from 'vitest';
import {
  createFrameScheduler,
  getOrCreateBoundedStreamWindow,
  BoundedStreamWindow,
} from '../../src/uikit/app/bounded-stream-window';

interface FakeElement {
  className: string;
  textContent: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  children: FakeElement[];
  ownerDocument: unknown;
  innerHTML: string;
  attributes: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  appendChild(child: FakeElement): FakeElement;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, handler: () => void): void;
  dispatch(type: string): void;
}

function createFakeElement(): FakeElement {
  let innerHTML = '';
  const element: FakeElement = {
    className: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 120,
    children: [],
    ownerDocument: null,
    attributes: new Map(),
    listeners: new Map(),
    get innerHTML() { return innerHTML; },
    set innerHTML(value: string) {
      innerHTML = value;
      if (value === '') element.children.length = 0;
    },
    appendChild(child: FakeElement) {
      element.children.push(child);
      return child;
    },
    setAttribute(name: string, value: string) {
      element.attributes.set(name, value);
    },
    getAttribute(name: string) {
      return element.attributes.get(name) ?? null;
    },
    addEventListener(type: string, handler: () => void) {
      const handlers = element.listeners.get(type) ?? [];
      handlers.push(handler);
      element.listeners.set(type, handlers);
    },
    dispatch(type: string) {
      for (const handler of element.listeners.get(type) ?? []) handler();
    },
  };
  return element;
}

function createFakeDocument() {
  return { createElement: () => createFakeElement() };
}

function createScroller(): FakeElement {
  const scroller = createFakeElement();
  scroller.ownerDocument = createFakeDocument();
  return scroller;
}

function asElement(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}

function row(): ReadonlyArray<HTMLElement> {
  const el = createFakeElement();
  el.className = 'row';
  return [asElement(el)] as unknown as ReadonlyArray<HTMLElement>;
}

function renderedClassNames(content: FakeElement): string[] {
  return content.children.map(child => child.className);
}

describe('BoundedStreamWindow 全量渲染', () => {
  it('渲染全部条目，不插入 spacer', () => {
    const scroller = createScroller();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });

    view.render({
      items: ['a', 'b', 'c'],
      renderItem: (item) => {
        const el = createFakeElement();
        el.className = `row-${item}`;
        return [asElement(el)] as unknown as ReadonlyArray<HTMLElement>;
      },
    });
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('提供 keyOf 时给每个条目的首元素打锚点标识', () => {
    const scroller = createScroller();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });

    view.render({
      items: ['a', 'b'],
      keyOf: (item) => `k-${item}`,
      renderItem: () => row(),
    });
    expect(scroller.children.map(c => c.getAttribute('data-bsw-key'))).toEqual(['k-a', 'k-b']);
  });

  it('渲染时保持 scrollTop 先读后清恢复', () => {
    const scroller = createScroller();
    scroller.scrollTop = 200;
    const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller) });
    Object.defineProperty(scroller, 'innerHTML', {
      set() { scroller.scrollTop = 0; scroller.children.length = 0; },
      get() { return ''; },
      configurable: true,
    });
    view.render({ items: [1, 2, 3], renderItem: () => row() });
    expect(scroller.scrollTop).toBe(200);
  });

  it('滚动经帧合并后调用 onScroll 与触界检测', () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.push(() => cb(0)); return callbacks.length; });
    try {
      const scroller = createScroller();
      scroller.clientHeight = 120;
      scroller.scrollHeight = 120;
      const onScroll = vi.fn();
      const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller), onScroll });
      const loadBefore = vi.fn();
      view.render({ items: [1, 2, 3], hasMoreBefore: true, loadBefore, renderItem: () => row() });
      loadBefore.mockClear();

      scroller.dispatch('scroll');
      scroller.dispatch('scroll');
      expect(onScroll).not.toHaveBeenCalled();
      callbacks.splice(0).forEach(cb => cb());
      expect(onScroll).toHaveBeenCalledTimes(1);
      expect(loadBefore).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('BoundedStreamWindow 状态与边界提示', () => {
  it('未加载只显示 loading 提示；空列表显示空态', () => {
    const scroller = createScroller();
    const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller) });

    view.render({ items: [], loaded: false, loadingText: '加载中', renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['list-boundary-hint list-boundary-hint-bottom']);
    expect(scroller.children[0].textContent).toBe('加载中');

    view.render({ items: [], emptyText: '暂无数据', renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['empty-state']);
    expect(scroller.children[0].textContent).toBe('暂无数据');
  });

  it('没有更多时渲染顶部 / 底部边界提示，加载中渲染 loading 提示', () => {
    const scroller = createScroller();
    const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller) });

    view.render({
      items: [1],
      hasMoreBefore: false,
      hasMoreAfter: false,
      topBoundaryText: '已到最早',
      bottomBoundaryText: '已到最新',
      renderItem: () => row(),
    });
    expect(renderedClassNames(scroller)[0]).toBe('list-boundary-hint list-boundary-hint-top');
    expect(renderedClassNames(scroller)[2]).toBe('list-boundary-hint list-boundary-hint-bottom');

    view.render({
      items: [1],
      hasMoreBefore: true,
      hasMoreAfter: true,
      loadingBefore: true,
      loadingAfter: true,
      loadingText: '加载中',
      topBoundaryText: '已到最早',
      bottomBoundaryText: '已到最新',
      renderItem: () => row(),
    });
    expect(scroller.children[0].textContent).toBe('加载中');
    expect(scroller.children[scroller.children.length - 1].textContent).toBe('加载中');
  });

  it('触顶 / 触底且仍有更多时触发加载；没有更多时不触发', () => {
    const scroller = createScroller();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller) });
    const loadBefore = vi.fn();
    const loadAfter = vi.fn();

    view.render({
      items: [1, 2, 3],
      hasMoreBefore: true,
      hasMoreAfter: true,
      loadBefore,
      loadAfter,
      renderItem: () => row(),
    });
    expect(loadBefore).toHaveBeenCalledTimes(1);
    expect(loadAfter).toHaveBeenCalledTimes(1);

    view.render({
      items: [1, 2, 3],
      hasMoreBefore: false,
      hasMoreAfter: false,
      loadBefore,
      loadAfter,
      renderItem: () => row(),
    });
    expect(loadBefore).toHaveBeenCalledTimes(1);
    expect(loadAfter).toHaveBeenCalledTimes(1);
  });
});

describe('BoundedStreamWindow 指针按下期间不重建（避免吃掉点击）', () => {
  function rowItem(item: string): ReadonlyArray<HTMLElement> {
    const el = createFakeElement();
    el.className = `row-${item}`;
    return [asElement(el)] as unknown as ReadonlyArray<HTMLElement>;
  }

  it('指针按下期间到达的重渲染被推迟，原行节点保持存活；抬起后下一帧才应用最新状态', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const scroller = createScroller();
      const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });

      view.render({ items: ['a', 'b'], renderItem: rowItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      // 用户按住某一行准备点击。
      scroller.dispatch('pointerdown');

      // 按下期间的后台刷新（初始同步等）不得重建 DOM：
      // 否则 mousedown 的行节点被销毁，mouseup 落到新节点，浏览器不再派发 click。
      view.render({ items: ['a', 'b', 'c'], renderItem: rowItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      // 抬起：积压的重建被安排到下一帧。click 在 pointerup 之后、下一帧之前同步派发，
      // 落在仍然存活的原节点上，点击不再失效。
      scroller.dispatch('pointerup');
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      // 下一帧应用最新状态。
      frames.splice(0).forEach(cb => cb());
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('指针在列表外取消（pointercancel）同样会冲刷积压的重渲染', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const scroller = createScroller();
      const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
      view.render({ items: ['a'], renderItem: rowItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], renderItem: rowItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a']);
      scroller.dispatch('pointercancel');
      frames.splice(0).forEach(cb => cb());
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('指针未按下时正常立即重建（不影响常规渲染路径）', () => {
    const scroller = createScroller();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
    view.render({ items: ['a'], renderItem: rowItem });
    view.render({ items: ['a', 'b'], renderItem: rowItem });
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
  });
});

describe('getOrCreateBoundedStreamWindow', () => {
  it('对同一 owner 复用同一实例', () => {
    const cache = new WeakMap<object, BoundedStreamWindow<string>>();
    const owner = {};
    const factory = vi.fn(() => new BoundedStreamWindow<string>({ scrollElement: asElement(createScroller()) }));
    expect(getOrCreateBoundedStreamWindow(cache, owner, factory)).toBe(getOrCreateBoundedStreamWindow(cache, owner, factory));
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('createFrameScheduler', () => {
  it('同一帧内合并多次调用', () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.push(() => cb(0)); return callbacks.length; });
    try {
      const fn = vi.fn();
      const schedule = createFrameScheduler(fn);
      schedule();
      schedule();
      expect(fn).not.toHaveBeenCalled();
      callbacks.splice(0).forEach(cb => cb());
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
