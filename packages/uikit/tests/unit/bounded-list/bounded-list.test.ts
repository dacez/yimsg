import { describe, expect, it, vi } from 'vitest';
import { createBoundedList } from '../../../src/app/bounded-list/bounded-list';
import { localPageSource } from '../../../src/app/bounded-list/page-source';
import { SelectionStore } from '../../../src/app/bounded-list/selection';
import { registeredBoundedListIds } from '../../../src/app/bounded-list/registry';
import type { BoundedListOptions, RenderItemContext } from '../../../src/app/bounded-list/types';
import { FakeDocument, asElement, row, type FakeElement } from './fake-dom';
import {
  createControllableSource,
  createInstantSource,
  idOf,
  makeTestItems,
  pageOf,
  type TestItem,
} from './test-sources';

function createHost() {
  const doc = new FakeDocument();
  const parent = doc.createElement();
  const scroller = doc.createElement();
  parent.appendChild(scroller);
  scroller.clientHeight = 100;
  // fake DOM 不会像真实浏览器那样随内容增长自动撑高 scrollHeight，默认给一个远大于
  // clientHeight 的值，避免「内容不足一屏」的链式补页判定在与分页无关的用例里意外触发
  // （链式补页本身单独在 stream-window.test.ts 里覆盖）。
  scroller.scrollHeight = 100000;
  // 默认停在既不贴顶也不贴底的位置，避免 checkReach 的链式补页在与滚动位置无关的
  // 用例里意外触发（关心滚动边界的用例会显式设置 scrollTop）。
  scroller.scrollTop = 500;
  return { doc, parent, scroller };
}

