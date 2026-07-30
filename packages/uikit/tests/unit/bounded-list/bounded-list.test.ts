// BoundedList（组件外壳）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.7：
//   A 构造与默认值 / B reset 首屏 / C loadMore 双向续翻 / D setQuery 防抖
//   E invalidate 决策树 / F 提示条三条消失路径 / G 本端增删改 / H 渲染与文案
//   I 交互与选中态 / K 错误处理 / L 释放 / M 只读状态 / N 防御性守卫。

import { describe, expect, it, vi } from 'vitest';
import { createBoundedList } from '../../../src/app/bounded-list/bounded-list';
import { localPageSource } from '../../../src/app/bounded-list/page-source';
import { SelectionStore } from '../../../src/app/bounded-list/selection';
import type { BoundedListOptions, RenderItemContext } from '../../../src/app/bounded-list/types';
import { FakeDocument, asElement, row, viewOf, type FakeElement } from './fake-dom';
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
 * 测试自持的注册表。组件的 `register` 是必填参数、注册表实体由宿主持有，
 * 所以注册 / 注销的生命周期断言对这一份做，而不是对一个进程级全局做。
 * 每个用例结束时 dispose 会把自己摘掉，用例之间天然不串。
 */
const testRegistry = new Map<string, { readonly id: string; invalidate(): void | Promise<void> }>();

function testRegister(instance: { readonly id: string; invalidate(): void | Promise<void> }): () => void {
  testRegistry.set(instance.id, instance);
  return () => {
    if (testRegistry.get(instance.id) === instance) testRegistry.delete(instance.id);
  };
}

function registeredIds(): string[] {
  return [...testRegistry.keys()];
}

function createHost(options: { withParent?: boolean } = {}) {
  const doc = new FakeDocument();
  const parent = doc.createElement();
  const scroller = doc.createElement();
  if (options.withParent !== false) parent.appendChild(scroller);
  scroller.clientHeight = 100;
  // fake DOM 不会像真实浏览器那样随内容增长自动撑高 scrollHeight，默认给一个远大于
  // clientHeight 的值，避免「内容不足一屏」的链式补页判定在与分页无关的用例里意外触发。
  scroller.scrollHeight = 100000;
  // 默认停在既不贴顶也不贴底的位置，避免 checkReach 的链式补页在与滚动位置无关的
  // 用例里意外触发（关心滚动边界的用例会显式设置 scrollTop）。
  scroller.scrollTop = 500;
  return { doc, parent, scroller };
}

type Host = ReturnType<typeof createHost>;

/** 等待微任务与一次宏任务边界都落定；用于 setQuery/invalidate 触发的 reset() 完全结算后再断言。 */
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
    // 默认不提供 backwardBoundary/forwardBoundary：大多数用例只关心「行」本身，提供边界文案会
    // 在 !hasMoreBackward（reset 后头部天然如此）时插入一个提示条节点，让「children 数组
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

function rendered(host: Host): string[] {
  return host.scroller.children.map((c) => c.className);
}

/** 只取条目行，忽略边界 / 加载提示节点。 */
function renderedRows(host: Host): string[] {
  return rendered(host).filter((cls) => cls.startsWith('row-'));
}

function pillOf(host: Host): FakeElement {
  return host.parent.children[1];
}

interface FrameQueue { run: () => void; size: () => number }

/** 把 requestAnimationFrame 换成手动可控的帧队列（同步用例）。 */
function withFrames<T>(fn: (frames: FrameQueue) => T): T {
  const queue: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(() => cb(0)); return queue.length; });
  try {
    return fn({ run: () => queue.splice(0).forEach((cb) => cb()), size: () => queue.length });
  } finally {
    vi.unstubAllGlobals();
  }
}

/** withFrames 的异步版本：必须 await 完回调再解除 stub，否则 stub 会在第一个 await 处提前失效。 */
async function withFramesAsync(fn: (frames: FrameQueue) => Promise<void>): Promise<void> {
  const queue: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(() => cb(0)); return queue.length; });
  try {
    await fn({ run: () => queue.splice(0).forEach((cb) => cb()), size: () => queue.length });
  } finally {
    vi.unstubAllGlobals();
  }
}

// ───────────────────────── A 构造与默认值 ─────────────────────────

describe('BoundedList / A 构造与默认值', () => {
  it('A1 默认 freshEdge=head，提示条挂到 scrollElement.parentElement 下', () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => [])));
    expect(host.parent.children).toHaveLength(2);
    expect(pillOf(host).classList.contains('list-updated-pill')).toBe(true);
    list.dispose();
  });

  it('A2 scrollElement 没有父元素时退化为「没有提示条」，不抛错', async () => {
    const host = createHost({ withParent: false });
    const items = makeTestItems(5);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    expect(() => list.invalidate({ count: 1 })).not.toThrow();
    expect(list.getState().stale).toBe(true);
    expect(host.parent.children).toHaveLength(0);
    list.dispose();
  });

  it('A3 显式 pillHost=false（弹窗内候选列表）时不创建任何提示条 DOM', async () => {
    const host = createHost();
    const items = makeTestItems(5);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { pillHost: false }));
    await list.reset();
    expect(host.parent.children).toHaveLength(1); // 只有 scroller
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 1 });
    expect(list.getState().stale).toBe(true);
    list.dispose();
  });

  it('A4 显式指定 pillHost 时提示条挂到指定容器', () => {
    const host = createHost();
    const customHost = host.doc.createElement();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => []), { pillHost: asElement(customHost) }));
    expect(customHost.children).toHaveLength(1);
    expect(host.parent.children).toHaveLength(1);
    list.dispose();
  });

  it('A5 freshEdge 决定 stickyPx / settleFrames 默认值：head=4/1，tail=50/4', async () => {
    const items = makeTestItems(5);
    // head：scrollTop=4 判定贴边、scrollTop=5 不贴边
    const headHost = createHost();
    const head = createBoundedList(baseOptions(headHost, createInstantSource(() => items)));
    await head.reset({ pinEdge: false });
    headHost.scroller.scrollTop = 4;
    expect(head.getState().atFreshEdge).toBe(true);
    headHost.scroller.scrollTop = 5;
    expect(head.getState().atFreshEdge).toBe(false);
    head.dispose();

    // tail：距底 50 判定贴边、51 不贴边
    const tailHost = createHost();
    const tail = createBoundedList(baseOptions(tailHost, createInstantSource(() => items), { freshEdge: 'tail' }));
    await tail.reset({ pinEdge: false });
    tailHost.scroller.scrollHeight = 1000;
    tailHost.scroller.clientHeight = 100;
    tailHost.scroller.scrollTop = 850; // 距底 50
    expect(tail.getState().atFreshEdge).toBe(true);
    tailHost.scroller.scrollTop = 849;
    expect(tail.getState().atFreshEdge).toBe(false);
    tail.dispose();
  });

  it('A6 显式 stickyPx 覆盖默认值', async () => {
    const items = makeTestItems(5);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { stickyPx: 100 }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 99;
    expect(list.getState().atFreshEdge).toBe(true);
    list.dispose();
  });

  it('A7 构造即注册到宿主注册表，dispose 后摘除，id 可读', () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => []), { id: 'ctor.registered' }));
    expect(list.id).toBe('ctor.registered');
    expect(registeredIds()).toContain('ctor.registered');
    list.dispose();
    expect(registeredIds()).not.toContain('ctor.registered');
  });

  it('A9 pageSize / maxPages 非法时构造直接抛错，不静默退化', () => {
    const host = createHost();
    const source = createInstantSource(() => []);
    for (const pageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createBoundedList(baseOptions(host, source, { pageSize }))).toThrow(RangeError);
    }
    for (const maxPages of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createBoundedList(baseOptions(host, source, { maxPages }))).toThrow(RangeError);
    }
    expect(() => createBoundedList(baseOptions(host, source, {
      pageSize: Number.MAX_SAFE_INTEGER,
      maxPages: 2,
    }))).toThrow(RangeError);
  });

  it('A10 selection.store 与 selection.max 同时给出时构造抛错（避免 max 被静默忽略）', () => {
    const host = createHost();
    const store = new SelectionStore();
    expect(() => createBoundedList(baseOptions(host, createInstantSource(() => []), {
      selection: { mode: 'multi', store, max: 1 },
    }))).toThrow(TypeError);
  });

  it('A11 构造时给滚动容器补上 a11y 属性，dispose 时清理干净', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi' },
    }));
    expect(host.scroller.getAttribute('tabindex')).toBe('0');
    expect(host.scroller.getAttribute('role')).toBe('listbox');
    expect(host.scroller.getAttribute('aria-multiselectable')).toBe('true');
    await list.reset();
    expect(host.scroller.children[0].getAttribute('role')).toBe('option');
    expect(host.scroller.children[0].getAttribute('aria-selected')).toBe('false');
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    expect(host.scroller.children[0].getAttribute('aria-selected')).toBe('true');

    list.dispose();
    expect(host.scroller.getAttribute('tabindex')).toBeNull();
    expect(host.scroller.getAttribute('role')).toBeNull();
    expect(host.scroller.getAttribute('aria-multiselectable')).toBeNull();
  });

  it('A12 未开启 selection 时行上只有 role=option，没有 aria-selected', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    expect(host.scroller.getAttribute('aria-multiselectable')).toBeNull();
    expect(host.scroller.children[0].getAttribute('role')).toBe('option');
    expect(host.scroller.children[0].getAttribute('aria-selected')).toBeNull();
    list.dispose();
  });

  it('A12b dispose 精确恢复宿主原有 a11y 属性，而不是一律删除', () => {
    const host = createHost();
    host.scroller.setAttribute('tabindex', '7');
    host.scroller.setAttribute('role', 'feed');
    host.scroller.setAttribute('aria-multiselectable', 'false');
    const list = createBoundedList(baseOptions(host, createInstantSource(() => []), {
      selection: { mode: 'multi' },
    }));
    expect(host.scroller.getAttribute('tabindex')).toBe('0');
    expect(host.scroller.getAttribute('role')).toBe('listbox');
    expect(host.scroller.getAttribute('aria-multiselectable')).toBe('true');

    list.dispose();
    expect(host.scroller.getAttribute('tabindex')).toBe('7');
    expect(host.scroller.getAttribute('role')).toBe('feed');
    expect(host.scroller.getAttribute('aria-multiselectable')).toBe('false');
  });

  it('A13 登记到 register 指定的那份宿主注册表，不会串到别的宿主（多实例隔离）', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const hostRegistry = new Map<string, { id: string; invalidate(): void | Promise<void> }>();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      id: 'host-owned',
      register: (instance) => {
        hostRegistry.set(instance.id, instance);
        return () => hostRegistry.delete(instance.id);
      },
    }));
    expect(hostRegistry.has('host-owned')).toBe(true);
    expect(registeredIds()).not.toContain('host-owned');

    // 宿主注册表广播得到的就是组件实例本身，invalidate 走的是组件的决策树。
    await list.reset();
    host.scroller.scrollTop = 100;
    void hostRegistry.get('host-owned')!.invalidate();
    expect(list.getState().stale).toBe(true);

    list.dispose();
    expect(hostRegistry.size).toBe(0);
  });

  it('A14 目录入口不再被同名旧模块遮蔽：`app/bounded-list` 解析到组件的公开导出面', async () => {
    // 历史上 src/app/ 下同时有 bounded-list.ts（旧 BoundedListController 接口）与
    // bounded-list/ 目录，.ts 文件优先导致公开入口只能写 './bounded-list/index'。
    const entry = await import('../../../src/app/bounded-list');
    // 运行时导出面刻意保持最小：一个工厂 + 两个数据源 + 选中集 + register 空实现。
    expect(Object.keys(entry).sort()).toEqual([
      'SelectionStore', 'createBoundedList', 'localPageSource', 'serverPageSource', 'standaloneList',
    ]);
    expect(typeof entry.createBoundedList).toBe('function');
    // BoundedList 只按类型导出（调用方从不 new，实例统一来自 createBoundedList）。
    expect(Object.keys(entry)).not.toContain('BoundedList');
    // 进程级注册表连同它的广播函数已经删除：register 必填，注册表实体只属于宿主。
    expect(Object.keys(entry)).not.toContain('invalidateAllBoundedLists');
    expect(Object.keys(entry)).not.toContain('registeredBoundedListIds');
  });

  it('A8 selection 不传 store 时按 max 自建一个内部 store', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onExceed = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', max: 1, onExceed },
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(onExceed).toHaveBeenCalledTimes(1);
    list.dispose();
  });
});

// ───────────────────────── B reset 首屏 ─────────────────────────

