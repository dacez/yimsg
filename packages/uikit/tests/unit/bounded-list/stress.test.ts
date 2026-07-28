// BoundedList 大数据量与长序列压力测试。
// 分类见 packages/uikit/docs/BoundedList测试方案.md §4.8：
//   A 有界性不变量 / B 长序列滚动 / C 高频事件 / D 极端形态数据 / E 生命周期压力。
//
// 这些用例的共同断言是「不变量」而不是具体数值：
//   ① 窗口条目数 ≤ pageSize × maxPages；
//   ② DOM 条目节点数 == 窗口条目数（有界全量渲染）；
//   ③ 窗口内同一身份至多出现一次；
//   ④ 无论跑多久，实例、监听、注册项都能被 dispose 收干净。

import { describe, expect, it, vi } from 'vitest';
import { createBoundedList } from '../../../src/app/bounded-list/bounded-list';
import { localPageSource } from '../../../src/app/bounded-list/page-source';
import { SelectionStore } from '../../../src/app/bounded-list/selection';
import { registeredBoundedListIds } from '../../../src/app/bounded-list/registry';
import type { BoundedListOptions } from '../../../src/app/bounded-list/types';
import { FakeDocument, asElement, row, viewOf } from './fake-dom';
import { createAnchoredSource, idOf, makeTestItems, type TestItem } from './test-sources';

function createHost() {
  const doc = new FakeDocument();
  const parent = doc.createElement();
  const scroller = doc.createElement();
  parent.appendChild(scroller);
  scroller.clientHeight = 100;
  scroller.scrollHeight = 100000;
  scroller.scrollTop = 500;
  return { doc, parent, scroller };
}
type Host = ReturnType<typeof createHost>;

function baseOptions(
  host: Host,
  source: BoundedListOptions<TestItem, void>['source'],
  overrides: Partial<BoundedListOptions<TestItem, void>> = {},
): BoundedListOptions<TestItem, void> {
  return {
    id: 'stress',
    scrollElement: asElement(host.scroller),
    pageSize: 40,
    maxPages: 5,
    source,
    identityOf: idOf,
    renderItem: (item: TestItem) => [asElement(row(host.doc, `row-${item.id}`))],
    text: { loading: () => '加载中', empty: () => '暂无数据', updatePill: (n: number) => `有更新(${n})` },
    ...overrides,
  };
}

function rowNodes(host: Host) {
  return host.scroller.children.filter((c) => c.className.startsWith('row-'));
}

function assertBounded(host: Host, list: { getState(): { count: number } }, limit: number): void {
  const state = list.getState();
  expect(state.count).toBeLessThanOrEqual(limit);
  const nodes = rowNodes(host);
  expect(nodes).toHaveLength(state.count);
  const keys = nodes.map((n) => n.getAttribute('data-bsw-key'));
  expect(new Set(keys).size).toBe(keys.length);
}

// ───────────────────────── A 有界性不变量 ─────────────────────────

