// BoundedList（组件外壳）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.5：
//   A 构造与默认值 / B 首屏与 reset / C 续翻与触界 / D setQuery 防抖
//   E invalidate 决策 / F 提示条 / G 本地层 / H 渲染与文案
//   I 交互与选中态 / J 错误处理 / K 释放 / L 只读状态。

import { describe, expect, it, vi } from 'vitest';
import { createBoundedList } from '../../../src/app/bounded-list/bounded-list';
import { localPageSource } from '../../../src/app/bounded-list/page-source';
import { SelectionStore } from '../../../src/app/bounded-list/selection';
import type { BoundedListOptions } from '../../../src/app/bounded-list/types';
import { FakeDocument, asElement, row, type FakeElement } from './fake-dom';
import {
  createAnchoredSource,
  createControllableFetcher,
  createControllableSource,
  createInstantSource,
  createOptimisticSource,
  idOf,
  makeTestItems,
  pageOf,
  type TestItem,
} from './test-sources';

/**
 * 测试自持的注册表：组件的 `register` 是必填参数、注册表实体由宿主持有，
 * 所以注册 / 注销的生命周期断言对这一份做，而不是对一个进程级全局做。
 */
const testRegistry = new Map<string, { readonly id: string; invalidate(): void | Promise<void> }>();

function testRegister(instance: { readonly id: string; invalidate(): void | Promise<void> }): () => void {
  testRegistry.set(instance.id, instance);
  return () => {
    if (testRegistry.get(instance.id) === instance) testRegistry.delete(instance.id);
  };
}

function createHost() {
  const doc = new FakeDocument();
  const parent = doc.createElement();
  const scroller = doc.createElement();
  parent.appendChild(scroller);
  scroller.clientHeight = 100;
  // fake DOM 不会像浏览器那样随内容自动撑高 scrollHeight：给一个远大于 clientHeight 的值，
  // 避免「内容不足一屏」的链式补页在与分页无关的用例里意外触发。
  scroller.scrollHeight = 100000;
  // 默认停在既不贴顶也不贴底的位置，避免触界补页在与滚动位置无关的用例里意外触发；
  // 关心贴边行为的用例自行设置 scrollTop 或依赖 reset 的贴边。
  scroller.scrollTop = 500;
  return { doc, parent, scroller };
}

type Host = ReturnType<typeof createHost>;

/** 用户滚到既不贴顶也不贴底的位置（reset 会把 scrollTop 摁回 0，所以要在 reset 之后调用）。 */
function scrollAway(host: Host): void {
  host.scroller.scrollTop = 500;
}

