// BoundedStreamWindow（渲染引擎）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.6：
//   A 全量渲染 / B 状态与边界提示 / C 触界检测 / D 锚点 / F 贴边判定
//   G 指针期间推迟重建 / H 事件委托 / I 键盘导航 / J 内容 load / K 释放 / L 帧调度。

import { describe, expect, it, vi } from 'vitest';
import { BoundedStreamWindow } from '../../../src/app/bounded-list/stream-window';
import { frameScheduler } from '../../../src/app/bounded-list/frame';
import {
  FakeDocument,
  asElement,
  capturedListeners,
  row,
  stripBoundingRect,
  viewOf,
  type FakeElement,
} from './fake-dom';

function renderedClassNames(content: FakeElement): string[] {
  return content.children.map((c) => c.className);
}

function makeView<T>(overrides: Partial<{
  contentElement: FakeElement;
  onScroll: () => void;
  onInteract: (id: string, ev: any) => void;
  onContentLoad: () => void;
  reachPx: number;
  doc: FakeDocument;
}> = {}) {
  const doc = overrides.doc ?? new FakeDocument();
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

// ───────────────────────── A 有键 DOM 协调 ─────────────────────────

describe('BoundedStreamWindow / A 有键 DOM 协调', () => {
  it('A1 渲染全部条目，不插入 spacer；keyOf 打锚点标识', () => {
    const { doc, scroller, view } = makeView<string>();
    view.render({
      items: ['a', 'b', 'c'],
      keyOf: (item) => `k-${item}`,
      renderItem: (item) => [asElement(row(doc, `row-${item}`))],
    });
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    expect(scroller.children.map((c) => c.getAttribute('data-bsw-key'))).toEqual(['k-a', 'k-b', 'k-c']);
  });

  it('A2 一行由多个平级元素组成时全部插入，锚点唯一且每个根节点都带交互键', () => {
    const onInteract = vi.fn();
    const { doc, scroller, view } = makeView<string>({ onInteract });
    view.render({
      items: ['a'],
      keyOf: (item) => item,
      renderItem: (item) => [asElement(row(doc, `name-${item}`)), asElement(row(doc, `bubble-${item}`))],
    });
    expect(renderedClassNames(scroller)).toEqual(['name-a', 'bubble-a']);
    expect(scroller.children[0].getAttribute('data-bsw-key')).toBe('a');
    expect(scroller.children[1].getAttribute('data-bsw-key')).toBeNull();
    expect(scroller.children.map((child) => child.getAttribute('data-bsw-interact-key'))).toEqual(['a', 'a']);
    scroller.dispatch('click', { target: scroller.children[1] });
    expect(onInteract).toHaveBeenCalledWith('a', expect.anything());
  });

  it('A3 renderItem 返回空数组时该条目不产生任何节点，也不打锚点', () => {
    const { doc, scroller, view } = makeView<string>();
    view.render({
      items: ['a', 'b'],
      keyOf: (item) => item,
      renderItem: (item) => (item === 'a' ? [] : [asElement(row(doc, 'row-b'))]),
    });
    expect(renderedClassNames(scroller)).toEqual(['row-b']);
  });

  it('A4 相同条目再次 render 时保留原 DOM 节点', () => {
    const { doc, scroller, view } = makeView<string>();
    const renderItem = vi.fn((item: string) => [asElement(row(doc, `row-${item}`))]);
    view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
    const originalNodes = [...scroller.children];
    renderItem.mockClear();
    view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
    expect(renderItem).toHaveBeenCalledTimes(2); // 仍生成候选 DOM，以反映语言等外部状态
    expect(scroller.children[0]).toBe(originalNodes[0]);
    expect(scroller.children[1]).toBe(originalNodes[1]);
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
  });

  it('A5 尾部追加只插入新行，不触碰既有行', () => {
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
    const originalNodes = [...scroller.children];

    view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem });

    expect(scroller.children[0]).toBe(originalNodes[0]);
    expect(scroller.children[1]).toBe(originalNodes[1]);
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('A6 只替换真实变化的条目，未变化兄弟保持节点身份', () => {
    type Item = { id: string; label: string };
    const { doc, scroller, view } = makeView<Item>();
    const renderItem = (item: Item) => [asElement(row(doc, `row-${item.id}-${item.label}`))];
    const keyOf = (item: Item) => item.id;
    view.render({ items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], keyOf, renderItem });
    const originalNodes = [...scroller.children];

    view.render({ items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B2' }], keyOf, renderItem });

    expect(scroller.children[0]).toBe(originalNodes[0]);
    expect(scroller.children[1]).not.toBe(originalNodes[1]);
    expect(renderedClassNames(scroller)).toEqual(['row-a-A', 'row-b-B2']);
  });

  it('A7 同 identity 的业务数据变化即使 DOM 相同也替换节点，避免保留旧条目监听', () => {
    type Item = { id: string; action: string };
    const { doc, scroller, view } = makeView<Item>();
    const seen: string[] = [];
    const renderItem = (item: Item) => {
      const element = row(doc, `row-${item.id}`);
      element.addEventListener('click', () => seen.push(item.action));
      return [asElement(element)];
    };
    const keyOf = (item: Item) => item.id;
    view.render({ items: [{ id: 'a', action: 'old' }], keyOf, renderItem });
    const original = scroller.children[0];

    view.render({ items: [{ id: 'a', action: 'new' }], keyOf, renderItem });
    scroller.children[0].dispatch('click');

    expect(scroller.children[0]).not.toBe(original);
    expect(seen).toEqual(['new']);
  });

  it('A7b 内部数据更新可按身份复用 DOM 相同的行，忽略 UI 未使用的快照字段差异', () => {
    type Item = { id: string; hiddenRevision: number };
    const { doc, scroller, view } = makeView<Item>();
    const renderItem = (item: Item) => [asElement(row(doc, `row-${item.id}`))];
    view.render({
      items: [{ id: 'a', hiddenRevision: 1 }],
      keyOf: (item) => item.id,
      renderItem,
      reuseUnchangedRows: true,
    });
    const original = scroller.children[0];

    view.render({
      items: [{ id: 'a', hiddenRevision: 2 }],
      keyOf: (item) => item.id,
      renderItem,
      reuseUnchangedRows: true,
    });

    expect(scroller.children[0]).toBe(original);
  });

  it('A8 渲染时保持 scrollTop 先读后改恢复', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.scrollTop = 200;
    view.render({ items: [1, 2, 3], keyOf: (n) => String(n), renderItem: () => [asElement(row(doc))] });
    expect(scroller.scrollTop).toBe(200);
  });

  it('A9 渲染过程中 scrollTop 被浏览器夹回 0 时会被显式恢复', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.scrollTop = 320;
    view.render({
      items: [1],
      keyOf: String,
      // 模拟真实浏览器：DOM 协调导致 scrollTop 被夹回 0。
      renderItem: () => { scroller.scrollTop = 0; return [asElement(row(doc))]; },
    });
    expect(scroller.scrollTop).toBe(320);
  });

  it('A10 大窗口（1000 行）一次性渲染，节点数与条目数严格一致', () => {
    const { doc, scroller, view } = makeView<number>();
    const items = Array.from({ length: 1000 }, (_, i) => i);
    view.render({ items, keyOf: String, renderItem: (n) => [asElement(row(doc, `row-${n}`))] });
    expect(scroller.children).toHaveLength(1000);
    expect(scroller.children[999].getAttribute('data-bsw-key')).toBe('999');
  });
});

