// BoundedList 已确认缺陷的「当前行为锁定」用例。
//
// 本文件里的每个用例断言的都是**今天的实际行为**，而不是期望行为——它们的作用是：
//   ① 让缺陷可复现、可讨论，不靠口头描述；
//   ② 修复某个缺陷时，对应用例必然失败，提醒同步更新断言与文档。
// 缺陷编号、成因与修复建议见 packages/uikit/docs/BoundedList测试方案.md §6「缺陷与待办清单」。
//
// 修复某条缺陷后：改这里的断言 → 把用例挪回对应的正式测试文件 → 在测试方案文档里勾掉它。

import { describe, expect, it, vi } from 'vitest';
import { createBoundedList } from '../../../src/app/bounded-list/bounded-list';
import { localPageSource } from '../../../src/app/bounded-list/page-source';
import { PageWindow } from '../../../src/app/bounded-list/page-window';
import { registeredBoundedListIds } from '../../../src/app/bounded-list/registry';
import { SelectionStore } from '../../../src/app/bounded-list/selection';
import type { BoundedListOptions } from '../../../src/app/bounded-list/types';
import { FakeDocument, asElement, row, type FakeElement } from './fake-dom';
import {
  createControllableFetcher,
  createControllableSource,
  createInstantSource,
  createOptimisticSource,
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
  scroller.scrollHeight = 100000;
  scroller.scrollTop = 500;
  return { doc, parent, scroller };
}
type Host = ReturnType<typeof createHost>;

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseOptions(
  host: Host,
  source: BoundedListOptions<TestItem, void>['source'],
  overrides: Partial<BoundedListOptions<TestItem, void>> = {},
): BoundedListOptions<TestItem, void> {
  return {
    id: 'known-issues',
    scrollElement: asElement(host.scroller),
    pageSize: 3,
    maxPages: 2,
    source,
    identityOf: idOf,
    renderItem: (item: TestItem) => [asElement(row(host.doc, `row-${item.id}`))],
    text: {
      loading: () => '加载中',
      empty: () => '暂无数据',
      emptyFiltered: () => '无搜索结果',
      updatePill: (n: number) => `有更新(${n})`,
    },
    ...overrides,
  };
}

function rows(host: Host): string[] {
  return host.scroller.children.map((c) => c.className).filter((cls) => cls.startsWith('row-'));
}
function pillOf(host: Host): FakeElement {
  return host.parent.children[1];
}

// ───────────────────── P0 ─────────────────────