describe('BoundedList / B reset 首屏', () => {
  it('B1 reset 拉首页并渲染，loaded 由 false 变 true', async () => {
    const all = makeTestItems(20);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    expect(list.getState().loaded).toBe(false);
    await list.reset();
    expect(list.getState().loaded).toBe(true);
    expect(list.getState().count).toBe(3);
    expect(list.getState().hasMoreBackward).toBe(false);
    expect(list.getState().hasMoreForward).toBe(true);
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2']);
    list.dispose();
  });

  it('B2 reset 拿到空首页时 loaded 仍为 true，渲染空态文案', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => [])));
    await list.reset();
    expect(list.getState().loaded).toBe(true);
    expect(list.getState().count).toBe(0);
    expect(host.scroller.children[0].className).toBe('empty-state');
    expect(host.scroller.children[0].textContent).toBe('暂无数据');
    list.dispose();
  });

  it('B3 reset 期间显示 loading 文案（首屏未落定前不显示空态）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset();
    expect(host.scroller.children[0].textContent).toBe('加载中');
    pending[0].resolve(pageOf(makeTestItems(2), '0', '2', false, false));
    await p;
    expect(rendered(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });

  it('B4 pinEdge 默认 true：head 摁到 0，tail 摁到 scrollHeight', async () => {
    const items = makeTestItems(5);
    const headHost = createHost();
    headHost.scroller.scrollTop = 999;
    const head = createBoundedList(baseOptions(headHost, createInstantSource(() => items)));
    await head.reset();
    expect(headHost.scroller.scrollTop).toBe(0);
    head.dispose();

    const tailHost = createHost();
    tailHost.scroller.scrollHeight = 7777;
    const tail = createBoundedList(baseOptions(tailHost, createInstantSource(() => items), { freshEdge: 'tail' }));
    await tail.reset();
    expect(tailHost.scroller.scrollTop).toBe(7777);
    tail.dispose();
  });

  it('B5 pinEdge=false 时不动滚动位置', async () => {
    const items = makeTestItems(5);
    const host = createHost();
    host.scroller.scrollTop = 321;
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset({ pinEdge: false });
    expect(host.scroller.scrollTop).toBe(321);
    list.dispose();
  });

  it('B6 settleFrames>1 时连续若干帧重设滚动位置（图片异步增高的兜底）', async () => {
    await withFramesAsync(async (frames) => {
      const items = makeTestItems(3);
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', settleFrames: 3 }));
      host.scroller.scrollHeight = 1000;
      await list.reset();
      expect(host.scroller.scrollTop).toBe(1000); // 第 1 帧（同步）
      host.scroller.scrollHeight = 2000;          // 图片加载完，内容变高
      frames.run();
      expect(host.scroller.scrollTop).toBe(2000); // 第 2 帧
      host.scroller.scrollHeight = 3000;
      frames.run();
      expect(host.scroller.scrollTop).toBe(3000); // 第 3 帧
      frames.run();
      expect(frames.size()).toBe(0);              // 不再继续排帧
      list.dispose();
    });
  });

  it('B7 settleFrames=1 时只摁一次，不排后续帧', async () => {
    await withFramesAsync(async (frames) => {
      const items = makeTestItems(3);
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
      await list.reset();
      expect(host.scroller.scrollTop).toBe(0);
      expect(frames.size()).toBe(0);
      list.dispose();
    });
  });

  it('B8 reset({ query }) 同时更新查询条件；显式传 query: undefined 也会生效', async () => {
    const host = createHost();
    const seen: Array<string | undefined> = [];
    const source = {
      async fetch(req: { cursor?: string; backward: boolean; limit: number; query: { keyword: string } | undefined }) {
        seen.push(req.query?.keyword);
        return pageOf([], '0', '0', false, false);
      },
    };
    const list = createBoundedList<TestItem, { keyword: string } | undefined>({
      ...(baseOptions(host, source as never) as unknown as BoundedListOptions<TestItem, { keyword: string } | undefined>),
      initialQuery: { keyword: 'init' },
    });
    await list.reset();
    await list.reset({ query: { keyword: 'x' } });
    await list.reset();                       // 不传 query → 沿用上一次
    await list.reset({ query: undefined });   // 显式清空
    expect(seen).toEqual(['init', 'x', 'x', undefined]);
    list.dispose();
  });

  it('B9 reset 并发丢弃：旧的 reset 请求返回后被整体丢弃', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));

    const first = list.reset();
    const second = list.reset();
    expect(pending).toHaveLength(2);
    pending[1].resolve(pageOf(makeTestItems(3, 100), '0', '3', false, false));
    await second;
    pending[0].resolve(pageOf(makeTestItems(3, 0), '0', '3', false, true));
    await first;

    expect(list.getState().count).toBe(3);
    expect(rendered(host)).toEqual(['row-100', 'row-101', 'row-102']);
    list.dispose();
  });

  it('B10 连续 10 次 reset 只有最后一次生效', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const promises = Array.from({ length: 10 }, () => list.reset());
    expect(pending).toHaveLength(10);
    // 乱序落地：先最后一个，再倒序把其余的都放行。
    pending[9].resolve(pageOf(makeTestItems(1, 900), '0', '1', false, false));
    for (let i = 0; i < 9; i++) pending[i].resolve(pageOf(makeTestItems(1, i), '0', '1', false, true));
    await Promise.all(promises);
    expect(rendered(host)).toEqual(['row-900']);
    expect(list.getState().hasMoreForward).toBe(false);
    list.dispose();
  });

  it('B11 reset 会清空上一次窗口内容（切换会话不残留旧数据）', async () => {
    let items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2']);
    items = makeTestItems(2, 50);
    await list.reset();
    expect(rendered(host)).toEqual(['row-50', 'row-51']);
    list.dispose();
  });

  it('B12 reset 透传 pageSize 与 cursor=undefined 给数据源', async () => {
    const host = createHost();
    const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, false));
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }, { pageSize: 40 }));
    await list.reset();
    expect(fetchSpy).toHaveBeenCalledWith({ cursor: undefined, backward: false, limit: 40, query: undefined });
    list.dispose();
  });

  it('B13 reset 在飞期间的 upsert/patch/remove 最终态，在权威响应落地后完整保留', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    let latest: readonly TestItem[] = [];
    const list = createBoundedList(baseOptions(host, source, {
      freshEdge: 'tail',
      pageSize: 3,
      maxPages: 2,
      onItemsChanged: (items) => { latest = items; },
    }));

    const resetting = list.reset({ pinEdge: false });
    list.upsertLocal({ id: 1, label: 'local-remove' });
    list.upsertLocal({ id: 2, label: 'local-draft' });
    expect(list.patch('2', (item) => ({ ...item, label: 'local-draft-v2' }))).toBe(true);
    expect(list.removeLocal('1')).toBe(true);

    pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
    await resetting;
    // remove 把权威页带回的 id=1 挡掉；upsert 连同其上的 patch 一起重放进新窗口，
    // 用户不会看到本端条目先消失再出现的闪动。
    expect(renderedRows(host)).toEqual(['row-0', 'row-2']);
    expect(latest.find((item) => item.id === 2)?.label).toBe('local-draft-v2');
    expect(list.getState().count).toBe(2);
    list.dispose();
  });

  it('B14 reset 在飞时超过硬预算的 overlay 静默丢最旧的一条，权威响应仍正常落地', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, {
      freshEdge: 'tail',
      pageSize: 2,
      maxPages: 1,
      onError,
    }));
    const initial = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
    await initial;

    const resetting = list.reset({ pinEdge: false });
    // reset 会清空 overlay，这三条 remove 都发生在新一轮请求在飞期间。
    // overlay 硬预算 = pageSize×maxPages = 2，写第三条时最旧的 remove(0) 被静默丢弃。
    expect(list.removeLocal('0')).toBe(false);
    expect(list.removeLocal('1')).toBe(false);
    expect(list.removeLocal('9')).toBe(false);
    pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
    await resetting;

    expect(pending).toHaveLength(2);
    // 只有仍在 overlay 里的 1/9 被挡住；被挤掉的 0 照常出现在权威页里。
    expect(renderedRows(host)).toEqual(['row-0']);
    expect(list.getState()).toMatchObject({ loaded: true, failed: false, count: 1 });
    expect(onError).not.toHaveBeenCalled();
    list.dispose();
  });
});

// ───────────────────────── C loadMore 双向续翻 ─────────────────────────

describe('BoundedList / C loadMore 双向续翻与整页裁剪', () => {
  it('C1 forward 续翻并在超限时整页裁首，窗口条目数不超过 pageSize×maxPages', async () => {
    const all = makeTestItems(20);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all)));
    await list.reset();
    host.scroller.scrollTop = 500; // 挪开滚动位置，避免 checkReach 干扰手动翻页
    for (let i = 0; i < 5; i++) await list.loadMore('forward');
    expect(list.getState().count).toBeLessThanOrEqual(3 * 2);
    expect(list.getState().hasMoreBackward).toBe(true);
    list.dispose();
  });

  it('C2 backward 续翻并在超限时整页裁尾（从窗口中部起步的场景）', async () => {
    const all = makeTestItems(30);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 15)));
    await list.reset({ pinEdge: false });
    expect(rendered(host)).toEqual(['row-15', 'row-16', 'row-17']);
    expect(list.getState().hasMoreBackward).toBe(true);

    await list.loadMore('backward');
    expect(rendered(host)).toEqual(['row-12', 'row-13', 'row-14', 'row-15', 'row-16', 'row-17']);
    await list.loadMore('backward'); // 超过 maxPages=2 → 裁掉尾页
    expect(rendered(host)).toEqual(['row-9', 'row-10', 'row-11', 'row-12', 'row-13', 'row-14']);
    expect(list.getState().hasMoreForward).toBe(true);
    expect(list.getState().count).toBe(6);
    list.dispose();
  });

  it('C3 backward 续翻到头时 hasMoreBackward 收敛为 false', async () => {
    const all = makeTestItems(6);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 3)));
    await list.reset({ pinEdge: false });
    await list.loadMore('backward');
    expect(list.getState().hasMoreBackward).toBe(false);
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
    list.dispose();
  });

  it('C4 loadMore 在该方向没有更多时直接返回，不发请求', async () => {
    const all = makeTestItems(3);
    const host = createHost();
    const fetchSpy = vi.fn(createInstantSource(() => all).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
    await list.reset();
    fetchSpy.mockClear();
    expect(list.getState().hasMoreForward).toBe(false);
    expect(list.getState().hasMoreBackward).toBe(false);
    await list.loadMore('forward');
    await list.loadMore('backward');
    expect(fetchSpy).not.toHaveBeenCalled();
    list.dispose();
  });

  it('C5 同方向已在加载时重复调用不重复发请求；反方向可以并发', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const resetPromise = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(3, 10), '10', '13', true, true));
    await resetPromise;
    host.scroller.scrollTop = 500; // 远离两端，避免触界检测插进来发额外请求

    const f1 = list.loadMore('forward');
    const f2 = list.loadMore('forward'); // 同方向已在加载 → 直接返回
    const b1 = list.loadMore('backward'); // 反方向 → 真的发请求
    expect(pending).toHaveLength(3);
    expect(list.getState().loadingBackward).toBe(true);
    expect(list.getState().loadingForward).toBe(true);
    expect(list.getState().loading).toBe(true);

    pending[1].resolve(pageOf(makeTestItems(3, 13), '13', '16', true, false));
    pending[2].resolve(pageOf(makeTestItems(3, 7), '7', '10', false, true));
    await Promise.all([f1, f2, b1]);
    expect(pending).toHaveLength(3);
    expect(list.getState().loading).toBe(false);
    list.dispose();
  });

  it('C6 loadMore 使用保留页的边界游标续翻（裁剪之后仍然正确）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { maxPages: 2 }));
    const p = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3, 0), 'sA', 'eA', false, true));
    await p;
    host.scroller.scrollTop = 500;

    const f1 = list.loadMore('forward');
    expect(pending[1].req.cursor).toBe('eA');
    pending[1].resolve(pageOf(makeTestItems(3, 3), 'sB', 'eB', true, true));
    await f1;

    const f2 = list.loadMore('forward');
    expect(pending[2].req.cursor).toBe('eB');
    pending[2].resolve(pageOf(makeTestItems(3, 6), 'sC', 'eC', true, true)); // 裁掉页 A
    await f2;

    const b1 = list.loadMore('backward');
    expect(pending[3].req.cursor).toBe('sB'); // 首页已变成 B
    expect(pending[3].req.backward).toBe(true);
    pending[3].resolve(pageOf(makeTestItems(3, 0), 'sA', 'eA', false, true));
    await b1;
    list.dispose();
  });

  it('C7 触界检测自动触发续翻：贴顶拉 backward、贴底拉 forward', async () => {
    const all = makeTestItems(30);
    const host = createHost();
    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 1000;
    const list = createBoundedList(baseOptions(host, createAnchoredSource(() => all, 15), { reachPx: 10 }));
    await list.reset({ pinEdge: false });

    host.scroller.scrollTop = 5; // 距顶 5 <= reachPx=10
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(list.getState().count).toBeGreaterThan(3);
    const afterBackward = list.getState().count;

    host.scroller.scrollTop = 895; // 距底 5
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(list.getState().count).toBeGreaterThanOrEqual(afterBackward);
    list.dispose();
  });

  it('C8 链式补页：首屏不足一屏时持续补页，直到某端返回空页而终止', async () => {
    const all = makeTestItems(9);
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120; // 永远「不足一屏」→ 每次 render 都触界
    const fetchSpy = vi.fn(createOptimisticSource(() => all).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }, { maxPages: 10 }));
    await list.reset({ pinEdge: false });
    await flushAsync();
    expect(list.getState().hasMoreForward).toBe(false);
    expect(list.getState().count).toBe(9);
    // 3 页数据 + 1 页空结果 = 4 次请求，链条必然终止。
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    list.dispose();
  });

  it('C13 翻页失败后不再自动重试：贴边且内容不足一屏也只发一次请求', async () => {
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120; // 内容不足一屏 → checkReach 恒判定贴底
    let calls = 0;
    const source = {
      async fetch() {
        calls++;
        if (calls === 1) return pageOf(makeTestItems(3), '0', '3', false, true);
        throw new Error('network');
      },
    };
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    await list.reset({ pinEdge: false });
    await flushAsync();
    expect(calls).toBe(2); // 首页 + 一次失败的自动续翻，然后停下
    expect(onError).toHaveBeenCalledTimes(1);
    expect(list.getState().loadingForward).toBe(false);
    list.dispose();
  });

  it('C14 自动续翻暂停后：显式 loadMore 会重试，滚离该端也会解除暂停', async () => {
    const host = createHost();
    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 1000;
    let calls = 0;
    let failing = true;
    const all = makeTestItems(30);
    const source = {
      async fetch(req: { cursor?: string; backward: boolean; limit: number; query: void }) {
        calls++;
        if (calls > 1 && failing) throw new Error('network');
        return createAnchoredSource(() => all, 0).fetch(req);
      },
    };
    const list = createBoundedList(baseOptions(host, source, { onError: () => {}, reachPx: 10 }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 895; // 贴底
    host.scroller.dispatch('scroll');
    await flushAsync();
    const afterFailure = calls;
    expect(afterFailure).toBe(2);

    // 仍然贴底再滚一次：被暂停挡住，不会重复轰炸。
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(calls).toBe(afterFailure);

    // 显式调用视为用户主动重试（成功后会照常继续链式补页，所以只断言「确实又发了请求」）。
    failing = false;
    await list.loadMore('forward');
    await flushAsync();
    expect(calls).toBeGreaterThan(afterFailure);
    expect(list.getState().count).toBeGreaterThan(3);
    list.dispose();
  });

  it('C15 滚离触界范围会解除自动续翻暂停，滚回去可以自然重试', async () => {
    const host = createHost();
    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 1000;
    let calls = 0;
    let failing = true;
    const all = makeTestItems(30);
    const source = {
      async fetch(req: { cursor?: string; backward: boolean; limit: number; query: void }) {
        calls++;
        if (calls > 1 && failing) throw new Error('network');
        return createAnchoredSource(() => all, 0).fetch(req);
      },
    };
    const list = createBoundedList(baseOptions(host, source, { onError: () => {}, reachPx: 10 }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 895;
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(calls).toBe(2);

    host.scroller.scrollTop = 400; // 滚离底部 → 解除暂停
    host.scroller.dispatch('scroll');
    await flushAsync();
    failing = false;
    host.scroller.scrollTop = 895; // 滚回底部 → 自然重试
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(calls).toBeGreaterThan(2);
    expect(list.getState().count).toBeGreaterThan(3);
    list.dispose();
  });

  it('C16 服务端把空页报成「还有更多」时该端照样收敛，不会无限补页', async () => {
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120;
    let calls = 0;
    const source = {
      async fetch() {
        calls++;
        if (calls === 1) return pageOf(makeTestItems(3), '0', '3', false, true);
        return pageOf([], '3', '3', false, true); // 违反契约：空页却说还有更多
      },
    };
    const list = createBoundedList(baseOptions(host, source));
    await list.reset({ pinEdge: false });
    await flushAsync();
    expect(calls).toBe(2);
    expect(list.getState().hasMoreForward).toBe(false);
    list.dispose();
  });

  it('C17 空首页但服务端说还有更多时继续补页，不会定格在空态', async () => {
    const host = createHost();
    host.scroller.clientHeight = 120;
    host.scroller.scrollHeight = 120;
    let calls = 0;
    const source = {
      async fetch() {
        calls++;
        if (calls === 1) return pageOf([], 'sEmpty', 'eEmpty', false, true);
        return pageOf(makeTestItems(2, 5), 'sEmpty', 'e2', false, false);
      },
    };
    const list = createBoundedList(baseOptions(host, source));
    await list.reset({ pinEdge: false });
    await flushAsync();
    expect(calls).toBe(2);
    expect(renderedRows(host)).toEqual(['row-5', 'row-6']);
    list.dispose();
  });

  it('C18 服务端说还有更多但没给出可用游标时不发空游标请求', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { freshEdge: 'tail' }));
    const p = list.reset({ pinEdge: false });
    // 首页为空且边界游标也是空串：服务端说前面还有，但客户端没有任何锚点可用。
    pending[0].resolve(pageOf([], '', '', true, false));
    await p;
    expect(list.getState().hasMoreBackward).toBe(true);
    await list.loadMore('backward');
    expect(pending).toHaveLength(1); // 没有发出第二个请求
    list.dispose();
  });

  it('C19 只有本端并入条目的窗口如实报告「两端都没有更多」，不会带空游标续翻', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { freshEdge: 'tail' }));
    const p = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf([], '', '', true, false));
    await p;
    list.upsertLocal({ id: 1, label: 'local' });
    expect(list.getState().hasMoreBackward).toBe(false);
    expect(list.getState().hasMoreForward).toBe(false);
    await list.loadMore('backward');
    await list.loadMore('forward');
    expect(pending).toHaveLength(1);
    list.dispose();
  });

  it('C20 空首页带有真实边界游标时，续翻用的就是它（锚点不丢）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf([], 'sEmpty', 'eEmpty', true, false));
    await p;
    const lp = list.loadMore('backward');
    expect(pending).toHaveLength(2);
    expect(pending[1].req.cursor).toBe('sEmpty');
    pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
    await lp;
    expect(renderedRows(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });

  it('C9 loadMore 拿到空页时强制收敛该端 hasMore（服务端乐观报还有更多也不认）', async () => {
    const all = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createOptimisticSource(() => all)));
    await list.reset({ pinEdge: false });
    expect(list.getState().hasMoreForward).toBe(true); // 满页 → 乐观认为还有
    await list.loadMore('forward');
    expect(list.getState().hasMoreForward).toBe(false);
    list.dispose();
  });

  it('C9b normalize 后为空时下一次续翻使用已前进的新游标，不重复请求旧游标', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, {
      pageSize: 1,
      maxPages: 3,
      normalize: (items) => items.filter((item) => item.id !== 1),
    }));
    const initial = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf([{ id: 0, label: 'item-0' }], 's0', 'e0', false, true));
    await initial;

    const filtered = list.loadMore('forward');
    pending[1].resolve(pageOf([{ id: 1, label: 'filtered' }], 's1', 'e1', true, true));
    await filtered;
    expect(list.getState().hasMoreForward).toBe(true);

    const next = list.loadMore('forward');
    expect(pending[2].req.cursor).toBe('e1');
    pending[2].resolve(pageOf([{ id: 2, label: 'item-2' }], 's2', 'e2', true, false));
    await next;
    expect(renderedRows(host)).toEqual(['row-0', 'row-2']);
    list.dispose();
  });

  it('C10 loadMore 期间发生 reset：陈旧结果被丢弃，loading 标志由 reset 归零', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onItemsChanged = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onItemsChanged }));
    const p = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(3, 0), 's0', 'e0', false, true));
    await p;
    host.scroller.scrollTop = 500;

    const loadP = list.loadMore('forward');
    expect(list.getState().loadingForward).toBe(true);
    const resetP = list.reset({ pinEdge: false });
    expect(list.getState().loadingForward).toBe(false); // reset 立刻归零两端 loading
    expect(pending).toHaveLength(3);

    pending[1].resolve(pageOf(makeTestItems(3, 3), 's1', 'e1', true, true)); // 陈旧的 loadMore 结果
    await loadP;
    pending[2].resolve(pageOf(makeTestItems(2, 900), 's9', 'e9', false, false));
    await resetP;

    expect(renderedRows(host)).toEqual(['row-900', 'row-901']);
    list.dispose();
  });

  it('C11 跨页去重：同一身份在窗口里至多出现一次', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { maxPages: 3 }));
    const p = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3, 0), 's0', 'e0', false, true));
    await p;
    host.scroller.scrollTop = 500;
    const f = list.loadMore('forward');
    pending[1].resolve(pageOf([{ id: 2, label: 'moved' }, { id: 3, label: 'i3' }], 's1', 'e1', true, false));
    await f;
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
    list.dispose();
  });

  it('C12 normalize 作用于每一页入窗前', async () => {
    const all = makeTestItems(6);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => all), {
      normalize: (items) => [...items].reverse(),
    }));
    await list.reset({ pinEdge: false });
    expect(rendered(host)).toEqual(['row-2', 'row-1', 'row-0']);
    list.dispose();
  });

  it('C21 loadMore 在飞期间的 patch/remove 最终态不会被返回页中的同 identity 旧值覆盖', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    let latest: readonly TestItem[] = [];
    const list = createBoundedList(baseOptions(host, source, {
      freshEdge: 'tail',
      pageSize: 2,
      maxPages: 2,
      onItemsChanged: (items) => { latest = items; },
    }));
    const initial = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, true));
    await initial;

    const loading = list.loadMore('forward');
    // 分页在飞期间对「该页将带回来的身份」做本地最终态：patch 改值、remove 删除。
    // 两者都与位置无关，会在页并入后重放；旧值不得回退，删除项不得复活。
    expect(list.patch('1', (item) => ({ ...item, label: 'local-1-v2' }))).toBe(true);
    expect(list.removeLocal('3')).toBe(false); // 还不在窗口里，但仍记入 overlay
    pending[1].resolve(pageOf(
      [{ id: 1, label: 'server-1-old' }, { id: 3, label: 'server-3' }],
      's1', 'e1', true, false,
    ));
    await loading;

    expect(latest.find((item) => item.id === 1)?.label).toBe('local-1-v2');
    expect(latest.map((item) => item.id).sort((a, b) => a - b)).toEqual([0, 1]);
    list.dispose();
  });
});