describe('BoundedList 压力 / A 有界性不变量', () => {
  it('A1 10000 条数据从头翻到尾：窗口与 DOM 始终 ≤ pageSize×maxPages，身份始终唯一', async () => {
    const all = makeTestItems(10000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 0)));
    await list.reset({ pinEdge: false });
    let steps = 0;
    while (list.getState().hasMoreAfter) {
      await list.loadMore('forward');
      assertBounded(host, list, 200);
      steps++;
      expect(steps).toBeLessThan(500); // 防跑飞
    }
    expect(steps).toBe(Math.ceil(10000 / 40) - 1);
    expect(list.getState().hasMoreBefore).toBe(true);
    list.dispose();
  });

  it('A2 从中间起步双向翻到两端：两端 hasMore 都收敛为 false 之前不变量恒成立', async () => {
    const all = makeTestItems(4000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 2000), { pageSize: 20, maxPages: 4 }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 60; i++) {
      await list.loadMore(i % 2 === 0 ? 'backward' : 'forward');
      assertBounded(host, list, 80);
    }
    list.dispose();
  });

  it('A3 maxPages=1 的极端配置下窗口永远只有一页', async () => {
    const all = makeTestItems(1000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 0), { pageSize: 10, maxPages: 1 }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 50; i++) {
      await list.loadMore('forward');
      assertBounded(host, list, 10);
    }
    list.dispose();
  });

  it('A4 单页 2000 条的超大页：不裁剪（裁剪按页不按条），DOM 与窗口仍然一一对应', async () => {
    const all = makeTestItems(2000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 0), { pageSize: 2000, maxPages: 2 }));
    await list.reset({ pinEdge: false });
    expect(list.getState().count).toBe(2000);
    expect(rowNodes(host)).toHaveLength(2000);
    list.dispose();
  });

  it('A5 localPageSource 全量 50000 条：翻遍全集只 loadAll 一次，窗口恒有界', async () => {
    const all = makeTestItems(50000);
    const loadAll = vi.fn(async () => all);
    const host = createHost();
    const source = localPageSource<TestItem, void>({ loadAll });
    const list = createBoundedList(baseOptions(host, source, { pageSize: 40, maxPages: 5 }));
    await list.reset({ pinEdge: false });
    let steps = 0;
    while (list.getState().hasMoreAfter && steps < 2000) {
      await list.loadMore('forward');
      steps++;
      if (steps % 200 === 0) assertBounded(host, list, 200);
    }
    expect(list.getState().hasMoreAfter).toBe(false);
    expect(loadAll).toHaveBeenCalledTimes(1);
    assertBounded(host, list, 200);
    list.dispose();
  });
});

// ───────────────────────── B 长序列滚动 ─────────────────────────

describe('BoundedList 压力 / B 长序列滚动', () => {
  it('B1 由触界检测驱动的 200 次来回滚动不越界、不重复、不死循环', async () => {
    // 说明：fake DOM 的 scrollHeight 不随内容增长，所以「滚到某一端」之后每次补页
    // 都仍然判定为贴该端，链式补页会一路拉到那一端的尽头才停——这正是 §2.5 链式补页
    // 循环的极端形态。本用例要证明的就是：它**必然终止**，且过程中不变量恒成立。
    const total = 600;
    const pageSize = 20;
    const all = makeTestItems(total);
    const host = createHost();
    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 2000;
    const fetchSpy = vi.fn(createAnchoredSource(() => all, total / 2).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }, { pageSize, maxPages: 4, reachPx: 50 }));
    await list.reset({ pinEdge: false });

    for (let i = 0; i < 200; i++) {
      host.scroller.scrollTop = i % 2 === 0 ? 10 : 1890; // 交替贴顶 / 贴底
      host.scroller.dispatch('scroll');
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 贴顶那一轮必然一路拉到最前，贴底那一轮必然一路拉到最后。
      expect(i % 2 === 0 ? list.getState().hasMoreBefore : list.getState().hasMoreAfter).toBe(false);
      if (i % 20 === 0) assertBounded(host, list, pageSize * 4);
    }
    assertBounded(host, list, pageSize * 4);
    // 每一轮最多把整个集合翻一遍（total/pageSize 页）再加一页空结果，链条不会失控放大。
    expect(fetchSpy.mock.calls.length).toBeLessThan(200 * (total / pageSize + 2));
    list.dispose();
  });

  it('B2 窗口边界游标始终来自保留页：长序列翻页后仍能正确往回翻', async () => {
    const all = makeTestItems(3000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 0), { pageSize: 25, maxPages: 3 }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 40; i++) await list.loadMore('forward');
    const forwardEndId = list.getState().count;
    expect(forwardEndId).toBeGreaterThan(0);
    const topAfterForward = rowNodes(host)[0].getAttribute('data-bsw-key');

    for (let i = 0; i < 40; i++) await list.loadMore('backward');
    expect(rowNodes(host)[0].getAttribute('data-bsw-key')).toBe('0');
    expect(list.getState().hasMoreBefore).toBe(false);
    expect(Number(topAfterForward)).toBeGreaterThan(0);
    list.dispose();
  });
});

// ───────────────────────── C 高频事件 ─────────────────────────

