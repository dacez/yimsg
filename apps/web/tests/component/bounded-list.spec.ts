// BoundedList 真实 Chromium 组件契约测试。
// 分类与执行入口见 packages/uikit/docs/boundedlist/测试方案.md §5。
//
// 只放「必须在真实浏览器里才有意义」的断言：真实布局几何、真实事件派发、真实 DOM 节点
// 身份、真实 rAF 时序。纯逻辑（窗口记账、本地层叠加、决策分支）由 Vitest 单测覆盖。

import type { Page } from '@playwright/test';
import { expect, test } from '../support/test-fixtures';
import {
  callBoundedListHarness as call,
  openBoundedListHarness,
  type BoundedListTestItem as TestItem,
} from '../support/bounded-list/fixture';

interface HarnessEvent {
  readonly type: string;
  readonly payload: unknown;
}

interface ListState {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingBackward: boolean;
  readonly loadingForward: boolean;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly count: number;
  readonly total: number;
  readonly stale: boolean;
  readonly atFreshEdge: boolean;
  readonly failed: boolean;
}

async function mount(page: Page, config: Record<string, unknown> = {}): Promise<string> {
  return call<string>(page, 'mount', config);
}

function root(page: Page, key: string) {
  return page.locator(`[data-case="${key}"]`);
}

function rows(page: Page, key: string) {
  return root(page, key).locator('[data-bsw-key]');
}

async function dispatchScroll(page: Page, key: string): Promise<void> {
  await root(page, key).locator('.bl-scroller').evaluate((element) => {
    element.dispatchEvent(new Event('scroll'));
  });
  await call(page, 'frames', 2);
}

async function events(page: Page, key: string): Promise<HarnessEvent[]> {
  return call<HarnessEvent[]>(page, 'events', key);
}

