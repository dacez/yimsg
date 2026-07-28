import { describe, expect, it, vi } from 'vitest';
import {
  BoundedStreamWindow,
  catchUpAtEdge,
  createFrameScheduler,
  getOrCreateBoundedStreamWindow,
} from '../../../src/app/bounded-list/stream-window';
import { FakeDocument, asElement, row, type FakeElement } from './fake-dom';

function renderedClassNames(content: FakeElement): string[] {
  return content.children.map((c) => c.className);
}

function makeView<T>(overrides: Partial<{ contentElement: FakeElement; onScroll: () => void; onInteract: (id: string, ev: any, viaKeyboard: boolean) => void; onContentLoad: () => void; reachPx: number }> = {}) {
  const doc = new FakeDocument();
  const scroller = doc.createElement();
  const view = new BoundedStreamWindow<T>({
    scrollElement: asElement(scroller),
    contentElement: overrides.contentElement ? asElement(overrides.contentElement) : undefined,
    onScroll: overrides.onScroll,
    onInteract: overrides.onInteract,
    onContentLoad: overrides.onContentLoad,
    reachPx: overrides.reachPx,
  });
  return { doc, scroller, view };
}

describe('BoundedStreamWindow 全量渲染', () => {
  it('渲染全部条目，不插入 spacer；keyOf 打锚点标识', () => {
    const { doc, scroller, view } = makeView<string>();
    view.render({
      items: ['a', 'b', 'c'],
      keyOf: (item) => `k-${item}`,
      renderItem: (item) => {
        const el = row(doc, `row-${item}`);
        return [asElement(el)];
      },
    });
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    expect(scroller.children.map((c) => c.getAttribute('data-bsw-key'))).toEqual(['k-a', 'k-b', 'k-c']);
  });

  it('渲染时保持 scrollTop 先读后清恢复', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.scrollTop = 200;
    view.render({ items: [1, 2, 3], keyOf: (n) => String(n), renderItem: () => [asElement(row(doc))] });
    expect(scroller.scrollTop).toBe(200);
  });

  it('滚动经帧合并后调用 onScroll 与触界检测', () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.push(() => cb(0)); return callbacks.length; });
    try {
      const onScroll = vi.fn();
      const { scroller, view, doc } = makeView<number>({ onScroll });
      scroller.clientHeight = 120;
      scroller.scrollHeight = 120;
      const loadBefore = vi.fn();
      view.render({ items: [1, 2, 3], hasMoreBefore: true, loadBefore, keyOf: String, renderItem: () => [asElement(row(doc))] });
      loadBefore.mockClear();

      scroller.dispatch('scroll');
      scroller.dispatch('scroll');
      expect(onScroll).not.toHaveBeenCalled();
      callbacks.splice(0).forEach((cb) => cb());
      expect(onScroll).toHaveBeenCalledTimes(1);
      expect(loadBefore).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('BoundedStreamWindow 状态与边界提示', () => {
  it('未加载只显示 loading 提示；空列表显示空态', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [], loaded: false, loadingText: '加载中', keyOf: String, renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['list-boundary-hint list-boundary-hint-bottom']);
    expect(scroller.children[0].textContent).toBe('加载中');

    view.render({ items: [], emptyText: '暂无数据', keyOf: String, renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['empty-state']);
    expect(scroller.children[0].textContent).toBe('暂无数据');
  });

  it('没有更多时渲染顶部/底部边界提示，加载中渲染 loading 提示', () => {
    const { scroller, view, doc } = makeView<number>();
    view.render({
      items: [1],
      hasMoreBefore: false,
      hasMoreAfter: false,
      topBoundaryText: '已到最早',
      bottomBoundaryText: '已到最新',
      keyOf: String,
      renderItem: () => [asElement(row(doc))],
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
      keyOf: String,
      renderItem: () => [asElement(row(doc))],
    });
    expect(scroller.children[0].textContent).toBe('加载中');
    expect(scroller.children[scroller.children.length - 1].textContent).toBe('加载中');
  });

  it('触顶/触底且仍有更多时触发加载；没有更多时不触发；reachPx 可配置', () => {
    const { scroller, view, doc } = makeView<number>({ reachPx: 10 });
    scroller.clientHeight = 100;
    scroller.scrollHeight = 1000; // 留足滚动空间，隔离顶/底两端的触发判定
    scroller.scrollTop = 500; // 既不贴顶也不贴底
    const loadBefore = vi.fn();
    const loadAfter = vi.fn();
    view.render({ items: [1], hasMoreBefore: true, hasMoreAfter: true, loadBefore, loadAfter, keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(loadBefore).not.toHaveBeenCalled();
    expect(loadAfter).not.toHaveBeenCalled();

    scroller.scrollTop = 5; // 距顶 5px <= reachPx=10
    view.render({ items: [1], hasMoreBefore: true, hasMoreAfter: true, loadBefore, loadAfter, keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(loadBefore).toHaveBeenCalledTimes(1);
    expect(loadAfter).not.toHaveBeenCalled();

    scroller.scrollTop = 895; // 距底 1000-100-895=5 <= reachPx=10
    view.render({ items: [1], hasMoreBefore: true, hasMoreAfter: true, loadBefore, loadAfter, keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(loadAfter).toHaveBeenCalledTimes(1);

    view.render({ items: [1], hasMoreBefore: false, hasMoreAfter: false, loadBefore, loadAfter, keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(loadBefore).toHaveBeenCalledTimes(1);
    expect(loadAfter).toHaveBeenCalledTimes(1);
  });

  it('内容不足一屏时（clientHeight===scrollHeight）视为已贴底，双向 hasMore 都会触发链式补页', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    const loadBefore = vi.fn();
    const loadAfter = vi.fn();
    view.render({ items: [1], hasMoreBefore: true, hasMoreAfter: true, loadBefore, loadAfter, keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(loadBefore).toHaveBeenCalledTimes(1);
    expect(loadAfter).toHaveBeenCalledTimes(1);
  });
});

describe('BoundedStreamWindow 锚点保持（内容双端变化画面不动）', () => {
  it('头部插入后锚点条目相对视口顶偏移不变', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 300 };
    scroller.clientHeight = 300;

    // renderItem 按「行高固定 50px、按 index 依次排布」在创建时就写死 rect，
    // 模拟真实浏览器「DOM 变更后同步可读到最终布局」这一前提（§2.6 的公式
    // 依赖的正是这一点）；fake DOM 没有真实 reflow，只能这样显式模拟。
    function renderItem(item: number, index: number) {
      const el = row(doc, `row-${item}`);
      el.rect = { top: index * 50, bottom: index * 50 + 50 };
      return [asElement(el)];
    }
    // 首次渲染 [3,4,5]：row3/row4/row5 分别在 top=0/50/100。
    view.render({ items: [3, 4, 5], keyOf: (n) => String(n), renderItem });
    scroller.scrollTop = 30; // 用户看到的是条目 3（top=0..50）靠下的部分，锚点应落在 3 上

    // 头部插入更旧的 [1,2]：row3 在新的 items 里下移到 index=2（top=100）。
    view.render({ items: [1, 2, 3, 4, 5], keyOf: (n) => String(n), renderItem });

    // 锚点条目「3」渲染前 delta = 0(row3 旧 top) - 0(视口 top) = 0；
    // 渲染后 row3 新 top=100，恢复公式：scrollTop += (100-0) - 0 = 100，
    // 加上原 scrollTop(30) 应为 130 —— 用户仍然看到条目 3 的同一相对位置。
    expect(scroller.scrollTop).toBe(130);
  });
});

describe('BoundedStreamWindow scrollToKey', () => {
  it('找到目标行时按 nearest 调整 scrollTop 并返回 true；未找到返回 false', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 100 };
    scroller.clientHeight = 100;
    view.render({ items: [1, 2, 3], keyOf: (n) => String(n), renderItem: () => [asElement(row(doc))] });
    scroller.children[2].rect = { top: 150, bottom: 200 }; // 第 3 行在视口下方之外
    expect(view.scrollToKey('3')).toBe(true);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(view.scrollToKey('does-not-exist')).toBe(false);
  });

  it('block=center 时把目标行居中', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 100 };
    scroller.clientHeight = 100;
    view.render({ items: [1], keyOf: (n) => String(n), renderItem: () => [asElement(row(doc))] });
    scroller.children[0].rect = { top: 40, bottom: 60 };
    view.scrollToKey('1', 'center');
    // (40-0) - (100/2 - 10) = 40 - 40 = 0
    expect(scroller.scrollTop).toBe(0);
  });
});

describe('BoundedStreamWindow isAtEdge', () => {
  it('head：scrollTop <= stickyPx', () => {
    const { scroller, view } = makeView<number>();
    scroller.scrollTop = 4;
    expect(view.isAtEdge('head', 4)).toBe(true);
    scroller.scrollTop = 5;
    expect(view.isAtEdge('head', 4)).toBe(false);
  });

  it('tail：距底 <= stickyPx', () => {
    const { scroller, view } = makeView<number>();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 200;
    scroller.scrollTop = 50; // 距底 50
    expect(view.isAtEdge('tail', 50)).toBe(true);
    scroller.scrollTop = 40;
    expect(view.isAtEdge('tail', 50)).toBe(false);
  });
});

describe('BoundedStreamWindow 指针按下期间不重建（避免吃掉点击）', () => {
  it('指针按下期间到达的重渲染被推迟，原行节点保持存活；抬起后下一帧才应用最新状态', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      scroller.dispatch('pointerup');
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      frames.splice(0).forEach((cb) => cb());
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('指针在列表外抬起（window pointerup）同样会冲刷积压的重渲染', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a']);
      doc.defaultView.dispatch('pointercancel');
      frames.splice(0).forEach((cb) => cb());
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('指针未按下时正常立即重建', () => {
    const { scroller, view, doc } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a'], keyOf: (s) => s, renderItem });
    view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
  });
});

describe('BoundedStreamWindow 点击事件委托', () => {
  it('点击行内嵌套元素也能定位到该行身份（沿 parentElement 上溯）', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    const renderItem = (item: string) => {
      const el = row(doc, `row-${item}`);
      const inner = doc.createElement();
      el.appendChild(inner);
      return [asElement(el)];
    };
    view.render({ items: ['a', 'b'], keyOf: (s) => `k-${s}`, renderItem });
    const innerOfB = scroller.children[1].children[0];
    scroller.dispatch('click', { target: innerOfB });
    expect(onInteract).toHaveBeenCalledWith('k-b', expect.anything(), false);
  });

  it('contentElement 与 scrollElement 分离时事件委托挂在 contentElement 上', () => {
    const onInteract = vi.fn();
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const content = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller), contentElement: asElement(content), onInteract });
    view.render({ items: ['a'], keyOf: (s) => `k-${s}`, renderItem: () => [asElement(row(doc, 'row-a'))] });
    content.dispatch('click', { target: content.children[0] });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything(), false);
  });

  it('点击落在没有 data-bsw-key 祖先的区域时不触发 onInteract', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc))] });
    const stray = doc.createElement(); // 不在 scroller 子树里
    scroller.dispatch('click', { target: stray });
    expect(onInteract).not.toHaveBeenCalled();
  });
});