// ───────────────────────── D setQuery 防抖 ─────────────────────────

describe('BoundedList / D setQuery 与防抖', () => {
  it('D1 debounceMs=0 时同步触发 reset', async () => {
    const host = createHost();
    const seen: string[] = [];
    const source = {
      async fetch(req: { query: { keyword: string } }) { seen.push(req.query.keyword); return pageOf([], '0', '0', false, false); },
    };
    const list = createBoundedList<TestItem, { keyword: string }>({
      ...(baseOptions(host, source as never) as unknown as BoundedListOptions<TestItem, { keyword: string }>),
      initialQuery: { keyword: '' },
    });
    list.setQuery({ keyword: 'abc' }, { debounceMs: 0 });
    await flushAsync();
    expect(seen).toEqual(['abc']);
    list.dispose();
  });

  it('D2 默认防抖 300ms：期间的连续输入只触发最后一次 reset', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      const seen: string[] = [];
      const source = {
        async fetch(req: { query: { keyword: string } }) { seen.push(req.query.keyword); return pageOf([], '0', '0', false, false); },
      };
      const list = createBoundedList<TestItem, { keyword: string }>({
        ...(baseOptions(host, source as never) as unknown as BoundedListOptions<TestItem, { keyword: string }>),
        initialQuery: { keyword: '' },
      });
      list.setQuery({ keyword: 'a' });
      await vi.advanceTimersByTimeAsync(100);
      list.setQuery({ keyword: 'ab' });
      await vi.advanceTimersByTimeAsync(100);
      list.setQuery({ keyword: 'abc' });
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(299);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(['abc']);
      list.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D3 自定义 debounceMs 生效', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, false));
      const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
      list.setQuery(undefined, { debounceMs: 50 });
      await vi.advanceTimersByTimeAsync(49);
      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      list.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D4 负数 debounceMs 等价于 0（立即执行）', async () => {
    const host = createHost();
    const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, false));
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
    list.setQuery(undefined, { debounceMs: -1 });
    await flushAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    list.dispose();
  });

  it('D5 dispose 会取消尚未触发的防抖计时器', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, false));
      const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
      list.setQuery(undefined, { debounceMs: 300 });
      list.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D6 dispose 后 setQuery 是空操作', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, false));
      const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
      list.dispose();
      list.setQuery(undefined, { debounceMs: 0 });
      list.setQuery(undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D9 reset 请求形状保持最小', async () => {
    const host = createHost();
    const fetchSpy = vi.fn(async () => pageOf([], '0', '0', false, false));
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }, { pageSize: 40 }));
    await list.reset();
    expect(fetchSpy).toHaveBeenCalledWith({ cursor: undefined, backward: false, limit: 40, query: undefined });
    list.dispose();
  });

  it('D7 setQuery 触发的 reset 会重置窗口并回到新鲜端', async () => {
    const host = createHost();
    const all = makeTestItems(1000).map((item) => ({ ...item, label: item.id % 2 === 0 ? `even-${item.id}` : `odd-${item.id}` }));
    const source = localPageSource<TestItem, { keyword: string }>({
      loadAll: async () => all,
      filter: (item, q) => !q.keyword || item.label.includes(q.keyword),
      compare: (a, b) => a.id - b.id,
    });
    const list = createBoundedList<TestItem, { keyword: string }>({
      id: 'mention-picker',
      scrollElement: asElement(host.scroller),
      register: testRegister,
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
    expect(host.scroller.children.length).toBeLessThanOrEqual(200);

    host.scroller.scrollTop = 900;
    list.setQuery({ keyword: 'even' }, { debounceMs: 0 });
    await flushAsync();
    expect(list.getState().count).toBeLessThanOrEqual(200);
    expect(host.scroller.scrollTop).toBe(0);
    expect(host.scroller.children[0]?.className).toMatch(/row-\d*[02468]$/);
    list.dispose();
  });
});

// ───────────────────────── E invalidate 决策树 ─────────────────────────