describe('BoundedList 压力 / C 高频事件', () => {
  it('C1 同一帧内 1000 次 invalidate 只跑一次决策，计数完整累加', () => {
    const queue: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(() => cb(0)); return queue.length; });
    try {
      const items = makeTestItems(100);
      const host = createHost();
      const fetchByIdentity = vi.fn(async () => []);
      const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), { fetchByIdentity }));
      host.scroller.scrollTop = 100;
      for (let i = 0; i < 1000; i++) list.invalidate({ count: 1, identities: [`id-${i % 7}`] });
      expect(queue).toHaveLength(1);
      queue.splice(0).forEach((cb) => cb());
      expect(list.getState().pendingCount).toBe(1000);
      expect(fetchByIdentity).not.toHaveBeenCalled(); // 这些身份都不在窗口内
      list.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('C2 连续 2000 次 upsertLocal：窗口与 DOM 始终受 pageSize×maxPages 硬预算约束', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => makeTestItems(40), 0), { freshEdge: 'tail', pageSize: 40, maxPages: 5 }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 2000; i++) list.upsertLocal({ id: 10000 + i, label: `local-${i}` });
    const state = list.getState();
    expect(state.count).toBe(40 * 5);
    expect(rowNodes(host)).toHaveLength(state.count);
    expect(state.hasMoreAfter).toBe(false);
    expect(rowNodes(host).at(-1)?.className).toContain('row-11999');
    list.dispose();
  });

  it('C3 1000 次 patch + 1000 次 removeLocal 后窗口自洽', async () => {
    const items = makeTestItems(1000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), { pageSize: 1000, maxPages: 1 }));
    await list.reset({ pinEdge: false });
    expect(list.getState().count).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(list.patch(String(i), (item) => ({ ...item, label: `p-${i}` }))).toBe(true);
    for (let i = 0; i < 1000; i++) expect(list.removeLocal(String(i))).toBe(true);
    expect(list.getState().count).toBe(0);
    expect(rowNodes(host)).toHaveLength(0);
    expect(list.removeLocal('0')).toBe(false);
    list.dispose();
  });

  it('C4 500 个共享同一 SelectionStore 的选中项：勾选 / 取消都及时反映到 RenderItemContext', async () => {
    const items = makeTestItems(500);
    const host = createHost();
    const store = new SelectionStore(500);
    const selectedFlags = new Map<string, boolean>();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), {
      pageSize: 500,
      maxPages: 1,
      selection: { mode: 'multi', store },
      renderItem: (item, ctx) => { selectedFlags.set(ctx.identity, ctx.selected); return [asElement(row(host.doc, `row-${item.id}`))]; },
    }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 500; i++) store.toggle(String(i));
    expect(store.size).toBe(500);
    expect([...selectedFlags.values()].every(Boolean)).toBe(true);
    store.clear();
    expect([...selectedFlags.values()].some(Boolean)).toBe(false);
    list.dispose();
  });

  it('C5 1000 次 render() 调用（display:updated 高频到达）不产生任何请求', async () => {
    const items = makeTestItems(200);
    const host = createHost();
    const fetchSpy = vi.fn(createAnchoredSource(() => items, 0).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }, { pageSize: 200, maxPages: 1 }));
    await list.reset({ pinEdge: false });
    fetchSpy.mockClear();
    for (let i = 0; i < 1000; i++) list.render();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rowNodes(host)).toHaveLength(200);
    list.dispose();
  });
});

// ───────────────────────── D 极端形态数据 ─────────────────────────