/** 等微任务与一次宏任务边界都落定。 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseOptions(
  host: Host,
  source: BoundedListOptions<TestItem, void>['source'],
  overrides: Partial<BoundedListOptions<TestItem, void>> = {},
): BoundedListOptions<TestItem, void> {
  return {
    id: 'test-list',
    scrollElement: asElement(host.scroller),
    register: testRegister,
    pageSize: 3,
    maxPages: 2,
    source,
    identityOf: idOf,
    renderItem: (item: TestItem) => [asElement(row(host.doc, `row-${item.id}`))],
    // 默认不提供边界文案：多数用例只关心「行」，边界提示会插入额外节点。
    text: {
      loading: () => '加载中',
      empty: () => '暂无数据',
      updatePill: () => '有更新',
    },
    ...overrides,
  };
}

function rendered(host: Host): string[] {
  return host.scroller.children.map((c) => c.className);
}

function renderedRows(host: Host): string[] {
  return rendered(host).filter((cls) => cls.startsWith('row-'));
}

function pillOf(host: Host): FakeElement {
  return host.parent.children[1];
}

function pillVisible(host: Host): boolean {
  return !pillOf(host).classList.contains('hidden');
}

// ───────────────────────── A 构造与默认值 ─────────────────────────

describe('BoundedList / A 构造与默认值', () => {
  it('A1 非法 pageSize / maxPages 在构造期抛错', () => {
    const host = createHost();
    const source = createInstantSource(() => makeTestItems(3));
    expect(() => createBoundedList(baseOptions(host, source, { pageSize: 0 }))).toThrow(RangeError);
    expect(() => createBoundedList(baseOptions(host, source, { maxPages: 0 }))).toThrow(RangeError);
    expect(() => createBoundedList(baseOptions(host, source, { pageSize: 1.5 }))).toThrow(RangeError);
  });

  it('A2 selection.store 与 selection.max 互斥', () => {
    const host = createHost();
    const source = createInstantSource(() => makeTestItems(3));
    expect(() => createBoundedList(baseOptions(host, source, {
      selection: { mode: 'multi', store: new SelectionStore(), max: 3 },
    }))).toThrow(TypeError);
  });

  it('A3 构造即登记到宿主注册表，dispose 时注销', () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => [])));
    expect(testRegistry.has('test-list')).toBe(true);
    list.dispose();
    expect(testRegistry.has('test-list')).toBe(false);
  });

  it('A4 不改写宿主容器上的任何属性', () => {
    const host = createHost();
    host.scroller.setAttribute('role', 'grid');
    const list = createBoundedList(baseOptions(host, createInstantSource(() => []), {
      selection: { mode: 'multi' },
    }));

    // 组件不再接管容器语义（无键盘导航，写 role/tabindex 只会给出无法操作的假承诺）。
    expect(host.scroller.getAttribute('role')).toBe('grid');
    expect(host.scroller.getAttribute('tabindex')).toBeNull();
    expect(host.scroller.getAttribute('aria-multiselectable')).toBeNull();

    list.dispose();
    expect(host.scroller.getAttribute('role')).toBe('grid');
  });
});

// ───────────────────────── B 首屏与 reset ─────────────────────────

describe('BoundedList / B 首屏与 reset', () => {
  it('B1 reset 拉首页并渲染，状态落定为 loaded', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(6), { withTotal: true })));
    await list.reset();

    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
    const state = list.getState();
    expect(state.loaded).toBe(true);
    expect(state.count).toBe(3);
    expect(state.total).toBe(6);
    expect(state.hasMoreTail).toBe(true);
    list.dispose();
  });

  it('B2 首页为空时显示空态；空态文案每次渲染都向调用方重新求值', async () => {
    const host = createHost();
    let keyword = '';
    const list = createBoundedList({
      ...baseOptions(host, createInstantSource(() => [])),
      // 组件不判断「什么算已过滤」：调用方自己按搜索框当前值给文案。
      text: { loading: () => '加载中', empty: () => (keyword ? '无搜索结果' : '暂无数据') },
    } as BoundedListOptions<TestItem, string>);
    await list.reset();
    expect(rendered(host)).toEqual(['empty-state']);
    expect(host.scroller.children[0].textContent).toBe('暂无数据');

    keyword = 'kw';
    await list.reset({ query: 'kw' as never });
    expect(host.scroller.children[0].textContent).toBe('无搜索结果');
    list.dispose();
  });

  it('B3 reset 默认贴回新鲜端', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(6))));
    scrollAway(host);
    await list.reset();
    expect(host.scroller.scrollTop).toBe(0);
    list.dispose();
  });

  it('B4 后发的 reset 使先发的响应作废，窗口只反映最后一次', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));

    void list.reset();
    void list.reset();
    pending[1].resolve(pageOf(makeTestItems(2, 10), 'c0', 'c2', false, false));
    pending[0].resolve(pageOf(makeTestItems(2), 'c0', 'c2', false, false));
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-10', 'row-11']);
    list.dispose();
  });

  it('B5 reset 清空本地层：上一世代的本端写入不会带进新窗口', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2))));
    await list.reset();
    list.upsertLocal({ id: 99, label: 'local' });
    expect(renderedRows(host)).toEqual(['row-99', 'row-0', 'row-1']);

    await list.reset();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });
});

// ───────────────────────── C 续翻与触界 ─────────────────────────

describe('BoundedList / C 续翻与触界', () => {
  it('C1 loadMore 向尾部续翻并入一页', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(9))));
    await list.reset();
    scrollAway(host);
    await list.loadMore('tail');

    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
    list.dispose();
  });

  it('C2 超过 maxPages 后整页淘汰，条目数恒有界', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(30))));
    await list.reset();
    scrollAway(host);
    for (let i = 0; i < 5; i++) await list.loadMore('tail');

    expect(list.getState().count).toBeLessThanOrEqual(6);
    expect(list.getState().hasMoreHead).toBe(true);
    list.dispose();
  });

  it('C3 双向续翻：锚点首页两端都能翻', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => makeTestItems(12), 6)));
    // pinEdge:false → 停在当前位置，两端都不在触界范围内，续翻完全由显式调用驱动。
    await list.reset({ pinEdge: false });
    expect(renderedRows(host)).toEqual(['row-6', 'row-7', 'row-8']);

    await list.loadMore('head');
    expect(renderedRows(host)).toEqual(['row-3', 'row-4', 'row-5', 'row-6', 'row-7', 'row-8']);
    list.dispose();
  });

  it('C4 单飞：已有请求在飞时的续翻请求被放弃，不会并发打两次', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, true));
    await flushAsync();
    scrollAway(host);

    const before = pending.length;
    void list.loadMore('tail');
    void list.loadMore('tail');
    expect(pending.length).toBe(before + 1);
    list.dispose();
  });

  it('C5 触界自动补页：贴在新鲜端一侧时链式补齐', async () => {
    const host = createHost();
    host.scroller.scrollHeight = 1000;
    host.scroller.scrollTop = 900;
    // order='asc' → 新鲜端在尾部，reset 贴底，尾端持续处于触界范围内。
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(9)), { order: 'asc' }));
    await list.reset();
    await flushAsync();
    await flushAsync();

    expect(list.getState().count).toBe(6);
    expect(list.getState().hasMoreTail).toBe(false);
    list.dispose();
  });

  it('C6 续翻拿到空页时该端收敛为「没有更多」，不会无限补页', async () => {
    const host = createHost();
    host.scroller.scrollHeight = 1000;
    host.scroller.scrollTop = 900;
    const fetchSpy = vi.fn();
    const inner = createOptimisticSource(() => makeTestItems(3));
    const list = createBoundedList(baseOptions(host, {
      fetch: (req) => { fetchSpy(req.cursor); return inner.fetch(req); },
    }, { order: 'asc' }));
    await list.reset();
    await flushAsync();
    await flushAsync();

    expect(list.getState().hasMoreTail).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    list.dispose();
  });

  it('C7 窗口已满且内容撑不满视口（如列表被隐藏）时停止自动补页', async () => {
    const host = createHost();
    host.scroller.clientHeight = 0;
    host.scroller.scrollHeight = 0; // 隐藏容器：两端都被判定为触界
    host.scroller.scrollTop = 0;
    const fetchSpy = vi.fn();
    const inner = createInstantSource(() => makeTestItems(100));
    const list = createBoundedList(baseOptions(host, {
      fetch: (req) => { fetchSpy(); return inner.fetch(req); },
    }));
    await list.reset();
    await flushAsync();
    await flushAsync();

    // 首页 + 补满窗口所需的一页，之后停手（不会为了填一个 0 高度的视口无限翻页）。
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(list.getState().count).toBe(6);
    list.dispose();
  });
});

// ───────────────────────── D setQuery 防抖 ─────────────────────────

describe('BoundedList / D setQuery 防抖', () => {
  it('D1 防抖窗口内的多次输入只触发一次重拉，且用最后一个关键字', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      const queries: string[] = [];
      const list = createBoundedList<TestItem, string>({
        ...baseOptions(host, createInstantSource(() => makeTestItems(3))) as unknown as BoundedListOptions<TestItem, string>,
        initialQuery: '',
        source: {
          fetch: async (req) => {
            queries.push(req.query);
            return pageOf(makeTestItems(1), 'c0', 'c1', false, false);
          },
        },
      });
      list.setQuery('a');
      list.setQuery('ab');
      vi.advanceTimersByTime(299);
      expect(queries).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(queries).toEqual(['ab']);
      list.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D2 debounceMs<=0 时立即重拉', async () => {
    const host = createHost();
    const queries: string[] = [];
    const list = createBoundedList<TestItem, string>({
      ...baseOptions(host, createInstantSource(() => makeTestItems(3))) as unknown as BoundedListOptions<TestItem, string>,
      initialQuery: '',
      source: {
        fetch: async (req) => {
          queries.push(req.query);
          return pageOf(makeTestItems(1), 'c0', 'c1', false, false);
        },
      },
    });
    list.setQuery('x', { debounceMs: 0 });
    await flushAsync();
    expect(queries).toEqual(['x']);
    list.dispose();
  });

  it('D3 dispose 时取消未触发的防抖', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      const fetch = vi.fn(async () => pageOf([], 'c0', 'c0', false, false));
      const list = createBoundedList<TestItem, string>({
        ...baseOptions(host, { fetch }) as unknown as BoundedListOptions<TestItem, string>,
        initialQuery: '',
      });
      list.setQuery('a');
      list.dispose();
      vi.advanceTimersByTime(500);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────── E invalidate 决策 ─────────────────────────

describe('BoundedList / E invalidate 决策', () => {
  it('E1 贴着新鲜端时直接追平重拉，提示条不出现', async () => {
    const host = createHost();
    let all = makeTestItems(3);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    await list.reset();
    expect(host.scroller.scrollTop).toBe(0);

    all = [{ id: 9, label: 'item-9' }, ...all];
    list.invalidate();
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-9', 'row-0', 'row-1']);
    expect(list.getState().stale).toBe(false);
    expect(pillVisible(host)).toBe(false);
    list.dispose();
  });

  it('E2 用户滚离新鲜端时只点亮提示条，不重排', async () => {
    const host = createHost();
    let all = makeTestItems(3);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    await list.reset();
    scrollAway(host);

    all = [{ id: 9, label: 'item-9' }, ...all];
    list.invalidate();
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(list.getState().stale).toBe(true);
    expect(pillVisible(host)).toBe(true);
    expect(pillOf(host).textContent).toBe('有更新');
    list.dispose();
  });

  it('E3 列表不可见时只点亮提示条，即便贴着新鲜端也不重拉', async () => {
    const host = createHost();
    const fetchSpy = vi.fn();
    const inner = createInstantSource(() => makeTestItems(3));
    const list = createBoundedList(baseOptions(host, { fetch: (req) => { fetchSpy(); return inner.fetch(req); } }, {
      isActive: () => false,
    }));
    await list.reset();
    fetchSpy.mockClear();

    list.invalidate();
    await flushAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(list.getState().stale).toBe(true);
    list.dispose();
  });

  it('E4 用户滚回新鲜端时自动追平并熄灭提示条', async () => {
    const host = createHost();
    let all = makeTestItems(3);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    await list.reset();
    scrollAway(host);
    all = [{ id: 9, label: 'item-9' }, ...all];
    list.invalidate();
    await flushAsync();
    expect(pillVisible(host)).toBe(true);

    host.scroller.scrollTop = 0;
    host.scroller.dispatch('scroll');
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-9', 'row-0', 'row-1']);
    expect(pillVisible(host)).toBe(false);
    list.dispose();
  });

  it('E5 未贴边时对窗口内受影响身份定向刷新，不重排', async () => {
    const host = createHost();
    const fetcher = createControllableFetcher<TestItem>();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      fetchByIdentity: fetcher.fetchByIdentity,
    }));
    await list.reset();
    scrollAway(host);

    list.invalidate({ identities: ['1', '404'] });
    await flushAsync();
    // 只请求仍在窗口内的身份。
    expect(fetcher.calls).toEqual([['1']]);

    fetcher.settle(0, [{ id: 1, label: 'refreshed' }]);
    await flushAsync();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('E6 定向刷新拉不到的身份视为已删除，就地摘掉', async () => {
    const host = createHost();
    const fetcher = createControllableFetcher<TestItem>();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      fetchByIdentity: fetcher.fetchByIdentity,
    }));
    await list.reset();
    scrollAway(host);

    list.invalidate({ identities: ['1'] });
    await flushAsync();
    fetcher.settle(0, []);
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-0', 'row-2']);
    list.dispose();
  });

  it('E7 回归：请求在飞期间到达的通知不会让提示条闪一下', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, false));
    await flushAsync();
    expect(host.scroller.scrollTop).toBe(0); // 贴着新鲜端

    // 追平请求在飞时又收到一条通知：此刻既不能追平，也绝不能点亮提示条。
    list.invalidate();
    await flushAsync();
    expect(pending).toHaveLength(2);
    list.invalidate();
    await flushAsync();
    expect(pillVisible(host)).toBe(false);
    expect(list.getState().stale).toBe(false);

    pending[1].resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, false));
    await flushAsync();
    // 落地后重新决策：仍贴边 → 再追平一次，全程提示条不亮。
    expect(pillVisible(host)).toBe(false);
    pending[2]?.resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, false));
    await flushAsync();
    expect(pillVisible(host)).toBe(false);
    list.dispose();
  });

  it('E8 同一帧内多次 invalidate 只做一次决策', async () => {
    const host = createHost();
    const fetchSpy = vi.fn();
    const inner = createInstantSource(() => makeTestItems(3));
    const list = createBoundedList(baseOptions(host, { fetch: (req) => { fetchSpy(); return inner.fetch(req); } }));
    await list.reset();
    fetchSpy.mockClear();

    list.invalidate();
    list.invalidate();
    list.invalidate();
    await flushAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    list.dispose();
  });

  it('E9 追平保留当前窗口直到新首页落地，中途不闪空', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, false));
    await flushAsync();

    list.invalidate();
    await flushAsync();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);

    pending[1].resolve(pageOf(makeTestItems(2, 5), 'c0', 'c2', false, false));
    await flushAsync();
    expect(renderedRows(host)).toEqual(['row-5', 'row-6']);
    list.dispose();
  });
});

// ───────────────────────── F 提示条 ─────────────────────────

describe('BoundedList / F 提示条', () => {
  it('F1 点击提示条立即追平并贴回新鲜端', async () => {
    const host = createHost();
    let all = makeTestItems(3);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    await list.reset();
    scrollAway(host);
    all = [{ id: 9, label: 'item-9' }, ...all];
    list.invalidate();
    await flushAsync();
    expect(pillVisible(host)).toBe(true);

    pillOf(host).dispatch('click');
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-9', 'row-0', 'row-1']);
    expect(host.scroller.scrollTop).toBe(0);
    expect(pillVisible(host)).toBe(false);
    list.dispose();
  });

  it('F2 没有提供 updatePill 文案时不出现空白提示条', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      text: { loading: () => '加载中', empty: () => '暂无数据' },
    }));
    await list.reset();
    scrollAway(host);
    list.invalidate();
    await flushAsync();

    expect(list.getState().stale).toBe(true);
    expect(pillVisible(host)).toBe(false);
    list.dispose();
  });

  it('F3 pillHost=false 时不创建任何提示条 DOM', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), { pillHost: false }));
    await list.reset();
    expect(host.parent.children).toHaveLength(1);
    list.dispose();
  });
});

// ───────────────────────── G 本地层 ─────────────────────────

describe('BoundedList / G 本地层', () => {
  it('G1 upsertLocal 立即可见，落在新鲜端（desc → 头部）', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3))));
    await list.reset();

    list.upsertLocal({ id: 99, label: 'local' });
    expect(renderedRows(host)).toEqual(['row-99', 'row-0', 'row-1', 'row-2']);
    list.dispose();
  });

  it('G2 order=asc 时 upsertLocal 落在尾部', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), { order: 'asc' }));
    await list.reset();

    list.upsertLocal({ id: 99, label: 'local' });
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2', 'row-99']);
    list.dispose();
  });

  it('G3 upsertLocal 已在窗口里的身份 = 移到新鲜端并改内容（会话置顶）', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3))));
    await list.reset();

    list.upsertLocal({ id: 2, label: 'promoted' });
    expect(renderedRows(host)).toEqual(['row-2', 'row-0', 'row-1']);
    list.dispose();
  });

  it('G4 窗口还没追平新鲜端时也照样立即可见（本端写入不猜位置、不点提示条）', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => makeTestItems(12), 6)));
    await list.reset({ pinEdge: false });
    expect(list.getState().hasMoreHead).toBe(true);

    list.upsertLocal({ id: 99, label: 'local' });
    expect(renderedRows(host)[0]).toBe('row-99');
    expect(list.getState().stale).toBe(false);
    list.dispose();
  });

  it('G5 removeLocal 立即消失并返回是否曾可见', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3))));
    await list.reset();

    expect(list.removeLocal('1')).toBe(true);
    expect(renderedRows(host)).toEqual(['row-0', 'row-2']);
    expect(list.removeLocal('404')).toBe(false);
    list.dispose();
  });

  it('G6 本端写入在权威首页落地后让位给服务端事实', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    pending[0].resolve(pageOf(makeTestItems(2), 'c0', 'c2', false, false));
    await flushAsync();

    list.upsertLocal({ id: 9, label: 'optimistic' });
    expect(renderedRows(host)).toEqual(['row-9', 'row-0', 'row-1']);

    list.invalidate();
    await flushAsync();
    pending[1].resolve(pageOf([{ id: 9, label: 'server' }, ...makeTestItems(2)], 'c0', 'c3', false, false));
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-9', 'row-0', 'row-1']);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('G7 请求在飞期间的本端写入不会被这次响应吞掉', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    pending[0].resolve(pageOf(makeTestItems(2), 'c0', 'c2', false, false));
    await flushAsync();

    list.invalidate();
    await flushAsync();
    // 首页请求已经发出，此时本端又写入一条。
    list.upsertLocal({ id: 9, label: 'sent-during-refresh' });
    pending[1].resolve(pageOf(makeTestItems(2), 'c0', 'c2', false, false));
    await flushAsync();

    expect(renderedRows(host)).toEqual(['row-9', 'row-0', 'row-1']);
    list.dispose();
  });

  it('G8 乐观发送的完整流程：占位 → 撤回占位 → 落地真实条目', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), { order: 'asc' }));
    await list.reset();

    list.upsertLocal({ id: -1, label: 'pending' });
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row--1']);

    list.removeLocal('-1');
    list.upsertLocal({ id: 7, label: 'sent' });
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-7']);
    list.dispose();
  });
});

// ───────────────────────── H 渲染与文案 ─────────────────────────

describe('BoundedList / H 渲染与文案', () => {
  it('H1 pinnedItems 钉在头部，且被同身份的窗口条目顶掉', async () => {
    const host = createHost();
    let pinned: TestItem[] = [{ id: 100, label: 'pinned' }];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), {
      pinnedItems: () => pinned,
    }));
    await list.reset();
    expect(renderedRows(host)).toEqual(['row-100', 'row-0', 'row-1']);

    pinned = [{ id: 1, label: 'dup' }];
    list.render();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });

  it('H2 onItemsChanged 报出的就是真正渲染的那份序列（含 pinned 与本地层）', async () => {
    const host = createHost();
    const seen: string[][] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), {
      pinnedItems: () => [{ id: 100, label: 'pinned' }],
      onItemsChanged: (items) => seen.push(items.map((i) => String(i.id))),
    }));
    await list.reset();
    list.upsertLocal({ id: 9, label: 'local' });

    expect(seen[seen.length - 1]).toEqual(['100', '9', '0', '1']);
    list.dispose();
  });

  it('H3 边界文案只在该端确实没有更多时出现', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(6)), {
      text: {
        loading: () => '加载中',
        headBoundary: () => '到顶了',
        tailBoundary: () => '到底了',
      },
    }));
    await list.reset();
    expect(rendered(host)).toEqual(['list-boundary-hint list-boundary-hint-top', 'row-0', 'row-1', 'row-2']);
    list.dispose();
  });

  it('H4 renderItem 拿到的上下文包含身份与上一条，不含行下标', async () => {
    const host = createHost();
    const contexts: Array<{ identity: string; previous?: number }> = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      renderItem: (item, ctx) => {
        contexts.push({ identity: ctx.identity, previous: ctx.previous?.id });
        return [asElement(row(host.doc, `row-${item.id}`))];
      },
    }));
    await list.reset();

    expect(contexts).toEqual([
      { identity: '0', previous: undefined },
      { identity: '1', previous: 0 },
      { identity: '2', previous: 1 },
    ]);
    list.dispose();
  });

  it('H4b beforeRender 每轮渲染前拿到本轮完整序列，只调用一次', async () => {
    const host = createHost();
    const batches: string[][] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      beforeRender: (items) => batches.push(items.map((item) => idOf(item))),
    }));
    await list.reset();

    // 首页落地那一轮拿到的就是真正渲染出来的三条。
    expect(batches.at(-1)).toEqual(['0', '1', '2']);
    const before = batches.length;
    list.render();
    expect(batches.length).toBe(before + 1);
    expect(batches.at(-1)).toEqual(['0', '1', '2']);
    list.dispose();
  });

  it('H5 render() 显式重绘会重跑每一行的 renderItem', async () => {
    const host = createHost();
    const renderItem = vi.fn((item: TestItem) => [asElement(row(host.doc, `row-${item.id}`))]);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), { renderItem }));
    await list.reset();
    renderItem.mockClear();

    list.render();
    expect(renderItem).toHaveBeenCalledTimes(2);
    list.dispose();
  });
});

// ───────────────────────── I 交互与选中态 ─────────────────────────

describe('BoundedList / I 交互与选中态', () => {
  it('I1 无选中态时点击直接激活', async () => {
    const host = createHost();
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), { onActivate }));
    await list.reset();

    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.anything());
    list.dispose();
  });

  it('I2 单选点击替换选中集并激活', async () => {
    const host = createHost();
    const snapshots: string[][] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), {
      selection: { mode: 'single' },
      onSelectionChange: (s) => snapshots.push([...s.ids]),
    }));
    await list.reset();

    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(snapshots[snapshots.length - 1]).toEqual(['1']);
    list.dispose();
  });

  it('I3 多选达上限时拒绝并回调 onExceed', async () => {
    const host = createHost();
    const onExceed = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      selection: { mode: 'multi', max: 1, onExceed },
    }));
    await list.reset();

    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(onExceed).toHaveBeenCalledTimes(1);
    list.dispose();
  });

  it('I4 共享 SelectionStore 的两个实例互相同步重渲', async () => {
    const store = new SelectionStore();
    const hostA = createHost();
    const hostB = createHost();
    const changed: number[] = [];
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => makeTestItems(2)), {
      id: 'a', selection: { mode: 'multi', store },
    }));
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => makeTestItems(2)), {
      id: 'b', selection: { mode: 'multi', store }, onSelectionChange: (s) => changed.push(s.count),
    }));
    await listA.reset();
    await listB.reset();

    hostA.scroller.dispatch('click', { target: hostA.scroller.children[0] });
    expect(changed[changed.length - 1]).toBe(1);
    listA.dispose();
    listB.dispose();
  });

  it('I5 removeLocal 只摘掉被删身份的选中项', async () => {
    const store = new SelectionStore();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      selection: { mode: 'multi', store },
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    host.scroller.dispatch('click', { target: host.scroller.children[1] });

    list.removeLocal('0');
    expect([...store.snapshotIds()]).toEqual(['1']);
    list.dispose();
  });
});

// ───────────────────────── J 错误处理 ─────────────────────────

describe('BoundedList / J 错误处理', () => {
  it('J1 首屏失败进入错误态，提示条充当重试入口', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, {
      onError,
      text: {
        loading: () => '加载中',
        empty: () => '暂无数据',
        error: () => '加载失败',
        retry: () => '重试',
      },
    }));
    void list.reset();
    pending[0].reject(new Error('boom'));
    await flushAsync();

    expect(list.getState().failed).toBe(true);
    expect(list.getState().loaded).toBe(true);
    expect(rendered(host)).toEqual(['list-error-state']);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'reset');
    expect(pillOf(host).textContent).toBe('重试');
    expect(pillVisible(host)).toBe(true);

    pillOf(host).dispatch('click');
    pending[1].resolve(pageOf(makeTestItems(2), 'c0', 'c2', false, false));
    await flushAsync();
    expect(list.getState().failed).toBe(false);
    expect(renderedRows(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });

  it('J2 首屏失败不自动重试（不会打成请求风暴）', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    pending[0].reject(new Error('boom'));
    await flushAsync();
    await flushAsync();

    expect(pending).toHaveLength(1);
    list.dispose();
  });

  it('J3 续翻失败后暂停该端的自动补页，显式 loadMore 解除', async () => {
    const host = createHost();
    host.scroller.scrollHeight = 1000;
    host.scroller.scrollTop = 900;
    const { source, pending } = createControllableSource<TestItem, void>();
    const onError = vi.fn();
    // order='asc' → reset 贴底，尾端持续处于触界范围内。
    const list = createBoundedList(baseOptions(host, source, { onError, order: 'asc' }));
    void list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, true));
    await flushAsync();

    // 首页落地后自动补页 → 失败 → 该端被暂停，不会在同一帧里无限重试。
    pending[1].reject(new Error('page failed'));
    await flushAsync();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'tail');
    const afterFailure = pending.length;
    await flushAsync();
    expect(pending).toHaveLength(afterFailure);

    // 显式 loadMore 视为用户主动重试，解除暂停。
    void list.loadMore('tail');
    expect(pending.length).toBe(afterFailure + 1);
    list.dispose();
  });

  it('J4 定向刷新失败只上报，不影响窗口', async () => {
    const host = createHost();
    const fetcher = createControllableFetcher<TestItem>();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      fetchByIdentity: fetcher.fetchByIdentity,
      onError,
    }));
    await list.reset();
    scrollAway(host);
    list.invalidate({ identities: ['1'] });
    await flushAsync();

    fetcher.fail(0, new Error('refresh failed'));
    await flushAsync();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'refresh');
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
    list.dispose();
  });

  it('J5 没有 onError 时降级为 console.warn，不抛到调用方', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host = createHost();
      const { source, pending } = createControllableSource<TestItem, void>();
      const list = createBoundedList(baseOptions(host, source));
      void list.reset();
      pending[0].reject(new Error('boom'));
      await flushAsync();
      expect(warn).toHaveBeenCalled();
      list.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});

// ───────────────────────── K 释放 ─────────────────────────

describe('BoundedList / K 释放', () => {
  it('K1 dispose 之后所有命令式接口都是空操作', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3))));
    await list.reset();
    const before = rendered(host);
    list.dispose();

    await list.reset();
    await list.loadMore('tail');
    list.invalidate();
    list.upsertLocal({ id: 9, label: 'x' });
    expect(list.removeLocal('0')).toBe(false);
    list.render();
    expect(rendered(host)).toEqual(before);
  });

  it('K2 dispose 时在飞的响应落地不再触碰 DOM', async () => {
    const host = createHost();
    const { source, pending } = createControllableSource<TestItem, void>();
    const list = createBoundedList(baseOptions(host, source));
    void list.reset();
    list.dispose();
    pending[0].resolve(pageOf(makeTestItems(3), 'c0', 'c3', false, false));
    await flushAsync();
    expect(renderedRows(host)).toEqual([]);
  });

  it('K3 重复 dispose 幂等', () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => [])));
    list.dispose();
    expect(() => list.dispose()).not.toThrow();
  });
});

// ───────────────────────── L 只读状态 ─────────────────────────

describe('BoundedList / L 只读状态', () => {
  it('L1 未加载时 loaded=false，count=0，total=-1', () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3))));
    const state = list.getState();
    expect(state.loaded).toBe(false);
    expect(state.count).toBe(0);
    expect(state.total).toBe(-1);
    expect(state.stale).toBe(false);
    list.dispose();
  });

  it('L2 onLoadStateChange 在加载、落地与本地写入时上报', async () => {
    const host = createHost();
    const states: boolean[] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(3)), {
      onLoadStateChange: (s) => states.push(s.loaded),
    }));
    await list.reset();
    expect(states).toContain(false);
    expect(states[states.length - 1]).toBe(true);
    list.dispose();
  });

  it('L3 count 是渲染序列长度（含 pinned 与本地层）', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => makeTestItems(2)), {
      pinnedItems: () => [{ id: 100, label: 'pinned' }],
    }));
    await list.reset();
    list.upsertLocal({ id: 9, label: 'local' });
    expect(list.getState().count).toBe(4);
    list.dispose();
  });

  it('L4 localPageSource 接入：本地全量切片同样满足有界与续翻契约', async () => {
    const host = createHost();
    const list = createBoundedList<TestItem, { keyword: string }>({
      ...(baseOptions(host, createInstantSource(() => [])) as unknown as BoundedListOptions<TestItem, { keyword: string }>),
      initialQuery: { keyword: '' },
      source: localPageSource<TestItem, { keyword: string }>({
        loadAll: async () => makeTestItems(9),
        filter: (item, query) => item.label.includes(query.keyword),
        order: 'desc',
      }),
    });
    await list.reset();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
    scrollAway(host);
    await list.loadMore('tail');
    expect(list.getState().count).toBe(6);
    expect(list.getState().total).toBe(9);
    list.dispose();
  });
});