describe('BoundedList / E invalidate 决策树（§5.1）', () => {
  function setupInvalidateList(items: TestItem[], overrides: Partial<BoundedListOptions<TestItem, void>> = {}) {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), overrides));
    return { host, list };
  }

  it('E1 isActive() 为 false 时只记 stale，不发任何请求', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items, { isActive: () => false });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 3 });
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(3);
    expect(list.getState().count).toBe(3); // 窗口没有被重拉
    list.dispose();
  });

  it('E1b isActive() 为 false 时仍然重渲一次，提示条与状态同步（切回可见即所见即最新）', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items, { isActive: () => false });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 3 });
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    expect(pillOf(host).textContent).toBe('有更新(3)');
    list.dispose();
  });

  it('E2 isActive() 为 false 且贴在新鲜端时同样不追平（可见性优先于贴边）', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items, { isActive: () => false });
    await list.reset();
    host.scroller.scrollTop = 0;
    items.unshift({ id: -1, label: 'new' });
    list.invalidate({ count: 1 });
    await flushAsync();
    expect(list.getState().stale).toBe(true);
    expect(rendered(host)[0]).toBe('row-0'); // 内容没变
    list.dispose();
  });

  it('E3 贴在新鲜端时直接 reset 追平，stale 保持 false', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 0;
    items.unshift({ id: -1, label: 'new' });
    list.invalidate({ count: 1 });
    await flushAsync();
    expect(list.getState().stale).toBe(false);
    expect(rendered(host)[0]).toBe('row--1');
    list.dispose();
  });

  it('E4 不贴新鲜端时只点亮提示条，列表内容不变', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 100;
    const before = rendered(host);
    list.invalidate({ count: 2 });
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(2);
    expect(rendered(host)).toEqual(before);
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    expect(pillOf(host).textContent).toBe('有更新(2)');
    list.dispose();
  });

  it('E5 pendingCount 在多次 invalidate 间累加，追平后归零', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 2 });
    list.invalidate({ count: 3 });
    list.invalidate();
    expect(list.getState().pendingCount).toBe(5);
    await list.reset();
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });

  it('E6 identities 命中窗口且提供 fetchByIdentity：只对交集批量拉取，返回缺失的身份被删除', async () => {
    const items = makeTestItems(10);
    const fetchByIdentity = vi.fn(async (ids: readonly string[]) =>
      ids.filter((id) => id !== '1').map((id) => ({ id: Number(id), label: `patched-${id}` })),
    );
    const { host, list } = setupInvalidateList(items, { fetchByIdentity });
    await list.reset(); // 窗口内 [0,1,2]
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1', '2', '999'] }); // 999 不在窗口内
    await flushAsync();
    expect(fetchByIdentity).toHaveBeenCalledTimes(1);
    expect(fetchByIdentity).toHaveBeenCalledWith(expect.arrayContaining(['1', '2']));
    expect((fetchByIdentity.mock.calls[0][0] as string[]).includes('999')).toBe(false);
    expect(rendered(host)).toEqual(['row-0', 'row-2']);
    list.dispose();
  });

  it('E7 定向刷新不改变页结构与边界游标（续翻锚点不受影响）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const fetcher = createControllableFetcher<TestItem>();
    const list = createBoundedList(baseOptions(host, source, { fetchByIdentity: fetcher.fetchByIdentity }));
    const p = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), 'sA', 'eA', false, true));
    await p;
    host.scroller.scrollTop = 100;

    list.invalidate({ identities: ['1'] });
    fetcher.settle(0, [{ id: 1, label: 'patched' }]);
    await flushAsync();

    const f = list.loadMore('forward');
    expect(pending[1].req.cursor).toBe('eA'); // 游标未受定向刷新影响
    pending[1].resolve(pageOf(makeTestItems(3, 3), 'sB', 'eB', true, false));
    await f;
    list.dispose();
  });

  it('E8 identities 均不命中窗口时不调用 fetchByIdentity，但仍重渲（同步提示条）', async () => {
    const items = makeTestItems(10);
    const fetchByIdentity = vi.fn(async () => []);
    const { host, list } = setupInvalidateList(items, { fetchByIdentity });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['999'], count: 1 });
    await flushAsync();
    expect(fetchByIdentity).not.toHaveBeenCalled();
    expect(list.getState().stale).toBe(true);
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    list.dispose();
  });

  it('E9 命中窗口但未提供 fetchByIdentity 时退化为只点亮提示条', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    await flushAsync();
    expect(list.getState().stale).toBe(true);
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2']);
    list.dispose();
  });

  it('E10 同一帧内多次 invalidate 只跑一次决策，identities 与 count 都被合并', () => {
    withFrames((frames) => {
      const items = makeTestItems(10);
      const fetchByIdentity = vi.fn(async () => []);
      const { host, list } = setupInvalidateList(items, { fetchByIdentity });
      host.scroller.scrollTop = 100;
      list.invalidate({ count: 1, identities: ['1'] });
      list.invalidate({ count: 2, identities: ['2'] });
      list.invalidate({ count: 3 });
      expect(frames.size()).toBe(1);
      frames.run();
      expect(list.getState().pendingCount).toBe(6); // 1+2+3 累加
      list.dispose();
    });
  });

  it('E11 重复身份在合并时自动去重（Set 语义）', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1', '1', '2', '1'] });
    await flushAsync();
    expect(fetcher.calls[0]).toEqual(['1', '2']);
    fetcher.settle(0, []);
    list.dispose();
  });

  it('E11b 定向刷新期间提示条立刻亮起，不等请求返回', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'], count: 2 });
    await flushAsync();
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    expect(pillOf(host).textContent).toBe('有更新(2)');
    fetcher.settle(0, [{ id: 1, label: 'patched' }]);
    await flushAsync();
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    list.dispose();
  });

  it('E12b 定向刷新期间发生 reset：陈旧结果被整体丢弃，不会误删新窗口里的条目', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    await flushAsync();
    expect(fetcher.calls).toHaveLength(1);

    await list.reset({ pinEdge: false }); // 窗口整体重建，旧请求的上下文已经作废
    fetcher.settle(0, []);                // 陈旧结果：id=1「不存在」
    await flushAsync();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
    list.dispose();
  });

  it('E12c 定向刷新失败但期间发生过 reset 时不上报错误（结果已作废）', async () => {
    const items = makeTestItems(10);
    const onError = vi.fn();
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity, onError });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    await flushAsync();
    await list.reset({ pinEdge: false });
    fetcher.fail(0, new Error('已经不关心了'));
    await flushAsync();
    expect(onError).not.toHaveBeenCalled();
    list.dispose();
  });

  it('E12d 不同 identity 的并发定向刷新互不淘汰，分别按各自结果落地', async () => {
    const items = makeTestItems(10);
    const latest: TestItem[][] = [];
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, {
      fetchByIdentity: fetcher.fetchByIdentity,
      onItemsChanged: (changed) => latest.push([...changed]),
    });
    await list.reset();
    host.scroller.scrollTop = 100;

    list.invalidate({ identities: ['1'] });
    await flushAsync();
    list.invalidate({ identities: ['2'] });
    await flushAsync();
    expect(fetcher.calls).toEqual([['1'], ['2']]);

    fetcher.settle(1, [{ id: 2, label: 'fresh-2' }]);
    await flushAsync();
    fetcher.settle(0, [{ id: 1, label: 'fresh-1' }]);
    await flushAsync();
    const final = latest.at(-1)!;
    expect(final.find((item) => item.id === 1)?.label).toBe('fresh-1');
    expect(final.find((item) => item.id === 2)?.label).toBe('fresh-2');
    list.dispose();
  });

  it('E12e 在飞定向刷新不会覆盖同 identity 的后续 patch/remove/upsertLocal', async () => {
    const items = makeTestItems(10);
    const latest: TestItem[][] = [];
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, {
      fetchByIdentity: fetcher.fetchByIdentity,
      onItemsChanged: (changed) => latest.push([...changed]),
      freshEdge: 'tail',
      // pageSize 覆盖全部条目：createInstantSource 的 reset 恒从头切片，只有一次
      // 拿全才能让 hasMoreForward 归零，满足 upsertLocal 对「已追平新鲜端」的前置要求。
      pageSize: items.length,
    });
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    await flushAsync();

    expect(list.patch('1', (item) => ({ ...item, label: 'local-patch' }))).toBe(true);
    fetcher.settle(0, [{ id: 1, label: 'stale-refresh' }]);
    await flushAsync();
    expect(latest.at(-1)?.find((item) => item.id === 1)?.label).toBe('local-patch');

    list.invalidate({ identities: ['2'] });
    await flushAsync();
    expect(list.removeLocal('2')).toBe(true);
    fetcher.settle(1, [{ id: 2, label: 'stale-refresh' }]);
    await flushAsync();
    expect(latest.at(-1)?.some((item) => item.id === 2)).toBe(false);

    list.invalidate({ identities: ['0'] });
    await flushAsync();
    list.upsertLocal({ id: 0, label: 'local-upsert' });
    fetcher.settle(2, [{ id: 0, label: 'stale-refresh' }]);
    await flushAsync();
    expect(latest.at(-1)?.find((item) => item.id === 0)?.label).toBe('local-upsert');
    list.dispose();
  });

  it('E12f 定向刷新 token 只为真实命中且在飞的 identity 存活，落定后立即释放', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity });
    const tokens = (list as unknown as { refreshTokenByIdentity: Map<string, symbol> }).refreshTokenByIdentity;
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 100;

    for (let index = 0; index < 1_000; index++) {
      list.invalidate({ identities: [`missing-${index}`] });
    }
    await flushAsync();
    expect(tokens.size).toBe(0);
    expect(fetcher.calls).toHaveLength(0);

    list.invalidate({ identities: ['1'] });
    await flushAsync();
    expect(tokens.size).toBe(1);
    fetcher.settle(0, [{ id: 1, label: 'fresh-1' }]);
    await flushAsync();
    expect(tokens.size).toBe(0);
    list.dispose();
  });

  it('E12g fetchByIdentity 同步抛错也进入 refresh 错误流并释放 token', async () => {
    const items = makeTestItems(10);
    const onError = vi.fn();
    const { host, list } = setupInvalidateList(items, {
      fetchByIdentity: (() => { throw new Error('sync-refresh-failure'); }) as never,
      onError,
    });
    const tokens = (list as unknown as { refreshTokenByIdentity: Map<string, symbol> }).refreshTokenByIdentity;
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 100;

    list.invalidate({ identities: ['1'] });
    await flushAsync();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync-refresh-failure' }), 'refresh');
    expect(tokens.size).toBe(0);
    list.dispose();
  });

  it('E12h 已接受的同 identity refresh 会淘汰旧 overlay，后续 reconcile 不回退到 v1', async () => {
    let sourceItems = makeTestItems(2);
    const fetcher = createControllableFetcher<TestItem>();
    const host = createHost();
    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 1_000;
    host.scroller.scrollTop = 0;
    let latest: readonly TestItem[] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => sourceItems), {
      freshEdge: 'tail',
      pageSize: 2,
      maxPages: 1,
      fetchByIdentity: fetcher.fetchByIdentity,
      onItemsChanged: (items) => { latest = items; },
    }));
    const mutations = (list as unknown as { pendingMutations: Map<string, unknown> }).pendingMutations;
    await list.reset({ pinEdge: false });
    // 这次 upsert 会撑破硬预算并裁剪，使非新鲜端游标失效；随后的 patch 因此进入
    // overlay，制造出「定向刷新落地时该身份已有旧 overlay」的前置条件。
    list.upsertLocal({ id: 2, label: 'local-v0' });
    expect(list.patch('2', (item) => ({ ...item, label: 'local-v1' }))).toBe(true);
    list.invalidate({ identities: ['2'] });
    await flushAsync();
    expect(fetcher.calls).toEqual([['2']]);
    expect(mutations.has('2')).toBe(true);

    fetcher.settle(0, [{ id: 2, label: 'authority-v2' }]);
    await flushAsync();
    expect(latest.find((item) => item.id === 2)?.label).toBe('authority-v2');
    // 没有普通分页在飞：接受 refresh 后直接淘汰同身份的旧 overlay。
    expect(mutations.has('2')).toBe(false);

    sourceItems = [{ id: 1, label: 'row-1' }, { id: 2, label: 'authority-v2' }];
    await list.loadMore('backward');
    expect(latest.find((item) => item.id === 2)?.label).toBe('authority-v2');
    list.dispose();
  });

  it('E12i 窗口还没追平新鲜端时 upsertLocal 只记入 overlay，不影响并发 refresh token', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const fetcher = createControllableFetcher<TestItem>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, {
      freshEdge: 'tail',
      pageSize: 2,
      maxPages: 2,
      fetchByIdentity: fetcher.fetchByIdentity,
    }));
    const tokens = (list as unknown as { refreshTokenByIdentity: Map<string, symbol> }).refreshTokenByIdentity;
    const initial = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, true));
    await initial;
    const fill = list.loadMore('forward');
    pending[1].resolve(pageOf(makeTestItems(2, 2), 's1', 'e1', true, true));
    await fill;

    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 1_000;
    host.scroller.scrollTop = 0;
    list.invalidate({ identities: ['0'] });
    await flushAsync();
    expect(tokens.size).toBe(1);

    // 窗口的 hasMoreForward 仍是 true（还没追平新鲜端），upsertLocal 走 overlay 记录分支，
    // 不直接改动窗口，因此不触发 cancelOrdinaryPageLoads，并发 refresh token 原样保留。
    const stalePage = list.loadMore('forward');
    list.upsertLocal({ id: 4, label: 'local-4' });
    expect(tokens.size).toBe(1);
    pending[2].resolve(pageOf(makeTestItems(2, 4), 's2', 'e2', true, false));
    await stalePage;
    expect(tokens.size).toBe(1);
    fetcher.settle(0, [{ id: 0, label: 'stale-refresh' }]);
    await flushAsync();
    expect(tokens.size).toBe(0);
    list.dispose();
  });

  it('E12j refresh 先于旧分页返回时，新值不回退且删除项不复活', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const fetcher = createControllableFetcher<TestItem>();
    const host = createHost();
    host.scroller.clientHeight = 100;
    host.scroller.scrollHeight = 1_000;
    host.scroller.scrollTop = 0;
    let latest: readonly TestItem[] = [];
    const list = createBoundedList(baseOptions(host, source, {
      freshEdge: 'tail',
      pageSize: 3,
      maxPages: 2,
      fetchByIdentity: fetcher.fetchByIdentity,
      onItemsChanged: (items) => { latest = items; },
    }));
    const initial = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(3), 's0', 'e0', false, true));
    await initial;

    list.invalidate({ identities: ['1', '2'] });
    await flushAsync();
    expect(fetcher.calls).toEqual([['1', '2']]);
    const stalePage = list.loadMore('forward');

    fetcher.settle(0, [{ id: 1, label: 'fresh-1' }]);
    await flushAsync();
    expect(latest.find((item) => item.id === 1)?.label).toBe('fresh-1');
    expect(latest.some((item) => item.id === 2)).toBe(false);

    pending[1].resolve(pageOf([
      { id: 1, label: 'stale-page-1' },
      { id: 2, label: 'stale-page-2' },
      { id: 3, label: 'row-3' },
    ], 's1', 'e1', true, false));
    await stalePage;
    expect(latest.find((item) => item.id === 1)?.label).toBe('fresh-1');
    expect(latest.some((item) => item.id === 2)).toBe(false);
    expect(latest.map((item) => item.id)).toEqual([0, 1, 3]);
    list.dispose();
  });

  it('E12 定向刷新失败时上报 refresh 阶段错误，列表保持原样', async () => {
    const items = makeTestItems(10);
    const onError = vi.fn();
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity, onError });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'], count: 1 });
    fetcher.fail(0, new Error('定向拉取失败'));
    await flushAsync();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'refresh');
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(list.getState().stale).toBe(true);
    list.dispose();
  });

  it('E13 定向刷新返回时组件已 dispose：结果被丢弃，不触碰 DOM', async () => {
    const items = makeTestItems(10);
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    const before = rendered(host);
    list.dispose();
    fetcher.settle(0, []); // 若不守卫会把 id=1 删掉
    await flushAsync();
    expect(rendered(host)).toEqual(before);
  });

  it('E14 定向刷新失败时组件已 dispose：不再上报错误', async () => {
    const items = makeTestItems(10);
    const onError = vi.fn();
    const fetcher = createControllableFetcher<TestItem>();
    const { host, list } = setupInvalidateList(items, { fetchByIdentity: fetcher.fetchByIdentity, onError });
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ identities: ['1'] });
    list.dispose();
    fetcher.fail(0, new Error('已经不关心了'));
    await flushAsync();
    expect(onError).not.toHaveBeenCalled();
  });

  it('E15 invalidate 不带任何参数（重连广播）时按决策树正常工作', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate();
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });

  it('E16 首屏尚未加载时 invalidate（贴顶）直接走 reset 追平', async () => {
    const items = makeTestItems(10);
    const { host, list } = setupInvalidateList(items);
    host.scroller.scrollTop = 0;
    list.invalidate({ count: 1 });
    await flushAsync();
    expect(list.getState().loaded).toBe(true);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

});

// ───────────────────────── F 提示条三条消失路径 ─────────────────────────