describe('已知缺陷 / P0', () => {
  it('BL-BUG-01 翻页失败后立即重试：贴边且窗口不足一屏时形成不让出主线程的无限重试', async () => {
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120; // 内容不足一屏 → checkReach 永远判定「已贴底」
    let calls = 0;
    // 熔断阀：到达上限后返回「没有更多」终止链条。没有它这个用例会永久卡死进程——
    // 这正是缺陷本身：组件侧没有任何终止条件。
    const BREAKER = 200;
    const source = {
      async fetch() {
        calls++;
        if (calls === 1) return pageOf(makeTestItems(3), '0', '3', false, true);
        if (calls >= BREAKER) return pageOf([], '3', '3', false, false);
        throw new Error('network');
      },
    };
    const list = createBoundedList(baseOptions(host, source, { onError: () => {} }));
    await list.reset({ pinEdge: false });
    // 失败 → render → checkReach → 立即再发一次；整条链全在微任务里跑，
    // 只有熔断阀生效、链条终止之后这个宏任务边界才可能被执行到。
    await flushAsync();
    expect(calls).toBe(BREAKER);
    list.dispose();
  });

  it('BL-BUG-01b 服务端把空页报成「还有更多」时同样无限补页', async () => {
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120;
    let calls = 0;
    const BREAKER = 100;
    const source = {
      async fetch() {
        calls++;
        if (calls === 1) return pageOf(makeTestItems(3), '0', '3', false, true);
        // 违反契约：空页却仍然报 hasMoreForward=true。
        return pageOf([], '3', '3', false, calls < BREAKER);
      },
    };
    const list = createBoundedList(baseOptions(host, source));
    await list.reset({ pinEdge: false });
    await flushAsync();
    expect(calls).toBe(BREAKER);
    list.dispose();
  });

  it('BL-BUG-02 removeLocal 的 retainOnly 会清掉共享 SelectionStore 中属于其它实例的选中项', async () => {
    const store = new SelectionStore();
    const itemsA = makeTestItems(3);
    const itemsB = makeTestItems(3, 100);
    const hostA = createHost();
    const hostB = createHost();
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => itemsA), { id: 'forward.conversations', selection: { mode: 'multi', store } }));
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => itemsB), { id: 'forward.contacts', selection: { mode: 'multi', store } }));
    await listA.reset();
    await listB.reset();
    store.toggle('100'); // 用户在「通讯录」tab 选了一个目标
    store.toggle('0');   // 又在「最近会话」tab 选了一个目标
    expect(store.snapshotIds()).toEqual(new Set(['100', '0']));

    listA.removeLocal('1'); // 会话 tab 里删掉一条（与两个已选目标都无关）

    // 期望：{'100','0'} 原样保留。实际：'100' 被误删——retainOnly 传的是「本实例窗口内的身份集合」。
    expect(store.snapshotIds()).toEqual(new Set(['0']));
    listA.dispose();
    listB.dispose();
  });

  it('BL-BUG-02b pinnedItems 的选中项同样会被 removeLocal 误删', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const pinned: TestItem = { id: -1, label: '所有人' };
    const store = new SelectionStore();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      pinnedItems: () => [pinned],
      selection: { mode: 'multi', store },
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] }); // 选中 pinned
    expect(store.has('-1')).toBe(true);
    list.removeLocal('1');
    expect(store.has('-1')).toBe(false); // 期望 true
    list.dispose();
  });

  it('BL-BUG-03 定向刷新回调没有 requestId 守卫：reset 之后陈旧结果仍会作用到新窗口', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { fetchByIdentity: fetcher.fetchByIdentity }));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    await flushAsync();
    expect(fetcher.calls).toHaveLength(1);

    await list.reset({ pinEdge: false }); // 窗口整体重建，旧请求的上下文已经作废
    expect(rows(host)).toEqual(['row-0', 'row-1', 'row-2']);

    fetcher.settle(0, []); // 陈旧结果：id=1「不存在」
    await flushAsync();
    // 期望：陈旧结果被丢弃，窗口不变。实际：新窗口里的 row-1 被误删。
    expect(rows(host)).toEqual(['row-0', 'row-2']);
    list.dispose();
  });
});

// ───────────────────── P1 ─────────────────────