// ───────────────────────── B 状态与边界提示 ─────────────────────────

describe('BoundedStreamWindow / B 状态与边界提示', () => {
  it('B1 未加载只显示 loading 提示；空列表显示空态', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [], loaded: false, loadingText: '加载中', keyOf: String, renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['list-boundary-hint list-boundary-hint-bottom']);
    expect(scroller.children[0].textContent).toBe('加载中');

    view.render({ items: [], emptyText: '暂无数据', keyOf: String, renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['empty-state']);
    expect(scroller.children[0].textContent).toBe('暂无数据');
  });

  it('B2 未加载且没有 loadingText 时渲染成完全空的容器', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [1], loaded: false, keyOf: String, renderItem: () => [] });
    expect(scroller.children).toHaveLength(0);
  });

  it('B3 空列表且没有 emptyText 时同样渲染成空容器（不留任何占位）', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [], keyOf: String, renderItem: () => [] });
    expect(scroller.children).toHaveLength(0);
  });

  it('B4 未加载分支优先于空列表分支（loaded=false 时不显示空态）', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [], loaded: false, loadingText: '加载中', emptyText: '暂无数据', keyOf: String, renderItem: () => [] });
    expect(scroller.children[0].textContent).toBe('加载中');
  });

  it('B5 没有更多时渲染顶部/底部边界提示，加载中渲染 loading 提示', () => {
    const { scroller, view, doc } = makeView<number>();
    view.render({
      items: [1], hasMoreHead: false, hasMoreTail: false,
      headBoundaryText: '已到最早', tailBoundaryText: '已到最新',
      keyOf: String, renderItem: () => [asElement(row(doc))],
    });
    expect(renderedClassNames(scroller)[0]).toBe('list-boundary-hint list-boundary-hint-top');
    expect(renderedClassNames(scroller)[2]).toBe('list-boundary-hint list-boundary-hint-bottom');

    view.render({
      items: [1], hasMoreHead: true, hasMoreTail: true,
      loadingHead: true, loadingTail: true, loadingText: '加载中',
      headBoundaryText: '已到最早', tailBoundaryText: '已到最新',
      keyOf: String, renderItem: () => [asElement(row(doc))],
    });
    expect(scroller.children[0].textContent).toBe('加载中');
    expect(scroller.children[scroller.children.length - 1].textContent).toBe('加载中');
  });

  it('B6 边界文案缺失时该端什么都不渲染（四种组合逐一验证）', () => {
    const { scroller, view, doc } = makeView<number>();
    const item = () => [asElement(row(doc, 'row'))];
    // 没有更多 + 没有边界文案 → 不渲染提示
    view.render({ items: [1], hasMoreHead: false, hasMoreTail: false, keyOf: String, renderItem: item });
    expect(renderedClassNames(scroller)).toEqual(['row']);
    // 有更多 + loading 但没有 loadingText → 不渲染提示
    view.render({ items: [1], hasMoreHead: true, hasMoreTail: true, loadingHead: true, loadingTail: true, keyOf: String, renderItem: item });
    expect(renderedClassNames(scroller)).toEqual(['row']);
    // 有更多 + 不在 loading → 不渲染提示
    view.render({ items: [1], hasMoreHead: true, hasMoreTail: true, loadingText: '加载中', keyOf: String, renderItem: item });
    expect(renderedClassNames(scroller)).toEqual(['row']);
    // 没有更多 + 同时 loading：边界提示优先
    view.render({ items: [1], hasMoreHead: false, hasMoreTail: false, loadingHead: true, loadingTail: true, loadingText: '加载中', headBoundaryText: '最早', tailBoundaryText: '最新', keyOf: String, renderItem: item });
    expect(scroller.children[0].textContent).toBe('最早');
    expect(scroller.children[2].textContent).toBe('最新');
  });

  it('B8 errorText 提供时用错误态代替空态（首屏加载失败不能显示成「暂无数据」）', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [], emptyText: '暂无数据', errorText: '加载失败', keyOf: String, renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['list-error-state']);
    expect(scroller.children[0].textContent).toBe('加载失败');

    view.render({ items: [], emptyText: '暂无数据', keyOf: String, renderItem: () => [] });
    expect(renderedClassNames(scroller)).toEqual(['empty-state']);
  });

  it('B9 errorText 为空串时仍走错误态分支（空串是有意的「不显示文字」而不是缺省）', () => {
    const { scroller, view } = makeView<number>();
    view.render({ items: [], emptyText: '暂无数据', errorText: '', keyOf: String, renderItem: () => [] });
    expect(scroller.children).toHaveLength(0);
  });

  it('B10 有条目时 errorText 不参与渲染（错误态只在列表为空时代替空态）', () => {
    const { scroller, view, doc } = makeView<number>();
    view.render({ items: [1], errorText: '加载失败', keyOf: String, renderItem: () => [asElement(row(doc, 'row-1'))] });
    expect(renderedClassNames(scroller)).toEqual(['row-1']);
  });

  it('B7 两端提示与条目的相对顺序固定为 [头部提示, ...条目, 尾部提示]', () => {
    const { scroller, view, doc } = makeView<number>();
    view.render({
      items: [1, 2], hasMoreHead: false, hasMoreTail: false,
      headBoundaryText: '最早', tailBoundaryText: '最新',
      keyOf: String, renderItem: (n) => [asElement(row(doc, `row-${n}`))],
    });
    expect(renderedClassNames(scroller)).toEqual([
      'list-boundary-hint list-boundary-hint-top',
      'row-1',
      'row-2',
      'list-boundary-hint list-boundary-hint-bottom',
    ]);
  });
});

