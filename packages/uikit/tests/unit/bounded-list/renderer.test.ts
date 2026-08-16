// ListRenderer（渲染引擎）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.4：
//   A 有键协调 / B 状态与边界提示 / C 触界检测 / D 锚点 / E 贴边判定
//   F 指针期间推迟重建 / G 点击委托 / I 内容 load / J 释放。

import { describe, expect, it, vi } from 'vitest';
import { ListRenderer, DEFAULT_REACH_PX, type ListRenderState } from '../../../src/app/bounded-list/renderer';
import {
  FakeDocument,
  asElement,
  capturedListeners,
  row,
  stripBoundingRect,
  viewOf,
  type FakeElement,
} from './fake-dom';

function classNames(content: FakeElement): string[] {
  return content.children.map((c) => c.className);
}

function makeView(overrides: Partial<{
  onScroll: () => void;
  onScrollImmediate: () => void;
  onInteract: (id: string, ev: any) => void;
  onContentLoad: () => void;
  doc: FakeDocument;
}> = {}) {
  const doc = overrides.doc ?? new FakeDocument();
  const scroller = doc.createElement();
  const view = new ListRenderer<string>({
    scrollElement: asElement(scroller),
    onScroll: overrides.onScroll,
    onScrollImmediate: overrides.onScrollImmediate,
    onInteract: overrides.onInteract,
    onContentLoad: overrides.onContentLoad,
  });
  return { doc, scroller, view };
}

/** 渲染状态的默认值：用例只写自己关心的字段。 */
function state(doc: FakeDocument, overrides: Partial<ListRenderState<string>> = {}): ListRenderState<string> {
  return {
    items: [],
    loaded: true,
    hasMoreHead: false,
    hasMoreTail: false,
    loadingHead: false,
    loadingTail: false,
    loadMore: () => {},
    renderItem: (item: string) => [asElement(row(doc, `row-${item}`))],
    keyOf: (item: string) => `k-${item}`,
    reuseUnchangedRows: true,
    revisionOf: () => 0,
    ...overrides,
  };
}

/** 把 requestAnimationFrame 换成手动可控的帧队列。 */
function withFrames(fn: (frames: { run: () => void; size: () => number }) => void): void {
  const queue: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(() => cb(0)); return queue.length; });
  try {
    fn({ run: () => queue.splice(0).forEach((cb) => cb()), size: () => queue.length });
  } finally {
    vi.unstubAllGlobals();
  }
}

// ───────────────────────── A 有键协调 ─────────────────────────

describe('ListRenderer / A 有键协调', () => {
  it('A1 渲染全部条目并打上锚点键与交互键', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { items: ['a', 'b', 'c'] }));

    expect(classNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    expect(scroller.children.map((c) => c.getAttribute('data-bsw-key'))).toEqual(['k-a', 'k-b', 'k-c']);
    expect(scroller.children.map((c) => c.getAttribute('data-bsw-interact-key'))).toEqual(['k-a', 'k-b', 'k-c']);
  });

  it('A2 一行由多个平级元素组成时全部插入，锚点唯一、每个根节点都带交互键', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, {
      items: ['a'],
      renderItem: (item) => [asElement(row(doc, `label-${item}`)), asElement(row(doc, `row-${item}`))],
    }));

    expect(classNames(scroller)).toEqual(['label-a', 'row-a']);
    expect(scroller.children.map((c) => c.getAttribute('data-bsw-key'))).toEqual(['k-a', null]);
    expect(scroller.children.every((c) => c.getAttribute('data-bsw-interact-key') === 'k-a')).toBe(true);
  });

  it('A3 renderItem 返回空数组时该条目不产生任何节点', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { items: ['a'], renderItem: () => [] }));
    expect(scroller.children).toHaveLength(0);
  });

  it('A4 数据与 revision 都没变时复用原节点，不重跑 renderItem', () => {
    const { doc, scroller, view } = makeView();
    const renderItem = vi.fn((item: string) => [asElement(row(doc, `row-${item}`))]);
    view.render(state(doc, { items: ['a', 'b'], renderItem }));
    const before = [...scroller.children];
    view.render(state(doc, { items: ['a', 'b'], renderItem }));

    expect(scroller.children).toEqual(before);
    expect(renderItem).toHaveBeenCalledTimes(2);
  });

  it('A5 revision 变化时该行重跑 renderItem', () => {
    const { doc, scroller, view } = makeView();
    const renderItem = vi.fn((item: string) => [asElement(row(doc, `row-${item}`))]);
    view.render(state(doc, { items: ['a'], renderItem, revisionOf: () => 'v1' }));
    view.render(state(doc, { items: ['a'], renderItem, revisionOf: () => 'v2' }));

    expect(renderItem).toHaveBeenCalledTimes(2);
    expect(classNames(scroller)).toEqual(['row-a']);
  });

  it('A6 只替换真正变化的条目，未变化的兄弟保持节点身份', () => {
    const { doc, scroller, view } = makeView();
    let bLabel = 'b1';
    const render = () => view.render(state(doc, {
      items: ['a', 'b'],
      reuseUnchangedRows: false,
      renderItem: (item) => [asElement(row(doc, item === 'b' ? `row-${bLabel}` : `row-${item}`))],
    }));
    render();
    const firstRow = scroller.children[0];
    bLabel = 'b2';
    render();

    expect(scroller.children[0]).toBe(firstRow);
    expect(classNames(scroller)).toEqual(['row-a', 'row-b2']);
  });

  it('A7 显式重绘（reuseUnchangedRows=false）时条目数据变化即使 DOM 一致也换节点', () => {
    const { doc, scroller, view } = makeView();
    const renderItem = () => [asElement(row(doc, 'row-fixed'))];
    view.render(state(doc, { items: ['a'], renderItem, reuseUnchangedRows: false }));
    const before = scroller.children[0];
    view.render(state(doc, { items: ['a2'], keyOf: () => 'k-a', renderItem, reuseUnchangedRows: false }));

    expect(scroller.children[0]).not.toBe(before);
  });

  it('A8 渲染前后 scrollTop 被夹回 0 时显式恢复', () => {
    const { doc, scroller, view } = makeView();
    scroller.scrollTop = 300;
    view.render(state(doc, { items: ['a'] }));
    expect(scroller.scrollTop).toBe(300);
  });

  it('A9 大窗口一次性渲染，节点数与条目数严格一致', () => {
    const { doc, scroller, view } = makeView();
    const items = Array.from({ length: 1000 }, (_, i) => `i${i}`);
    view.render(state(doc, { items }));
    expect(scroller.children).toHaveLength(1000);
  });
});