describe('BoundedList / F 提示条自动消失（§5.3 三条路径）', () => {
  it('F1 路径①：用户自己滚回新鲜端时自动追平，stale 与 pendingCount 一并清零', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 5 });
    expect(list.getState().stale).toBe(true);

    host.scroller.scrollTop = 0;
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    list.dispose();
  });

  it('F2 路径①的守卫：正在加载时即使贴边也不追平（避免与翻页打架）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), 's0', 'e0', true, true));
    await p;
    host.scroller.scrollTop = 500;
    list.invalidate({ count: 1 });
    expect(list.getState().stale).toBe(true);

    void list.loadMore('backward'); // 制造 loadingBackward=true
    const requestsBefore = pending.length;
    host.scroller.scrollTop = 0;
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(pending).toHaveLength(requestsBefore); // 没有为追平再发请求
    expect(list.getState().stale).toBe(true);
    list.dispose();
  });

  it('F3 路径②：触界续翻到新鲜端尽头（拿到空页）时清零 stale 与 pendingCount', async () => {
    const items = makeTestItems(6);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createOptimisticSource(() => items), { freshEdge: 'tail' }));
    await list.reset();
    host.scroller.scrollTop = 999;
    host.scroller.scrollHeight = 2000;
    list.invalidate({ count: 4 });
    expect(list.getState().stale).toBe(true);

    await list.loadMore('forward'); // [3,4,5]，满页仍乐观报告 hasMoreForward=true
    expect(list.getState().hasMoreForward).toBe(true);
    expect(list.getState().stale).toBe(true);
    await list.loadMore('forward'); // 真正拿到空页 → 命中新鲜端方向
    expect(list.getState().hasMoreForward).toBe(false);
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });

  it('F4 路径②只认新鲜端方向：freshEdge=head 时空的 backward 页才清提示条', async () => {
    const all = makeTestItems(9);
    const host = createHost();
    // 两端都「乐观」：满页时先认为可能还有更多，只有真的拿到空页才收敛。
    const optimisticBothEnds = {
      async fetch(req: { cursor?: string; backward: boolean; limit: number; query: void }) {
        const cursor = req.cursor === undefined ? 3 : Number(req.cursor);
        if (req.backward) {
          const start = Math.max(0, cursor - req.limit);
          const page = all.slice(start, cursor);
          return { items: page, startCursor: String(start), endCursor: String(cursor), hasMoreBackward: page.length === req.limit, hasMoreForward: true };
        }
        const end = Math.min(all.length, cursor + req.limit);
        const page = all.slice(cursor, end);
        return { items: page, startCursor: String(cursor), endCursor: String(end), hasMoreBackward: true, hasMoreForward: page.length === req.limit };
      },
    };
    const list = createBoundedList(baseOptions(host, optimisticBothEnds, { freshEdge: 'head' }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 500;
    list.invalidate({ count: 7 });
    expect(list.getState().stale).toBe(true);

    // 非新鲜端方向（forward）拿到空页：不清提示条。
    await list.loadMore('forward'); // [6,7,8]
    await list.loadMore('forward'); // 空页
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(7);

    // 新鲜端方向（backward）拿到空页：清提示条。
    await list.loadMore('backward'); // [0,1,2]
    await list.loadMore('backward'); // 空页
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    list.dispose();
  });

  it('F5 路径③：调用方主动 reset（切换会话等）清空提示条', async () => {
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

  it('F6 点击提示条触发 reset 追平（路径③的手动入口）', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    items.unshift({ id: -1, label: 'new' });
    list.invalidate({ count: 1 });
    expect(pillOf(host).classList.contains('hidden')).toBe(false);

    pillOf(host).dispatch('click');
    await flushAsync();
    expect(list.getState().stale).toBe(false);
    expect(rendered(host)[0]).toBe('row--1');
    expect(host.scroller.scrollTop).toBe(0); // pinEdge:true
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    list.dispose();
  });

  it('F6b tail 提示条追平后回到尾部新鲜端', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      freshEdge: 'tail',
    }));
    await list.reset();
    host.scroller.scrollTop = 100;
    items.push({ id: 10, label: 'new-tail' });
    list.invalidate({ count: 1 });

    pillOf(host).dispatch('click');
    await flushAsync();
    expect(list.getState().stale).toBe(false);
    expect(list.getState().atFreshEdge).toBe(true);
    expect(host.scroller.scrollTop).toBe(host.scroller.scrollHeight);
    list.dispose();
  });

  it('F7 提示条文案随 pendingCount 变化', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 1 });
    expect(pillOf(host).textContent).toBe('有更新(1)');
    list.invalidate({ count: 9 });
    expect(pillOf(host).textContent).toBe('有更新(10)');
    list.dispose();
  });

  it('F9 未提供 text.updatePill 时不显示提示条（不再出现空白色块）', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      text: { loading: () => '加载中', empty: () => '暂无数据' },
    }));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 3 });
    expect(list.getState().stale).toBe(true); // 状态照常记账
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    list.dispose();
  });

  it('F10 非空的最后一页把 hasMore 收敛为 false 时提示条一并消失', async () => {
    const items = makeTestItems(4); // pageSize=3 → 第二页只有 1 条（非空）
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 500;
    list.invalidate({ count: 4 });
    expect(list.getState().stale).toBe(true);

    await list.loadMore('forward');
    expect(list.getState().hasMoreForward).toBe(false);
    expect(list.getState().stale).toBe(false);
    expect(list.getState().pendingCount).toBe(0);
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    list.dispose();
  });

  it('F11 非新鲜端方向翻到尽头不清提示条', async () => {
    const items = makeTestItems(4);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'head' }));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 500;
    list.invalidate({ count: 4 });
    await list.loadMore('forward'); // forward 不是 head 的新鲜方向
    expect(list.getState().hasMoreForward).toBe(false);
    expect(list.getState().stale).toBe(true);
    expect(list.getState().pendingCount).toBe(4);
    list.dispose();
  });

  it('F8 没有待追平更新时滚回新鲜端不会触发任何请求', async () => {
    const host = createHost();
    const fetchSpy = vi.fn(createInstantSource(() => makeTestItems(10)).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
    await list.reset();
    fetchSpy.mockClear();
    host.scroller.scrollTop = 0;
    host.scroller.dispatch('scroll');
    await flushAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
    list.dispose();
  });
});

// ───────────────────────── G 本端增删改 ─────────────────────────