// ───────────────────────── C 触界检测 ─────────────────────────

describe('BoundedStreamWindow / C 触界检测', () => {
  it('C1 触顶/触底且仍有更多时触发加载；没有更多时不触发；reachPx 可配置', () => {
    const { scroller, view, doc } = makeView<number>({ reachPx: 10 });
    scroller.clientHeight = 100;
    scroller.scrollHeight = 1000;
    scroller.scrollTop = 500;
    const loadHead = vi.fn();
    const loadTail = vi.fn();
    const state = { items: [1], hasMoreHead: true, hasMoreTail: true, loadHead, loadTail, keyOf: String, renderItem: () => [asElement(row(doc))] };
    view.render(state);
    expect(loadHead).not.toHaveBeenCalled();
    expect(loadTail).not.toHaveBeenCalled();

    scroller.scrollTop = 5; // 距顶 5px <= reachPx=10
    view.render(state);
    expect(loadHead).toHaveBeenCalledTimes(1);
    expect(loadTail).not.toHaveBeenCalled();

    scroller.scrollTop = 895; // 距底 5px <= reachPx=10
    view.render(state);
    expect(loadTail).toHaveBeenCalledTimes(1);

    view.render({ ...state, hasMoreHead: false, hasMoreTail: false });
    expect(loadHead).toHaveBeenCalledTimes(1);
    expect(loadTail).toHaveBeenCalledTimes(1);
  });

  it('C2 默认 reachPx=160：距边界 160px 触发、161px 不触发', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 2000;
    const loadHead = vi.fn();
    const state = { items: [1], hasMoreHead: true, loadHead, keyOf: String, renderItem: () => [asElement(row(doc))] };
    scroller.scrollTop = 161;
    view.render(state);
    expect(loadHead).not.toHaveBeenCalled();
    scroller.scrollTop = 160;
    view.render(state);
    expect(loadHead).toHaveBeenCalledTimes(1);
  });

  it('C3 内容不足一屏时（clientHeight >= scrollHeight）视为双端都已触界', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    const loadHead = vi.fn();
    const loadTail = vi.fn();
    view.render({ items: [1], hasMoreHead: true, hasMoreTail: true, loadHead, loadTail, keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(loadHead).toHaveBeenCalledTimes(1);
    expect(loadTail).toHaveBeenCalledTimes(1);
  });

  it('C4 未加载（loaded=false）时不做触界检测', () => {
    const { scroller, view } = makeView<number>();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    const loadHead = vi.fn();
    const loadTail = vi.fn();
    view.render({ items: [], loaded: false, hasMoreHead: true, hasMoreTail: true, loadHead, loadTail, keyOf: String, renderItem: () => [] });
    expect(loadHead).not.toHaveBeenCalled();
    expect(loadTail).not.toHaveBeenCalled();
  });

  it('C5 空列表（items 为空）但该端仍有更多时照样触界补页，不会定格在空态', () => {
    const { scroller, view } = makeView<number>();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    const loadHead = vi.fn();
    const loadTail = vi.fn();
    view.render({ items: [], emptyText: '空', hasMoreHead: true, hasMoreTail: true, loadHead, loadTail, keyOf: String, renderItem: () => [] });
    expect(loadHead).toHaveBeenCalledTimes(1);
    expect(loadTail).toHaveBeenCalledTimes(1);
  });

  it('C5b 空列表且两端都没有更多时不触发任何加载', () => {
    const { scroller, view } = makeView<number>();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    const loadTail = vi.fn();
    view.render({ items: [], emptyText: '空', hasMoreTail: false, loadTail, keyOf: String, renderItem: () => [] });
    expect(loadTail).not.toHaveBeenCalled();
  });

  it('C6 滚动经帧合并后调用 onScroll 与触界检测', () => {
    withFrames((frames) => {
      const onScroll = vi.fn();
      const { scroller, view, doc } = makeView<number>({ onScroll });
      scroller.clientHeight = 120;
      scroller.scrollHeight = 120;
      const loadHead = vi.fn();
      view.render({ items: [1, 2, 3], hasMoreHead: true, loadHead, keyOf: String, renderItem: () => [asElement(row(doc))] });
      loadHead.mockClear();

      scroller.dispatch('scroll');
      scroller.dispatch('scroll');
      expect(onScroll).not.toHaveBeenCalled();
      frames.run();
      expect(onScroll).toHaveBeenCalledTimes(1);
      expect(loadHead).toHaveBeenCalledTimes(1);
    });
  });

  it('C7 从未 render 过就滚动：没有 lastState，触界检测直接返回', () => {
    withFrames((frames) => {
      const onScroll = vi.fn();
      const { scroller } = makeView<number>({ onScroll });
      scroller.dispatch('scroll');
      expect(() => frames.run()).not.toThrow();
      expect(onScroll).toHaveBeenCalledTimes(1);
    });
  });

  it('C8 没有提供 loadHead/loadTail 时触界是空操作，不抛错', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.clientHeight = 120;
    scroller.scrollHeight = 120;
    expect(() => view.render({ items: [1], hasMoreHead: true, hasMoreTail: true, keyOf: String, renderItem: () => [asElement(row(doc))] })).not.toThrow();
  });
});