describe('BoundedList 压力 / D 极端形态数据', () => {
  it('D1 身份键极长（10KB）时去重与锚点仍然正确', async () => {
    const long = 'x'.repeat(10000);
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), {
      pageSize: 10,
      maxPages: 1,
      identityOf: (item) => `${long}-${item.id}`,
    }));
    await list.reset({ pinEdge: false });
    expect(rowNodes(host)[0].getAttribute('data-bsw-key')).toBe(`${long}-0`);
    expect(list.scrollToIdentity(`${long}-3`)).toBe(true);
    expect(list.patch(`${long}-3`, (item) => item)).toBe(true);
    list.dispose();
  });

  it('D2 全部条目身份相同（异常数据）时跨页去重把窗口收敛成一条', async () => {
    const items = makeTestItems(100);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), {
      pageSize: 10,
      maxPages: 5,
      identityOf: () => 'same',
    }));
    await list.reset({ pinEdge: false });
    expect(list.getState().count).toBe(10); // 页内重复不由去重负责
    await list.loadMore('forward');
    // 新页把旧页里的同身份条目全删掉，只剩新页那 10 条。
    expect(list.getState().count).toBe(10);
    expect(rowNodes(host)).toHaveLength(10);
    list.dispose();
  });

  it('D3 renderItem 每行返回 5 个节点时，DOM 节点数正比于窗口条目数而非数据总量', async () => {
    const items = makeTestItems(10000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), {
      pageSize: 40,
      maxPages: 5,
      renderItem: (item) => Array.from({ length: 5 }, (_, i) => asElement(row(host.doc, `row-${item.id}-${i}`))),
    }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 20; i++) await list.loadMore('forward');
    expect(list.getState().count).toBe(200);
    expect(host.scroller.children).toHaveLength(200 * 5);
    list.dispose();
  });

  it('D4 normalize 把整页压缩到 1 条时窗口计数与 DOM 同步收敛', async () => {
    const items = makeTestItems(1000);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), {
      pageSize: 100,
      maxPages: 3,
      normalize: (input) => (input.length ? [input[0]] : []),
    }));
    await list.reset({ pinEdge: false });
    for (let i = 0; i < 5; i++) await list.loadMore('forward');
    expect(list.getState().count).toBe(3); // 3 页 × 每页 1 条
    expect(rowNodes(host)).toHaveLength(3);
    list.dispose();
  });
});

// ───────────────────────── E 生命周期压力 ─────────────────────────

describe('BoundedList 压力 / E 生命周期', () => {
  it('E1 200 次「打开面板 → 翻页 → 关闭面板」循环后不残留监听、DOM 与注册项', async () => {
    const before = registeredBoundedListIds().length;
    const items = makeTestItems(500);
    for (let i = 0; i < 200; i++) {
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), { id: `panel-${i}`, pageSize: 20, maxPages: 3 }));
      await list.reset({ pinEdge: false });
      await list.loadMore('forward');
      list.dispose();
      expect(host.scroller.listenerCount('scroll')).toBe(0);
      expect(host.scroller.listenerCount('click')).toBe(0);
      expect(viewOf(host.doc).listenerCount('pointerup')).toBe(0);
      expect(host.parent.children).toHaveLength(1); // 提示条被摘除
    }
    expect(registeredBoundedListIds().length).toBe(before);
  });

  it('E2 100 个实例同时存活并共享一个 SelectionStore：全部 dispose 后 store 不再有订阅者', async () => {
    const items = makeTestItems(20);
    const store = new SelectionStore();
    const lists: Array<{ dispose(): void }> = [];
    const renderCounts: Array<() => number> = [];
    for (let i = 0; i < 100; i++) {
      const host = createHost();
      let renders = 0;
      const list = createBoundedList(baseOptions(host, createAnchoredSource(() => items, 0), {
        id: `shared-${i}`,
        pageSize: 20,
        maxPages: 1,
        selection: { mode: 'multi', store },
        renderItem: (item) => { renders++; return [asElement(row(host.doc, `row-${item.id}`))]; },
      }));
      await list.reset({ pinEdge: false });
      lists.push(list);
      renderCounts.push(() => renders);
    }
    const beforeToggle = renderCounts.map((f) => f());
    store.toggle('1');
    expect(renderCounts.map((f) => f()).every((n, i) => n > beforeToggle[i])).toBe(true);

    for (const list of lists) list.dispose();
    const afterDispose = renderCounts.map((f) => f());
    store.toggle('2');
    expect(renderCounts.map((f) => f())).toEqual(afterDispose); // 没有实例再重渲
  });
});