describe('BoundedList / G 本端产生的条目（upsertLocal / patch / removeLocal）', () => {
  it('G1 freshEdge=tail 时并入尾页；新鲜端方向的 hasMoreForward 置 false', async () => {
    // pageSize 覆盖全部条目，reset 后 hasMoreForward 天然为 false（真正追平新鲜端），
    // upsertLocal 才会走立即并入分支。
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', maxPages: 1, pageSize: 3 }));
    await list.reset();
    list.upsertLocal({ id: 100, label: 'local' });
    expect(rendered(host)[rendered(host).length - 1]).toBe('row-100');
    expect(list.getState().hasMoreForward).toBe(false);
    list.dispose();
  });

  it('G2 freshEdge=head 时并入首页；hasMoreBackward 置 false', async () => {
    const items = makeTestItems(4);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'head' }));
    await list.reset();
    list.upsertLocal({ id: -1, label: 'local' });
    expect(rendered(host)[0]).toBe('row--1');
    expect(list.getState().hasMoreBackward).toBe(false);
    list.dispose();
  });

  it('G3 mergeLive 到达硬预算后从非新鲜端裁剪，并保留新条目', async () => {
    // 总量正好等于 hardBudget（3×2=6）：reset + 一次 forward 续翻后 hasMoreForward 归零，
    // 窗口真正追平新鲜端，upsertLocal 才会走立即并入分支（而不是记入 overlay 待重放）。
    const items = makeTestItems(6);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', maxPages: 2, pageSize: 3 }));
    await list.reset({ pinEdge: false });
    await list.loadMore('forward');
    expect(list.getState().count).toBe(6);
    list.upsertLocal({ id: 100, label: 'local' });
    expect(list.getState().count).toBe(6);
    expect(list.getState().hasMoreBackward).toBe(false); // 旧游标失效，权威追平前禁止继续分页
    expect(rendered(host)).toContain('row-100');
    list.dispose();
  });

  it('G3b 硬裁剪后旧端游标立即封锁，显式 loadMore 转为无游标权威追平', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 'old-start', 'old-end', false, false));
      await initial;

      host.scroller.scrollTop = 0;
      host.scroller.dispatch('scroll');
      frames.run();
      list.upsertLocal({ id: 2, label: 'local-2' });
      expect(list.getState().hasMoreBackward).toBe(false);
      expect(pending).toHaveLength(1); // render 不得用 old-start 自动翻页
      frames.run(); // away-edge invalidate 只置 stale
      expect(pending).toHaveLength(1);

      const reconcile = list.loadMore('backward');
      expect(pending).toHaveLength(2);
      expect(pending[1].req.cursor).toBeUndefined();
      expect(renderedRows(host)).toEqual(['row-1', 'row-2']);
      pending[1].resolve(pageOf(makeTestItems(2, 10), 'fresh-start', 'fresh-end', false, false));
      await reconcile;
      // 权威追平换上服务端新内容，本端并入的 row-2 由 overlay 重放回新鲜端。
      expect(renderedRows(host)).toEqual(['row-11', 'row-2']);
      list.dispose();
    });
  });

  it('G3c staged reconcile 请求在飞时不清空 DOM，期间 upsert 在响应后仍然保留', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' });
      const capped = renderedRows(host);
      frames.run();
      expect(pending).toHaveLength(2);
      expect(list.getState().loading).toBe(true);
      expect(renderedRows(host)).toEqual(capped);

      list.upsertLocal({ id: 3, label: 'local-3' });
      expect(renderedRows(host)).toContain('row-3'); // 请求在飞时先乐观显示

      pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
      await flushAsync();
      // 权威响应整体替换窗口，但本端条目由 overlay 重放回来：全程可见，无闪动。
      expect(renderedRows(host)).toContain('row-3');
      expect(list.getState().count).toBeLessThanOrEqual(2);
      list.dispose();
    });
  });

  it('G3d staged reconcile 失败时保留 capped rows，并暴露 failed/retry', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const onError = vi.fn();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
        onError,
        text: {
          empty: () => '暂无数据',
          updatePill: (count) => `有更新(${count})`,
          error: () => '加载失败',
          retry: () => '重新加载',
        },
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' });
      const capped = renderedRows(host);
      frames.run();
      expect(renderedRows(host)).toEqual(capped);
      pending[1].reject(new Error('reconcile failed'));
      await flushAsync();

      expect(renderedRows(host)).toEqual(capped);
      expect(list.getState()).toMatchObject({ loaded: true, loading: false, failed: true, count: 2 });
      expect(pillOf(host).textContent).toBe('重新加载');
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'reset');
      list.dispose();
    });
  });

  it('G3e 显式追平先于已排队自动帧完成时不会重复发送 reset', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' }); // 排队自动 reconcile
      const explicit = list.loadMore('backward'); // 同帧由显式入口先接管
      expect(pending).toHaveLength(2);
      pending[1].resolve(pageOf(makeTestItems(2, 10), 's1', 'e1', false, false));
      await explicit;

      frames.run(); // 原自动帧即使到达，也必须已被显式入口取消
      await flushAsync();
      expect(pending).toHaveLength(2);
      list.dispose();
    });
  });

  it('G3f overlay 按 identity 合并，重复 upsert 不会挤掉较早的 remove', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      let latest: readonly TestItem[] = [];
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
        onItemsChanged: (items) => { latest = items; },
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      // 操作顺序即重放顺序：remove('1') 发生在第一次 upsert 之后、后两次之前。
      // 重复 upsert 同一身份只能合并成一条，不能把较早的 remove 从 overlay 里挤掉，
      // 也不能把重放顺序搅乱到「先并入再删除」而白白撑破硬预算。
      list.upsertLocal({ id: 2, label: 'local-2-a' });
      expect(list.removeLocal('1')).toBe(true);
      list.upsertLocal({ id: 2, label: 'local-2-b' });
      list.upsertLocal({ id: 2, label: 'local-2-final' });
      // 同一身份重复并入只保留最后一次的值，不产生重复行。
      expect(latest.filter((item) => item.id === 2)).toHaveLength(1);
      frames.run();
      expect(pending).toHaveLength(2);
      pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
      await flushAsync();

      // remove 重放到权威窗口上，row-1 不得复活；重复 upsert 的最后一次值保留。
      expect(renderedRows(host)).toEqual(['row-0', 'row-2']);
      expect(latest.find((item) => item.id === 2)?.label).toBe('local-2-final');
      expect(renderedRows(host)).not.toContain('row-1');
      list.dispose();
    });
  });

  it('G3g pinEdge=false 后即使没有 scroll 事件也按真实几何判断为已离开尾部', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      host.scroller.clientHeight = 100;
      host.scroller.scrollHeight = 1_000;
      host.scroller.scrollTop = 0;
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset({ pinEdge: false });
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' });
      frames.run();
      expect(pending).toHaveLength(1);
      expect(list.getState()).toMatchObject({ stale: true, loading: false });
      list.dispose();
    });
  });

  it('G3h staged reconcile 在飞时把 identity 刷新延后到新窗口提交之后', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const fetcher = createControllableFetcher<TestItem>();
      const host = createHost();
      let latest: readonly TestItem[] = [];
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
        fetchByIdentity: fetcher.fetchByIdentity,
        onItemsChanged: (items) => { latest = items; },
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' });
      frames.run();
      expect(pending).toHaveLength(2);

      host.scroller.clientHeight = 100;
      host.scroller.scrollHeight = 1_000;
      host.scroller.scrollTop = 0;
      host.scroller.dispatch('scroll');
      frames.run();
      list.invalidate({ identities: ['1'], count: 3 });
      frames.run();
      expect(fetcher.calls).toHaveLength(0);
      expect(list.getState().pendingCount).toBe(3);

      pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
      await flushAsync();
      frames.run();
      expect(fetcher.calls).toEqual([['1']]);
      fetcher.settle(0, [{ id: 1, label: 'fresh-1' }]);
      await flushAsync();
      expect(latest.find((item) => item.id === 1)?.label).toBe('fresh-1');
      expect(list.getState().pendingCount).toBe(3);
      list.dispose();
    });
  });

  it('G3i overlay 超过硬预算时静默丢最旧一条，reconcile 仍正常落地', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' });
      frames.run();
      expect(pending).toHaveLength(2); // 裁剪触发了 staged reconcile

      // reconcile 在飞期间的三条 remove：overlay 硬预算 = pageSize×maxPages = 2，
      // 写第三条时最旧的 remove(0) 被静默丢弃。
      list.removeLocal('0');
      list.removeLocal('1');
      list.removeLocal('9');

      pending[1].resolve(pageOf(makeTestItems(2), 'fresh-s', 'fresh-e', false, false));
      await flushAsync();
      expect(pending).toHaveLength(2);
      // 仍在 overlay 里的 1/9 被挡住；被挤掉的 0 照常出现在权威页里。
      expect(renderedRows(host)).toEqual(['row-0']);
      expect(list.getState()).toMatchObject({ failed: false, loading: false });
      list.dispose();
    });
  });

  it('G3k reconcile 在飞时的 upsert 乐观可见；权威响应落地后贴边自动追平一次即收敛', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      list.upsertLocal({ id: 2, label: 'local-2' });
      frames.run();
      expect(pending).toHaveLength(2);
      host.scroller.clientHeight = 100;
      host.scroller.scrollHeight = 1_000;
      host.scroller.scrollTop = 0;
      list.upsertLocal({ id: 3, label: 'local-3' });

      pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
      await flushAsync();
      host.scroller.scrollHeight = 0; // 贴边：积压的 invalidate 会触发一次自动追平
      frames.run();
      await flushAsync();
      expect(pending).toHaveLength(3);

      // 这一次追平即收敛：服务端此时已经有本端那两条，追平后不再有积压，也不再发请求。
      pending[2].resolve(pageOf(
        [{ id: 2, label: 'local-2' }, { id: 3, label: 'local-3' }],
        's2', 'e2', false, false,
      ));
      await flushAsync();
      frames.run();
      await flushAsync();
      expect(pending).toHaveLength(3);
      expect(renderedRows(host)).toEqual(['row-2', 'row-3']);
      expect(list.getState()).toMatchObject({ stale: false });
      list.dispose();
    });
  });

  it('G3m reconcile 在飞时的 removeLocal 与 upsert 最终态在权威响应后同时成立', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;
      frames.run();

      // 撑破硬预算触发裁剪与 staged reconcile。
      list.upsertLocal({ id: 2, label: 'C-v1' });
      frames.run();
      expect(pending).toHaveLength(2);

      // reconcile 在飞期间删掉 id=1，并重复并入同一身份。
      expect(list.removeLocal('1')).toBe(true);
      list.upsertLocal({ id: 2, label: 'C-v2' });
      list.upsertLocal({ id: 2, label: 'C-v3' });

      // 权威页会重新带回 id=1；overlay 里的 remove 必须把它挡住，
      // 同时本端并入的 id=2 由 overlay 重放回新鲜端，不出现闪动。
      pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
      await flushAsync();
      expect(renderedRows(host)).toEqual(['row-0', 'row-2']);
      list.dispose();
    });
  });

  it('G3n 权威请求在飞期间并入的本端条目全程可见，不出现「消失又出现」的闪动', async () => {
    await withFramesAsync(async (frames) => {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const seen: boolean[] = [];
      const list = createBoundedList(baseOptions(host, source, {
        freshEdge: 'tail',
        pageSize: 2,
        maxPages: 1,
        settleFrames: 1,
        // 每次窗口内容变化都记一次「本端条目在不在」，用来证明它从未中断过。
        onItemsChanged: (items) => { seen.push(items.some((item) => item.id === 99)); },
      }));
      const initial = list.reset();
      pending[0].resolve(pageOf(makeTestItems(2), 's0', 'e0', false, false));
      await initial;

      // 制造一次在飞的权威 reconcile：窗口已满，这次并入撑破硬预算触发裁剪。
      list.upsertLocal({ id: 2, label: 'fill' });
      frames.run();
      expect(pending).toHaveLength(2);

      // 权威请求在飞期间本端发送。
      seen.length = 0;
      list.upsertLocal({ id: 99, label: 'local-send' });
      expect(renderedRows(host)).toContain('row-99'); // 立即可见

      pending[1].resolve(pageOf(makeTestItems(2), 's1', 'e1', false, false));
      await flushAsync();
      frames.run();
      await flushAsync();

      // 关键断言：权威响应整体替换窗口之后它仍在，且中间没有任何一帧把它丢掉。
      expect(renderedRows(host)).toContain('row-99');
      expect(seen).not.toContain(false);
      list.dispose();
    });
  });

  it('G4 upsertLocal 经 normalize 处理（可去重 + 排序）', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      freshEdge: 'tail',
      normalize: (input) => {
        const seen = new Map<number, TestItem>();
        for (const item of input) seen.set(item.id, item);
        return [...seen.values()].sort((a, b) => a.id - b.id);
      },
    }));
    await list.reset({ pinEdge: false });
    list.upsertLocal({ id: 1, label: 'updated' });
    list.upsertLocal({ id: 1, label: 'updated-again' });
    expect(rendered(host)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('G5 upsertLocal 触发 onItemsChanged 与 onLoadStateChange', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onItemsChanged = vi.fn();
    const onLoadStateChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onItemsChanged, onLoadStateChange }));
    await list.reset();
    onItemsChanged.mockClear();
    onLoadStateChange.mockClear();
    list.upsertLocal({ id: 99, label: 'x' });
    expect(onItemsChanged).toHaveBeenCalledTimes(1);
    expect(onLoadStateChange).toHaveBeenCalledTimes(1);
    expect(onItemsChanged.mock.calls[0][0]).toHaveLength(4);
    list.dispose();
  });

  it('G6 patch 就地更新命中条目并重渲；未命中返回 false 且不重渲', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onItemsChanged = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      onItemsChanged,
      renderItem: (item) => [asElement(row(host.doc, `row-${item.id}-${item.label}`))],
    }));
    await list.reset();
    onItemsChanged.mockClear();
    expect(list.patch('1', (item) => ({ ...item, label: 'patched' }))).toBe(true);
    expect(onItemsChanged).toHaveBeenCalledTimes(1);
    expect(rendered(host)[1]).toBe('row-1-patched');

    onItemsChanged.mockClear();
    expect(list.patch('999', (item) => item)).toBe(false);
    expect(onItemsChanged).not.toHaveBeenCalled();
    list.dispose();
  });

  it('G7 removeLocal 就地删除命中条目，剩余条目自然补齐；重复删除返回 false', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    expect(list.removeLocal('1')).toBe(true);
    expect(rendered(host)).toEqual(['row-0', 'row-2']);
    expect(list.getState().count).toBe(2);
    expect(list.removeLocal('1')).toBe(false);
    list.dispose();
  });

  it('G8 removeLocal 会把已删除的身份从选中集里修剪掉', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const store = new SelectionStore();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { selection: { mode: 'multi', store } }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(store.snapshotIds()).toEqual(new Set(['0', '1']));
    list.removeLocal('1');
    expect(store.snapshotIds()).toEqual(new Set(['0']));
    list.dispose();
  });

  it('G8b removeLocal 只摘掉被删的那一个身份，共享 store 里其它实例的选中项不受影响', async () => {
    const store = new SelectionStore();
    const itemsA = makeTestItems(3);
    const itemsB = makeTestItems(3, 100);
    const hostA = createHost();
    const hostB = createHost();
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => itemsA), { id: 'forward.conversations', selection: { mode: 'multi', store } }));
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => itemsB), { id: 'forward.contacts', selection: { mode: 'multi', store } }));
    await listA.reset();
    await listB.reset();
    store.toggle('100'); // 通讯录 tab 选的目标
    store.toggle('0');   // 最近会话 tab 选的目标

    listA.removeLocal('1'); // 与两个已选目标都无关
    expect(store.snapshotIds()).toEqual(new Set(['100', '0']));

    listA.removeLocal('0'); // 删掉的正是已选目标 → 只摘它
    expect(store.snapshotIds()).toEqual(new Set(['100']));
    listA.dispose();
    listB.dispose();
  });

  it('G8c removeLocal 不会误删 pinnedItems 的选中项', async () => {
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
    list.removeLocal('1');
    expect(store.has('-1')).toBe(true);
    list.dispose();
  });

  it('G11 重复 upsertLocal 同一条目是幂等的，不会渲染两遍', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    await list.reset({ pinEdge: false });
    list.upsertLocal({ id: 100, label: 'local' });
    list.upsertLocal({ id: 100, label: 'local-retry' });
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2', 'row-100']);
    expect(list.getState().count).toBe(4);
    list.dispose();
  });

  it('G12 upsertLocal 一条已在窗口里的条目时先摘旧再并入新鲜端', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    await list.reset({ pinEdge: false });
    list.upsertLocal({ id: 0, label: 'moved-to-tail' });
    expect(renderedRows(host)).toEqual(['row-1', 'row-2', 'row-0']);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('G9 patch 不改变窗口条目数，因此不触发 onLoadStateChange', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onLoadStateChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onLoadStateChange }));
    await list.reset();
    onLoadStateChange.mockClear();
    list.patch('1', (item) => ({ ...item, label: 'x' }));
    expect(onLoadStateChange).not.toHaveBeenCalled();
    list.dispose();
  });

  it('G10 空窗口上 upsertLocal 自建一页（本端先发消息、服务端还没有数据）', async () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => []), { freshEdge: 'tail' }));
    await list.reset();
    expect(list.getState().count).toBe(0);
    list.upsertLocal({ id: 1, label: 'first' });
    expect(list.getState().count).toBe(1);
    expect(rendered(host)).toEqual(['row-1']);
    list.dispose();
  });
});

// ───────────────────────── H 渲染与文案 ─────────────────────────