// ───────────────────────── D 锚点 ─────────────────────────

describe('BoundedStreamWindow / D 锚点（内容双端变化画面不动）', () => {
  /** 行高固定 50px、按 index 依次排布，模拟「DOM 变更后同步可读到最终布局」。 */
  function fixedRows(doc: FakeDocument) {
    return (item: number, index: number) => {
      const el = row(doc, `row-${item}`);
      el.rect = { top: index * 50, bottom: index * 50 + 50 };
      el.setAttribute('data-test-layout-index', String(index));
      return [asElement(el)];
    };
  }

  it('D1 头部插入后锚点条目相对视口顶偏移不变', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 300 };
    scroller.clientHeight = 300;
    const renderItem = fixedRows(doc);
    view.render({ items: [3, 4, 5], keyOf: (n) => String(n), renderItem });
    scroller.scrollTop = 30;
    view.render({ items: [1, 2, 3, 4, 5], keyOf: (n) => String(n), renderItem });
    // 锚点 3 渲染前 delta=0，渲染后新 top=100 → scrollTop += 100 → 30+100=130
    expect(scroller.scrollTop).toBe(130);
  });

  it('D2 尾部裁剪（锚点位置不变）时 scrollTop 不动', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 300 };
    scroller.clientHeight = 300;
    const renderItem = fixedRows(doc);
    view.render({ items: [1, 2, 3, 4, 5], keyOf: (n) => String(n), renderItem });
    scroller.scrollTop = 20;
    view.render({ items: [1, 2, 3], keyOf: (n) => String(n), renderItem }); // 只裁尾，1 仍在 index 0
    expect(scroller.scrollTop).toBe(20);
  });

  it('D3 锚点取「第一条底边仍在视口顶以下」的条目，完全滚过去的条目不做锚点', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 100, bottom: 400 };
    scroller.clientHeight = 300;
    const renderItem = (item: number, index: number) => {
      const el = row(doc, `row-${item}`);
      // 条目 1 完全在视口顶之上（bottom=50 < top=100），锚点应落在条目 2。
      el.rect = { top: index * 50, bottom: index * 50 + 50 };
      el.setAttribute('data-test-layout-index', String(index));
      return [asElement(el)];
    };
    view.render({ items: [1, 2, 3], keyOf: (n) => String(n), renderItem });
    scroller.scrollTop = 0;
    view.render({ items: [0, 1, 2, 3], keyOf: (n) => String(n), renderItem });
    // 锚点是「3」（旧 index 2 → top=100，delta=0；新 index 3 → top=150）→ scrollTop += 50
    expect(scroller.scrollTop).toBe(50);
  });

  it('D4 锚点条目在新一轮渲染里消失时不做校正（scrollTop 保持先读后清的值）', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 300 };
    const renderItem = fixedRows(doc);
    view.render({ items: [1, 2, 3], keyOf: (n) => String(n), renderItem });
    scroller.scrollTop = 25;
    view.render({ items: [7, 8, 9], keyOf: (n) => String(n), renderItem });
    expect(scroller.scrollTop).toBe(25);
  });

  it('D5 没有任何带锚点键的子节点时不做校正', () => {
    const { scroller, view, doc } = makeView<number>();
    scroller.rect = { top: 0, bottom: 300 };
    // renderItem 返回空数组 → 没有节点会被打上 data-bsw-key
    view.render({ items: [1], keyOf: String, renderItem: () => [] });
    scroller.scrollTop = 40;
    view.render({ items: [1, 2], keyOf: String, renderItem: () => [asElement(row(doc))] });
    expect(scroller.scrollTop).toBe(40);
  });

  it('D6 宿主元素没有 getBoundingClientRect 时锚点整体降级为不校正，不抛错', () => {
    const doc = new FakeDocument();
    const scroller = stripBoundingRect(doc.createElement());
    const content = stripBoundingRect(doc.createElement());
    const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller), contentElement: asElement(content) });
    const renderItem = (n: number) => [asElement(row(doc, `row-${n}`))];
    expect(() => {
      view.render({ items: [1], keyOf: String, renderItem });
      view.render({ items: [0, 1], keyOf: String, renderItem });
    }).not.toThrow();
    expect(renderedClassNames(content)).toEqual(['row-0', 'row-1']);
    view.dispose();
  });

  it('D7 锚点捕获成功但恢复阶段失去布局能力时安全降级（不校正、不抛错）', () => {
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    scroller.rect = { top: 0, bottom: 300 };
    const content = doc.createElement();
    const view = new BoundedStreamWindow<number>({ scrollElement: asElement(scroller), contentElement: asElement(content) });
    let stripped = false;
    const renderItem = (n: number, index: number) => {
      // renderItem 在「捕获锚点之后、恢复锚点之前」执行：在这里抽掉布局能力，
      // 就精确落在 restoreAnchor 的降级分支上。
      if (!stripped && n === 0) { stripBoundingRect(content); stripped = true; }
      const el = row(doc, `row-${n}`);
      el.rect = { top: index * 50, bottom: index * 50 + 50 };
      return [asElement(el)];
    };
    view.render({ items: [1, 2], keyOf: String, renderItem });
    scroller.scrollTop = 15;
    expect(() => view.render({ items: [0, 1, 2], keyOf: String, renderItem })).not.toThrow();
    expect(scroller.scrollTop).toBe(15); // 没有做任何锚点校正
    view.dispose();
  });
});