// ───────────────────────── B 状态与边界提示 ─────────────────────────

describe('ListRenderer / B 状态与边界提示', () => {
  it('B1 未加载时只显示 loading，优先于空态', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { loaded: false, loadingText: '加载中', emptyText: '暂无数据' }));

    expect(classNames(scroller)).toEqual(['list-boundary-hint list-boundary-hint-bottom']);
    expect(scroller.children[0].textContent).toBe('加载中');
  });

  it('B2 空列表显示空态；没有文案时渲染成完全空的容器', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { emptyText: '暂无数据' }));
    expect(classNames(scroller)).toEqual(['empty-state']);

    view.render(state(doc, {}));
    expect(scroller.children).toHaveLength(0);
  });

  it('B3 errorText 提供时用错误态代替空态', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { emptyText: '暂无数据', errorText: '加载失败' }));

    expect(classNames(scroller)).toEqual(['list-error-state']);
    expect(scroller.children[0].textContent).toBe('加载失败');
  });

  it('B4 两端提示与条目的相对顺序固定为 [头部提示, ...条目, 尾部提示]', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, {
      items: ['a'],
      headBoundaryText: '到顶了',
      tailBoundaryText: '到底了',
    }));

    expect(classNames(scroller)).toEqual([
      'list-boundary-hint list-boundary-hint-top',
      'row-a',
      'list-boundary-hint list-boundary-hint-bottom',
    ]);
  });

  it('B5 该端还有更多时不显示边界提示；正在加载则显示 loading', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, {
      items: ['a'],
      hasMoreHead: true,
      loadingHead: true,
      loadingText: '加载中',
      headBoundaryText: '到顶了',
    }));

    expect(scroller.children[0].textContent).toBe('加载中');
  });
});

// ───────────────────────── C 触界检测 ─────────────────────────