describe('BoundedList / H 渲染与文案', () => {
  it('H1 pinnedItems 参与渲染但不进入分页窗口计数', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const pinned: TestItem = { id: -1, label: '所有人' };
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { pinnedItems: () => [pinned] }));
    await list.reset();
    expect(rendered(host)).toEqual(['row--1', 'row-0', 'row-1', 'row-2']);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('H2 只有 pinnedItems、窗口为空时不显示空态（列表并非真的空）', async () => {
    const host = createHost();
    const pinned: TestItem = { id: -1, label: '所有人' };
    const list = createBoundedList(baseOptions(host, createInstantSource(() => []), { pinnedItems: () => [pinned] }));
    await list.reset();
    expect(rendered(host)).toEqual(['row--1']);
    list.dispose();
  });

  it('H3 RenderItemContext 提供 index / identity / previous', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const contexts: RenderItemContext<TestItem>[] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      renderItem: (item, ctx) => { contexts.push(ctx); return [asElement(row(host.doc, `row-${item.id}`))]; },
    }));
    await list.reset();
    expect(contexts.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(contexts.map((c) => c.identity)).toEqual(['0', '1', '2']);
    expect(contexts[0].previous).toBeUndefined();
    expect(contexts[1].previous).toEqual(items[0]);
    list.dispose();
  });

  it('H4 未开启 selection 时 selected=false、selectable=true', async () => {
    const items = makeTestItems(1);
    const host = createHost();
    let ctx: RenderItemContext<TestItem> | null = null;
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      renderItem: (item, c) => { ctx = c; return [asElement(row(host.doc, `row-${item.id}`))]; },
    }));
    await list.reset();
    expect(ctx!.selected).toBe(false);
    expect(ctx!.selectable).toBe(true);
    list.dispose();
  });

  it('H5 pinnedItems 排在窗口条目之前，previous 链路连续', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const pinned: TestItem = { id: -1, label: '所有人' };
    const contexts: RenderItemContext<TestItem>[] = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      pinnedItems: () => [pinned],
      renderItem: (item, ctx) => { contexts.push(ctx); return [asElement(row(host.doc, `row-${item.id}`))]; },
    }));
    await list.reset();
    expect(contexts[1].previous).toEqual(pinned);
    list.dispose();
  });

  it('H6 有查询条件时空态改用 emptyFiltered 文案', async () => {
    const host = createHost();
    const list = createBoundedList<TestItem, { keyword: string }>({
      ...(baseOptions(host, { async fetch() { return pageOf([], '0', '0', false, false); } }) as unknown as BoundedListOptions<TestItem, { keyword: string }>),
      initialQuery: { keyword: '' },
    });
    await list.reset();
    expect(host.scroller.children[0].textContent).toBe('暂无数据');
    await list.reset({ query: { keyword: 'zzz' } });
    expect(host.scroller.children[0].textContent).toBe('无搜索结果');
    list.dispose();
  });

  it('H7 没有提供 emptyFiltered 时回退到 empty 文案', async () => {
    const host = createHost();
    const list = createBoundedList<TestItem, { keyword: string }>({
      ...(baseOptions(host, { async fetch() { return pageOf([], '0', '0', false, false); } }, {
        text: { loading: () => '加载中', empty: () => '暂无数据' },
      }) as unknown as BoundedListOptions<TestItem, { keyword: string }>),
      initialQuery: { keyword: '' },
    });
    await list.reset({ query: { keyword: 'zzz' } });
    expect(host.scroller.children[0].textContent).toBe('暂无数据');
    list.dispose();
  });

  it('H8 查询条件含循环引用时不抛错：同一引用视为未过滤，结构不同视为已过滤', async () => {
    const host = createHost();
    type Cyclic = { self?: unknown };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const list = createBoundedList<TestItem, Cyclic>({
      ...(baseOptions(host, { async fetch() { return pageOf([], '0', '0', false, false); } }) as unknown as BoundedListOptions<TestItem, Cyclic>),
      initialQuery: cyclic,
    });
    await expect(list.reset()).resolves.toBeUndefined();
    expect(host.scroller.children[0].textContent).toBe('暂无数据'); // 同一引用 → 未过滤
    await expect(list.reset({ query: { self: undefined } })).resolves.toBeUndefined();
    expect(host.scroller.children[0].textContent).toBe('无搜索结果'); // 结构不同 → 已过滤
    list.dispose();
  });

  it('H8b 查询条件按结构比较，键的书写顺序不影响「是否已过滤」的判定', async () => {
    const host = createHost();
    const list = createBoundedList<TestItem, { a: number; b: number[] }>({
      ...(baseOptions(host, { async fetch() { return pageOf([], '0', '0', false, false); } }) as unknown as BoundedListOptions<TestItem, { a: number; b: number[] }>),
      initialQuery: { a: 1, b: [1, 2] },
    });
    await list.reset({ query: { b: [1, 2], a: 1 } as { a: number; b: number[] } });
    expect(host.scroller.children[0].textContent).toBe('暂无数据');
    await list.reset({ query: { a: 1, b: [1, 3] } });
    expect(host.scroller.children[0].textContent).toBe('无搜索结果');
    list.dispose();
  });

  it('H8c 查询条件的结构比较覆盖各类不相等形态（数组 vs 对象、键数不同、键名不同、超深嵌套）', async () => {
    const host = createHost();
    const nest = (depth: number, leaf: unknown): unknown =>
      (depth === 0 ? leaf : { next: nest(depth - 1, leaf) });

    async function emptyTextFor(initial: unknown, next: unknown): Promise<string> {
      const list = createBoundedList<TestItem, unknown>({
        ...(baseOptions(host, { async fetch() { return pageOf([], '0', '0', false, false); } }) as unknown as BoundedListOptions<TestItem, unknown>),
        initialQuery: initial,
      });
      await list.reset({ query: next });
      const text = host.scroller.children[0].textContent;
      list.dispose();
      return text;
    }

    // 数组与普通对象：键集合可能相同，但形态不同 → 已过滤
    expect(await emptyTextFor({ 0: 'a' }, ['a'])).toBe('无搜索结果');
    // 键数量不同 → 已过滤
    expect(await emptyTextFor({ a: 1 }, { a: 1, b: 2 })).toBe('无搜索结果');
    // 键数量相同但键名不同 → 已过滤
    expect(await emptyTextFor({ a: 1 }, { b: 1 })).toBe('无搜索结果');
    // 嵌套超过深度上限：不再展开，一律视为已过滤
    expect(await emptyTextFor(nest(12, 1), nest(12, 1))).toBe('无搜索结果');
    // 深度上限之内的等价结构仍然判为未过滤
    expect(await emptyTextFor(nest(3, 1), nest(3, 1))).toBe('暂无数据');
  });

  it('H13 首屏失败时显示错误态文案而不是空态，成功一次后恢复', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, {
      onError: () => {},
      text: {
        loading: () => '加载中',
        empty: () => '暂无数据',
        error: (err) => `加载失败：${(err as Error).message}`,
        retry: () => '点击重试',
      },
    }));
    const p = list.reset();
    pending[0].reject(new Error('network down'));
    await p;
    expect(host.scroller.children[0].className).toBe('list-error-state');
    expect(host.scroller.children[0].textContent).toBe('加载失败：network down');
    expect(list.getState().failed).toBe(true);
    // 提示条位置变成重试入口。
    expect(pillOf(host).classList.contains('hidden')).toBe(false);
    expect(pillOf(host).textContent).toBe('点击重试');

    pillOf(host).dispatch('click');
    pending[1].resolve(pageOf(makeTestItems(2), '0', '2', false, false));
    await flushAsync();
    expect(renderedRows(host)).toEqual(['row-0', 'row-1']);
    expect(list.getState().failed).toBe(false);
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    list.dispose();
  });

  it('H14 没有提供 error 文案时保持原来的空态渲染（向后兼容）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { onError: () => {} }));
    const p = list.reset();
    pending[0].reject(new Error('network down'));
    await p;
    expect(host.scroller.children[0].className).toBe('empty-state');
    expect(list.getState().failed).toBe(true); // 状态照样如实上报
    expect(pillOf(host).classList.contains('hidden')).toBe(true);
    list.dispose();
  });

  it('H15 首屏失败但窗口里仍有条目（后续 upsertLocal）时不显示错误态', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, {
      onError: () => {},
      freshEdge: 'tail',
      text: { loading: () => '加载中', empty: () => '暂无数据', error: () => '加载失败' },
    }));
    const p = list.reset({ pinEdge: false });
    pending[0].reject(new Error('boom'));
    await p;
    list.upsertLocal({ id: 1, label: 'local' });
    expect(renderedRows(host)).toEqual(['row-1']);
    list.dispose();
  });

  it('H9 边界文案：没有更多时头尾各渲染一条提示', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      text: {
        loading: () => '加载中',
        empty: () => '暂无数据',
        backwardBoundary: () => '已到最早',
        forwardBoundary: () => '已到最新',
      },
    }));
    await list.reset();
    expect(host.scroller.children[0].textContent).toBe('已到最早');
    expect(host.scroller.children[host.scroller.children.length - 1].textContent).toBe('已到最新');
    list.dispose();
  });

  it('H10 text 全部缺省时渲染成纯条目列表，不抛错', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { text: {} }));
    await list.reset();
    expect(rendered(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });

  it('H11 render() 可被宿主主动调用以反映外部状态（display:updated 场景）', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    let suffix = 'v1';
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      renderItem: (item) => [asElement(row(host.doc, `row-${item.id}-${suffix}`))],
    }));
    await list.reset();
    expect(rendered(host)).toEqual(['row-0-v1', 'row-1-v1']);
    suffix = 'v2';
    list.render();
    expect(rendered(host)).toEqual(['row-0-v2', 'row-1-v2']);
    list.dispose();
  });

  it('H12 render() 不发任何请求、不改变滚动位置', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const fetchSpy = vi.fn(createInstantSource(() => items).fetch);
    const list = createBoundedList(baseOptions(host, { fetch: fetchSpy }));
    await list.reset({ pinEdge: false });
    fetchSpy.mockClear();
    host.scroller.scrollTop = 456;
    list.render();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(host.scroller.scrollTop).toBe(456);
    list.dispose();
  });
});

// ───────────────────────── I 交互与选中态 ─────────────────────────

describe('BoundedList / I 交互与选中态', () => {
  it('I1 无 selection 时点击整行触发 onActivate', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onActivate }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toEqual(items[1]);
    list.dispose();
  });

  it('I2 键盘 Enter 同样触发 onActivate', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onActivate }));
    await list.reset();
    host.scroller.dispatch('keydown', { key: 'ArrowDown' });
    host.scroller.dispatch('keydown', { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toEqual(items[0]);
    list.dispose();
  });

  it('I3 点击 pinnedItems 也能命中（findItem 先查 pinned，且会遍历过不匹配的 pinned）', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const pinnedA: TestItem = { id: -1, label: '所有人' };
    const pinnedB: TestItem = { id: -2, label: '在线成员' };
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      pinnedItems: () => [pinnedA, pinnedB],
      onActivate,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    expect(onActivate.mock.calls[0][0]).toEqual(pinnedA);
    // 点第二个钉住项：findItem 会先跳过第一个不匹配的 pinned 再命中。
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(onActivate.mock.calls[1][0]).toEqual(pinnedB);
    // 点窗口条目：两个 pinned 都不匹配，落到窗口查找。
    host.scroller.dispatch('click', { target: host.scroller.children[2] });
    expect(onActivate.mock.calls[2][0]).toEqual(items[0]);
    list.dispose();
  });

  it('I4 点击到已不存在的身份（陈旧 DOM）时静默忽略', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { onActivate }));
    await list.reset();
    const staleRow = host.scroller.children[1];
    list.removeLocal('1'); // 该行已从窗口移除，但测试仍持有旧节点
    host.scroller.dispatch('click', { target: staleRow });
    expect(onActivate).not.toHaveBeenCalled();
    list.dispose();
  });

  it('I5 single 模式点击整行既 replaceSingle 又触发 onActivate', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onActivate = vi.fn();
    const store = new SelectionStore();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'single', store },
      onActivate,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[1] });
    expect(store.snapshotIds()).toEqual(new Set(['1']));
    expect(onActivate).toHaveBeenCalledTimes(1);
    host.scroller.dispatch('click', { target: host.scroller.children[2] });
    expect(store.snapshotIds()).toEqual(new Set(['2'])); // 单选替换
    list.dispose();
  });

  it('I6 multi 模式点击翻转选中；再次点击取消', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const store = new SelectionStore();
    const onActivate = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', store },
      onActivate,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    expect(store.has('0')).toBe(true);
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    expect(store.has('0')).toBe(false);
    expect(onActivate).not.toHaveBeenCalled(); // multi 模式不触发 onActivate
    list.dispose();
  });

  it('I7 multi 模式无论点在行的哪个区域都检查上限（不存在绕过路径）', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onExceed = vi.fn();
    const store = new SelectionStore(1);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', store, onExceed },
      renderItem: (item) => {
        const el = row(host.doc, `row-${item.id}`);
        el.appendChild(host.doc.createElement()); // 行内空白区域
        return [asElement(el)];
      },
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    for (let i = 0; i < 5; i++) {
      host.scroller.dispatch('click', { target: host.scroller.children[1].children[0] });
    }
    expect(store.size).toBe(1);
    expect(onExceed).toHaveBeenCalledTimes(5);
    list.dispose();
  });

  it('I8 共享 SelectionStore：实例 A 勾选后实例 B 重渲且勾选框同步，超 max 时拒绝并回调 onExceed', async () => {
    const itemsA = makeTestItems(3);
    const itemsB = makeTestItems(3, 100);
    const store = new SelectionStore(1);
    const onExceedB = vi.fn();
    let lastCtxB: RenderItemContext<TestItem> | null = null;

    const hostA = createHost();
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => itemsA), {
      id: 'forward.conversations',
      selection: { mode: 'multi', store },
    }));
    const hostB = createHost();
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => itemsB), {
      id: 'forward.contacts',
      selection: { mode: 'multi', store, onExceed: onExceedB },
      renderItem: (item, ctx) => { lastCtxB = ctx; return [asElement(row(hostB.doc, `row-${item.id}`))]; },
    }));
    await listA.reset();
    await listB.reset();

    hostA.scroller.dispatch('click', { target: hostA.scroller.children[0] });
    expect(store.has('0')).toBe(true);
    expect(lastCtxB?.selectable).toBe(false); // B 侧因为已达 max=1 且未选中，禁用

    hostB.scroller.dispatch('click', { target: hostB.scroller.children[0] });
    expect(store.has('100')).toBe(false);
    expect(onExceedB).toHaveBeenCalledTimes(1);

    listA.dispose();
    listB.dispose();
  });

  it('I9 onSelectionChange 携带命中的完整条目与计数', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const onSelectionChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', max: 10 },
      onSelectionChange,
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    expect(onSelectionChange).toHaveBeenCalledWith({ ids: new Set(['0']), count: 1, items: [items[0]] });
    host.scroller.dispatch('click', { target: host.scroller.children[2] });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ ids: new Set(['0', '2']), count: 2, items: [items[0], items[2]] });
    list.dispose();
  });

  it('I9b onSelectionChange 的 items 顺序与渲染顺序一致（pinnedItems 在前）', async () => {
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
    host.scroller.dispatch('click', { target: host.scroller.children[1] }); // id=0
    host.scroller.dispatch('click', { target: host.scroller.children[0] }); // pinned
    const last = onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1][0];
    expect(renderedRows(host)).toEqual(['row--1', 'row-0', 'row-1', 'row-2']);
    expect(last.items.map((i: TestItem) => i.id)).toEqual([-1, 0]);
    list.dispose();
  });

  it('I10 开启 selection 但未提供 onSelectionChange 时不抛错', async () => {
    const items = makeTestItems(2);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { selection: { mode: 'multi' } }));
    await list.reset();
    expect(() => host.scroller.dispatch('click', { target: host.scroller.children[0] })).not.toThrow();
    list.dispose();
  });

  it('I11 selectable 反映上限状态：已选中的条目永远可选', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const contexts = new Map<string, RenderItemContext<TestItem>>();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', max: 1 },
      renderItem: (item, ctx) => { contexts.set(ctx.identity, ctx); return [asElement(row(host.doc, `row-${item.id}`))]; },
    }));
    await list.reset();
    host.scroller.dispatch('click', { target: host.scroller.children[0] });
    expect(contexts.get('0')!.selected).toBe(true);
    expect(contexts.get('0')!.selectable).toBe(true);
    expect(contexts.get('1')!.selectable).toBe(false);
    list.dispose();
  });

  it('I12 外部直接改动共享 store 时组件自动重渲', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const store = new SelectionStore();
    const contexts: Array<{ id: string; selected: boolean }> = [];
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', store },
      renderItem: (item, ctx) => { contexts.push({ id: ctx.identity, selected: ctx.selected }); return [asElement(row(host.doc, `row-${item.id}`))]; },
    }));
    await list.reset();
    contexts.length = 0;
    store.toggle('2'); // 组件外部改动
    expect(contexts.find((c) => c.id === '2')?.selected).toBe(true);
    list.dispose();
  });
});

// ───────────────────────── K 错误处理 ─────────────────────────

describe('BoundedList / K 错误处理', () => {
  it('K1 reset 失败：onError 被调用一次，loaded 置 true 以解除卡在加载态', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const p = list.reset();
    pending[0].reject(new Error('boom'));
    await expect(p).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'reset');
    expect(list.getState().loaded).toBe(true);
    expect(list.getState().loading).toBe(false);
    list.dispose();
  });

  it('K2 过期的 reset 失败被整体丢弃，不上报错误', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const first = list.reset();
    const second = list.reset();
    pending[0].reject(new Error('过期请求失败'));
    await first;
    pending[1].resolve(pageOf(makeTestItems(2), '0', '2', false, false));
    await second;
    expect(onError).not.toHaveBeenCalled();
    expect(rendered(host)).toEqual(['row-0', 'row-1']);
    list.dispose();
  });

  it('K3 loadMore(forward) 失败：onError 带 forward 阶段，loading 标志恢复', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const resetP = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, true));
    await resetP;
    host.scroller.scrollTop = 500;

    const loadP = list.loadMore('forward');
    expect(list.getState().loadingForward).toBe(true);
    pending[1].reject(new Error('network'));
    await loadP;
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'forward');
    expect(list.getState().loadingForward).toBe(false);
    expect(list.getState().hasMoreForward).toBe(true); // 失败不改变边界状态
    list.dispose();
  });

  it('K4 loadMore(backward) 失败：onError 带 backward 阶段，loadingBackward 恢复', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const resetP = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3, 10), '10', '13', true, false));
    await resetP;
    host.scroller.scrollTop = 500;

    const loadP = list.loadMore('backward');
    expect(list.getState().loadingBackward).toBe(true);
    pending[1].reject(new Error('network'));
    await loadP;
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'backward');
    expect(list.getState().loadingBackward).toBe(false);
    list.dispose();
  });

  it('K5 过期的 loadMore 失败被丢弃（reset 已经接管）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const resetP = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, true));
    await resetP;
    host.scroller.scrollTop = 500;

    const loadP = list.loadMore('forward');
    const secondReset = list.reset({ pinEdge: false });
    pending[1].reject(new Error('过期的翻页失败'));
    await loadP;
    pending[2].resolve(pageOf(makeTestItems(1, 77), '0', '1', false, false));
    await secondReset;
    expect(onError).not.toHaveBeenCalled();
    expect(rendered(host)).toEqual(['row-77']);
    list.dispose();
  });

  it('K6 未提供 onError 时退化为 console.warn，不产生未处理的 Promise 拒绝', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { source, pending } = createControllableSource<TestItem, void>();
      const host = createHost();
      const list = createBoundedList(baseOptions(host, source, { id: 'warn-list' }));
      const p = list.reset();
      pending[0].reject(new Error('boom'));
      await expect(p).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[BoundedList:warn-list]');
      list.dispose();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('K7 reset 失败后仍可重新 reset 成功（错误不是终态）', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const p1 = list.reset();
    pending[0].reject(new Error('第一次失败'));
    await p1;
    const p2 = list.reset();
    pending[1].resolve(pageOf(makeTestItems(2), '0', '2', false, false));
    await p2;
    expect(rendered(host)).toEqual(['row-0', 'row-1']);
    expect(onError).toHaveBeenCalledTimes(1);
    list.dispose();
  });

  it('K8 非 Error 类型的拒绝值原样上报', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const p = list.reset();
    pending[0].reject('字符串错误');
    await p;
    expect(onError).toHaveBeenCalledWith('字符串错误', 'reset');
    list.dispose();
  });
});