// ───────────────────────── F 贴边判定 ─────────────────────────

describe('BoundedStreamWindow / F isAtEdge', () => {
  it('F1 head：scrollTop <= stickyPx', () => {
    const { scroller, view } = makeView<number>();
    scroller.scrollTop = 4;
    expect(view.isAtEdge('head', 4)).toBe(true);
    scroller.scrollTop = 5;
    expect(view.isAtEdge('head', 4)).toBe(false);
  });

  it('F2 tail：距底 <= stickyPx', () => {
    const { scroller, view } = makeView<number>();
    scroller.clientHeight = 100;
    scroller.scrollHeight = 200;
    scroller.scrollTop = 50;
    expect(view.isAtEdge('tail', 50)).toBe(true);
    scroller.scrollTop = 40;
    expect(view.isAtEdge('tail', 50)).toBe(false);
  });

  it('F3 stickyPx=0 时必须严格贴边', () => {
    const { scroller, view } = makeView<number>();
    scroller.scrollTop = 0;
    expect(view.isAtEdge('head', 0)).toBe(true);
    scroller.scrollTop = 1;
    expect(view.isAtEdge('head', 0)).toBe(false);
  });

  it('F4 内容不足一屏时两端都判定为贴边（maxScrollTop 被夹到 0）', () => {
    const { scroller, view } = makeView<number>();
    scroller.clientHeight = 500;
    scroller.scrollHeight = 100;
    scroller.scrollTop = 0;
    expect(view.isAtEdge('head', 4)).toBe(true);
    expect(view.isAtEdge('tail', 50)).toBe(true);
  });

  it('F5 dispose 之后 isAtEdge 仍按当前 DOM 计算（纯几何查询，无状态依赖）', () => {
    const { scroller, view } = makeView<number>();
    view.dispose();
    scroller.scrollTop = 0;
    expect(view.isAtEdge('head', 4)).toBe(true);
  });
});

// ───────────────────────── G 指针期间推迟重建 ─────────────────────────

describe('BoundedStreamWindow / G 指针按下期间不重建（避免吃掉点击）', () => {
  it('G1 指针按下期间到达的重渲染被推迟，抬起后下一帧才应用最新状态', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      scroller.dispatch('pointerup');
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);

      frames.run();
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    });
  });

  it('G2 按下期间多次 render 只应用最后一次状态', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
      view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem });
      view.render({ items: ['z'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerup');
      frames.run();
      expect(renderedClassNames(scroller)).toEqual(['row-z']);
    });
  });

  it('G3 指针在列表外抬起（window pointercancel）同样会冲刷积压的重渲染', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
      expect(renderedClassNames(scroller)).toEqual(['row-a']);
      viewOf(doc).dispatch('pointercancel');
      frames.run();
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
    });
  });

  it('G4 按下期间没有任何 render 时，抬起不安排冲刷', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-a'))] });
      scroller.dispatch('pointerdown');
      scroller.dispatch('pointerup');
      expect(frames.size()).toBe(0);
    });
  });

  it('G5 未按下就收到 pointerup（例如按下发生在组件创建之前）时直接返回', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-a'))] });
      scroller.dispatch('pointerup');
      viewOf(doc).dispatch('pointerup');
      expect(frames.size()).toBe(0);
      expect(renderedClassNames(scroller)).toEqual(['row-a']);
    });
  });

  it('G6 抬起后到下一帧之间又发生了一次正常 render，则积压的冲刷退化为空操作', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem }); // 积压
      scroller.dispatch('pointerup');                                  // 安排下一帧冲刷
      view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem }); // 指针已抬起 → 立即应用
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
      frames.run(); // 冲刷发现 pendingRender 已被清掉，直接返回
      expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b', 'row-c']);
    });
  });

  it('G7 一次按下对应多次抬起事件（scroller + window）时只冲刷一次', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = vi.fn((item: string) => [asElement(row(doc, `row-${item}`))]);
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
      renderItem.mockClear();
      scroller.dispatch('pointerup');
      viewOf(doc).dispatch('pointerup');
      frames.run();
      expect(renderItem).toHaveBeenCalledTimes(2); // 只重建了一次（两个条目各一次）
    });
  });

  it('G8 指针未按下时正常立即重建', () => {
    const { scroller, view, doc } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a'], keyOf: (s) => s, renderItem });
    view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
    expect(renderedClassNames(scroller)).toEqual(['row-a', 'row-b']);
  });
});

// ───────────────────────── H 事件委托 ─────────────────────────