describe('已知缺陷 / P1', () => {
  it('BL-BUG-04 非空的最后一页把 hasMore 收敛为 false 时，提示条不消失', async () => {
    const items = makeTestItems(4); // pageSize=3 → 第二页只有 1 条（非空）
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 500;
    list.invalidate({ count: 4 });
    expect(list.getState().stale).toBe(true);

    await list.loadMore('forward'); // 拿到非空的最后一页，hasMoreAfter 收敛为 false
    expect(list.getState().hasMoreAfter).toBe(false);
    // 期望：新鲜端之后已无未加载数据 → stale/pendingCount 清零。实际：只有「空页」才清。
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(4);
    list.dispose();
  });

  it('BL-BUG-05 未提供 text.updatePill 时提示条仍会以空文案显示出来', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      text: { loading: () => '加载中', empty: () => '暂无数据' }, // 没有 updatePill
    }));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 3 });
    // 期望：没有文案就不显示提示条。实际：显示了一个空白提示条。
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    expect(pillOf(host).textContent).toBe('');
    list.dispose();
  });

  it('BL-BUG-06 组件没有把 onContentLoad 接给渲染引擎：图片异步增高后不会重新贴底', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 0;
    host.scroller.scrollHeight = 5000; // 图片加载完，内容被撑高

    expect(host.scroller.listenerCount('load')).toBe(1); // 监听挂上了
    host.scroller.dispatch('load');
    // 期望：freshEdge=tail 且此前贴底时重新滚到底。实际：回调是 undefined，什么都没发生。
    expect(host.scroller.scrollTop).toBe(0);
    list.dispose();
  });

  it('BL-BUG-07 isActive() 为 false 时不重渲，提示条与状态脱节', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { isActive: () => false }));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 3 });
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(3);
    // 期望：提示条同步为「有更新(3)」，宿主切回可见时立即可见。实际：仍是隐藏 + 陈旧文案。
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    expect(pillOf(host).textContent).toBe('有更新(0)');
    list.dispose();
  });

  it('BL-BUG-08 空首页 + hasMoreForward=true 时停在空态不补页', async () => {
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120;
    const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, true));
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
    await list.reset();
    await flushAsync();
    // 期望：链式补页继续拉下一页。实际：渲染层在「空列表」分支提前返回，不做触界检测。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(list.getState().hasMoreAfter).toBe(true);
    expect(list.getState().count).toBe(0);
    list.dispose();
  });

  it('BL-BUG-09 upsertLocal 不做身份去重：重复并入同一条目会重复渲染', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    await list.reset({ pinEdge: false });
    list.upsertLocal({ id: 100, label: 'local' });
    list.upsertLocal({ id: 100, label: 'local' }); // 重发 / 重复回包
    // 期望：同一身份只保留一条。实际：默认 normalize 不去重，渲染出两行。
    expect(rows(host)).toEqual(['row-0', 'row-1', 'row-2', 'row-100', 'row-100']);
    list.dispose();
  });

  it('BL-BUG-09b upsertLocal 不参与跨页去重：条目已在别的页时同样重复', () => {
    const window = new PageWindow<number>(3, undefined, (n) => String(n));
    window.setInitial({ items: [1, 2], startCursor: 's1', endCursor: 'e1', hasMoreBackward: false, hasMoreForward: true });
    window.appendForward({ items: [3, 4], startCursor: 's2', endCursor: 'e2', hasMoreBackward: true, hasMoreForward: false });
    window.mergeLive(1, 'tail');
    expect(window.items).toEqual([1, 2, 3, 4, 1]); // 期望 [1,2,3,4]
  });

  it('BL-BUG-10 mergeLive 在空窗口自建页时游标为空串，后续续翻会带着空游标去请求', async () => {
    const window = new PageWindow<number>(2);
    window.mergeLive(1, 'tail');
    expect(window.backwardCursor).toBe('');
    expect(window.forwardCursor).toBe('');

    // 组件层的表现：空窗口 upsertLocal 之后向前续翻，cursor 传的是空串而不是 undefined。
    // freshEdge=tail：mergeLive 只把 hasMoreAfter 置 false，hasMoreBefore 保持服务端给的 true。
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { freshEdge: 'tail' }));
    const p = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf([], '', '', true, false)); // 空首页但服务端说前面还有
    await p;
    list.upsertLocal({ id: 1, label: 'local' });
    expect(list.getState().hasMoreBefore).toBe(true);
    void list.loadMore('backward');
    expect(pending).toHaveLength(2);
    expect(pending[1].req.cursor).toBe('');       // 不是 undefined，因此不会被数据源当成 reset
    expect(pending[1].req.backward).toBe(true);
    list.dispose();
  });
});

// ───────────────────── P2 ─────────────────────