// ───────────────────────── L 释放 ─────────────────────────

describe('BoundedList / L dispose：全部监听注销、注册表注销、幂等空操作', () => {
  it('L1 dispose 后 scrollElement / window / content 上的监听全部为 0；registry 不再含该 id', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { id: 'dispose-leak-check' }));
    await list.reset();
    expect(registeredIds()).toContain('dispose-leak-check');
    expect(host.scroller.listenerCount('scroll')).toBeGreaterThan(0);

    list.dispose();
    expect(registeredIds()).not.toContain('dispose-leak-check');
    for (const type of ['scroll', 'pointerdown', 'pointerup', 'pointercancel', 'keydown', 'click', 'load']) {
      expect(host.scroller.listenerCount(type)).toBe(0);
    }
    expect(viewOf(host.doc).listenerCount('pointerup')).toBe(0);
    expect(viewOf(host.doc).listenerCount('pointercancel')).toBe(0);
    // parent 下原本是 [scroller, pill] 两个子节点；dispose 后提示条应被移除。
    expect(host.parent.children).toHaveLength(1);
    expect(host.parent.children[0]).toBe(host.scroller);
    // 组件自己补的 a11y 属性也要还回去。
    expect(host.scroller.getAttribute('tabindex')).toBeNull();
    expect(host.scroller.getAttribute('role')).toBeNull();
  });

  it('L11 dispose 后 pinToFreshEdge 已排队的帧不再触碰宿主的滚动位置', async () => {
    await withFramesAsync(async (frames) => {
      const items = makeTestItems(3);
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail', settleFrames: 4 }));
      await list.reset({ pinEdge: true });
      list.dispose();
      host.scroller.scrollTop = 12345; // 宿主在 dispose 之后自己设置的滚动位置
      frames.run();
      expect(host.scroller.scrollTop).toBe(12345);
    });
  });

  it('L2 dispose 之后调用其它命令均为空操作，不抛错', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    list.dispose();
    await expect(list.reset()).resolves.toBeUndefined();
    await expect(list.loadMore('forward')).resolves.toBeUndefined();
    await expect(list.loadMore('backward')).resolves.toBeUndefined();
    expect(() => list.setQuery(undefined)).not.toThrow();
    expect(() => list.invalidate({ count: 1 })).not.toThrow();
    expect(() => list.upsertLocal(items[0])).not.toThrow();
    expect(list.patch('0', (i) => i)).toBe(false);
    expect(list.removeLocal('0')).toBe(false);
    expect(() => list.render()).not.toThrow();
    expect(() => list.dispose()).not.toThrow(); // 幂等
  });

  it('L3 dispose 后 getState 仍可读（宿主收尾逻辑可能还要看一眼）', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    list.dispose();
    expect(list.getState().count).toBe(3);
    expect(list.getState().loaded).toBe(true);
  });

  it('L4 dispose 后进行中的 reset 结果被丢弃，不触碰 DOM', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset();
    list.dispose();
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, false));
    await p;
    expect(host.scroller.children.filter((c) => c.className.startsWith('row-'))).toHaveLength(0);
  });

  it('L5 dispose 后进行中的 reset 失败同样被丢弃，不上报错误', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const p = list.reset();
    list.dispose();
    pending[0].reject(new Error('已经不关心了'));
    await p;
    expect(onError).not.toHaveBeenCalled();
  });

  it('L6 dispose 后进行中的 loadMore 结果被丢弃', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset({ pinEdge: false });
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, true));
    await p;
    host.scroller.scrollTop = 500;
    const loadP = list.loadMore('forward');
    list.dispose();
    pending[1].resolve(pageOf(makeTestItems(3, 3), '3', '6', true, false));
    await loadP;
    expect(renderedRows(host)).toEqual(['row-0', 'row-1', 'row-2']);
  });

  it('L7 dispose 后 loadMore 失败也被丢弃，不上报错误', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const onError = vi.fn();
    const list = createBoundedList(baseOptions(host, source, { onError }));
    const p = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3), '0', '3', false, true));
    await p;
    host.scroller.scrollTop = 500;
    const loadP = list.loadMore('forward');
    list.dispose();
    pending[1].reject(new Error('已经不关心了'));
    await loadP;
    expect(onError).not.toHaveBeenCalled();
  });

  it('L8 批量创建并 dispose 大量实例后不残留任何监听或注册项（内存泄漏压力测试）', async () => {
    const before = registeredIds().length;
    for (let i = 0; i < 50; i++) {
      const items = makeTestItems(5);
      const host = createHost();
      const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { id: `leak-check-${i}` }));
      await list.reset();
      list.dispose();
      expect(host.scroller.listenerCount('scroll')).toBe(0);
      expect(viewOf(host.doc).listenerCount('pointerup')).toBe(0);
      expect(host.parent.children).toHaveLength(1);
    }
    expect(registeredIds().length).toBe(before);
  });

  it('L9 共享 SelectionStore 时 dispose 会取消订阅，之后另一实例的选中变化不再触发已 dispose 实例的重渲', async () => {
    const store = new SelectionStore();
    const itemsA = makeTestItems(3);
    const itemsB = makeTestItems(3, 50);
    const hostA = createHost();
    const hostB = createHost();
    const renderA = vi.fn((item: TestItem) => [asElement(row(hostA.doc, `row-${item.id}`))]);
    const listA = createBoundedList(baseOptions(hostA, createInstantSource(() => itemsA), { id: 'share-a', selection: { mode: 'multi', store }, renderItem: renderA }));
    const listB = createBoundedList(baseOptions(hostB, createInstantSource(() => itemsB), { id: 'share-b', selection: { mode: 'multi', store } }));
    await listA.reset();
    await listB.reset();
    listA.dispose();
    renderA.mockClear();
    expect(() => store.toggle('50')).not.toThrow();
    expect(renderA).not.toHaveBeenCalled();
    listB.dispose();
  });

  it('L10 同 id 重建实例：先 dispose 旧实例，注册表指向新实例', async () => {
    const items = makeTestItems(2);
    const hostOld = createHost();
    const hostNew = createHost();
    const oldList = createBoundedList(baseOptions(hostOld, createInstantSource(() => items), { id: 'group-detail' }));
    await oldList.reset();
    oldList.dispose();
    const newList = createBoundedList(baseOptions(hostNew, createInstantSource(() => items), { id: 'group-detail' }));
    await newList.reset();
    expect(registeredIds().filter((id) => id === 'group-detail')).toHaveLength(1);
    newList.dispose();
  });
});

// ───────────────────────── M 只读状态 ─────────────────────────

describe('BoundedList / M 只读状态 getState', () => {
  it('M1 初始状态：未加载、无条目、total 未知（-1）', () => {
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => [])));
    expect(list.getState()).toEqual({
      loaded: false, loading: false, loadingBackward: false, loadingForward: false,
      hasMoreBackward: false, hasMoreForward: false, count: 0, total: -1,
      stale: false, pendingCount: 0, atFreshEdge: false, failed: false,
    });
    list.dispose();
  });

  it('M2 total 透传服务端 PageInfo.total（群成员总数场景）', async () => {
    const items = makeTestItems(238);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items, { withTotal: true })));
    await list.reset({ pinEdge: false });
    expect(list.getState().total).toBe(238);
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('M3 服务端不返回 total 时保持 -1（未知）', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset({ pinEdge: false });
    expect(list.getState().total).toBe(-1);
    list.dispose();
  });

  it('M4 loading 是两端 loading 的并集', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source));
    const p = list.reset();
    pending[0].resolve(pageOf(makeTestItems(3, 10), '10', '13', true, true));
    await p;
    host.scroller.scrollTop = 500;

    void list.loadMore('backward');
    expect(list.getState()).toMatchObject({ loading: true, loadingBackward: true, loadingForward: false });
    void list.loadMore('forward');
    expect(list.getState()).toMatchObject({ loading: true, loadingBackward: true, loadingForward: true });
    pending[1].resolve(pageOf(makeTestItems(3, 7), '7', '10', true, true));
    pending[2].resolve(pageOf(makeTestItems(3, 13), '13', '16', true, true));
    await flushAsync();
    expect(list.getState()).toMatchObject({ loading: false, loadingBackward: false, loadingForward: false });
    list.dispose();
  });

  it('M5 onLoadStateChange 在 reset 前后被调用，反映 loading 与 count 变化', async () => {
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

  it('M6 getState 每次返回新快照，改它不影响组件', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    const snapshot = list.getState() as { count: number };
    snapshot.count = 999;
    expect(list.getState().count).toBe(3);
    list.dispose();
  });

  it('M8 freshEdge=tail 时图片等异步增高内容加载完会重新贴底；此前不贴底则不动', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { freshEdge: 'tail' }));
    host.scroller.scrollHeight = 1000;
    host.scroller.clientHeight = 100;
    await list.reset(); // pinEdge → 贴底，缓存的贴边状态为真
    host.scroller.scrollHeight = 5000; // 图片加载完把内容撑高
    host.scroller.dispatch('load');
    expect(host.scroller.scrollTop).toBe(5000);

    // 用户主动滚离底部之后，异步增高不再把他拽回去。
    host.scroller.scrollTop = 100;
    host.scroller.dispatch('scroll');
    host.scroller.scrollHeight = 9000;
    host.scroller.dispatch('load');
    expect(host.scroller.scrollTop).toBe(100);
    list.dispose();
  });

  it('M9 freshEdge=head 的列表不因内容异步增高改动滚动位置', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset({ pinEdge: false });
    host.scroller.scrollTop = 321;
    host.scroller.scrollHeight = 9000;
    host.scroller.dispatch('load');
    expect(host.scroller.scrollTop).toBe(321);
    list.dispose();
  });

  it('M10 failed 字段：失败置真、重新 reset 立即回到假', async () => {
    const { source, pending } = createControllableSource<TestItem, void>();
    const host = createHost();
    const list = createBoundedList(baseOptions(host, source, { onError: () => {} }));
    const p1 = list.reset();
    pending[0].reject(new Error('boom'));
    await p1;
    expect(list.getState().failed).toBe(true);

    const p2 = list.reset();
    expect(list.getState().failed).toBe(false); // 重新开始加载就不再是失败态
    pending[1].resolve(pageOf(makeTestItems(1), '0', '1', false, false));
    await p2;
    expect(list.getState().failed).toBe(false);
    list.dispose();
  });

  it('M7 atFreshEdge 实时反映当前滚动位置', async () => {
    const items = makeTestItems(10);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    expect(list.getState().atFreshEdge).toBe(true); // pinEdge 摁到了顶
    host.scroller.scrollTop = 500;
    expect(list.getState().atFreshEdge).toBe(false);
    list.dispose();
  });
});

// ───────────────────────── N 防御性守卫（白盒） ─────────────────────────

describe('BoundedList / N 防御性守卫（白盒，公开 API 走不到的分支）', () => {
  it('N1 dispose 后残留的选中态订阅回调被触发时不重渲（disposed 守卫）', async () => {
    class SpyStore extends SelectionStore {
      readonly captured: Array<() => void> = [];
      subscribe(listener: () => void): () => void {
        this.captured.push(listener);
        return super.subscribe(listener);
      }
    }
    const items = makeTestItems(3);
    const host = createHost();
    const store = new SpyStore();
    const renderItem = vi.fn((item: TestItem) => [asElement(row(host.doc, `row-${item.id}`))]);
    const onSelectionChange = vi.fn();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), {
      selection: { mode: 'multi', store },
      onSelectionChange,
      renderItem,
    }));
    await list.reset();
    list.dispose();
    renderItem.mockClear();
    onSelectionChange.mockClear();
    // 模拟「订阅回调因故仍被调用」：dispose 已注销订阅，这里直接调用捕获到的回调。
    expect(() => store.captured[0]()).not.toThrow();
    expect(renderItem).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('N2 invalidate 决策的帧回调在 dispose 后被触发时直接返回', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const fetchByIdentity = vi.fn(async () => []);
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items), { fetchByIdentity }));
    await list.reset();
    host.scroller.scrollTop = 100;
    list.invalidate({ count: 1 });
    list.dispose();
    // flushInvalidate 是私有方法，正常路径下 dispose 已取消它的调度；
    // 这里直接调用以验证守卫本身（防止将来调度实现变化后漏保护）。
    expect(() => (list as unknown as { flushInvalidate(): void }).flushInvalidate()).not.toThrow();
    expect(fetchByIdentity).not.toHaveBeenCalled();
  });

  it('N3 没有待处理的 invalidate 时帧回调是空操作', async () => {
    const items = makeTestItems(3);
    const host = createHost();
    const list = createBoundedList(baseOptions(host, createInstantSource(() => items)));
    await list.reset();
    host.scroller.scrollTop = 100;
    const before = list.getState();
    (list as unknown as { flushInvalidate(): void }).flushInvalidate();
    expect(list.getState()).toEqual(before);
    list.dispose();
  });
});