describe('ListRenderer / C 触界检测', () => {
  it('C1 触顶 / 触底且该端仍有更多时触发续翻', () => {
    const { doc, scroller, view } = makeView();
    const loadMore = vi.fn();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 1000;
    scroller.scrollTop = DEFAULT_REACH_PX - 1;
    view.render(state(doc, { items: ['a'], hasMoreHead: true, hasMoreTail: true, loadMore }));
    expect(loadMore.mock.calls.map((c) => c[0])).toEqual(['head']);

    loadMore.mockClear();
    scroller.scrollTop = 900 - (DEFAULT_REACH_PX - 1);
    view.render(state(doc, { items: ['a'], hasMoreHead: true, hasMoreTail: true, loadMore }));
    expect(loadMore.mock.calls.map((c) => c[0])).toEqual(['tail']);
  });

  it('C1b 两端都在触界范围之外时都不触发', () => {
    const { doc, scroller, view } = makeView();
    const loadMore = vi.fn();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 10000;
    scroller.scrollTop = 5000;
    view.render(state(doc, { items: ['a'], hasMoreHead: true, hasMoreTail: true, loadMore }));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('C2 该端没有更多时不触发', () => {
    const { doc, scroller, view } = makeView();
    const loadMore = vi.fn();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 1000;
    scroller.scrollTop = 0;
    view.render(state(doc, { items: ['a'], loadMore }));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('C3 内容不足一屏时两端都视为已触界', () => {
    const { doc, scroller, view } = makeView();
    const loadMore = vi.fn();
    scroller.clientHeight = 500;
    scroller.scrollHeight = 100;
    view.render(state(doc, { items: ['a'], hasMoreHead: true, hasMoreTail: true, loadMore }));
    expect(loadMore.mock.calls.map((c) => c[0])).toEqual(['head', 'tail']);
  });

  it('C4 未加载时不做触界检测', () => {
    const { doc, view } = makeView();
    const loadMore = vi.fn();
    view.render(state(doc, { loaded: false, hasMoreTail: true, loadMore }));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('C5 空列表但仍有更多时照样补页，不会永远定格在空态', () => {
    const { doc, view } = makeView();
    const loadMore = vi.fn();
    view.render(state(doc, { items: [], hasMoreTail: true, loadMore }));
    expect(loadMore.mock.calls.map((c) => c[0])).toEqual(['tail']);
  });

  it('C6 滚动经帧合并后先回调 onScroll 再做触界检测', () => {
    withFrames((frames) => {
      const order: string[] = [];
      const { doc, scroller, view } = makeView({ onScroll: () => order.push('scroll') });
      scroller.clientHeight = 100;
      scroller.scrollHeight = 1000;
      view.render(state(doc, { items: ['a'], hasMoreHead: true, loadMore: () => order.push('load') }));
      order.length = 0;

      scroller.dispatch('scroll');
      scroller.dispatch('scroll');
      frames.run();
      expect(order).toEqual(['scroll', 'load']);
    });
  });

  it('C7 从未 render 过就滚动时安全返回', () => {
    const { scroller } = makeView();
    expect(() => scroller.dispatch('scroll')).not.toThrow();
  });
});

// ───────────────────────── D 锚点 ─────────────────────────

describe('ListRenderer / D 锚点', () => {
  /** 模拟一次重排：把当前已在 DOM 里的行整体下移 delta。 */
  function shiftRows(scroller: FakeElement, delta: number): void {
    for (const child of scroller.children) {
      child.rect = { top: child.rect.top + delta, bottom: child.rect.bottom + delta };
    }
  }

  it('D1 头部插入后锚点行相对视口顶的偏移不变', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { items: ['b', 'c'] }));
    scroller.rect = { top: 0, bottom: 100 };
    scroller.children[0].rect = { top: 10, bottom: 30 };
    scroller.children[1].rect = { top: 30, bottom: 50 };
    scroller.scrollTop = 100;

    // 头部插入一行 20px：已有行整体下移 20，锚点校正应把 scrollTop 加 20。
    view.render(state(doc, {
      items: ['a', 'b', 'c'],
      renderItem: (item) => {
        if (item === 'a') shiftRows(scroller, 20);
        const el = row(doc, `row-${item}`);
        el.rect = { top: 10, bottom: 30 };
        return [asElement(el)];
      },
    }));
    expect(scroller.scrollTop).toBe(120);
  });

  it('D2 锚点取「底边仍在视口顶以下」的第一条，完全滚过去的不做锚点', () => {
    const { doc, scroller, view } = makeView();
    view.render(state(doc, { items: ['a', 'b'] }));
    scroller.rect = { top: 0, bottom: 100 };
    scroller.children[0].rect = { top: -40, bottom: -20 }; // a 已完全滚过
    scroller.children[1].rect = { top: -20, bottom: 10 };  // b 还露着，它才是锚点
    scroller.scrollTop = 50;

    view.render(state(doc, {
      items: ['a', 'b', 'c'],
      renderItem: (item) => {
        if (item === 'c') shiftRows(scroller, 10);
        return [asElement(row(doc, `row-${item}`))];
      },
    }));
    expect(scroller.scrollTop).toBe(60);
  });

  it('D3 宿主拿不到布局信息时锚点整体降级为不校正，不抛错', () => {
    const doc = new FakeDocument();
    const scroller = stripBoundingRect(doc.createElement());
    const view = new ListRenderer<string>({ scrollElement: asElement(scroller) });
    scroller.scrollTop = 42;

    expect(() => view.render(state(doc, { items: ['a'] }))).not.toThrow();
    expect(scroller.scrollTop).toBe(42);
  });
});

// ───────────────────────── E 贴边判定 ─────────────────────────

describe('ListRenderer / E isAtEdge', () => {
  it('E1 head 端看 scrollTop，tail 端看距底距离', () => {
    const { scroller, view } = makeView();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 1000;

    scroller.scrollTop = 4;
    expect(view.isAtEdge('head', 4)).toBe(true);
    expect(view.isAtEdge('head', 3)).toBe(false);

    scroller.scrollTop = 860;
    expect(view.isAtEdge('tail', 40)).toBe(true);
    expect(view.isAtEdge('tail', 39)).toBe(false);
  });

  it('E2 内容不足一屏时两端都判定为贴边', () => {
    const { scroller, view } = makeView();
    scroller.clientHeight = 500;
    scroller.scrollHeight = 100;
    expect(view.isAtEdge('head', 0)).toBe(true);
    expect(view.isAtEdge('tail', 0)).toBe(true);
  });
});

// ───────────────────────── F 指针期间推迟重建 ─────────────────────────

describe('ListRenderer / F 指针期间推迟重建', () => {
  it('F1 按下期间的重渲染被积压，抬起后下一帧才应用最后一次状态', () => {
    withFrames((frames) => {
      const { doc, scroller, view } = makeView();
      view.render(state(doc, { items: ['a'] }));
      scroller.dispatch('pointerdown');

      view.render(state(doc, { items: ['a', 'b'] }));
      view.render(state(doc, { items: ['a', 'b', 'c'] }));
      expect(classNames(scroller)).toEqual(['row-a']);

      scroller.dispatch('pointerup');
      frames.run();
      expect(classNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    });
  });

  it('F2 指针在列表之外抬起时同样冲刷积压（window 兜底监听）', () => {
    withFrames((frames) => {
      const { doc, scroller, view } = makeView();
      view.render(state(doc, { items: ['a'] }));
      scroller.dispatch('pointerdown');
      view.render(state(doc, { items: ['a', 'b'] }));

      viewOf(doc).dispatch('pointercancel');
      frames.run();
      expect(classNames(scroller)).toEqual(['row-a', 'row-b']);
    });
  });

  it('F3 没有按下就收到抬起事件时是空操作', () => {
    withFrames((frames) => {
      const { doc, scroller, view } = makeView();
      view.render(state(doc, { items: ['a'] }));
      scroller.dispatch('pointerup');
      expect(frames.size()).toBe(0);
    });
  });
});

// ───────────────────────── G 点击委托 ─────────────────────────

describe('ListRenderer / G 点击委托', () => {
  it('G1 点击行内嵌套元素沿 parentElement 上溯到该行身份', () => {
    const onInteract = vi.fn();
    const { doc, scroller, view } = makeView({ onInteract });
    view.render(state(doc, { items: ['a'] }));

    const inner = doc.createElement();
    scroller.children[0].appendChild(inner);
    scroller.dispatch('click', { target: inner });

    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything());
  });

  it('G2 点击落在任何行之外时不回调', () => {
    const onInteract = vi.fn();
    const { doc, scroller, view } = makeView({ onInteract });
    view.render(state(doc, { items: ['a'] }));

    scroller.dispatch('click', { target: scroller });
    expect(onInteract).not.toHaveBeenCalled();
  });
});

// ───────────────────────── I 内容 load ─────────────────────────

describe('ListRenderer / I 内容异步增高', () => {
  it('I1 列表内的 load 事件（捕获阶段）回调上层', () => {
    const onContentLoad = vi.fn();
    const { scroller } = makeView({ onContentLoad });
    scroller.dispatch('load');
    expect(onContentLoad).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── J 释放 ─────────────────────────

describe('ListRenderer / J 释放', () => {
  it('J1 dispose 注销全部监听，含 window 级 pointer 兜底', () => {
    const doc = new FakeDocument();
    const { scroller, view } = makeView({ doc });
    const win = viewOf(doc);
    expect(win.listenerCount('pointerup')).toBe(1);

    view.dispose();
    for (const type of ['scroll', 'pointerdown', 'pointerup', 'pointercancel', 'keydown', 'click', 'load']) {
      expect(scroller.listenerCount(type)).toBe(0);
    }
    expect(win.listenerCount('pointerup')).toBe(0);
    expect(win.listenerCount('pointercancel')).toBe(0);
  });

  it('J2 dispose 之后 render 是空操作；残留的监听回调也不再改 DOM', () => {
    const doc = new FakeDocument();
    const { scroller, view } = makeView({ doc });
    view.render(state(doc, { items: ['a'] }));
    const scrollHandlers = capturedListeners(scroller, 'scroll');
    view.dispose();

    view.render(state(doc, { items: ['a', 'b'] }));
    expect(classNames(scroller)).toEqual(['row-a']);
    expect(() => scrollHandlers.forEach((handler) => handler({ type: 'scroll' }))).not.toThrow();
  });

  it('J3 重复 dispose 幂等', () => {
    const { view } = makeView();
    view.dispose();
    expect(() => view.dispose()).not.toThrow();
  });
});