test.describe('BoundedList 真实 Chromium 组件契约', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(async ({ page }) => {
    await openBoundedListHarness(page);
  });

  // ───────────── 构造与宿主 ─────────────

  test('构造默认值、id、完整初始状态、默认提示条与注册表', async ({ page }) => {
    const key = await mount(page, { id: 'bounded.defaults', itemCount: 0, autoReset: false });

    expect(await call(page, 'id', key)).toBe('bounded.defaults');
    expect(await call<ListState>(page, 'state', key)).toEqual({
      loaded: false,
      loading: false,
      loadingBackward: false,
      loadingForward: false,
      hasMoreBackward: false,
      hasMoreForward: false,
      count: 0,
      total: -1,
      stale: false,
      atFreshEdge: true,
      failed: false,
    });
    expect(await call<string[]>(page, 'registryIds')).toContain('bounded.defaults');
    expect(await call(page, 'pillInfo', key)).toEqual({
      exists: true,
      visible: false,
      text: '',
      parentClass: 'bl-case',
    });
  });

  test('不改写宿主容器上的任何属性，宿主自设的属性原样保留', async ({ page }) => {
    const preconfigured = await mount(page, {
      itemCount: 1,
      selection: { mode: 'multi', max: 1 },
      initialA11y: { tabindex: '7', role: 'feed', ariaMultiselectable: 'false' },
      reachPx: -1,
    });
    const scroller = root(page, preconfigured).locator('.bl-scroller');
    // 组件不接管容器语义：没有键盘导航，写 role/tabindex 只会给出无法操作的假承诺。
    await expect(scroller).toHaveAttribute('tabindex', '7');
    await expect(scroller).toHaveAttribute('role', 'feed');
    await expect(scroller).toHaveAttribute('aria-multiselectable', 'false');

    await call(page, 'disposeNow', preconfigured);
    await expect(scroller).toHaveAttribute('tabindex', '7');
    await expect(scroller).toHaveAttribute('role', 'feed');
  });

  test('register 隔离到宿主注册表，只有对应宿主的广播命中它', async ({ page }) => {
    const key = await mount(page, {
      id: 'bounded.custom-registry',
      itemCount: 3,
      register: 'custom',
      reachPx: -1,
    });
    expect(await call<string[]>(page, 'registryIds')).not.toContain('bounded.custom-registry');
    expect(await call<string[]>(page, 'customRegistryIds')).toContain('bounded.custom-registry');

    await call(page, 'clearFetchCalls', key);
    await call(page, 'invalidateAll');
    await call(page, 'frames', 2);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);

    await call(page, 'customInvalidateAll');
    await expect.poll(() => call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);

    await call(page, 'disposeNow', key);
    expect(await call<string[]>(page, 'customRegistryIds')).not.toContain('bounded.custom-registry');
  });

  test('pillHost 三态', async ({ page }) => {
    const explicit = await mount(page, { itemCount: 1, pillHost: 'explicit', reachPx: -1 });
    expect(await call<{ parentClass: string }>(page, 'pillInfo', explicit))
      .toMatchObject({ exists: true, parentClass: 'bl-explicit-pill-host' });

    const none = await mount(page, { itemCount: 1, pillHost: 'false', reachPx: -1 });
    expect(await call<{ exists: boolean }>(page, 'pillInfo', none)).toMatchObject({ exists: false });
  });

  // ───────────── 首屏与文案 ─────────────

  test('reset 透传 query/pageSize，加载中显示加载态，落地后输出完整渲染上下文', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 3,
      pageSize: 2,
      maxPages: 2,
      initialQuery: { keyword: '' },
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key, { query: { keyword: 'item' }, pinEdge: true });
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await expect(root(page, key).locator('.list-boundary-hint')).toHaveText('正在加载');
    expect(await call<ListState>(page, 'state', key)).toMatchObject({ loaded: false, loading: true, count: 0 });

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);

    expect(await call(page, 'fetchCalls', key)).toEqual([
      { backward: false, limit: 2, query: { keyword: 'item' }, phase: 'reset' },
    ]);
    await expect(rows(page, key)).toHaveCount(2);
    await expect(rows(page, key).nth(1)).toHaveAttribute('data-previous', '0');
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loaded: true,
      loading: false,
      count: 2,
      total: 3,
      hasMoreBackward: false,
      hasMoreForward: true,
    });
    const eventLog = await events(page, key);
    expect(eventLog.map((event) => event.type))
      .toEqual(['onLoadStateChange', 'onItemsChanged', 'onLoadStateChange']);
    expect(eventLog[1].payload).toEqual([
      { id: '0', label: 'item-0', order: 0 },
      { id: '1', label: 'item-1', order: 1 },
    ]);
  });

  test('空态、过滤空态与双端边界文案', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 4,
      pageSize: 10,
      maxPages: 1,
      initialQuery: { keyword: '' },
      reachPx: -1,
    });
    await expect(root(page, key).locator('.list-boundary-hint-top')).toHaveText('已到开头');
    await expect(root(page, key).locator('.list-boundary-hint-bottom')).toHaveText('已到结尾');

    await call(page, 'setQuery', key, { keyword: '不存在' }, 0);
    await call(page, 'waitForIdle', key);
    await expect(root(page, key).locator('.empty-state')).toHaveText('没有匹配项');

    await call(page, 'setQuery', key, { keyword: '' }, 0);
    await call(page, 'waitForIdle', key);
    await call(page, 'setItems', key, []);
    await call(page, 'reset', key);
    await expect(root(page, key).locator('.empty-state')).toHaveText('列表为空');
  });

  // ───────────── 分页与真实滚动 ─────────────

  test('双向分页、精确游标与整页裁剪保持窗口有界', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 100,
      pageSize: 10,
      maxPages: 2,
      initialStart: 40,
      reachPx: -1,
    });
    await call(page, 'clearFetchCalls', key);

    await call(page, 'loadMore', key, 'forward');
    await expect(rows(page, key)).toHaveCount(20);
    await call(page, 'loadMore', key, 'forward');
    await expect(rows(page, key)).toHaveCount(20); // 整页淘汰，窗口恒有界
    expect(await call<string[]>(page, 'rowIds', key)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(50 + i)),
    );
    expect(await call<ListState>(page, 'state', key)).toMatchObject({ hasMoreBackward: true, hasMoreForward: true });

    await call(page, 'loadMore', key, 'backward');
    expect(await call<string[]>(page, 'rowIds', key)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(40 + i)),
    );
  });

  test('单飞：已有请求在飞时的续翻请求被放弃，不会并发打两次', async ({ page }) => {
    const key = await mount(page, { itemCount: 100, pageSize: 10, maxPages: 3, initialStart: 40, reachPx: -1 });
    await call(page, 'clearFetchCalls', key);

    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'forward');
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    await call(page, 'startLoadMore', key, 'forward');
    await call(page, 'startLoadMore', key, 'backward');
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    await expect(rows(page, key)).toHaveCount(20);
  });

  test('真实滚动只在 reachPx 阈值内触发续翻', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 100,
      pageSize: 10,
      maxPages: 3,
      initialStart: 0,
      rowHeight: 40,
      reachPx: 20,
    });
    await call(page, 'clearFetchCalls', key);

    const metrics = await call<{ scrollHeight: number; clientHeight: number }>(page, 'scrollMetrics', key);
    await call(page, 'setScrollTop', key, metrics.scrollHeight - metrics.clientHeight - 200);
    await dispatchScroll(page, key);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);

    await call(page, 'setScrollTop', key, metrics.scrollHeight - metrics.clientHeight);
    await dispatchScroll(page, key);
    await expect.poll(() => call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
  });

  test('真实异高 DOM 在头部插页后保持可见锚点位置', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 100,
      pageSize: 10,
      maxPages: 3,
      initialStart: 50,
      rowHeight: 40,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 120);
    await dispatchScroll(page, key);

    const anchorId = (await call<string[]>(page, 'rowIds', key))[4];
    const before = await root(page, key).locator(`[data-bsw-key="${anchorId}"]`).boundingBox();
    await call(page, 'loadMore', key, 'backward');
    await call(page, 'frames', 2);
    const after = await root(page, key).locator(`[data-bsw-key="${anchorId}"]`).boundingBox();

    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
  });

  test('order=asc 贴底时内容异步增高后仍然贴底', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 30,
      maxPages: 1,
      order: 'asc',
      rowHeight: 24,
      reachPx: -1,
    });
    await call(page, 'frames', 4);
    expect((await call<ListState>(page, 'state', key)).atFreshEdge).toBe(true);

    await call(page, 'expandRow', key, '5', 400);
    await call(page, 'frames', 6);
    expect((await call<ListState>(page, 'state', key)).atFreshEdge).toBe(true);
  });

  // ───────────── setQuery ─────────────

  test('setQuery 默认 300ms 防抖、覆盖旧查询，0ms 立即重拉', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 20,
      pageSize: 10,
      maxPages: 1,
      initialQuery: { keyword: '' },
      reachPx: -1,
    });
    await call(page, 'clearFetchCalls', key);

    await call(page, 'setQuery', key, { keyword: 'item-1' });
    await call(page, 'setQuery', key, { keyword: 'item-19' });
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);

    await expect.poll(() => call<unknown[]>(page, 'fetchCalls', key), { timeout: 3000 }).toHaveLength(1);
    await call(page, 'waitForIdle', key);
    await expect(rows(page, key)).toHaveCount(1);

    await call(page, 'setQuery', key, { keyword: '' }, 0);
    await call(page, 'waitForIdle', key);
    await expect(rows(page, key)).toHaveCount(10);
  });

  // ───────────── invalidate 决策与提示条 ─────────────

  test('贴着新鲜端收到 invalidate 时直接追平，提示条不出现', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, reachPx: -1 });
    await call(page, 'setItems', key, [
      { id: 'new', label: 'item-new', order: -1 },
      ...await call<TestItem[]>(page, 'createItems', 10),
    ]);

    await call(page, 'invalidate', key);
    await call(page, 'waitForIdle', key);

    expect((await call<string[]>(page, 'rowIds', key))[0]).toBe('new');
    expect(await call<{ visible: boolean }>(page, 'pillInfo', key)).toMatchObject({ visible: false });
    expect((await call<ListState>(page, 'state', key)).stale).toBe(false);
  });

  test('离开新鲜端时点亮提示条并定向刷新窗口内条目，点击提示条追平', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 60,
      pageSize: 20,
      maxPages: 2,
      rowHeight: 40,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 400);
    await dispatchScroll(page, key);
    await call(page, 'clearEvents', key);

    const updated = await call<TestItem[]>(page, 'createItems', 60);
    updated[3] = { ...updated[3], label: 'refreshed-3' };
    await call(page, 'setItems', key, updated);
    await call(page, 'invalidate', key, { identities: ['3'] });
    await call(page, 'waitForIdle', key);

    expect(await call<{ visible: boolean; text: string }>(page, 'pillInfo', key))
      .toMatchObject({ visible: true, text: '有更新' });
    await expect(root(page, key).locator('[data-bsw-key="3"] .bl-row-label')).toHaveText('refreshed-3#0');
    expect((await events(page, key)).some((event) => event.type === 'fetchByIdentity')).toBe(true);

    await call(page, 'clickPill', key);
    await call(page, 'waitForIdle', key);
    expect(await call<{ visible: boolean }>(page, 'pillInfo', key)).toMatchObject({ visible: false });
    expect((await call<ListState>(page, 'state', key)).atFreshEdge).toBe(true);
  });

  test('回归：追平请求在飞期间到达的通知不会让提示条闪一下', async ({ page }) => {
    // 本端发消息 → 会话列表先收到一次通知开始追平，紧接着又收到同步成功的通知。
    // 第二条通知落在「请求在飞」的时间窗里，此时点亮提示条就会在响应落地后立刻熄灭。
    const key = await mount(page, { itemCount: 20, pageSize: 10, maxPages: 2, reachPx: -1 });
    const pillStates: boolean[] = [];

    await call(page, 'pauseNextPage', key);
    await call(page, 'invalidate', key);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    for (let i = 0; i < 3; i++) {
      await call(page, 'invalidate', key);
      await call(page, 'frames', 2);
      pillStates.push((await call<{ visible: boolean }>(page, 'pillInfo', key)).visible);
    }
    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    pillStates.push((await call<{ visible: boolean }>(page, 'pillInfo', key)).visible);

    expect(pillStates).toEqual([false, false, false, false]);
    expect((await call<ListState>(page, 'state', key)).stale).toBe(false);
  });

  test('追平期间保留当前 DOM，权威首页到达后只替换变化的行', async ({ page }) => {
    const key = await mount(page, { itemCount: 20, pageSize: 10, maxPages: 2, reachPx: -1 });
    await call(page, 'rememberRows', key);

    await call(page, 'pauseNextPage', key);
    await call(page, 'invalidate', key);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    await expect(rows(page, key)).toHaveCount(10); // 在飞期间不闪空

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    const identity = await call<Record<string, boolean>>(page, 'rememberedRowIdentity', key);
    expect(Object.values(identity).every(Boolean)).toBe(true);
  });

  test('isActive=false 时只记 stale，恢复活动并贴边后才追平', async ({ page }) => {
    const key = await mount(page, { itemCount: 20, pageSize: 10, maxPages: 2, active: false, reachPx: -1 });
    await call(page, 'clearFetchCalls', key);

    await call(page, 'invalidate', key);
    await call(page, 'frames', 2);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);
    expect((await call<ListState>(page, 'state', key)).stale).toBe(true);

    await call(page, 'setActive', key, true);
    await call(page, 'invalidate', key);
    await call(page, 'waitForIdle', key);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
    expect((await call<ListState>(page, 'state', key)).stale).toBe(false);
  });

  test('未提供 updatePill 文案时不显示空白提示条', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 60,
      pageSize: 20,
      maxPages: 2,
      rowHeight: 40,
      text: { updatePill: false },
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 400);
    await dispatchScroll(page, key);
    await call(page, 'invalidate', key);
    await call(page, 'frames', 2);

    expect((await call<ListState>(page, 'state', key)).stale).toBe(true);
    expect(await call<{ visible: boolean }>(page, 'pillInfo', key)).toMatchObject({ visible: false });
  });

  // ───────────── 本地层 ─────────────

  test('upsertLocal 立即可见并落在新鲜端，权威首页落地后让位给服务端事实', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, reachPx: -1 });

    await call(page, 'upsertLocal', key, { id: 'local', label: 'local-item', order: -1 });
    expect((await call<string[]>(page, 'rowIds', key))[0]).toBe('local');

    await call(page, 'setItems', key, [
      { id: 'local', label: 'server-item', order: -1 },
      ...await call<TestItem[]>(page, 'createItems', 10),
    ]);
    await call(page, 'invalidate', key);
    await call(page, 'waitForIdle', key);

    await expect(root(page, key).locator('[data-bsw-key="local"] .bl-row-label')).toHaveText('server-item#0');
    expect(await call<string[]>(page, 'rowIds', key)).toHaveLength(10);
  });

  test('upsertLocal 已在窗口内的身份 = 移到新鲜端（发消息后会话置顶）', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, reachPx: -1 });
    const before = await call<string[]>(page, 'rowIds', key);
    expect(before[0]).toBe('0');

    await call(page, 'upsertLocal', key, { id: '5', label: 'promoted', order: 5 });
    const after = await call<string[]>(page, 'rowIds', key);
    expect(after[0]).toBe('5');
    expect(after).toHaveLength(before.length);
  });

  test('请求在飞期间的本端写入不会被这次响应吞掉', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, reachPx: -1 });

    await call(page, 'pauseNextPage', key);
    await call(page, 'invalidate', key);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'upsertLocal', key, { id: 'sent', label: 'sent-during-refresh', order: -1 });
    await call(page, 'removeLocal', key, '2');
    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);

    const ids = await call<string[]>(page, 'rowIds', key);
    expect(ids[0]).toBe('sent');
    expect(ids).not.toContain('2');
  });

  test('单条删除只变更对应 DOM，未变化行保持真实节点身份', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, reachPx: -1 });
    await call(page, 'rememberRows', key);

    // 删掉末行：其余行的下标、上一条身份、选中态都没变，节点必须原样复用。
    await call(page, 'removeLocal', key, '9');
    await call(page, 'frames', 2);

    const identity = await call<Record<string, boolean>>(page, 'rememberedRowIdentity', key);
    for (const [id, same] of Object.entries(identity)) {
      expect(same, `row ${id}`).toBe(id !== '9');
    }
    await expect(rows(page, key)).toHaveCount(9);
  });

  test('pinnedItems 钉在头部，被同身份的窗口条目顶掉', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 10,
      pageSize: 10,
      maxPages: 2,
      pinnedItems: [{ id: 'pinned', label: 'pinned', order: -1 }],
      reachPx: -1,
    });
    expect((await call<string[]>(page, 'rowIds', key))[0]).toBe('pinned');

    await call(page, 'setPinnedItems', key, [{ id: '1', label: 'dup', order: 1 }]);
    await call(page, 'render', key);
    expect(await call<string[]>(page, 'rowIds', key)).toHaveLength(10);
    expect((await call<string[]>(page, 'rowIds', key))[0]).toBe('0');
  });

  // ───────────── 交互 ─────────────

  test('无 selection / single / multi+max 的真实点击行为', async ({ page }) => {
    const plain = await mount(page, { itemCount: 3, reachPx: -1 });
    await rows(page, plain).nth(1).locator('.bl-row-label').click();
    expect((await events(page, plain)).filter((event) => event.type === 'onActivate')).toHaveLength(1);

    const single = await mount(page, { itemCount: 3, selection: { mode: 'single' }, reachPx: -1 });
    await rows(page, single).nth(0).click();
    await rows(page, single).nth(1).click();
    await expect(root(page, single).locator('[data-selected="true"]')).toHaveCount(1);

    const multi = await mount(page, { itemCount: 3, selection: { mode: 'multi', max: 1 }, reachPx: -1 });
    await rows(page, multi).nth(0).click();
    await rows(page, multi).nth(1).click();
    expect((await events(page, multi)).filter((event) => event.type === 'onExceed')).toHaveLength(1);
    await expect(root(page, multi).locator('[data-selectable="false"]')).toHaveCount(2);
  });

  test('共享 SelectionStore 跨两个真实列表同步', async ({ page }) => {
    const left = await mount(page, {
      itemCount: 3, selection: { mode: 'multi', storeKey: 'shared' }, reachPx: -1,
    });
    const right = await mount(page, {
      itemCount: 3, selection: { mode: 'multi', storeKey: 'shared' }, reachPx: -1,
    });

    await rows(page, left).nth(0).click();
    await expect(root(page, right).locator('[data-selected="true"]')).toHaveCount(1);

    await call(page, 'disposeNow', right);
    await rows(page, left).nth(1).click();
    await expect(root(page, left).locator('[data-selected="true"]')).toHaveCount(2);
  });

  test('真实 pointerdown 期间不重建 DOM，window pointerup 后下一帧才应用', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, reachPx: -1 });
    const target = root(page, key).locator('[data-bsw-key="1"]');
    const handle = await target.elementHandle();

    await target.dispatchEvent('pointerdown');
    await call(page, 'removeLocal', key, '1');
    expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);

    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup')));
    await call(page, 'frames', 2);
    expect(await handle!.evaluate((element) => element.isConnected)).toBe(false);
  });

  // ───────────── 错误处理 ─────────────

  test('首屏失败展示错误态与重试入口，重试成功后清零', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, autoReset: false, reachPx: -1 });
    await call(page, 'failNext', key, 'reset');
    await call(page, 'reset', key);
    await call(page, 'waitForIdle', key);

    expect(await call<ListState>(page, 'state', key)).toMatchObject({ failed: true, loaded: true, count: 0 });
    await expect(root(page, key).locator('.list-error-state')).toBeVisible();
    expect(await call<{ visible: boolean; text: string }>(page, 'pillInfo', key))
      .toMatchObject({ visible: true, text: '重新加载' });

    const errors = (await events(page, key)).filter((event) => event.type === 'onError');
    expect(errors[0].payload).toMatchObject({ phase: 'reset' });

    await call(page, 'clickPill', key);
    await call(page, 'waitForIdle', key);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({ failed: false, count: 10 });
    expect(await call<{ visible: boolean }>(page, 'pillInfo', key)).toMatchObject({ visible: false });
  });

  test('首屏失败后不自动重试，避免请求风暴', async ({ page }) => {
    const key = await mount(page, { itemCount: 10, pageSize: 10, maxPages: 2, autoReset: false, reachPx: -1 });
    await call(page, 'failNext', key, 'reset');
    await call(page, 'reset', key);
    await call(page, 'waitForIdle', key);
    await call(page, 'clearFetchCalls', key);

    await call(page, 'frames', 6);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);
  });

  test('续翻与定向刷新失败都只上报 phase，不破坏当前窗口', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 100, pageSize: 10, maxPages: 3, initialStart: 40, fetchByIdentity: true, rowHeight: 40, reachPx: -1,
    });
    await call(page, 'failNext', key, 'forward');
    await call(page, 'loadMore', key, 'forward');
    await call(page, 'waitForIdle', key);
    await expect(rows(page, key)).toHaveCount(10);

    await call(page, 'setScrollTop', key, 120);
    await dispatchScroll(page, key);
    await call(page, 'failNext', key, 'refresh');
    await call(page, 'invalidate', key, { identities: ['41'] });
    await call(page, 'waitForIdle', key);
    await expect(rows(page, key)).toHaveCount(10);

    const phases = (await events(page, key))
      .filter((event) => event.type === 'onError')
      .map((event) => (event.payload as { phase: string }).phase);
    expect(phases).toEqual(['forward', 'refresh']);
  });

  test('恶意 source 单页超过 limit 时进入失败态且不突破容量', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 50, pageSize: 10, maxPages: 2, overflowPageBy: 5, autoReset: false, reachPx: -1,
    });
    await call(page, 'reset', key);
    await call(page, 'waitForIdle', key);

    expect(await call<ListState>(page, 'state', key)).toMatchObject({ failed: true, count: 0 });
    await expect(rows(page, key)).toHaveCount(0);
  });

  // ───────────── 大数据量与释放 ─────────────

  test('localPageSource 在 1000 条数据上保持窗口与 DOM 有界', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      logicalCount: 1000,
      pageSize: 40,
      maxPages: 3,
      initialQuery: { keyword: '' },
      reachPx: -1,
    });
    for (let i = 0; i < 6; i++) await call(page, 'loadMore', key, 'forward');
    await call(page, 'waitForIdle', key);

    const state = await call<ListState>(page, 'state', key);
    expect(state.count).toBeLessThanOrEqual(120);
    await expect(rows(page, key)).toHaveCount(state.count);
    expect(state.total).toBe(1000);
  });

  test('后发 reset 胜出，旧请求晚返回不覆盖当前 DOM', async ({ page }) => {
    const key = await mount(page, { itemCount: 40, pageSize: 10, maxPages: 2, autoReset: false, reachPx: -1 });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'setItems', key, await call<TestItem[]>(page, 'createItems', 5));
    await call(page, 'startReset', key);
    await expect(rows(page, key)).toHaveCount(5);

    // 第一次 reset 的响应此刻才落地：世代已推进，它必须被整体丢弃。
    await call(page, 'resolvePage', key);
    await call(page, 'frames', 4);
    await expect(rows(page, key)).toHaveCount(5);
  });

  test('dispose 幂等，隔离在飞结果、取消防抖并清理 DOM 与注册项', async ({ page }) => {
    const key = await mount(page, {
      id: 'bounded.dispose', itemCount: 40, pageSize: 10, maxPages: 2, reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'forward');
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'setQuery', key, { keyword: 'never' });
    await call(page, 'disposeNow', key);
    await call(page, 'disposeNow', key);
    await call(page, 'resolvePage', key);
    await call(page, 'frames', 4);

    await expect(rows(page, key)).toHaveCount(10);
    expect(await call<string[]>(page, 'registryIds')).not.toContain('bounded.dispose');
    expect(await call<{ visible: boolean }>(page, 'pillInfo', key)).toMatchObject({ visible: false });
  });
});