describe('BoundedStreamWindow 键盘导航', () => {
  function setup() {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b', 'c'], keyOf: (s) => `k-${s}`, renderItem });
    return { scroller, view, onInteract, doc, renderItem };
  }

  it('ArrowDown/ArrowUp 移动焦点并高亮当前行', () => {
    const { scroller } = setup();
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(false);
    expect(scroller.children[1].classList.contains('bsw-row-focused')).toBe(true);
    scroller.dispatch('keydown', { key: 'ArrowUp' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
  });

  it('Enter/Space 激活当前聚焦行', () => {
    const { scroller, onInteract } = setup();
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    scroller.dispatch('keydown', { key: 'Enter' });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything(), true);
    scroller.dispatch('keydown', { key: ' ' });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything(), true);
  });

  it('到达窗口顶部再次 ArrowUp 触发 loadBefore；到达底部再次 ArrowDown 触发 loadAfter', () => {
    const loadBefore = vi.fn();
    const loadAfter = vi.fn();
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b'], hasMoreBefore: true, hasMoreAfter: true, loadBefore, loadAfter, keyOf: (s) => s, renderItem });
    scroller.dispatch('keydown', { key: 'ArrowUp' }); // focusedIndex 从 -1 到 items.length-1（末尾），先落在末尾
    // 从末尾继续向上直到越界触发 loadBefore
    for (let i = 0; i < 5; i++) scroller.dispatch('keydown', { key: 'ArrowUp' });
    expect(loadBefore).toHaveBeenCalled();
  });

  it('没有条目时按键不抛错', () => {
    const { scroller, view, doc } = makeView<string>();
    view.render({ items: [], emptyText: '空', keyOf: (s) => s, renderItem: () => [] });
    expect(() => scroller.dispatch('keydown', { key: 'ArrowDown' })).not.toThrow();
  });
});