describe('BoundedStreamWindow / H 点击事件委托', () => {
  it('H1 点击行内嵌套元素也能定位到该行身份（沿 parentElement 上溯）', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    const renderItem = (item: string) => {
      const el = row(doc, `row-${item}`);
      el.appendChild(doc.createElement());
      return [asElement(el)];
    };
    view.render({ items: ['a', 'b'], keyOf: (s) => `k-${s}`, renderItem });
    scroller.dispatch('click', { target: scroller.children[1].children[0] });
    expect(onInteract).toHaveBeenCalledWith('k-b', expect.anything());
  });

  it('H2 深层嵌套（5 层）同样能上溯到行', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    let deepest: FakeElement | null = null;
    const renderItem = (item: string) => {
      const el = row(doc, `row-${item}`);
      let cur = el;
      for (let i = 0; i < 5; i++) { const child = doc.createElement(); cur.appendChild(child); cur = child; }
      deepest = cur;
      return [asElement(el)];
    };
    view.render({ items: ['a'], keyOf: (s) => `k-${s}`, renderItem });
    scroller.dispatch('click', { target: deepest });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything());
  });

  it('H3 contentElement 与 scrollElement 分离时事件委托挂在 contentElement 上', () => {
    const onInteract = vi.fn();
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const content = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller), contentElement: asElement(content), onInteract });
    view.render({ items: ['a'], keyOf: (s) => `k-${s}`, renderItem: () => [asElement(row(doc, 'row-a'))] });
    content.dispatch('click', { target: content.children[0] });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything());
    scroller.dispatch('click', { target: content.children[0] }); // scroller 上没有委托
    expect(onInteract).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('H4 点击落在没有 data-bsw-key 祖先的区域时不触发 onInteract', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc))] });
    scroller.dispatch('click', { target: doc.createElement() });
    expect(onInteract).not.toHaveBeenCalled();
  });

  it('H5 点击边界提示（无锚点键）不触发 onInteract', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    view.render({
      items: ['a'], hasMoreHead: false, headBoundaryText: '最早',
      keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-a'))],
    });
    scroller.dispatch('click', { target: scroller.children[0] }); // 边界提示
    expect(onInteract).not.toHaveBeenCalled();
    scroller.dispatch('click', { target: scroller.children[1] }); // 真正的行
    expect(onInteract).toHaveBeenCalledTimes(1);
  });

  it('H6 target 为 null（合成事件）时安全返回', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc))] });
    expect(() => scroller.dispatch('click', { target: null })).not.toThrow();
    expect(onInteract).not.toHaveBeenCalled();
  });

  it('H7 上溯路径中夹着没有 getAttribute 的节点（文本节点等）时跳过它继续上溯', () => {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    view.render({ items: ['a'], keyOf: (s) => `k-${s}`, renderItem: () => [asElement(row(doc, 'row-a'))] });
    const textLike = { parentElement: scroller.children[0] }; // 没有 getAttribute
    scroller.dispatch('click', { target: textLike });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything());
  });

  it('H8 未提供 onInteract 时点击是空操作', () => {
    const { scroller, view, doc } = makeView<string>();
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc))] });
    expect(() => scroller.dispatch('click', { target: scroller.children[0] })).not.toThrow();
  });
});

// ───────────────────────── I 键盘导航 ─────────────────────────

