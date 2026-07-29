import type { Page } from '@playwright/test';
import { expect, test } from '../support/test-fixtures';
import { openBoundedListHarness } from '../support/bounded-list/fixture';

interface TestItem {
  readonly id: string;
  readonly label: string;
  readonly order: number;
}

interface HarnessEvent {
  readonly type: string;
  readonly payload: unknown;
}

interface ListState {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingBefore: boolean;
  readonly loadingAfter: boolean;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly count: number;
  readonly total: number;
  readonly stale: boolean;
  readonly pendingCount: number;
  readonly atFreshEdge: boolean;
  readonly failed: boolean;
}

async function call<T>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return page.evaluate(
    ({ methodName, methodArgs }) => {
      const harness = (window as unknown as {
        boundedListTestHarness: Record<string, (...values: unknown[]) => unknown>;
      }).boundedListTestHarness;
      return harness[methodName](...methodArgs);
    },
    { methodName: method, methodArgs: args },
  ) as Promise<T>;
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

function allParts(page: Page, key: string) {
  return root(page, key).locator('.bl-row');
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

async function mountFullTailWindow(
  page: Page,
  position: 'old-edge' | 'fresh-edge',
): Promise<string> {
  const key = await mount(page, {
    itemCount: 100,
    pageSize: 10,
    maxPages: 2,
    freshEdge: 'tail',
    settleFrames: 1,
    reachPx: -1,
  });
  await call(page, 'loadMore', key, 'forward');
  await call(page, 'loadMore', key, 'forward');
  expect(await call<ListState>(page, 'state', key)).toMatchObject({
    count: 20,
    hasMoreBefore: true,
    hasMoreAfter: true,
  });
  await call(page, 'setScrollTop', key, position === 'fresh-edge' ? 1_000_000 : 0);
  await dispatchScroll(page, key);
  expect((await call<ListState>(page, 'state', key)).atFreshEdge)
    .toBe(position === 'fresh-edge');
  await call(page, 'clearFetchCalls', key);
  await call(page, 'clearEvents', key);
  return key;
}

test.describe('BoundedList 真实 Chromium 组件契约', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(async ({ page }) => {
    await openBoundedListHarness(page);
  });

  test('构造默认值、id、完整初始状态、默认提示条与注册表', async ({ page }) => {
    const key = await mount(page, {
      id: 'bounded.defaults',
      itemCount: 0,
      autoReset: false,
    });

    expect(await call(page, 'id', key)).toBe('bounded.defaults');
    expect(await call<ListState>(page, 'state', key)).toEqual({
      loaded: false,
      loading: false,
      loadingBefore: false,
      loadingAfter: false,
      hasMoreBefore: false,
      hasMoreAfter: false,
      count: 0,
      total: -1,
      stale: false,
      pendingCount: 0,
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

  test('真实元素具备 listbox/option 选择语义，dispose 后清理组件注入的 a11y 属性', async ({ page }) => {
    const plain = await mount(page, {
      itemCount: 2,
      reachPx: -1,
    });
    const plainScroller = root(page, plain).locator('.bl-scroller');
    await expect(plainScroller).toHaveAttribute('tabindex', '0');
    await expect(plainScroller).toHaveAttribute('role', 'listbox');
    await expect(plainScroller).not.toHaveAttribute('aria-multiselectable');
    await expect(rows(page, plain).first()).toHaveAttribute('role', 'option');
    await expect(rows(page, plain).first()).not.toHaveAttribute('aria-selected');

    const multi = await mount(page, {
      itemCount: 2,
      selection: { mode: 'multi', max: 2 },
      reachPx: -1,
    });
    const multiScroller = root(page, multi).locator('.bl-scroller');
    await expect(multiScroller).toHaveAttribute('aria-multiselectable', 'true');
    await expect(rows(page, multi).first()).toHaveAttribute('aria-selected', 'false');
    await rows(page, multi).first().click();
    await expect(rows(page, multi).first()).toHaveAttribute('aria-selected', 'true');

    await call(page, 'disposeNow', multi);
    await expect(multiScroller).not.toHaveAttribute('tabindex');
    await expect(multiScroller).not.toHaveAttribute('role');
    await expect(multiScroller).not.toHaveAttribute('aria-multiselectable');
    await expect(multiScroller).toHaveAttribute('aria-label', `BoundedList ${multi}`);

    const preconfigured = await mount(page, {
      itemCount: 1,
      selection: { mode: 'multi', max: 1 },
      initialA11y: {
        tabindex: '7',
        role: 'feed',
        ariaMultiselectable: 'false',
      },
      reachPx: -1,
    });
    const preconfiguredScroller = root(page, preconfigured).locator('.bl-scroller');
    await expect(preconfiguredScroller).toHaveAttribute('tabindex', '0');
    await expect(preconfiguredScroller).toHaveAttribute('role', 'listbox');
    await expect(preconfiguredScroller).toHaveAttribute('aria-multiselectable', 'true');
    await call(page, 'disposeNow', preconfigured);
    await expect(preconfiguredScroller).toHaveAttribute('tabindex', '7');
    await expect(preconfiguredScroller).toHaveAttribute('role', 'feed');
    await expect(preconfiguredScroller).toHaveAttribute('aria-multiselectable', 'false');
  });

  test('register 可隔离到宿主注册表，并由对应广播与 dispose 精确管理', async ({ page }) => {
    const key = await mount(page, {
      id: 'bounded.custom-registry',
      itemCount: 3,
      register: 'custom',
      reachPx: -1,
    });
    expect(await call<string[]>(page, 'registryIds')).not.toContain('bounded.custom-registry');
    expect(await call<string[]>(page, 'customRegistryIds')).toContain('bounded.custom-registry');
    expect((await events(page, key)).filter((event) => event.type === 'register')).toEqual([
      { type: 'register', payload: 'bounded.custom-registry' },
    ]);

    await call(page, 'clearFetchCalls', key);
    await call(page, 'invalidateAll');
    await call(page, 'frames', 2);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);

    await call(page, 'customInvalidateAll');
    await call(page, 'frames', 2);
    await expect.poll(() => call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);

    await call(page, 'disposeNow', key);
    expect(await call<string[]>(page, 'customRegistryIds')).not.toContain('bounded.custom-registry');
    expect((await events(page, key)).filter((event) => event.type === 'unregister')).toEqual([
      { type: 'unregister', payload: 'bounded.custom-registry' },
    ]);
  });

  test('reset 透传 query/pageSize，显示加载态并输出全部渲染上下文', async ({ page }) => {
    const key = await mount(page, {
      id: 'bounded.reset',
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
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loaded: false,
      count: 0,
      total: -1,
    });

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);

    expect(await call(page, 'fetchCalls', key)).toEqual([
      {
        backward: false,
        limit: 2,
        query: { keyword: 'item' },
        phase: 'reset',
      },
    ]);
    await expect(rows(page, key)).toHaveCount(2);
    await expect(rows(page, key).nth(0)).toHaveAttribute('data-index', '0');
    await expect(rows(page, key).nth(0)).toHaveAttribute('data-identity', '0');
    await expect(rows(page, key).nth(0)).toHaveAttribute('data-previous', '');
    await expect(rows(page, key).nth(1)).toHaveAttribute('data-previous', '0');
    await expect(rows(page, key).nth(0)).toHaveAttribute('data-selected', 'false');
    await expect(rows(page, key).nth(0)).toHaveAttribute('data-selectable', 'true');
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loaded: true,
      count: 2,
      total: 3,
      hasMoreBefore: false,
      hasMoreAfter: true,
    });

    const eventTypes = await call<string[]>(page, 'eventTypes', key);
    expect(eventTypes).toEqual([
      'onStaleChange',
      'onLoadStateChange',
      'onItemsChanged',
      'onLoadStateChange',
    ]);
    const eventLog = await events(page, key);
    expect(eventLog[0]).toEqual({
      type: 'onStaleChange',
      payload: { stale: false, pendingCount: 0 },
    });
    expect(eventLog[1]).toMatchObject({
      type: 'onLoadStateChange',
      payload: {
        loaded: false,
        loading: false,
        count: 0,
        total: -1,
        stale: false,
        pendingCount: 0,
      },
    });
    expect(eventLog[2]).toEqual({
      type: 'onItemsChanged',
      payload: [
        { id: '0', label: 'item-0', order: 0 },
        { id: '1', label: 'item-1', order: 1 },
      ],
    });
    expect(eventLog[3]).toMatchObject({
      type: 'onLoadStateChange',
      payload: {
        loaded: true,
        loading: false,
        count: 2,
        total: 3,
        hasMoreBefore: false,
        hasMoreAfter: true,
      },
    });
  });

  test('localPageSource reset 透传 onProgress，续翻不重复上报进度', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 50,
      pageSize: 10,
      onLoadProgress: true,
      progressValues: [0, 20, 50],
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'reset', key);

    expect((await events(page, key)).filter((event) => event.type === 'onLoadProgress')).toEqual([
      { type: 'onLoadProgress', payload: 0 },
      { type: 'onLoadProgress', payload: 20 },
      { type: 'onLoadProgress', payload: 50 },
    ]);
    expect(await call(page, 'fetchCalls', key)).toEqual([
      {
        backward: false,
        limit: 10,
        query: { keyword: '' },
        phase: 'reset',
        hasOnProgress: true,
      },
    ]);

    await call(page, 'clearEvents', key);
    await call(page, 'loadMore', key, 'forward');
    expect((await events(page, key)).filter((event) => event.type === 'onLoadProgress')).toEqual([]);
  });

  test('localPageSource 并发 reset 只上报最新查询的进度，旧进度晚到也被丢弃', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 50,
      pageSize: 10,
      onLoadProgress: true,
      progressByKeyword: {
        old: [10, 50],
        new: [20, 50],
      },
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key, { query: { keyword: 'old' } });
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'reset', key, { query: { keyword: 'new' } });
    expect((await events(page, key)).filter((event) => event.type === 'onLoadProgress')).toEqual([
      { type: 'onLoadProgress', payload: 20 },
      { type: 'onLoadProgress', payload: 50 },
    ]);

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    expect((await events(page, key)).filter((event) => event.type === 'onLoadProgress')).toEqual([
      { type: 'onLoadProgress', payload: 20 },
      { type: 'onLoadProgress', payload: 50 },
    ]);
  });

  test('空态、过滤空态、加载、双端文案与最小容量边界均正确', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 4,
      pageSize: 10,
      initialQuery: { keyword: '' },
      reachPx: -1,
      text: {
        loading: 'L',
        empty: 'E',
        emptyFiltered: 'F',
        headBoundary: 'H',
        tailBoundary: 'T',
      },
    });

    await call(page, 'setQuery', key, { keyword: 'missing' }, 0);
    await expect(root(page, key).locator('.empty-state')).toHaveText('F');
    await call(page, 'setQuery', key, { keyword: '' }, 0);
    await expect(rows(page, key)).toHaveCount(4);
    await expect(root(page, key).locator('.list-boundary-hint-top')).toHaveText('H');
    await expect(root(page, key).locator('.list-boundary-hint-bottom')).toHaveText('T');

    const emptyKey = await mount(page, {
      itemCount: 0,
      text: { empty: '真正为空' },
      reachPx: -1,
    });
    await expect(root(page, emptyKey).locator('.empty-state')).toHaveText('真正为空');

    const single = await mount(page, {
      itemCount: 1,
      pageSize: 1,
      maxPages: 1,
      callbacks: false,
      reachPx: -1,
    });
    const pageMinusOne = await mount(page, { itemCount: 4, pageSize: 5, reachPx: -1 });
    const exactPage = await mount(page, { itemCount: 5, pageSize: 5, reachPx: -1 });
    const pagePlusOne = await mount(page, { itemCount: 6, pageSize: 5, reachPx: -1 });
    expect(await call<ListState>(page, 'state', single)).toMatchObject({
      count: 1,
      hasMoreAfter: false,
    });
    expect(await events(page, single)).toEqual([]);
    expect(await call<ListState>(page, 'state', pageMinusOne)).toMatchObject({
      count: 4,
      hasMoreAfter: false,
    });
    expect(await call<ListState>(page, 'state', exactPage)).toMatchObject({
      count: 5,
      hasMoreAfter: false,
    });
    expect(await call<ListState>(page, 'state', pagePlusOne)).toMatchObject({
      count: 5,
      hasMoreAfter: true,
    });
  });

  test('contentElement 与 scrollElement 分离，pillHost 默认/显式/false/无父节点', async ({ page }) => {
    const separate = await mount(page, {
      separateContent: true,
      pillHost: 'explicit',
      reachPx: -1,
    });
    const noPill = await mount(page, {
      pillHost: 'false',
      reachPx: -1,
    });
    const detached = await mount(page, {
      detachedScroller: true,
      active: false,
      reachPx: -1,
    });

    await call(page, 'setScrollTop', separate, 100);
    await call(page, 'setScrollTop', noPill, 100);
    // detached scroller 没有真实布局，改用 inactive 分支只验证不创建默认 pill。
    await call(page, 'invalidate', separate, { count: 2 });
    await call(page, 'invalidate', noPill, { count: 2 });
    await call(page, 'invalidate', detached, { count: 2 });
    await call(page, 'frames', 2);

    await expect(root(page, separate).locator('.bl-content [data-bsw-key]')).toHaveCount(10);
    expect(await call(page, 'pillInfo', separate)).toMatchObject({
      exists: true,
      visible: true,
      parentClass: 'bl-explicit-pill-host',
    });
    expect(await call(page, 'pillInfo', noPill)).toMatchObject({ exists: false });
    expect(await call(page, 'pillInfo', detached)).toMatchObject({ exists: false });
  });

  test('双向分页、精确游标、normalize 与整页裁剪保持窗口有界', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 25,
      pageSize: 5,
      maxPages: 2,
      reachPx: -1,
      normalize: 'reverse',
    });

    expect(await call<string[]>(page, 'rowIds', key)).toEqual(['4', '3', '2', '1', '0']);
    await call(page, 'loadMore', key, 'forward');
    await call(page, 'loadMore', key, 'forward');
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      count: 10,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(await call<string[]>(page, 'rowIds', key)).toEqual([
      '9', '8', '7', '6', '5',
      '14', '13', '12', '11', '10',
    ]);

    await call(page, 'loadMore', key, 'backward');
    expect(await call<string[]>(page, 'rowIds', key)).toEqual([
      '4', '3', '2', '1', '0',
      '9', '8', '7', '6', '5',
    ]);
    expect(await call(page, 'fetchCalls', key)).toEqual([
      { backward: false, limit: 5, query: { keyword: '' }, phase: 'reset' },
      { cursor: '5', backward: false, limit: 5, query: { keyword: '' }, phase: 'forward' },
      { cursor: '10', backward: false, limit: 5, query: { keyword: '' }, phase: 'forward' },
      { cursor: '5', backward: true, limit: 5, query: { keyword: '' }, phase: 'backward' },
    ]);

    const normalized = await mount(page, {
      items: [
        { id: '2', label: 'two', order: 2 },
        { id: '1', label: 'stale-one', order: 99 },
        { id: '0', label: 'zero', order: 0 },
        { id: '1', label: 'fresh-one', order: 1 },
      ],
      pageSize: 10,
      maxPages: 1,
      reachPx: -1,
      normalize: 'dedupe-sort',
    });
    expect(await call<string[]>(page, 'rowIds', normalized)).toEqual(['0', '1', '2']);
    await expect(root(page, normalized).locator('[data-id="1"]')).toContainText('fresh-one');
  });

  test('同方向并发只发一次请求，相反方向可独立加载', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 5,
      initialStart: 10,
      reachPx: -1,
    });
    await call(page, 'clearFetchCalls', key);
    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'forward');
    await call(page, 'startLoadMore', key, 'forward');
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loading: true,
      loadingAfter: true,
      loadingBefore: false,
    });
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);

    await call(page, 'clearFetchCalls', key);
    await call(page, 'pauseNextPage', key);
    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'backward');
    await call(page, 'startLoadMore', key, 'forward');
    await expect.poll(() => call<number>(page, 'pageGateCount', key)).toBe(2);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loading: true,
      loadingBefore: true,
      loadingAfter: true,
    });
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(2);
    await call(page, 'resolvePage', key);
    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      loadingBefore: false,
      loadingAfter: false,
    });
  });

  test('forward loadMore 在飞时同 identity 的 upsert/patch 不被旧返回页覆盖或复制', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 10,
      maxPages: 3,
      reachPx: -1,
    });
    await call(page, 'clearFetchCalls', key);
    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'forward');
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'upsertLocal', key, {
      id: '10',
      label: 'local-upsert',
      order: 10,
    });
    expect(await call(page, 'patchLabel', key, '10', 'local-final')).toBe(true);
    await expect(root(page, key).locator('[data-id="10"]')).toHaveCount(1);
    await expect(root(page, key).locator('[data-id="10"] .bl-row-label')).toContainText('local-final');

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);

    expect(await call(page, 'fetchCalls', key)).toEqual([
      { cursor: '10', backward: false, limit: 10, query: { keyword: '' }, phase: 'forward' },
    ]);
    await expect(root(page, key).locator('[data-id="10"]')).toHaveCount(1);
    await expect(root(page, key).locator('[data-id="10"] .bl-row-label')).toContainText('local-final');
    const finalIds = await call<string[]>(page, 'rowIds', key);
    expect(finalIds.filter((id) => id === '10')).toEqual(['10']);
  });

  test('定向 refresh 先于旧分页落地时，新值不回退且删除项不复活', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 6,
      pageSize: 3,
      maxPages: 2,
      freshEdge: 'tail',
      fetchByIdentity: true,
      rowHeight: 100,
      settleFrames: 1,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 0);
    await dispatchScroll(page, key);

    // identity 请求先捕获较新的权威快照：id=1 已更新，id=2 已删除。
    await call(page, 'setItems', key, [
      { id: '0', label: 'item-0', order: 0 },
      { id: '1', label: 'fresh-1', order: 1 },
      { id: '3', label: 'item-3', order: 3 },
      { id: '4', label: 'item-4', order: 4 },
      { id: '5', label: 'item-5', order: 5 },
    ]);
    await call(page, 'pauseNextIdentity', key);
    await call(page, 'invalidate', key, { identities: ['1', '2'] });
    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasIdentityGate', key)).toBe(true);

    // 普通分页随后从更旧快照启动，返回页会再次携带 stale id=1/id=2。
    await call(page, 'setItems', key, [
      { id: '0', label: 'item-0', order: 0 },
      { id: '1', label: 'stale-existing-1', order: 1 },
      { id: '2', label: 'stale-existing-2', order: 2 },
      { id: '1', label: 'stale-page-1', order: 1 },
      { id: '2', label: 'stale-page-2', order: 2 },
      { id: '3', label: 'item-3', order: 3 },
    ]);
    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'forward');
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'resolveIdentity', key);
    await call(page, 'frames', 2);
    await expect(root(page, key).locator('[data-id="1"] .bl-row-label')).toContainText('fresh-1');
    await expect(root(page, key).locator('[data-id="2"]')).toHaveCount(0);

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    await expect(root(page, key).locator('[data-id="1"] .bl-row-label')).toContainText('fresh-1');
    await expect(root(page, key).locator('[data-id="2"]')).toHaveCount(0);
    expect(await call<string[]>(page, 'rowIds', key)).toEqual(['0', '1', '3']);
  });

  test('真实滚动只在 reachPx 阈值内触发续翻', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 10,
      maxPages: 3,
      reachPx: 12,
    });
    await call(page, 'clearFetchCalls', key);
    const metrics = await call<{
      scrollHeight: number;
      clientHeight: number;
    }>(page, 'scrollMetrics', key);
    const maxScrollTop = metrics.scrollHeight - metrics.clientHeight;

    await call(page, 'setScrollTop', key, maxScrollTop - 13);
    await dispatchScroll(page, key);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);

    await call(page, 'setScrollTop', key, maxScrollTop - 12);
    await dispatchScroll(page, key);
    await expect.poll(() => call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toEqual([
      { cursor: '10', backward: false, limit: 10, query: { keyword: '' }, phase: 'forward' },
    ]);
  });

  test('真实异高 DOM 在头部插页后保持可见锚点位置', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 5,
      initialStart: 10,
      reachPx: -1,
      autoReset: false,
    });
    await call(page, 'reset', key, { pinEdge: false });
    await call(page, 'setScrollTop', key, 70);
    const before = await root(page, key).locator('[data-id="12"]').evaluate((row) => {
      const scroller = row.closest('.bl-scroller')!;
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });

    await call(page, 'loadMore', key, 'backward');
    const after = await root(page, key).locator('[data-id="12"]').evaluate((row) => {
      const scroller = row.closest('.bl-scroller')!;
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  });

  test('scrollToIdentity 支持 nearest/center、pinnedItems 与未命中返回值', async ({ page }) => {
    const pinned: TestItem = { id: 'pinned', label: 'pinned', order: -1 };
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 20,
      maxPages: 1,
      pinnedItems: [pinned],
      reachPx: -1,
    });

    expect(await call(page, 'scrollToIdentity', key, 'pinned', 'nearest')).toBe(true);
    expect(await call(page, 'scrollToIdentity', key, 'missing', 'center')).toBe(false);
    expect(await call(page, 'scrollToIdentity', key, '10', 'center')).toBe(true);
    const centerDelta = await root(page, key).locator('[data-id="10"]').evaluate((row) => {
      const scroller = row.closest('.bl-scroller')!;
      const rowRect = row.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      return Math.abs(
        (rowRect.top + rowRect.bottom) / 2
          - (scrollerRect.top + scrollerRect.bottom) / 2,
      );
    });
    expect(centerDelta).toBeLessThanOrEqual(1);
    expect((await call<ListState>(page, 'state', key)).count).toBe(20);
    await expect(rows(page, key)).toHaveCount(21);
  });

  test('setQuery 默认 300ms 防抖、覆盖旧查询，0ms 立即 reset', async ({ page }) => {
    await page.clock.install();
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 10,
      reachPx: -1,
    });
    await call(page, 'clearFetchCalls', key);
    // install() 后虚拟时间默认仍按真实时间流动；在高并发机器上，两次 page.evaluate 的调度
    // 可能已经消耗超过 100ms，再 fastForward(200) 就会越过 300ms 合法边界。先暂停时钟，
    // 再精确推进 299+1ms，使断言只依赖防抖契约而不依赖 worker 调度速度。
    await page.clock.pauseAt(Date.now() + 1_000);

    await call(page, 'setQuery', key, { keyword: 'item-1' });
    await call(page, 'setQuery', key, { keyword: 'item-2' });
    await page.clock.fastForward(299);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);
    await page.clock.fastForward(1);
    await page.clock.resume();
    await call(page, 'waitForIdle', key);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toEqual([
      {
        backward: false,
        limit: 10,
        query: { keyword: 'item-2' },
        phase: 'reset',
      },
    ]);

    await call(page, 'setQuery', key, { keyword: 'item-3' }, 0);
    await call(page, 'waitForIdle', key);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(2);
  });

  test('invalidate 同帧合并 identities/count，离开新鲜端显示提示条并定向更新', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 30,
      pageSize: 10,
      maxPages: 3,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 120);
    await call(page, 'setItems', key, [
      { id: '0', label: 'item-0', order: 0 },
      { id: '1', label: 'updated-1', order: 1 },
      { id: '2', label: 'updated-2', order: 2 },
      ...Array.from({ length: 27 }, (_, index) => ({
        id: String(index + 3),
        label: `item-${index + 3}`,
        order: index + 3,
      })),
    ]);
    await call(page, 'clearEvents', key);

    await call(page, 'invalidateMany', key, [
      { identities: ['1', '2'], count: 2 },
      { identities: ['2', '99'], count: 3 },
    ]);
    await call(page, 'frames', 2);

    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: true,
      pendingCount: 5,
    });
    const firstRefreshEvents = await events(page, key);
    expect(firstRefreshEvents.filter((event) => event.type === 'onStaleChange')).toEqual([
      { type: 'onStaleChange', payload: { stale: true, pendingCount: 5 } },
    ]);
    expect(firstRefreshEvents.filter((event) => event.type === 'fetchByIdentity')).toEqual([
      { type: 'fetchByIdentity', payload: ['1', '2'] },
    ]);
    const refreshedItems = firstRefreshEvents
      .filter((event) => event.type === 'onItemsChanged')
      .at(-1)?.payload as TestItem[];
    expect(refreshedItems.find((item) => item.id === '1')).toEqual({
      id: '1',
      label: 'updated-1',
      order: 1,
    });
    await expect(root(page, key).locator('[data-id="1"]')).toContainText('updated-1');

    await call(page, 'setItems', key, Array.from({ length: 29 }, (_, index) => {
      const order = index < 2 ? index : index + 1;
      return { id: String(order), label: `item-${order}`, order };
    }));
    await call(page, 'invalidate', key, { identities: ['2'] });
    await call(page, 'frames', 2);
    await expect(root(page, key).locator('[data-id="2"]')).toHaveCount(0);
    const afterRemovalEvents = await events(page, key);
    const afterRemovalItems = afterRemovalEvents
      .filter((event) => event.type === 'onItemsChanged')
      .at(-1)?.payload as TestItem[];
    expect(afterRemovalItems.some((item) => item.id === '2')).toBe(false);
    expect(await call(page, 'pillInfo', key)).toMatchObject({
      exists: true,
      visible: true,
      text: '有 5 条更新',
    });

    await call(page, 'clickPill', key);
    await call(page, 'waitForIdle', key);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: false,
      pendingCount: 0,
      atFreshEdge: true,
    });
    expect(await call(page, 'pillInfo', key)).toMatchObject({ visible: false });
  });

  test('同一 reset 世代的定向刷新乱序返回时，最后发出的结果保持胜出', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 10,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 100);
    await call(page, 'setItems', key, Array.from({ length: 20 }, (_, order) => ({
      id: String(order),
      label: order === 1 ? 'refresh-v1' : `item-${order}`,
      order,
    })));
    await call(page, 'pauseNextIdentity', key);
    await call(page, 'invalidate', key, { identities: ['1'] });
    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasIdentityGate', key)).toBe(true);

    await call(page, 'setItems', key, Array.from({ length: 20 }, (_, order) => ({
      id: String(order),
      label: order === 1 ? 'refresh-v2' : `item-${order}`,
      order,
    })));
    await call(page, 'invalidate', key, { identities: ['1'] });
    await call(page, 'frames', 2);
    await expect(root(page, key).locator('[data-id="1"] .bl-row-label')).toContainText('refresh-v2');

    await call(page, 'resolveIdentity', key);
    await call(page, 'frames', 2);
    await expect(root(page, key).locator('[data-id="1"] .bl-row-label')).toContainText('refresh-v2');
  });

  test('不同 identity 的定向刷新并发互不丢弃，各自响应都能落地', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 10,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 100);
    await call(page, 'setItems', key, Array.from({ length: 20 }, (_, order) => ({
      id: String(order),
      label: order === 1 ? 'identity-one' : `item-${order}`,
      order,
    })));
    await call(page, 'pauseNextIdentity', key);
    await call(page, 'invalidate', key, { identities: ['1'] });
    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasIdentityGate', key)).toBe(true);

    await call(page, 'setItems', key, Array.from({ length: 20 }, (_, order) => ({
      id: String(order),
      label: order === 1
        ? 'identity-one'
        : order === 2
          ? 'identity-two'
          : `item-${order}`,
      order,
    })));
    await call(page, 'invalidate', key, { identities: ['2'] });
    await call(page, 'frames', 2);
    await expect(root(page, key).locator('[data-id="2"] .bl-row-label')).toContainText('identity-two');

    await call(page, 'resolveIdentity', key);
    await call(page, 'frames', 2);
    await expect(root(page, key).locator('[data-id="1"] .bl-row-label')).toContainText('identity-one');
    await expect(root(page, key).locator('[data-id="2"] .bl-row-label')).toContainText('identity-two');
  });

  test('isActive=false 只记 stale；恢复活动且贴边后才 reset 追平', async ({ page }) => {
    const key = await mount(page, {
      active: false,
      itemCount: 20,
      pageSize: 10,
      reachPx: -1,
    });
    await call(page, 'clearFetchCalls', key);
    await call(page, 'invalidate', key, { count: 4 });
    await call(page, 'frames', 2);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(0);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: true,
      pendingCount: 4,
    });

    await call(page, 'setActive', key, true);
    await call(page, 'setScrollTop', key, 0);
    await call(page, 'invalidate', key, { count: 1 });
    await call(page, 'frames', 2);
    await call(page, 'waitForIdle', key);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: false,
      pendingCount: 0,
    });
  });

  test('新鲜端空页触发 onEmptyPage，并同时清 stale/pendingCount', async ({ page }) => {
    const key = await mount(page, {
      freshEdge: 'tail',
      stickyPx: 0,
      itemCount: 11,
      pageSize: 10,
      reachPx: -1,
    });
    // tail 默认 settleFrames=4；先让 reset 的剩余贴底帧全部落定，再模拟用户离底。
    await call(page, 'frames', 5);
    await call(page, 'clearEvents', key);
    await call(page, 'setScrollTop', key, 0);
    await call(page, 'invalidate', key, { count: 7 });
    await call(page, 'frames', 2);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: true,
      pendingCount: 7,
      hasMoreAfter: true,
    });

    await call(page, 'setItems', key, Array.from({ length: 10 }, (_, order) => ({
      id: String(order),
      label: `item-${order}`,
      order,
    })));
    await call(page, 'loadMore', key, 'forward');
    expect((await events(page, key)).filter((event) => event.type === 'onEmptyPage')).toEqual([
      { type: 'onEmptyPage', payload: 'forward' },
    ]);
    expect((await events(page, key)).filter((event) => event.type === 'onStaleChange')).toEqual([
      { type: 'onStaleChange', payload: { stale: true, pendingCount: 7 } },
      { type: 'onStaleChange', payload: { stale: false, pendingCount: 0 } },
    ]);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: false,
      pendingCount: 0,
      hasMoreAfter: false,
    });
  });

  test('无 selection、single、multi/max 的点击事件与回调参数正确', async ({ page }) => {
    const plain = await mount(page, { itemCount: 3, reachPx: -1 });
    await root(page, plain).locator('[data-id="1"] .bl-row-label').click();
    expect((await events(page, plain)).filter((event) => event.type === 'onActivate')).toEqual([
      {
        type: 'onActivate',
        payload: {
          item: { id: '1', label: 'item-1', order: 1 },
          eventType: 'click',
          keyboard: false,
        },
      },
    ]);

    const single = await mount(page, {
      itemCount: 3,
      selection: { mode: 'single' },
      reachPx: -1,
    });
    await root(page, single).locator('[data-id="1"]').click();
    await expect(root(page, single).locator('[data-id="1"]')).toHaveAttribute('data-selected', 'true');
    expect((await events(page, single)).filter((event) => event.type === 'onSelectionChange')).toEqual([
      {
        type: 'onSelectionChange',
        payload: {
          ids: ['1'],
          count: 1,
          items: [{ id: '1', label: 'item-1', order: 1 }],
        },
      },
    ]);
    expect((await events(page, single)).filter((event) => event.type === 'onActivate')).toEqual([
      {
        type: 'onActivate',
        payload: {
          item: { id: '1', label: 'item-1', order: 1 },
          eventType: 'click',
          keyboard: false,
        },
      },
    ]);

    const multi = await mount(page, {
      itemCount: 3,
      selection: { mode: 'multi', max: 1 },
      reachPx: -1,
    });
    await root(page, multi).locator('[data-id="0"]').click();
    await expect(root(page, multi).locator('[data-id="1"]')).toHaveAttribute('data-selectable', 'false');
    await root(page, multi).locator('[data-id="1"]').click();
    expect((await events(page, multi)).filter((event) => event.type === 'onExceed')).toEqual([
      { type: 'onExceed', payload: null },
    ]);
    await expect(root(page, multi).locator('[data-id="1"]')).toHaveAttribute('data-selected', 'false');
    await root(page, multi).locator('[data-id="0"]').click();
    await expect(root(page, multi).locator('[data-id="1"]')).toHaveAttribute('data-selectable', 'true');
  });

  test('共享 SelectionStore 跨两个真实列表同步，dispose 后取消订阅', async ({ page }) => {
    const first = await mount(page, {
      itemCount: 3,
      selection: { mode: 'multi', storeKey: 'shared', storeMax: 2 },
      reachPx: -1,
    });
    const second = await mount(page, {
      itemCount: 3,
      selection: { mode: 'multi', storeKey: 'shared', storeMax: 2 },
      reachPx: -1,
    });
    await call(page, 'clearEvents', first);
    await call(page, 'clearEvents', second);

    await root(page, first).locator('[data-id="1"]').click();
    await expect(root(page, second).locator('[data-id="1"]')).toHaveAttribute('data-selected', 'true');
    const secondSelection = (await events(page, second)).find(
      (event) => event.type === 'onSelectionChange',
    );
    expect(secondSelection).toMatchObject({
      payload: {
        ids: ['1'],
        count: 1,
        items: [{ id: '1', label: 'item-1', order: 1 }],
      },
    });

    await call(page, 'dispose', first);
    await call(page, 'clearEvents', first);
    await root(page, second).locator('[data-id="2"]').click();
    expect((await events(page, first)).filter((event) => event.type === 'onSelectionChange')).toHaveLength(0);
  });

  test('真实 pointerdown 期间 patch 不重建 DOM，window pointerup 后下一帧应用', async ({ page }) => {
    const key = await mount(page, { itemCount: 3, reachPx: -1 });
    const row = root(page, key).locator('[data-id="1"]');
    const original = await row.elementHandle();
    await row.dispatchEvent('pointerdown');
    expect(await call(page, 'patchLabel', key, '1', 'patched')).toBe(true);

    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(row).toContainText('item-1');
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup')));
    await call(page, 'frames', 2);
    expect(await original!.evaluate((element) => element.isConnected)).toBe(false);
    await expect(root(page, key).locator('[data-id="1"]')).toContainText('patched');

    const patchedRow = root(page, key).locator('[data-id="1"]');
    const patchedHandle = await patchedRow.elementHandle();
    await patchedRow.dispatchEvent('pointerdown');
    expect(await call(page, 'patchLabel', key, '1', 'cancelled-pointer')).toBe(true);
    await root(page, key).locator('.bl-scroller').dispatchEvent('pointercancel');
    await call(page, 'frames', 2);
    expect(await patchedHandle!.evaluate((element) => element.isConnected)).toBe(false);
    await expect(root(page, key).locator('[data-id="1"]')).toContainText('cancelled-pointer');
  });

  test('键盘 ArrowUp/Down、Enter、Space 与边界翻页使用真实焦点和事件', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 5,
      initialStart: 5,
      reachPx: -1,
    });
    const scroller = root(page, key).locator('.bl-scroller');
    await scroller.focus();
    await scroller.press('ArrowDown');
    await scroller.press('ArrowDown');
    expect(await call<string[]>(page, 'focusedIds', key)).toEqual(['6']);
    await scroller.press('Enter');
    await scroller.press(' ');
    const activations = (await events(page, key)).filter((event) => event.type === 'onActivate');
    expect(activations).toHaveLength(2);
    expect(activations[0]).toMatchObject({
      payload: { item: { id: '6' }, eventType: 'keydown', keyboard: true },
    });

    await call(page, 'clearFetchCalls', key);
    await scroller.press('ArrowUp');
    await scroller.press('ArrowUp');
    await scroller.press('ArrowUp');
    await expect.poll(() => call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toEqual([
      { cursor: '5', backward: true, limit: 5, query: { keyword: '' }, phase: 'backward' },
    ]);
  });

  test('reset/forward/backward/refresh 四个错误 phase 均回调且不产生页面异常', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const resetKey = await mount(page, {
      itemCount: 20,
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'failNext', resetKey, 'reset');
    await call(page, 'reset', resetKey);
    expect((await events(page, resetKey)).filter((event) => event.type === 'onError')).toEqual([
      {
        type: 'onError',
        payload: {
          error: { name: 'Error', message: 'reset-failure' },
          phase: 'reset',
        },
      },
    ]);
    expect(await call<ListState>(page, 'state', resetKey)).toMatchObject({
      loaded: true,
      loading: false,
      failed: true,
    });

    const pageKey = await mount(page, {
      itemCount: 30,
      initialStart: 10,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'failNext', pageKey, 'forward');
    await call(page, 'loadMore', pageKey, 'forward');
    await call(page, 'failNext', pageKey, 'backward');
    await call(page, 'loadMore', pageKey, 'backward');
    await call(page, 'setScrollTop', pageKey, 100);
    await call(page, 'failNext', pageKey, 'refresh');
    await call(page, 'invalidate', pageKey, { identities: ['10'] });
    await call(page, 'frames', 2);

    expect(
      (await events(page, pageKey))
        .filter((event) => event.type === 'onError')
        .map((event) => (event.payload as { phase: string }).phase),
    ).toEqual(['forward', 'backward', 'refresh']);
    expect(await call<ListState>(page, 'state', pageKey)).toMatchObject({
      loading: false,
      loadingBefore: false,
      loadingAfter: false,
    });
    expect(pageErrors).toEqual([]);
  });

  test('reset 失败展示 error/failed 与 retry，重试成功后清零；文案缺省时兼容空态', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 3,
      autoReset: false,
      reachPx: -1,
      text: {
        error: '请求错误：{message}',
        retry: '再次尝试',
      },
    });
    await call(page, 'failNext', key, 'reset');
    await call(page, 'reset', key);

    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loaded: true,
      loading: false,
      failed: true,
      count: 0,
    });
    await expect(root(page, key).locator('.list-error-state')).toHaveText('请求错误：reset-failure');
    expect(await call(page, 'pillInfo', key)).toMatchObject({
      visible: true,
      text: '再次尝试',
    });

    await call(page, 'clickPill', key);
    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loaded: true,
      failed: false,
      count: 3,
    });
    await expect(root(page, key).locator('.list-error-state')).toHaveCount(0);
    expect(await call(page, 'pillInfo', key)).toMatchObject({ visible: false });

    const fallback = await mount(page, {
      itemCount: 0,
      autoReset: false,
      reachPx: -1,
      text: {
        error: false,
        retry: false,
        empty: '兼容空态',
      },
    });
    await call(page, 'failNext', fallback, 'reset');
    await call(page, 'reset', fallback);
    expect(await call<ListState>(page, 'state', fallback)).toMatchObject({ failed: true });
    await expect(root(page, fallback).locator('.list-error-state')).toHaveCount(0);
    await expect(root(page, fallback).locator('.empty-state')).toHaveText('兼容空态');
    expect(await call(page, 'pillInfo', fallback)).toMatchObject({ visible: false });
  });

  test('localPageSource 在 1000 条数据上保持窗口/DOM 有界并重新过滤排序', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 1000,
      pageSize: 40,
      maxPages: 5,
      reachPx: -1,
    });
    for (let index = 0; index < 8; index++) {
      await call(page, 'loadMore', key, 'forward');
    }
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      count: 200,
      total: 1000,
    });
    await expect(rows(page, key)).toHaveCount(200);

    await call(page, 'setQuery', key, { keyword: 'item-99' }, 0);
    await call(page, 'waitForIdle', key);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      count: 11,
      total: 11,
    });
    const ids = await call<string[]>(page, 'rowIds', key);
    expect(ids).toEqual(['99', '990', '991', '992', '993', '994', '995', '996', '997', '998', '999']);
  });

  test('后发 reset 胜出，旧请求晚返回不覆盖当前 DOM', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 40,
      pageSize: 20,
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key, { query: { keyword: 'item-1' } });
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'reset', key, { query: { keyword: 'item-2' } });
    await expect(rows(page, key)).toHaveCount(11);
    await expect(rows(page, key).first()).toHaveAttribute('data-id', '2');
    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    await expect(rows(page, key)).toHaveCount(11);
    await expect(rows(page, key).first()).toHaveAttribute('data-id', '2');
  });

  test('普通 reset 在飞期间的 upsert/patch/remove 在权威响应后仍保留最终本地语义', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 10,
      pageSize: 10,
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key, { pinEdge: false });
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'upsertLocal', key, {
      id: 'local-draft',
      label: 'local-draft-v1',
      order: 100,
    });
    expect(await call(page, 'patchLabel', key, 'local-draft', 'local-draft-v2')).toBe(true);
    await call(page, 'upsertLocal', key, {
      id: '1',
      label: 'optimistic-one',
      order: 1,
    });
    expect(await call(page, 'removeLocal', key, '1')).toBe(true);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loaded: false,
      count: 1,
    });

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    await expect(root(page, key).locator('[data-id="local-draft"] .bl-row-label'))
      .toContainText('local-draft-v2');
    await expect(root(page, key).locator('[data-id="1"]')).toHaveCount(0);
    const finalIds = await call<string[]>(page, 'rowIds', key);
    expect(finalIds.filter((id) => id === 'local-draft')).toEqual(['local-draft']);
  });

  test('upsertLocal、patch、removeLocal、render 与 pinnedItems 命令式接口', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 4,
      pageSize: 4,
      freshEdge: 'tail',
      pinnedItems: [],
      reachPx: -1,
    });
    await call(page, 'clearEvents', key);
    await call(page, 'upsertLocal', key, { id: '100', label: 'local', order: 100 });
    await expect(allParts(page, key).last()).toContainText('local');
    expect(await call(page, 'patchLabel', key, '1', 'patched')).toBe(true);
    expect(await call(page, 'patchLabel', key, 'missing', 'never')).toBe(false);
    await expect(root(page, key).locator('[data-id="1"]')).toContainText('patched');
    expect(await call(page, 'removeLocal', key, '2')).toBe(true);
    expect(await call(page, 'removeLocal', key, 'missing')).toBe(false);
    await expect(root(page, key).locator('[data-id="2"]')).toHaveCount(0);

    await call(page, 'setPinnedItems', key, [
      { id: 'pinned', label: 'pinned', order: -1 },
    ]);
    await call(page, 'render', key);
    await expect(rows(page, key).first()).toHaveAttribute('data-id', 'pinned');
    expect((await call<ListState>(page, 'state', key)).count).toBe(4);
    const changedPayloads = (await events(page, key))
      .filter((event) => event.type === 'onItemsChanged')
      .map((event) => event.payload as TestItem[]);
    expect(changedPayloads).toHaveLength(3);
    expect(changedPayloads[0].at(-1)).toEqual({ id: '100', label: 'local', order: 100 });
    expect(changedPayloads[1].find((item) => item.id === '1')).toEqual({
      id: '1',
      label: 'patched',
      order: 1,
    });
    expect(changedPayloads[2].some((item) => item.id === '2')).toBe(false);
  });

  test('重复 id 注册覆盖旧实例，广播只命中当前注册实例', async ({ page }) => {
    const first = await mount(page, {
      id: 'duplicate.registry',
      autoReset: false,
      reachPx: -1,
    });
    const second = await mount(page, {
      id: 'duplicate.registry',
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'invalidateAll');
    await call(page, 'frames', 2);
    await call(page, 'waitForIdle', second);
    expect(await call<unknown[]>(page, 'fetchCalls', first)).toHaveLength(0);
    expect(await call<unknown[]>(page, 'fetchCalls', second)).toHaveLength(1);

    await call(page, 'dispose', second);
    expect(await call<string[]>(page, 'registryIds')).not.toContain('duplicate.registry');
    await call(page, 'dispose', first);
  });

  test('dispose 幂等，隔离 pending 结果、取消防抖和后续 DOM apply，并清理资源', async ({ page }) => {
    await page.clock.install();
    const key = await mount(page, {
      id: 'bounded.dispose',
      itemCount: 20,
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    await page.clock.pauseAt(Date.now() + 1_000);
    await call(page, 'setQuery', key, { keyword: 'late' });
    const before = await root(page, key).locator('.bl-scroller').innerHTML();

    // 时钟暂停期间不能调用会等待 animation frame 的异步 dispose helper；
    // 本场景验证的是同步销毁立即取消 pending 与防抖，因此使用 disposeNow。
    await call(page, 'disposeNow', key);
    await call(page, 'disposeNow', key);
    await call(page, 'resolvePage', key);
    await page.clock.fastForward(500);
    await page.clock.resume();
    await call(page, 'waitForIdle', key);

    expect(await root(page, key).locator('.bl-scroller').innerHTML()).toBe(before);
    expect(await call<string[]>(page, 'registryIds')).not.toContain('bounded.dispose');
    expect(await call(page, 'pillInfo', key)).toMatchObject({ exists: false });
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toHaveLength(1);
    expect(await call(page, 'patchLabel', key, '1', 'ignored')).toBe(false);
    expect(await call(page, 'removeLocal', key, '1')).toBe(false);
    expect(await call(page, 'scrollToIdentity', key, '1')).toBe(false);
  });

  test('BL-BUG-001：localPageSource 并发 reset 的旧 loadAll 会污染新查询续翻缓存', async ({ page }) => {
    const key = await mount(page, {
      sourceKind: 'local',
      itemCount: 60,
      pageSize: 5,
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'pauseNextPage', key);
    await call(page, 'startReset', key, { query: { keyword: 'item-1' } });
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    await call(page, 'reset', key, { query: { keyword: 'item-2' } });
    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    await call(page, 'loadMore', key, 'forward');
    const labels = await rows(page, key).allTextContents();

    expect(labels.every((label) => label.includes('item-2'))).toBe(true);
  });

  test('BL-BUG-002：旧 fetchByIdentity 不应在后续 reset 后覆盖新窗口', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 10,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 100);
    await call(page, 'setItems', key, Array.from({ length: 20 }, (_, order) => ({
      id: String(order),
      label: order === 1 ? 'stale-refresh' : `item-${order}`,
      order,
    })));
    await call(page, 'pauseNextIdentity', key);
    await call(page, 'invalidate', key, { identities: ['1'] });
    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasIdentityGate', key)).toBe(true);

    await call(page, 'setItems', key, Array.from({ length: 20 }, (_, order) => ({
      id: String(order),
      label: order === 1 ? 'fresh-reset' : `item-${order}`,
      order,
    })));
    await call(page, 'reset', key);
    await call(page, 'resolveIdentity', key);
    await call(page, 'frames', 2);
    const rowText = await root(page, key).locator('[data-id="1"]').textContent();

    expect(rowText).toContain('fresh-reset');
  });

  test('BL-BUG-003：renderItem 多个平级元素应全部触发同一 identity 交互', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 3,
      renderParts: 2,
      reachPx: -1,
    });
    await call(page, 'clearEvents', key);
    await root(page, key).locator('.bl-row[data-id="1"][data-part="1"] .bl-row-label').click();

    expect((await events(page, key)).filter((event) => event.type === 'onActivate')).toEqual([
      {
        type: 'onActivate',
        payload: {
          item: { id: '1', label: 'item-1', order: 1 },
          eventType: 'click',
          keyboard: false,
        },
      },
    ]);
  });

  test('selection.store 与 selection.max 构造互斥，外部 store 自身上限生效', async ({ page }) => {
    await expect(mount(page, {
      itemCount: 3,
      selection: {
        mode: 'multi',
        max: 1,
        storeKey: 'unbounded-external-store',
      },
      reachPx: -1,
    })).rejects.toThrow(/selection\.store.*selection\.max/);

    const key = await mount(page, {
      itemCount: 3,
      selection: {
        mode: 'multi',
        storeKey: 'bounded-external-store',
        storeMax: 1,
      },
      reachPx: -1,
    });
    await root(page, key).locator('[data-id="0"]').click();
    await root(page, key).locator('[data-id="1"]').click();
    const selected = await root(page, key).locator('[data-id="1"]').getAttribute('data-selected');
    const exceedEvents = (await events(page, key)).filter((event) => event.type === 'onExceed');

    expect({ selected, exceedEvents }).toEqual({
      selected: 'false',
      exceedEvents: [{ type: 'onExceed', payload: null }],
    });
  });

  test('BL-BUG-005：键盘焦点在 prepend 后应按 identity 保持而不是按 index 漂移', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      initialStart: 5,
      pageSize: 5,
      reachPx: -1,
    });
    const scroller = root(page, key).locator('.bl-scroller');
    await scroller.focus();
    await scroller.press('ArrowDown');
    await scroller.press('ArrowDown');
    expect(await call<string[]>(page, 'focusedIds', key)).toEqual(['6']);
    await call(page, 'loadMore', key, 'backward');

    expect(await call<string[]>(page, 'focusedIds', key)).toEqual(['6']);
  });

  test('BL-BUG-006：未提供 updatePill 文案时不应显示空白提示条', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      text: { updatePill: false },
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 100);
    await call(page, 'invalidate', key, { count: 1 });
    await call(page, 'frames', 2);

    expect(await call(page, 'pillInfo', key)).toMatchObject({
      exists: true,
      visible: false,
      text: '',
    });
  });

  test('BL-BUG-007：分页参数非法值应在构造阶段快速失败', async ({ page }) => {
    const mounted: string[] = [];
    for (const config of [
      { pageSize: 0, maxPages: 2 },
      { pageSize: -1, maxPages: 2 },
      { pageSize: 1.5, maxPages: 2 },
      { pageSize: Number.NaN, maxPages: 2 },
      { pageSize: Number.POSITIVE_INFINITY, maxPages: 2 },
      { pageSize: 10, maxPages: 0 },
      { pageSize: 10, maxPages: -1 },
      { pageSize: 10, maxPages: 1.5 },
      { pageSize: 10, maxPages: Number.NaN },
      { pageSize: 10, maxPages: Number.POSITIVE_INFINITY },
    ]) {
      try {
        mounted.push(await mount(page, { ...config, autoReset: false }));
      } catch {
        // 期望路径：构造阶段明确拒绝。
      }
    }
    for (const key of mounted) await call(page, 'removeCase', key);

    expect(mounted).toHaveLength(0);
  });

  test('恶意 source 单页超过 limit 时进入失败态且不突破 pageSize×maxPages 预算', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 100,
      pageSize: 10,
      maxPages: 2,
      overflowPageBy: 50,
      reachPx: -1,
    });

    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loaded: true,
      failed: true,
      count: 0,
      total: -1,
    });
    await expect(rows(page, key)).toHaveCount(0);
    await expect(root(page, key).locator('.list-error-state')).toContainText('超过');
    expect((await events(page, key)).filter((event) => event.type === 'onError')).toEqual([
      {
        type: 'onError',
        payload: {
          error: {
            name: 'RangeError',
            message: 'PageSource 返回 60 条，超过本次 pageSize=10',
          },
          phase: 'reset',
        },
      },
    ]);
  });

  test('BL-BUG-009：tail 已贴底时内容 load 增高后仍应贴底', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 20,
      freshEdge: 'tail',
      settleFrames: 1,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 1_000_000);
    expect((await call<{ distanceToBottom: number }>(page, 'scrollMetrics', key)).distanceToBottom).toBe(0);
    await call(page, 'expandRow', key, '19', 300, true);
    await call(page, 'frames', 2);

    expect((await call<{ distanceToBottom: number }>(page, 'scrollMetrics', key)).distanceToBottom)
      .toBeLessThanOrEqual(1);
  });

  test('tail 从贴底滚离与内容 load 同帧发生时，以最新滚动意图为准且不重新贴底', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 20,
      freshEdge: 'tail',
      settleFrames: 1,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 1_000_000);
    expect((await call<{ distanceToBottom: number }>(page, 'scrollMetrics', key)).distanceToBottom).toBe(0);

    await call(page, 'scrollThenLoadSameFrame', key, 0, '19', 300);
    await call(page, 'frames', 2);
    expect((await call<{ scrollTop: number }>(page, 'scrollMetrics', key)).scrollTop).toBe(0);
  });

  test('staged reconcile 与定向刷新乱序并发时，旧窗口结果不会覆盖或丢失刷新结果', async ({ page }) => {
    const baseItems = Array.from({ length: 100 }, (_, order) => ({
      id: String(order),
      label: `item-${order}`,
      order,
    }));
    const refreshedItems = baseItems.map((item) => (
      item.id === '5' ? { ...item, label: 'refresh-during-reconcile' } : item
    ));
    const key = await mount(page, {
      items: baseItems,
      pageSize: 10,
      maxPages: 2,
      freshEdge: 'tail',
      settleFrames: 1,
      fetchByIdentity: true,
      reachPx: -1,
    });
    await call(page, 'loadMore', key, 'forward');
    await call(page, 'setScrollTop', key, 1_000_000);
    await dispatchScroll(page, key);
    await call(page, 'pauseNextPage', key);
    await call(page, 'upsertLocal', key, {
      id: 'capacity-live',
      label: 'capacity-live',
      order: 100,
    });
    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    await call(page, 'setScrollTop', key, 0);
    await dispatchScroll(page, key);
    await call(page, 'setItems', key, refreshedItems);
    await call(page, 'pauseNextIdentity', key);
    await call(page, 'invalidate', key, { identities: ['5'] });
    await call(page, 'frames', 2);
    expect(await call<boolean>(page, 'hasIdentityGate', key)).toBe(false);
    await call(page, 'setItems', key, baseItems);

    // 先让 staged page 读取旧快照，再把数据源切回刷新值；reconcile 落定后必须重发定向刷新。
    await page.evaluate(
      ({ caseKey, latestItems }) => {
        const harness = (window as unknown as {
          boundedListTestHarness: {
            resolvePage(key: string): void;
            setItems(key: string, items: readonly TestItem[]): void;
          };
        }).boundedListTestHarness;
        harness.resolvePage(caseKey);
        queueMicrotask(() => queueMicrotask(() => harness.setItems(caseKey, latestItems)));
      },
      { caseKey: key, latestItems: refreshedItems },
    );
    await expect.poll(() => call<boolean>(page, 'hasIdentityGate', key)).toBe(true);
    await call(page, 'resolveIdentity', key);
    await call(page, 'frames', 2);
    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      failed: false,
    });
    await expect.poll(
      () => root(page, key).locator('[data-id="5"] .bl-row-label').textContent(),
    ).toContain('refresh-during-reconcile');
  });

  test('pageSize=2/maxPages=1 裁剪后的 remove B 与重复 upsert C 在权威响应后保持最终语义', async ({ page }) => {
    const key = await mount(page, {
      items: [
        { id: 'A', label: 'A', order: 0 },
        { id: 'B', label: 'B', order: 1 },
      ],
      pageSize: 2,
      maxPages: 1,
      freshEdge: 'tail',
      settleFrames: 1,
      reachPx: -1,
    });
    await call(page, 'setScrollTop', key, 1_000_000);
    await dispatchScroll(page, key);
    await call(page, 'pauseNextPage', key);
    await call(page, 'upsertLocal', key, { id: 'C', label: 'C-v1', order: 2 });
    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);

    expect(await call(page, 'removeLocal', key, 'B')).toBe(true);
    await call(page, 'upsertLocal', key, { id: 'C', label: 'C-v2', order: 3 });
    await call(page, 'upsertLocal', key, { id: 'C', label: 'C-v3', order: 4 });
    await call(page, 'resolvePage', key);
    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      failed: false,
    });

    await expect(root(page, key).locator('[data-id="B"]')).toHaveCount(0);
    await expect(root(page, key).locator('[data-id="C"]')).toHaveCount(1);
    await expect(root(page, key).locator('[data-id="C"] .bl-row-label')).toContainText('C-v3');
    expect((await call<string[]>(page, 'rowIds', key)).filter((id) => id === 'C')).toEqual(['C']);
    expect((await call<ListState>(page, 'state', key)).count).toBeLessThanOrEqual(2);
  });

  test('tail reset(pinEdge=false) 形成远离尾部的真实几何后，无 scroll 事件的 upsert 不自动追平或贴底', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 100,
      pageSize: 20,
      maxPages: 1,
      freshEdge: 'tail',
      settleFrames: 1,
      autoReset: false,
      reachPx: -1,
    });
    await call(page, 'reset', key, { pinEdge: false });
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      count: 20,
      atFreshEdge: false,
    });
    expect((await call<{ scrollTop: number }>(page, 'scrollMetrics', key)).scrollTop).toBe(0);
    await call(page, 'clearFetchCalls', key);
    await call(page, 'pauseNextPage', key);

    // reset 后刻意不派发 scroll；组件必须读取当前几何，而不是沿用构造期 stick=true。
    await call(page, 'upsertLocal', key, {
      id: 'live-no-scroll',
      label: 'live-no-scroll',
      order: 100,
    });
    await call(page, 'frames', 2);
    expect(await call<boolean>(page, 'hasPageGate', key)).toBe(false);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toEqual([]);
    expect((await call<{ scrollTop: number }>(page, 'scrollMetrics', key)).scrollTop).toBe(0);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      stale: true,
      pendingCount: 1,
      atFreshEdge: false,
      count: 20,
    });
    expect(await call<string[]>(page, 'rowIds', key)).toContain('live-no-scroll');
  });

  test('live eviction 后旧端游标立即失效，自动/手动续翻都改走后台权威 reconcile', async ({ page }) => {
    const key = await mountFullTailWindow(page, 'old-edge');
    await call(page, 'upsertLocal', key, {
      id: 'live-old-edge',
      label: 'live-old-edge',
      order: 100,
    });
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      count: 20,
      hasMoreBefore: false,
    });
    expect(await call<string[]>(page, 'rowIds', key)).toContain('live-old-edge');

    // eviction 后 render 与真实触顶滚动都不得再携被裁窗口的旧 cursor=10 自动续翻。
    await call(page, 'render', key);
    await dispatchScroll(page, key);
    await call(page, 'frames', 2);
    expect(await call<unknown[]>(page, 'fetchCalls', key)).toEqual([]);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      stale: true,
      pendingCount: 1,
    });

    await call(page, 'pauseNextPage', key);
    await call(page, 'startLoadMore', key, 'backward');
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    expect(await call(page, 'fetchCalls', key)).toEqual([
      {
        backward: false,
        limit: 10,
        query: { keyword: '' },
        phase: 'reset',
      },
    ]);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loading: true,
      count: 20,
      hasMoreBefore: false,
    });

    await call(page, 'resolvePage', key);
    await call(page, 'waitForIdle', key);
    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      failed: false,
    });
  });

  test('staged reconcile 在飞时保留 capped DOM，并在响应后重放期间新增的 live 条目', async ({ page }) => {
    const key = await mountFullTailWindow(page, 'fresh-edge');
    await call(page, 'pauseNextPage', key);
    await call(page, 'upsertLocal', key, {
      id: 'live-before-reconcile',
      label: 'live-before-reconcile',
      order: 100,
    });
    const cappedIds = await call<string[]>(page, 'rowIds', key);
    expect(cappedIds).toHaveLength(20);
    expect(cappedIds).toContain('live-before-reconcile');

    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    expect(await call<ListState>(page, 'state', key)).toMatchObject({
      loading: true,
      count: 20,
    });
    expect(await call<string[]>(page, 'rowIds', key)).toEqual(cappedIds);

    await call(page, 'upsertLocal', key, {
      id: 'live-during-reconcile',
      label: 'live-during-reconcile',
      order: 101,
    });
    expect(await call<ListState>(page, 'state', key)).toMatchObject({ count: 20 });
    expect(await call<string[]>(page, 'rowIds', key)).toContain('live-during-reconcile');

    await call(page, 'resolvePage', key);
    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      failed: false,
    });
    const reconciledIds = await call<string[]>(page, 'rowIds', key);
    expect(reconciledIds).toContain('live-during-reconcile');
    expect(reconciledIds.length).toBeLessThanOrEqual(20);
  });

  test('staged reconcile 失败时保留 capped rows，并通过 failed/retry 完成恢复', async ({ page }) => {
    const key = await mountFullTailWindow(page, 'fresh-edge');
    await call(page, 'pauseNextPage', key);
    await call(page, 'failNext', key, 'reset');
    await call(page, 'upsertLocal', key, {
      id: 'live-reconcile-failure',
      label: 'live-reconcile-failure',
      order: 100,
    });
    const cappedIds = await call<string[]>(page, 'rowIds', key);
    expect(cappedIds).toHaveLength(20);

    await call(page, 'frames', 2);
    await expect.poll(() => call<boolean>(page, 'hasPageGate', key)).toBe(true);
    expect(await call<string[]>(page, 'rowIds', key)).toEqual(cappedIds);
    await call(page, 'resolvePage', key);

    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      failed: true,
      stale: true,
      count: 20,
    });
    expect(await call<string[]>(page, 'rowIds', key)).toEqual(cappedIds);
    expect(await call(page, 'pillInfo', key)).toMatchObject({
      visible: true,
      text: '重新加载',
    });
    expect((await events(page, key)).filter((event) => event.type === 'onError')).toEqual([
      {
        type: 'onError',
        payload: {
          error: { name: 'Error', message: 'reset-failure' },
          phase: 'reset',
        },
      },
    ]);

    await call(page, 'clickPill', key);
    await expect.poll(() => call<ListState>(page, 'state', key)).toMatchObject({
      loading: false,
      failed: false,
    });
    expect(await call(page, 'pillInfo', key)).toMatchObject({ visible: false });
  });

  test('BL-BUG-010：upsertLocal 同 identity 应替换而不是产生重复 DOM', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 3,
      pageSize: 3,
      maxPages: 2,
      freshEdge: 'tail',
      reachPx: -1,
    });
    await call(page, 'upsertLocal', key, { id: '1', label: 'new-item-1', order: 100 });
    const ids = await call<string[]>(page, 'rowIds', key);
    const labels = await root(page, key).locator('[data-id="1"] .bl-row-label').allTextContents();

    expect({
      matchingIds: ids.filter((id) => id === '1'),
      labels,
    }).toEqual({
      matchingIds: ['1'],
      labels: ['new-item-1#0'],
    });
  });

  test('BL-BUG-011：dispose 应取消 reset 尚未完成的贴边 rAF', async ({ page }) => {
    const key = await mount(page, {
      itemCount: 20,
      pageSize: 20,
      freshEdge: 'tail',
      settleFrames: 4,
      reachPx: -1,
      autoReset: false,
    });
    const dimensions = await call<{ scrollHeight: number; clientHeight: number }>(
      page,
      'resetAndDisposeBeforeFrame',
      key,
    );
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    await call(page, 'frames', 5);
    const metrics = await call<{ scrollTop: number }>(page, 'scrollMetrics', key);

    expect(metrics.scrollTop).toBe(0);
  });
});