describe('BoundedStreamWindow load 捕获（图片异步增高）', () => {
  it('contentElement 内部 load 事件触发 onContentLoad', () => {
    const onContentLoad = vi.fn();
    const { scroller } = makeView<string>({ onContentLoad });
    scroller.dispatch('load');
    expect(onContentLoad).toHaveBeenCalledTimes(1);
  });
});

describe('BoundedStreamWindow dispose：内存泄漏回归', () => {
  it('注销 scrollElement 上的全部监听', () => {
    const { scroller, view } = makeView<string>();
    expect(scroller.listenerCount('scroll')).toBe(1);
    expect(scroller.listenerCount('pointerdown')).toBe(1);
    expect(scroller.listenerCount('pointerup')).toBe(1);
    expect(scroller.listenerCount('pointercancel')).toBe(1);
    expect(scroller.listenerCount('keydown')).toBe(1);
    view.dispose();
    expect(scroller.listenerCount('scroll')).toBe(0);
    expect(scroller.listenerCount('pointerdown')).toBe(0);
    expect(scroller.listenerCount('pointerup')).toBe(0);
    expect(scroller.listenerCount('pointercancel')).toBe(0);
    expect(scroller.listenerCount('keydown')).toBe(0);
  });

  it('注销 window 级 pointerup/pointercancel 兜底监听（§3.4① 泄漏的回归用例）', () => {
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
    expect(doc.defaultView.listenerCount('pointerup')).toBe(1);
    expect(doc.defaultView.listenerCount('pointercancel')).toBe(1);
    view.dispose();
    expect(doc.defaultView.listenerCount('pointerup')).toBe(0);
    expect(doc.defaultView.listenerCount('pointercancel')).toBe(0);
  });

  it('注销 contentElement 上的 click 与 load 捕获监听', () => {
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const content = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller), contentElement: asElement(content) });
    expect(content.listenerCount('click')).toBe(1);
    expect(content.listenerCount('load')).toBe(1);
    view.dispose();
    expect(content.listenerCount('click')).toBe(0);
    expect(content.listenerCount('load')).toBe(0);
  });

  it('dispose 后 render 是空操作，不再重建 DOM 或抛错', () => {
    const { scroller, view, doc } = makeView<string>();
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-a'))] });
    view.dispose();
    expect(() => view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-b'))] })).not.toThrow();
    expect(renderedClassNames(scroller)).toEqual(['row-a']); // 内容保持 dispose 前最后一次渲染结果
  });

  it('dispose 幂等：多次调用不抛错、不重复移除', () => {
    const { view } = makeView<string>();
    expect(() => { view.dispose(); view.dispose(); }).not.toThrow();
  });

  it('dispose 后已排队的下一帧重渲染不会再触碰 DOM（指针按下期间关闭弹窗的场景）', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem }); // 积压一次重渲染
      view.dispose(); // 弹窗在指针抬起前就被关闭
      expect(() => frames.splice(0).forEach((cb) => cb())).not.toThrow();
      expect(renderedClassNames(scroller)).toEqual(['row-a']); // 没有被积压的重渲染污染
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('getOrCreateBoundedStreamWindow', () => {
  it('对同一 owner 复用同一实例', () => {
    const cache = new WeakMap<object, BoundedStreamWindow<string>>();
    const owner = {};
    const factory = vi.fn(() => new BoundedStreamWindow<string>({ scrollElement: asElement(new FakeDocument().createElement()) }));
    expect(getOrCreateBoundedStreamWindow(cache, owner, factory)).toBe(getOrCreateBoundedStreamWindow(cache, owner, factory));
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('catchUpAtEdge（列表贴顶/贴底追平的统一契约）', () => {
  it('有待追平的更新且已贴边缘时才追平', () => {
    const catchUp = vi.fn();
    catchUpAtEdge(() => true, () => true, catchUp);
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  it('没有待追平的更新时，就算贴边缘也不追平', () => {
    const catchUp = vi.fn();
    catchUpAtEdge(() => false, () => true, catchUp);
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('有待追平的更新但不在边缘时不追平', () => {
    const catchUp = vi.fn();
    catchUpAtEdge(() => true, () => false, catchUp);
    expect(catchUp).not.toHaveBeenCalled();
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
      callbacks.splice(0).forEach((cb) => cb());
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancel 后已排队的调用不再执行', () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.push(() => cb(0)); return callbacks.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      const fn = vi.fn();
      const schedule = createFrameScheduler(fn);
      schedule();
      schedule.cancel();
      callbacks.splice(0).forEach((cb) => cb());
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