describe('BoundedStreamWindow / I 键盘导航', () => {
  function setup(items = ['a', 'b', 'c']) {
    const onInteract = vi.fn();
    const { scroller, view, doc } = makeView<string>({ onInteract });
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items, keyOf: (s) => `k-${s}`, renderItem });
    return { scroller, view, onInteract, doc, renderItem };
  }

  it('I1 ArrowDown/ArrowUp 移动焦点并高亮当前行', () => {
    const { scroller } = setup();
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(false);
    expect(scroller.children[1].classList.contains('bsw-row-focused')).toBe(true);
    scroller.dispatch('keydown', { key: 'ArrowUp' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
  });

  it('I2 首次 ArrowUp 从末尾开始，首次 ArrowDown 从开头开始', () => {
    const down = setup();
    down.scroller.dispatch('keydown', { key: 'ArrowDown' });
    expect(down.scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);

    const up = setup();
    up.scroller.dispatch('keydown', { key: 'ArrowUp' });
    expect(up.scroller.children[2].classList.contains('bsw-row-focused')).toBe(true);
  });

  it('I3 方向键会 preventDefault（避免页面整体滚动）', () => {
    const { scroller } = setup();
    const preventDefault = vi.fn();
    scroller.dispatch('keydown', { key: 'ArrowDown', preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('I4 Enter/Space 激活当前聚焦行，回调只带 identity 与事件', () => {
    const { scroller, onInteract } = setup();
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    scroller.dispatch('keydown', { key: 'Enter' });
    expect(onInteract).toHaveBeenCalledWith('k-a', expect.anything());
    scroller.dispatch('keydown', { key: ' ' });
    expect(onInteract).toHaveBeenCalledTimes(2);
  });

  it('I5 没有聚焦行时 Enter/Space 不触发激活', () => {
    const { scroller, onInteract } = setup();
    scroller.dispatch('keydown', { key: 'Enter' });
    scroller.dispatch('keydown', { key: ' ' });
    expect(onInteract).not.toHaveBeenCalled();
  });

  it('I6 到达窗口顶部再次 ArrowUp 触发 loadHead，且不移动焦点', () => {
    const loadHead = vi.fn();
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b'], hasMoreHead: true, loadHead, keyOf: (s) => s, renderItem });
    scroller.dispatch('keydown', { key: 'ArrowUp' }); // -1 → 末尾(1)
    scroller.dispatch('keydown', { key: 'ArrowUp' }); // 1 → 0
    loadHead.mockClear();
    scroller.dispatch('keydown', { key: 'ArrowUp' }); // 0 → -1 越界
    expect(loadHead).toHaveBeenCalledTimes(1);
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true); // 焦点仍在第一行
  });

  it('I7 到达窗口底部再次 ArrowDown 触发 loadTail，且不移动焦点', () => {
    const loadTail = vi.fn();
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b'], hasMoreTail: true, loadTail, keyOf: (s) => s, renderItem });
    scroller.dispatch('keydown', { key: 'ArrowDown' }); // -1 → 0
    scroller.dispatch('keydown', { key: 'ArrowDown' }); // 0 → 1
    loadTail.mockClear();
    scroller.dispatch('keydown', { key: 'ArrowDown' }); // 1 → 2 越界
    expect(loadTail).toHaveBeenCalledTimes(1);
    expect(scroller.children[1].classList.contains('bsw-row-focused')).toBe(true);
  });

  it('I8 越界方向没有 loadHead/loadTail 时是空操作', () => {
    const { doc, scroller, view } = makeView<string>();
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc))] });
    expect(() => {
      scroller.dispatch('keydown', { key: 'ArrowDown' });
      scroller.dispatch('keydown', { key: 'ArrowDown' });
      scroller.dispatch('keydown', { key: 'ArrowUp' });
      scroller.dispatch('keydown', { key: 'ArrowUp' });
    }).not.toThrow();
  });

  it('I9 没有条目时按键不抛错', () => {
    const { scroller, view } = makeView<string>();
    view.render({ items: [], emptyText: '空', keyOf: (s) => s, renderItem: () => [] });
    expect(() => scroller.dispatch('keydown', { key: 'ArrowDown' })).not.toThrow();
    expect(() => scroller.dispatch('keydown', { key: 'Enter' })).not.toThrow();
  });

  it('I10 从未 render 过就按键不抛错', () => {
    const { scroller } = makeView<string>();
    expect(() => scroller.dispatch('keydown', { key: 'ArrowDown' })).not.toThrow();
  });

  it('I11 其它按键（Tab / Escape / 字符键）完全不被组件消费', () => {
    const { scroller, onInteract } = setup();
    const preventDefault = vi.fn();
    for (const key of ['Tab', 'Escape', 'a', 'PageDown', 'Home']) {
      scroller.dispatch('keydown', { key, preventDefault });
    }
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onInteract).not.toHaveBeenCalled();
  });

  it('I12 焦点跟随身份键而非下标：头部插入后仍高亮同一条', () => {
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['b', 'c'], keyOf: (s) => s, renderItem });
    scroller.dispatch('keydown', { key: 'ArrowDown' }); // 聚焦 b（index 0）
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
    // 头部插入 a 之后，原本聚焦的 b 移到 index 1；高亮必须跟随身份而不是旧下标。
    view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(false);
    expect(scroller.children[1].classList.contains('bsw-row-focused')).toBe(true);
    expect(scroller.children[1].className).toContain('row-b');
  });

  it('I13 窗口变短到焦点越界时先钳制再取焦点键，本次渲染就保住高亮', () => {
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b', 'c'], keyOf: (s) => s, renderItem });
    for (let i = 0; i < 3; i++) scroller.dispatch('keydown', { key: 'ArrowDown' }); // focusedIndex=2
    view.render({ items: ['a'], keyOf: (s) => s, renderItem });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
    view.render({ items: ['a'], keyOf: (s) => s, renderItem });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
  });

  it('I14 列表清空后 focusedIndex 归位，重新有条目时从头开始', () => {
    const { doc, scroller, view } = makeView<string>();
    const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
    view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem });
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    scroller.dispatch('keydown', { key: 'ArrowDown' }); // focusedIndex=1
    view.render({ items: [], emptyText: '空', keyOf: (s) => s, renderItem: () => [] });
    view.render({ items: ['x', 'y'], keyOf: (s) => s, renderItem });
    scroller.dispatch('keydown', { key: 'ArrowDown' });
    expect(scroller.children[0].classList.contains('bsw-row-focused')).toBe(true);
  });

  it('I15 首元素没有 classList 时高亮降级为空操作，不抛错', () => {
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
    const renderItem = () => {
      const el = doc.createElement();
      Object.defineProperty(el, 'classList', { value: undefined, configurable: true });
      return [asElement(el)];
    };
    view.render({ items: ['a'], keyOf: (s) => s, renderItem });
    expect(() => scroller.dispatch('keydown', { key: 'ArrowDown' })).not.toThrow();
    view.dispose();
  });
});

// ───────────────────────── J 内容 load ─────────────────────────

describe('BoundedStreamWindow / J 内容 load 捕获（图片异步增高）', () => {
  it('J1 contentElement 内部 load 事件触发 onContentLoad', () => {
    const onContentLoad = vi.fn();
    const { scroller } = makeView<string>({ onContentLoad });
    scroller.dispatch('load');
    expect(onContentLoad).toHaveBeenCalledTimes(1);
  });

  it('J2 未提供 onContentLoad 时 load 事件是空操作（当前 BoundedList 就是这种情况，见 BL-BUG-06）', () => {
    const { scroller } = makeView<string>();
    expect(scroller.listenerCount('load')).toBe(1);
    expect(() => scroller.dispatch('load')).not.toThrow();
  });

  it('J3 load 监听注册在捕获阶段（子元素的 load 不冒泡，只能靠捕获拿到）', () => {
    const onContentLoad = vi.fn();
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const content = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller), contentElement: asElement(content), onContentLoad });
    expect(content.listeners.get('load')?.[0].capture).toBe(true);
    view.dispose();
  });
});

// ───────────────────────── K 释放 ─────────────────────────