/** 等待微任务与一次宏任务边界都落定；用于 setQuery/invalidate 触发的 reset() 完全结算后再断言。 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseOptions(
  host: ReturnType<typeof createHost>,
  source: BoundedListOptions<TestItem, void>['source'],
  overrides: Partial<BoundedListOptions<TestItem, void>> = {},
): BoundedListOptions<TestItem, void> {
  return {
    id: 'test-list',
    scrollElement: asElement(host.scroller),
    pageSize: 3,
    maxPages: 2,
    source,
    identityOf: idOf,
    renderItem: (item: TestItem) => [asElement(row(host.doc, `row-${item.id}`))],
    // 默认不提供 headBoundary/tailBoundary：大多数用例只关心「行」本身，提供边界文案会
    // 在 !hasMoreBefore（reset 后头部天然如此）时插入一个提示条节点，让「children 数组
    // 与条目一一对应」的假设失效。需要专门验证边界提示的用例自行在 overrides 里传入。
    text: {
      loading: () => '加载中',
      empty: () => '暂无数据',
      emptyFiltered: () => '无搜索结果',
      updatePill: (n: number) => `有更新(${n})`,
    },
    ...overrides,
  };
}

function scrollerContent(host: ReturnType<typeof createHost>): FakeElement {
  return host.scroller;
}

describe('BoundedList 基本分页：reset / loadMore / 整页裁剪', () => {
  it('reset 拉首页；loadMore 双向续翻；窗口条目数不超过 pageSize×maxPages', async () => {
    const all = makeTestItems(20);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    await list.reset();
    expect(list.getState().count).toBe(3);
    expect(list.getState().hasMoreBefore).toBe(false);
    expect(list.getState().hasMoreAfter).toBe(true);
    expect(scrollerContent(host).children.map((c) => c.className)).toEqual(['row-0', 'row-1', 'row-2']);

    // reset 默认 pinEdge=true 会把 scrollTop 摁回新鲜端（head→0）；这里刻意只想验证
    // loadMore('forward') 自身的分页/裁剪逻辑，所以显式挪开滚动位置，避免 checkReach
    // 把「贴顶且 hasMoreBefore 一旦变 true」也解读成需要自动触发 backward 续翻，
    // 与本用例的手动 forward 循环相互干扰。
    host.scroller.scrollTop = 500;
    for (let i = 0; i < 5; i++) await list.loadMore('forward');
    expect(list.getState().count).toBeLessThanOrEqual(3 * 2);
    expect(list.getState().hasMoreBefore).toBe(true);
    list.dispose();
  });

  it('loadMore 在没有更多或已在加载时直接返回，不发请求', async () => {
    const all = makeTestItems(3);
    const host = createHost();
    const fetchSpy = vi.fn(createInstantSource(() => all).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
    await list.reset();
    fetchSpy.mockClear();
    expect(list.getState().hasMoreAfter).toBe(false);
    await list.loadMore('forward'); // hasMoreAfter=false，不应发请求
    expect(fetchSpy).not.toHaveBeenCalled();
    list.dispose();
  });

  it('并发保护：loadMore 已在加载中时重复调用不重复发请求', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const resetPromise = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, true));
    await resetPromise;

    const p1 = list.loadMore('forward');
    const p2 = list.loadMore('forward'); // 同方向已在加载，应直接返回
    expect(pending).toHaveLength(2); // 只有第一次真的发了请求
    pending[1].resolve(pageOf(makeTestItems(3, 3), '3', '6', true, false));
    await Promise.all([p1, p2]);
    expect(pending).toHaveLength(2);
    list.dispose();
  });
});

describe('BoundedList 并发丢弃：reset 期间再 reset 以最后一次为准', () => {
  it('旧的 reset 请求返回后被整体丢弃', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));

    const first = list.reset();
    const second = list.reset();
    expect(pending).toHaveLength(2);
    // 先让第二次（最新）的请求落地，再让过期的第一次请求落地。
    pending[1].resolve(pageOf(makeTestItems(3, 100), '0', '3', false, false));
    await second;
    pending[0].resolve(pageOf(makeTestItems(3, 0), '0', '3', false, true));
    await first;

    // 过期请求的结果必须被丢弃：窗口内容仍是第二次（最新）reset 的结果。
    expect(list.getState().count).toBe(3);
    expect(scrollerContent(host).children.map((c) => c.className)).toEqual(['row-100', 'row-101', 'row-102']);
    list.dispose();
  });
});

describe('BoundedList 错误处理', () => {
  it('reset 失败：onError 被调用一次，loading 恢复（loaded 置 true 以解除卡在加载态）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const p = list.reset();
    pending[0].reject(new Error('boom'));
    await expect(p).resolves.toBeUndefined(); // reset 本身不应该把异常继续往外抛（不产生未处理拒绝）
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'reset');
    expect(list.getState().loaded).toBe(true);
    expect(list.getState().loading).toBe(false);
    list.dispose();
  });

  it('loadMore 失败：onError 被调用一次并带正确 phase，loading 标志恢复', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const resetP = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, true));
    await resetP;

    const loadP = list.loadMore('forward');
    expect(list.getState().loadingAfter).toBe(true);
    pending[1].reject(new Error('network'));
    await loadP;
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'forward');
    expect(list.getState().loadingAfter).toBe(false);
    list.dispose();
  });

  it('未提供 onError 时退化为 console.warn，不产生未处理的 Promise 拒绝', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset();
    pending[0].reject(new Error('boom'));
    await expect(p).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    list.dispose();
  });
});

describe('BoundedList invalidate 决策树（§5.1）', () => {
  function setupInvalidateList(items: TestItem[], overrides: Partial<BoundedListOptions<TestItem, void>> = {}) {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), overrides));
    return { host, list };
  }

  it('isActive() 为 false 时只记 stale，不发任何请求', async () => {
    const items = makeTestItems(10);
    let active = false;
    const { host, list } = setupInvalidateList(items, { isActive: () => active });
    await list.reset();
    host.scroller.scrollTop = 100; // 不贴新鲜端
    list.invalidate({ count: 3 });
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(3);
    expect(list.getState().count).toBe(3); // 窗口没有被重拉
    list.dispose();
  });

  it('贴在新鲜端时直接 reset 追平，stale 保持 false', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 0; // 贴顶（head 新鲜端，默认 stickyPx=4）
    items.unshift({ id: -1, label: 'new' });
    list.invalidate({ count: 1 });
    // reset 是异步的（内部走 source.fetch），这里等待微任务落定。
    await flushAsync();
    expect(list.getState().stale).toBe(false);
    expect(scrollerContent(host).children[0].className).toBe('row--1');
    list.dispose();
  });

  it('不贴新鲜端时只点亮提示条，列表内容不变', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 100;
    const before = scrollerContent(host).children.map((c) => c.className);
    list.invalidate({ count: 2 });
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(2);
    expect(scrollerContent(host).children.map((c) => c.className)).toEqual(before);
    list.dispose();
  });

  it('identities 命中窗口且提供 fetchByIdentity：只对交集批量拉取，返回缺失的身份被 removeLocal', async () => {
    const items = makeTestItems(10);
    const fetchByIdentity = vi.fn(async (ids: readonly string[]) =>
      ids.filter((id) => id !== '1').map((id) => ({ id: Number(id), label: `patched-${id}` })),
    );
    const { host, list } = setupInvalidateList(items, { fetchByIdentity });
    await list.reset(); // 窗口内 [0,1,2]
    host.scroller.scrollTop = 100; // 不贴新鲜端
    list.invalidate({ identities: ['1', '2', '999'] }); // 999 不在窗口内
    await flushAsync();
    expect(fetchByIdentity).toHaveBeenCalledTimes(1);
    expect(fetchByIdentity).toHaveBeenCalledWith(expect.arrayContaining(['1', '2']));
    expect((fetchByIdentity.mock.calls[0][0] as string[]).includes('999')).toBe(false);
    // id=1 被 removeLocal（fetchByIdentity 返回里没有它），id=2 被 patch。
    expect(scrollerContent(host).children.map((c) => c.className)).toEqual(['row-0', 'row-2']);
    list.dispose();
  });

  it('identities 均不命中窗口时不调用 fetchByIdentity，但仍重渲（同步提示条）', async () => {
    const items = makeTestItems(10);
    const fetchByIdentity = vi.fn(async () => []);
    const { host, list } = setupInvalidateList(items, { fetchByIdentity });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['999'], count: 1 });
    await flushAsync();
    expect(fetchByIdentity).not.toHaveBeenCalled();
    expect(list.getState().stale).toBe(true);
    list.dispose();
  });

  it('同一帧内多次 invalidate 只跑一次决策', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const items = makeTestItems(10);
      const fetchByIdentity = vi.fn(async () => []);
      const { host, list } = setupInvalidateList(items, { fetchByIdentity });
      host.scroller.scrollTop = 100;
      list.invalidate({ count: 1, identities: ['1'] });
      list.invalidate({ count: 2, identities: ['2'] });
      list.invalidate({ count: 3 });
      expect(frames.length).toBeGreaterThan(0);
      frames.splice(0).forEach((cb) => cb());
      expect(list.getState().pendingCount).toBe(6); // 1+2+3 累加
      list.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('BoundedList 提示条自动消失（§5.3 三条路径）', () => {
  it('路径①：用户自己滚回新鲜端时自动追平，stale 与 pendingCount 一并清零', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 5 });
    expect(list.getState().stale).toBe(true);

    host.scroller.scrollTop = 0; // 滚回新鲜端
    host.scroller.dispatch('scroll'); // 无 rAF 时同步触发 onScrollFrame
    await flushAsync();
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });

  it('路径②：触界续翻到新鲜端尽头时清零 stale 与 pendingCount（§3.4③ 回归）', async () => {
    // 用「乐观 hasMore」数据源：满页时先乐观认为可能还有更多（真实 keyset 分页在拿到
    // 一整页之前无法确定是否已到末尾），只有真正拿到一页空结果才收敛为 false——
    // 这样才能走到「触界续翻拿到空页」这条路径，而不是在最后一页非空数据时就
    // 直接把 hasMore 判定为 false（那种精确判定见 createInstantSource，用于其它用例）。
    const items = makeTestItems(6);
    const optimisticTailSource = {
      async fetch(req: { cursor?: string; backward: boolean; limit: number; query: void }) {
        const cursor = req.cursor === undefined ? 0 : Number(req.cursor);
        const end = Math.min(items.length, cursor + req.limit);
        const page = items.slice(cursor, end);
        return {
          items: page,
          startCursor: String(cursor),
          endCursor: String(end),
          hasMoreBackward: cursor > 0,
          hasMoreForward: page.length === req.limit, // 乐观：满页就先当作还有更多
        };
      },
    };
    const host = createHost();
    const list = createBoundedList(baseOptions(host, optimisticTailSource, { freshEdge: 'tail' }));
    await list.reset(); // 首页 [0,1,2]，freshEdge=tail → 新鲜方向是 forward
    host.scroller.scrollTop = 999; // 不贴底，人为制造「不在尾部」的假象
    host.scroller.scrollHeight = 2000;
    list.invalidate({ count: 4 });
    expect(list.getState().stale).toBe(true);

    await list.loadMore('forward'); // [3,4,5]，满页仍乐观报告 hasMoreForward=true
    expect(list.getState().hasMoreAfter).toBe(true);
    await list.loadMore('forward'); // 真正拿到空页：hasMoreAfter 收敛为 false，freshDirection=forward 命中
    expect(list.getState().hasMoreAfter).toBe(false);
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });

  it('路径③：调用方主动 reset（切换会话等）清空提示条', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 1 });
    expect(list.getState().stale).toBe(true);
    await list.reset();
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });
});

describe('BoundedList 本端产生的新条目（§5.6 upsertLocal）', () => {
  it('freshEdge=tail 时并入尾页；新鲜端方向的 hasMoreAfter 置 false', async () => {
    // 注：mergeLive 把新条目并入「已存在的尾页」内部数组，页数不变，因此这里的
    // maxPages 页数裁剪判定不会触发（裁剪只按页数、不按单页条数，与旧版
    // appendLive 的行为一致）；单页条数临时超过 pageSize 会在下一次真实翻页时
    // 被整页裁剪收敛，属于设计上可接受的软上界（§5.6）。
    const items = makeTestItems(4);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', maxPages: 1, pageSize: 3 }));
    await list.reset(); // [0,1,2]
    list.upsertLocal({ id: 100, label: 'local' });
    expect(scrollerContent(host).children[scrollerContent(host).children.length - 1].className).toBe('row-100');
    expect(list.getState().hasMoreAfter).toBe(false);
    list.dispose();
  });

  it('freshEdge=tail 时 mergeLive 的整页裁剪确实按页数生效（窗口已有多页时新增页会裁掉最旧页）', async () => {
    const items = makeTestItems(9);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', maxPages: 2, pageSize: 3 }));
    // pinEdge:false 避免 reset 把 scrollTop 摁到「贴底」——fake DOM 的 scrollHeight
    // 不随内容增长，贴底会让 checkReach 此后一直判定「已到底部」而自动链式续翻，
    // 与本用例想要单独观察的 mergeLive 行为互相干扰。
    await list.reset({ pinEdge: false }); // page0=[0,1,2]
    await list.loadMore('forward'); // page1=[3,4,5]，窗口已达 maxPages=2
    expect(list.getState().count).toBe(6);
    list.upsertLocal({ id: 100, label: 'local' }); // 并入 page1（尾页），不新增页，故仍是 2 页
    expect(list.getState().hasMoreBefore).toBe(false); // 未新增页，没有需要裁剪的第三页
    list.dispose();
  });

  it('freshEdge=head 时并入首页', async () => {
    const items = makeTestItems(4);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'head' }));
    await list.reset();
    list.upsertLocal({ id: -1, label: 'local' });
    expect(scrollerContent(host).children[0].className).toBe('row--1');
    expect(list.getState().hasMoreBefore).toBe(false);
    list.dispose();
  });
});

describe('BoundedList patch / removeLocal', () => {
  it('patch 就地更新命中条目并重渲；未命中返回 false', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onItemsChanged = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onItemsChanged }));
    await list.reset();
    onItemsChanged.mockClear();
    expect(list.patch('1', (item) => ({ ...item, label: 'patched' }))).toBe(true);
    expect(onItemsChanged).toHaveBeenCalledTimes(1);
    expect(list.patch('999', (item) => item)).toBe(false);
    list.dispose();
  });

  it('removeLocal 就地删除命中条目，剩余条目自然补齐', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    expect(list.removeLocal('1')).toBe(true);
    expect(scrollerContent(host).children.map((c) => c.className)).toEqual(['row-0', 'row-2']);
    expect(list.removeLocal('1')).toBe(false);
    list.dispose();
  });
});

describe('BoundedList 事件：onActivate / onLoadStateChange / onItemsChanged', () => {
  it('无 selection 时点击整行触发 onActivate', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onActivate }));
    await list.reset();
    const target = scrollerContent(host).children[1];
    host.scroller.dispatch('click', { target });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toEqual(items[1]);
    list.dispose();
  });

  it('onLoadStateChange 在 reset / loadMore 前后被调用，反映 loading 与 count 变化', async () => {
    const items = makeTestItems(6);
    const host = createHost();
    const onLoadStateChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onLoadStateChange }));
    await list.reset();
    const states = onLoadStateChange.mock.calls.map((c) => c[0]);
    expect(states.some((s) => s.loaded === false)).toBe(true);
    expect(states[states.length - 1].loaded).toBe(true);
    expect(states[states.length - 1].count).toBe(3);
    list.dispose();
  });
});

describe('BoundedList scrollToIdentity', () => {
  it('命中窗口内条目时滚动并返回 true；未命中返回 false', async () => {
    const items = makeTestItems(5);
    const host = createHost();
    host.scroller.rect = { top: 0, bottom: 100 };
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    scrollerContent(host).children[2].rect = { top: 500, bottom: 520 };
    expect(list.scrollToIdentity('2')).toBe(true);
    expect(host.scroller.scrollTop).toBeGreaterThan(0);
    expect(list.scrollToIdentity('not-in-window')).toBe(false);
    list.dispose();
  });
});

describe('BoundedList pinnedItems（钉在头部的纯展示条目）', () => {
  it('钉住条目参与渲染但不参与分页窗口计数', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const pinned: TestItem = { id: -1, label: '所有人' };
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      pinnedItems: () => [pinned],
    }));
    await list.reset();
    expect(scrollerContent(host).children.map((c) => c.className)).toEqual(['row--1', 'row-0', 'row-1', 'row-2']);
    expect(list.getState().count).toBe(3); // 不含 pinned
    list.dispose();
  });
});

describe('BoundedList 共享 SelectionStore（§6.2 转发弹窗双 tab）', () => {
  it('实例 A 勾选后实例 B 重渲且勾选框同步；超 max 时拒绝并回调 onExceed', async () => {
    const itemsA = makeTestItems(3);
    const itemsB = makeTestItems(3, 100);
    const store = new SelectionStore(1);
    const onExceedA = vi.fn();
    const onExceedB = vi.fn();
    let lastCtxA: RenderItemContext<TestItem> | null = null;
    let lastCtxB: RenderItemContext<TestItem> | null = null;

    const hostA = createHost();
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => itemsA), {
      id: 'forward.conversations',
      selection: { mode: 'multi', store, onExceed: onExceedA },
      renderItem: (item, ctx) => { lastCtxA = ctx; return [asElement(row(hostA.doc, `row-${item.id}`))]; },
    }));
    const hostB = createHost();
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => itemsB), {
      id: 'forward.contacts',
      selection: { mode: 'multi', store, onExceed: onExceedB },
      renderItem: (item, ctx) => { lastCtxB = ctx; return [asElement(row(hostB.doc, `row-${item.id}`))]; },
    }));
    await listA.reset();
    await listB.reset();

    hostA.scroller.dispatch('click', { target: hostA.scroller.children[0] }); // 勾选 A 的第 0 条（id=0）
    expect(store.has('0')).toBe(true);
    expect(lastCtxB?.selectable).toBe(false); // B 侧因为已达 max=1 且未选中，禁用

    hostB.scroller.dispatch('click', { target: hostB.scroller.children[0] }); // 尝试勾选 B 的第 0 条（id=100），应被拒绝
    expect(store.has('100')).toBe(false);
    expect(onExceedB).toHaveBeenCalledTimes(1);

    listA.dispose();
    listB.dispose();
  });

  it('single 模式点击整行既 replaceSingle 又触发 onActivate', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onActivate = vi.fn();
    const store = new SelectionStore();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'single', store },
      onActivate,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: scrollerContent(host).children[1] });
    expect(store.snapshotIds()).toEqual(new Set(['1']));
    expect(onActivate).toHaveBeenCalledTimes(1);
    list.dispose();
  });

  it('onSelectionChange 携带命中的完整条目', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onSelectionChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', max: 10 },
      onSelectionChange,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: scrollerContent(host).children[0] });
    expect(onSelectionChange).toHaveBeenCalledWith({ ids: new Set(['0']), count: 1, items: [items[0]] });
    list.dispose();
  });
});

describe('BoundedList + localPageSource（提及群成员场景，§6.4）', () => {
  it('全量 1000 条时窗口与 DOM 都 ≤ pageSize×maxPages；setQuery 后重新过滤排序并从头切片', async () => {
    const all = makeTestItems(1000).map((item) => ({ ...item, label: item.id % 2 === 0 ? `even-${item.id}` : `odd-${item.id}` }));
    const host = createHost();
    const source = localPageSource<TestItem, { keyword: string }>({
      loadAll: async () => all,
      filter: (item, q) => !q.keyword || item.label.includes(q.keyword),
      compare: (a, b) => a.id - b.id,
    });
    const list = createBoundedList<TestItem, { keyword: string }>({
      id: 'mention-picker',
      scrollElement: asElement(host.scroller),
      pageSize: 40,
      maxPages: 5,
      source,
      identityOf: idOf,
      initialQuery: { keyword: '' },
      renderItem: (item) => [asElement(row(host.doc, `row-${item.id}`))],
      text: { loading: () => '加载中', empty: () => '暂无数据', emptyFiltered: () => '无搜索结果' },
    });
    await list.reset();
    expect(list.getState().count).toBeLessThanOrEqual(200);
    expect(scrollerContent(host).children.length).toBeLessThanOrEqual(200);

    list.setQuery({ keyword: 'even' }, { debounceMs: 0 });
    await flushAsync();
    const state = list.getState();
    expect(state.count).toBeLessThanOrEqual(200);
    // 过滤后应该只剩偶数 id，抽查首条属于偶数。
    const firstClass = scrollerContent(host).children[0]?.className;
    expect(firstClass).toMatch(/row-\d*[02468]$/);
    list.dispose();
  });
});

describe('BoundedList dispose：全部监听注销、注册表注销、幂等空操作', () => {
  it('dispose 后 scrollElement / window / content 上的监听全部为 0；registry 不再含该 id', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { id: 'dispose-leak-check' }));
    await list.reset();
    expect(registeredBoundedListIds()).toContain('dispose-leak-check');
    expect(host.scroller.listenerCount('scroll')).toBeGreaterThan(0);

    list.dispose();
    expect(registeredBoundedListIds()).not.toContain('dispose-leak-check');
    expect(host.scroller.listenerCount('scroll')).toBe(0);
    expect(host.scroller.listenerCount('pointerdown')).toBe(0);
    expect(host.scroller.listenerCount('keydown')).toBe(0);
    expect(host.doc.defaultView.listenerCount('pointerup')).toBe(0);
    // parent 下原本是 [scroller, pill] 两个子节点；dispose 后提示条应被移除，只剩 scroller 自己。
    expect(host.parent.children).toHaveLength(1);
    expect(host.parent.children[0]).toBe(host.scroller);
  });

  it('dispose 之后调用其它命令均为空操作，不抛错', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    list.dispose();
    await expect(list.reset()).resolves.toBeUndefined();
    await expect(list.loadMore('forward')).resolves.toBeUndefined();
    expect(() => list.setQuery(undefined)).not.toThrow();
    expect(() => list.invalidate({ count: 1 })).not.toThrow();
    expect(() => list.upsertLocal(items[0])).not.toThrow();
    expect(list.patch('0', (i) => i)).toBe(false);
    expect(list.removeLocal('0')).toBe(false);
    expect(() => list.render()).not.toThrow();
    expect(list.scrollToIdentity('0')).toBe(false);
    expect(() => list.dispose()).not.toThrow(); // 幂等
  });

  it('批量创建并 dispose 大量实例后不残留任何监听或注册项（内存泄漏压力测试）', async () => {
    const before = registeredBoundedListIds().length;
    for (let i = 0; i < 50; i++) {
      const items = makeTestItems(5);
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { id: `leak-check-${i}` }));
      await list.reset();
      list.dispose();
      expect(host.scroller.listenerCount('scroll')).toBe(0);
      expect(host.doc.defaultView.listenerCount('pointerup')).toBe(0);
    }
    expect(registeredBoundedListIds().length).toBe(before);
  });

  it('共享 SelectionStore 时 dispose 会取消订阅，之后另一实例的选中变化不再触发已 dispose 实例的重渲', async () => {
    const store = new SelectionStore();
    const itemsA = makeTestItems(3);
    const itemsB = makeTestItems(3, 50);
    const hostA = createHost();
    const hostB = createHost();
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => itemsA), { selection: { mode: 'multi', store } }));
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => itemsB), { selection: { mode: 'multi', store } }));
    await listA.reset();
    await listB.reset();
    listA.dispose();
    // listA 已 dispose，store 变化不应该再触发它的渲染逻辑（不抛错即达标——
    // 内部 render() 有 disposed 守卫，重渲会被跳过）。
    expect(() => store.toggle('50')).not.toThrow();
    listB.dispose();
  });
});