describe('已知缺陷 / P2', () => {
  it('BL-BUG-11 localPageSource 对非法游标不设防：产出 "NaN" 游标且此后永远返回空页', async () => {
    const source = localPageSource<number, void>({ loadAll: async () => [1, 2, 3, 4, 5] });
    await source.fetch({ backward: false, limit: 2, query: undefined });
    const bad = await source.fetch({ cursor: 'not-a-number', backward: false, limit: 2, query: undefined });
    expect(bad.items).toEqual([]);
    expect(bad.startCursor).toBe('NaN');
    expect(bad.endCursor).toBe('NaN');
    // 拿着 "NaN" 继续翻，永远翻不动。
    const again = await source.fetch({ cursor: bad.endCursor, backward: false, limit: 2, query: undefined });
    expect(again.items).toEqual([]);
    expect(again.startCursor).toBe('NaN');
  });

  it('BL-BUG-12 isQueryActive 用 JSON.stringify 比较：键顺序不同即误判为「已过滤」', async () => {
    const host = createHost();
    const list = createBoundedList<TestItem, { a: number; b: number }>({
      ...(baseOptions(host, { async fetch() { return pageOf([], '0', '0', false, false); } }) as unknown as BoundedListOptions<TestItem, { a: number; b: number }>),
      initialQuery: { a: 1, b: 2 },
    });
    await list.reset({ query: { b: 2, a: 1 } }); // 语义上与 initialQuery 完全相同
    // 期望：视为「没有过滤」→ 显示「暂无数据」。实际：显示「无搜索结果」。
    expect(host.scroller.children[0].textContent).toBe('无搜索结果');
    list.dispose();
  });

  it('BL-BUG-13 定向刷新期间提示条延迟亮起（render 被推迟到请求返回之后）', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { fetchByIdentity: fetcher.fetchByIdentity }));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'], count: 2 });
    await flushAsync();

    expect(list.getState().stale).toBe(true); // 状态已经是 stale
    // 期望：提示条立即亮起。实际：要等 fetchByIdentity 返回后的那次 render。
    expect(pillOf(host).classList.contains('hidden')).toBe(true);

    fetcher.settle(0, [{ id: 1, label: 'patched' }]);
    await flushAsync();
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    expect(pillOf(host).textContent).toBe('有更新(2)');
    list.dispose();
  });

  it('BL-BUG-14 dispose 之后 pinToFreshEdge 已排队的帧仍会写 scrollTop', async () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return frames.length; });
    try {
      const items = makeTestItems(3);
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', settleFrames: 4 }));
      await list.reset({ pinEdge: true });
      list.dispose();
      host.scroller.scrollTop = 12345; // 宿主在 dispose 之后自己设置的滚动位置
      frames.splice(0).forEach((cb) => cb());
      // 期望：dispose 后不再触碰 DOM，scrollTop 保持 12345。实际：被摁回 scrollHeight。
      expect(host.scroller.scrollTop).toBe(100000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('BL-BUG-16 reset 失败后显示「暂无数据」，用户无法区分「没有数据」与「加载失败」', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { onError: () => {} }));
    const p = list.reset();
    pending[0].reject(new Error('network down'));
    await p;
    expect(host.scroller.children[0].className).toBe('empty-state');
    expect(host.scroller.children[0].textContent).toBe('暂无数据'); // 期望：错误态文案 + 重试入口
    list.dispose();
  });

  it('BL-BUG-17 maxPages=0：setInitial 不裁剪，但随后一次 mergeLive 会把窗口连同新条目一起裁光', () => {
    const window = new PageWindow<number>(0);
    window.setInitial({ items: [1, 2], startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: false });
    expect(window.count).toBe(2); // setInitial 不做 maxPages 裁剪

    window.mergeLive(3, 'tail');
    expect(window.items).toEqual([]); // 刚并入的条目连同整页一起被裁掉
    expect(window.hasMoreBefore).toBe(true);

    const headWindow = new PageWindow<number>(0);
    headWindow.setInitial({ items: [1], startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: false });
    headWindow.mergeLive(0, 'head');
    expect(headWindow.items).toEqual([]);
    expect(headWindow.hasMoreAfter).toBe(true);
  });

  it('BL-BUG-18 onSelectionChange 的 items 顺序（窗口在前、pinned 在后）与渲染顺序不一致', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const pinned: TestItem = { id: -1, label: '所有人' };
    const onSelectionChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      pinnedItems: () => [pinned],
      selection: { mode: 'multi' },
      onSelectionChange,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] }); // pinned（渲染上排第一）
    host.scroller.dispatch('click', { target: host.scroller.children[1] }); // id=0
    const last = onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1][0];
    expect(rows(host)).toEqual(['row--1', 'row-0', 'row-1', 'row-2']);
    // 期望：与渲染顺序一致（pinned 在前）。实际：窗口条目在前。
    expect(last.items.map((i: TestItem) => i.id)).toEqual([0, -1]);
    list.dispose();
  });

  it('BL-BUG-20 构造参数不做合法性校验：selection.store 与 selection.max 同时给出时 max 被静默忽略', async () => {
    const items = makeTestItems(5);
    const host = createHost();
    const store = new SelectionStore(); // 无上限
    const onExceed = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', store, max: 1, onExceed }, // max 与 store 同时给出
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    // 期望：受 max=1 约束或直接报错。实际：max 被忽略，两个都选上了。
    expect(store.size).toBe(2);
    expect(onExceed).not.toHaveBeenCalled();
    list.dispose();
  });

  it('BL-BUG-20b pageSize / maxPages 传 0 不报错，行为退化为「永远空窗口」', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createOptimisticSource(() => items), { pageSize: 0 }));
    await list.reset();
    expect(list.getState().count).toBe(0);
    expect(list.getState().loaded).toBe(true);
    list.dispose();
  });

  it('BL-BUG-21 组件不设置 tabindex / role：键盘导航依赖宿主自行让滚动容器可聚焦', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    expect(host.scroller.getAttribute('tabindex')).toBeNull();
    expect(host.scroller.getAttribute('role')).toBeNull();
    expect(host.scroller.children[0].getAttribute('role')).toBeNull();
    list.dispose();
  });

  it('BL-BUG-24 组件只登记到 bounded-list/registry.ts，与 app-instance 的旧注册表互不连通', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { id: 'registry-split-check' }));
    await list.reset();

    // 新注册表能看见它。
    expect(registeredBoundedListIds()).toContain('registry-split-check');
    // 旧的 BoundedListController 契约（app-instance 的 boundedLists Map、main-app 重连时广播的那个）
    // 只是一个类型，运行时没有任何注册表能力——组件不会自动登记进去。
    const legacyModule = await import('../../../src/app/bounded-list');
    expect(Object.keys(legacyModule)).toEqual([]);

    // 后果：重连后 main-app 调 app.invalidateBoundedLists()（旧注册表）时，
    // 通过 createBoundedList 创建的列表**收不到**这次广播。
    list.dispose();
  });

  it('BL-BUG-25 模块名冲突：`./bounded-list` 解析到旧的 .ts 文件，组件的公开入口被遮蔽', async () => {
    // packages/uikit/src/app/ 下同时存在 bounded-list.ts（旧 BoundedListController 接口）
    // 与 bounded-list/（新组件目录）。按 bundler 解析规则，.ts 文件优先于目录的 index.ts。
    const byDirectoryPath = await import('../../../src/app/bounded-list');
    expect(Object.keys(byDirectoryPath)).toEqual([]); // 拿到的是旧模块（只有类型，运行时为空）

    const byExplicitIndex = await import('../../../src/app/bounded-list/index');
    expect(Object.keys(byExplicitIndex)).toEqual(
      expect.arrayContaining(['createBoundedList', 'BoundedList', 'serverPageSource', 'localPageSource', 'SelectionStore']),
    );
  });
});