describe('BoundedStreamWindow / K dispose：内存泄漏回归', () => {
  it('K1 注销 scrollElement 上的全部监听', () => {
    const { scroller, view } = makeView<string>();
    for (const type of ['scroll', 'pointerdown', 'pointerup', 'pointercancel', 'keydown']) {
      expect(scroller.listenerCount(type)).toBe(1);
    }
    view.dispose();
    for (const type of ['scroll', 'pointerdown', 'pointerup', 'pointercancel', 'keydown']) {
      expect(scroller.listenerCount(type)).toBe(0);
    }
  });

  it('K2 注销 window 级 pointerup/pointercancel 兜底监听（§3.4① 泄漏的回归用例）', () => {
    const doc = new FakeDocument();
    const scroller = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
    expect(viewOf(doc).listenerCount('pointerup')).toBe(1);
    expect(viewOf(doc).listenerCount('pointercancel')).toBe(1);
    view.dispose();
    expect(viewOf(doc).listenerCount('pointerup')).toBe(0);
    expect(viewOf(doc).listenerCount('pointercancel')).toBe(0);
  });

  it('K3 注销 contentElement 上的 click 与 load 捕获监听', () => {
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

  it('K4 宿主文档没有 defaultView 时不挂 window 级监听，dispose 同样不抛错', () => {
    const doc = new FakeDocument({ withView: false });
    const scroller = doc.createElement();
    const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
    expect(() => view.dispose()).not.toThrow();
    expect(scroller.listenerCount('scroll')).toBe(0);
  });

  it('K5 dispose 后 render 是空操作，不再重建 DOM 或抛错', () => {
    const { scroller, view, doc } = makeView<string>();
    view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-a'))] });
    view.dispose();
    expect(() => view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem: () => [asElement(row(doc, 'row-b'))] })).not.toThrow();
    expect(renderedClassNames(scroller)).toEqual(['row-a']);
  });

  it('K7 dispose 幂等：多次调用不抛错、不重复移除', () => {
    const { scroller, view } = makeView<string>();
    expect(() => { view.dispose(); view.dispose(); view.dispose(); }).not.toThrow();
    expect(scroller.listenerCount('scroll')).toBe(0);
  });

  it('K8 dispose 后已排队的下一帧重渲染不会再触碰 DOM（指针按下期间关闭弹窗的场景）', () => {
    withFrames((frames) => {
      const { scroller, view, doc } = makeView<string>();
      const renderItem = (item: string) => [asElement(row(doc, `row-${item}`))];
      view.render({ items: ['a'], keyOf: (s) => s, renderItem });
      scroller.dispatch('pointerdown');
      view.render({ items: ['a', 'b'], keyOf: (s) => s, renderItem }); // 积压一次重渲染
      view.dispose();
      expect(() => frames.run()).not.toThrow();
      expect(renderedClassNames(scroller)).toEqual(['row-a']);
    });
  });

  it('K9 dispose 后若残留的滚动帧调度仍被触发，回调不会再触碰 DOM（白盒守卫验证）', () => {
    withFrames((frames) => {
      const onScroll = vi.fn();
      const { scroller, view } = makeView<string>({ onScroll });
      // 取出组件挂在 scroller 上的 scroll 监听（就是帧调度函数本身）。
      const [scheduleScrollFrame] = capturedListeners(scroller, 'scroll');
      view.dispose();
      // 正常情况下 dispose 已经摘掉监听，这里模拟「浏览器仍派发了一次已排队的事件」。
      scheduleScrollFrame({ type: 'scroll' });
      frames.run();
      expect(onScroll).not.toHaveBeenCalled();
    });
  });

  it('K10 批量创建并 dispose 200 个实例后不残留任何监听（泄漏压力测试）', () => {
    const doc = new FakeDocument();
    for (let i = 0; i < 200; i++) {
      const scroller = doc.createElement();
      const view = new BoundedStreamWindow<string>({ scrollElement: asElement(scroller) });
      view.render({ items: ['a'], keyOf: (s) => s, renderItem: () => [asElement(row(doc))] });
      view.dispose();
      expect(scroller.listenerCount('scroll')).toBe(0);
    }
    expect(viewOf(doc).listenerCount('pointerup')).toBe(0);
    expect(viewOf(doc).listenerCount('pointercancel')).toBe(0);
  });

  it('K11 dispose 清空有键协调缓存，不继续持有条目与 DOM 引用', () => {
    const { view, doc } = makeView<{ id: string }>();
    view.render({
      items: [{ id: 'a' }],
      keyOf: (item) => item.id,
      renderItem: () => [asElement(row(doc, 'row-a'))],
    });
    const cache = (view as unknown as { renderedRows: Map<string, unknown> }).renderedRows;
    expect(cache.size).toBe(1);
    view.dispose();
    expect(cache.size).toBe(0);
  });
});

// ───────────────────────── L 辅助导出 ─────────────────────────

describe('frameScheduler', () => {
  it('L5 同一帧内合并多次调用', () => {
    withFrames((frames) => {
      const fn = vi.fn();
      const schedule = frameScheduler(fn);
      schedule();
      schedule();
      schedule();
      expect(fn).not.toHaveBeenCalled();
      frames.run();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('L6 上一帧执行完之后再次调用会重新排队', () => {
    withFrames((frames) => {
      const fn = vi.fn();
      const schedule = frameScheduler(fn);
      schedule();
      frames.run();
      schedule();
      frames.run();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  it('L7 cancel 后已排队的调用不再执行', () => {
    withFrames((frames) => {
      const fn = vi.fn();
      const schedule = frameScheduler(fn);
      schedule();
      schedule.cancel();
      frames.run();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  it('L8 cancel 之后仍可以重新调度（token 递增而非永久失效）', () => {
    withFrames((frames) => {
      const fn = vi.fn();
      const schedule = frameScheduler(fn);
      schedule();
      schedule.cancel();
      schedule();
      frames.run();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  it('L9 未调度时 cancel 是空操作', () => {
    withFrames((frames) => {
      const fn = vi.fn();
      const schedule = frameScheduler(fn);
      schedule.cancel();
      frames.run();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  it('L10 环境没有 requestAnimationFrame 时同步执行（node 单测环境的默认路径）', () => {
    const fn = vi.fn();
    const schedule = frameScheduler(fn);
    schedule();
    expect(fn).toHaveBeenCalledTimes(1);
    schedule();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
