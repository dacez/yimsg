// PageSource（数据源层）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.2：
//   A serverPageSource 透传 / B localPageSource 切片 / C 边界与非法输入 / D 大数据量。

import { describe, expect, it, vi } from 'vitest';
import { localPageSource, serverPageSource } from '../../../src/app/bounded-list/page-source';
import { PageWindow } from '../../../src/app/bounded-list/page-window';

interface Item { id: number; name: string }
function makeItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `name-${i}` }));
}

// ───────────────────────── A serverPageSource ─────────────────────────

describe('PageSource / A serverPageSource', () => {
  it('A1 原样透传请求，用 map 把原始响应整理成 PageLoadResult', async () => {
    const fetchRaw = vi.fn(async (req: { cursor?: string; backward: boolean; limit: number; query: { keyword: string } }) => ({
      contacts: [1, 2],
      page: { start: 's', end: 'e', more_backward: false, more_forward: true },
      raw: req,
    }));
    const source = serverPageSource(fetchRaw, (raw) => ({
      items: raw.contacts,
      startCursor: raw.page.start,
      endCursor: raw.page.end,
      hasMoreBackward: raw.page.more_backward,
      hasMoreForward: raw.page.more_forward,
    }));

    const result = await source.fetch({ cursor: 'c1', backward: true, limit: 40, query: { keyword: 'a' } });
    expect(result.items).toEqual([1, 2]);
    expect(result.startCursor).toBe('s');
    expect(result.hasMoreForward).toBe(true);
    expect(fetchRaw).toHaveBeenCalledWith({ cursor: 'c1', backward: true, limit: 40, query: { keyword: 'a' } });
  });

  it('A2 reset 语义（cursor 未提供）原样透传为 undefined，不被替换成空串', async () => {
    const fetchRaw = vi.fn(async () => ({ items: [] as number[] }));
    const source = serverPageSource(fetchRaw, () => ({
      items: [], startCursor: '', endCursor: '', hasMoreBackward: false, hasMoreForward: false,
    }));
    await source.fetch({ backward: false, limit: 10, query: undefined });
    expect(fetchRaw.mock.calls[0][0]).toEqual({ cursor: undefined, backward: false, limit: 10, query: undefined });
  });

  it('A3 游标是不透明字符串：任意内容都原样透传，不解析、不构造', async () => {
    const opaque = 'eyJzZXEiOjEyMzQ1Njc4OTAsInVpZCI6Ijk5OSJ9==';
    const fetchRaw = vi.fn(async () => ({}));
    const source = serverPageSource(fetchRaw, () => ({
      items: [], startCursor: opaque, endCursor: opaque, hasMoreBackward: false, hasMoreForward: false,
    }));
    const page = await source.fetch({ cursor: opaque, backward: false, limit: 1, query: undefined });
    expect((fetchRaw.mock.calls[0][0] as { cursor?: string }).cursor).toBe(opaque);
    expect(page.startCursor).toBe(opaque);
  });

  it('A4 底层 fetch 拒绝时错误原样透传（由上层 BoundedList 接管，不在这里吞掉）', async () => {
    const source = serverPageSource(
      async () => { throw new Error('network down'); },
      (raw: unknown) => raw as never,
    );
    await expect(source.fetch({ backward: false, limit: 10, query: undefined })).rejects.toThrow('network down');
  });

  it('A5 map 自身抛错同样原样透传（响应结构不符合预期时不静默吞掉）', async () => {
    const source = serverPageSource(
      async () => ({ broken: true }),
      () => { throw new TypeError('bad shape'); },
    );
    await expect(source.fetch({ backward: false, limit: 10, query: undefined })).rejects.toThrow(TypeError);
  });

  it('A6 map 可以在整理阶段做过滤（组织类联系人不作为会话目标），组件不感知', async () => {
    const source = serverPageSource(
      async () => ({ contacts: [{ id: 1, org: false }, { id: 2, org: true }, { id: 3, org: false }] }),
      (raw) => ({
        items: raw.contacts.filter((c) => !c.org),
        startCursor: 's', endCursor: 'e', hasMoreBackward: false, hasMoreForward: false,
      }),
    );
    const page = await source.fetch({ backward: false, limit: 10, query: undefined });
    expect(page.items.map((c) => c.id)).toEqual([1, 3]);
  });
});

// ───────────────────────── B localPageSource ─────────────────────────

describe('PageSource / B localPageSource', () => {
  it('B1 cursor 未提供时重新 loadAll 并按 filter/compare 处理后从头切片', async () => {
    const loadAll = vi.fn(async () => makeItems(10));
    const source = localPageSource<Item, void>({ loadAll, compare: (a, b) => b.id - a.id });
    const first = await source.fetch({ backward: false, limit: 3, query: undefined });
    expect(first.items.map((i) => i.id)).toEqual([9, 8, 7]);
    expect(first.startCursor).toBe('0');
    expect(first.endCursor).toBe('3');
    expect(first.hasMoreBackward).toBe(false);
    expect(first.hasMoreForward).toBe(true);
    expect(first.total).toBe(10);
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('B2 forward / backward 续翻直接对缓存切片，不重新 loadAll', async () => {
    const loadAll = vi.fn(async () => makeItems(10));
    const source = localPageSource<Item, void>({ loadAll });
    const first = await source.fetch({ backward: false, limit: 4, query: undefined });
    expect(first.items.map((i) => i.id)).toEqual([0, 1, 2, 3]);

    const forward = await source.fetch({ cursor: first.endCursor, backward: false, limit: 4, query: undefined });
    expect(forward.items.map((i) => i.id)).toEqual([4, 5, 6, 7]);
    expect(forward.hasMoreForward).toBe(true);

    const backward = await source.fetch({ cursor: forward.startCursor, backward: true, limit: 4, query: undefined });
    expect(backward.items.map((i) => i.id)).toEqual([0, 1, 2, 3]);
    expect(backward.hasMoreBackward).toBe(false);

    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('B3 setQuery 语义（cursor 未提供）后重新过滤排序并从头切片', async () => {
    const loadAll = vi.fn(async () => makeItems(10));
    const source = localPageSource<Item, { keyword: string }>({
      loadAll,
      filter: (item, query) => !query.keyword || item.name.includes(query.keyword),
      compare: (a, b) => a.id - b.id,
    });
    const all = await source.fetch({ backward: false, limit: 10, query: { keyword: '' } });
    expect(all.items).toHaveLength(10);

    const filtered = await source.fetch({ backward: false, limit: 10, query: { keyword: 'name-1' } });
    expect(filtered.items.map((i) => i.id)).toEqual([1]);
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it('B4 filter 把全部条目过滤掉时返回空页且 total=0', async () => {
    const source = localPageSource<Item, { keyword: string }>({
      loadAll: async () => makeItems(50),
      filter: (item, q) => item.name === q.keyword,
    });
    const page = await source.fetch({ backward: false, limit: 10, query: { keyword: '不存在' } });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMoreBackward).toBe(false);
    expect(page.hasMoreForward).toBe(false);
  });

  it('B5 compare 不污染 loadAll 返回的原数组（排序作用在副本上）', async () => {
    const original = makeItems(5);
    const source = localPageSource<Item, void>({ loadAll: async () => original, compare: (a, b) => b.id - a.id });
    await source.fetch({ backward: false, limit: 5, query: undefined });
    expect(original.map((i) => i.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('B6 无 filter 时同样对副本切片，loadAll 数组的后续原地修改不影响已缓存快照', async () => {
    const original = makeItems(3);
    const source = localPageSource<Item, void>({ loadAll: async () => original });
    await source.fetch({ backward: false, limit: 3, query: undefined });
    original.push({ id: 99, name: 'late' });
    const again = await source.fetch({ cursor: '0', backward: false, limit: 10, query: undefined });
    expect(again.items.map((i) => i.id)).toEqual([0, 1, 2]);
  });

  it('B7 loadAll 抛错时原样透传（上层按 reset 失败处理）', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => { throw new Error('全量拉取失败'); } });
    await expect(source.fetch({ backward: false, limit: 10, query: undefined })).rejects.toThrow('全量拉取失败');
  });

  it('B10 续翻（走缓存切片）不重新 loadAll', async () => {
    const loadAll = vi.fn(async () => makeItems(10));
    const source = localPageSource<Item, void>({ loadAll });
    await source.fetch({ backward: false, limit: 4, query: undefined });
    await source.fetch({ cursor: '4', backward: false, limit: 4, query: undefined });
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('B11 并发 reset 乱序返回时旧结果不污染最新查询的续翻缓存', async () => {
    type Query = { keyword: 'old' | 'new' };
    const resolvers = new Map<Query['keyword'], { resolve(items: Item[]): void }>();
    const source = localPageSource<Item, Query>({
      loadAll: (query) => new Promise<Item[]>((resolve) => {
        resolvers.set(query.keyword, { resolve });
      }),
    });

    const oldReset = source.fetch({ backward: false, limit: 2, query: { keyword: 'old' } });
    const newReset = source.fetch({ backward: false, limit: 2, query: { keyword: 'new' } });

    resolvers.get('new')!.resolve([
      { id: 20, name: 'new-20' },
      { id: 21, name: 'new-21' },
      { id: 22, name: 'new-22' },
      { id: 23, name: 'new-23' },
    ]);
    const latest = await newReset;
    resolvers.get('old')!.resolve([
      { id: 10, name: 'old-10' },
      { id: 11, name: 'old-11' },
      { id: 12, name: 'old-12' },
    ]);
    await oldReset;

    const continued = await source.fetch({
      cursor: latest.endCursor,
      backward: false,
      limit: 2,
      query: { keyword: 'new' },
    });
    expect(continued.items.map((item) => item.id)).toEqual([22, 23]);
  });
});

// ───────────────────────── C 边界与非法输入 ─────────────────────────

describe('PageSource / C localPageSource 边界与非法输入', () => {
  it('C1 越界的 forward/backward 请求被夹紧，不返回负数下标或超界条目', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(5) });
    await source.fetch({ backward: false, limit: 5, query: undefined });

    const backwardAtStart = await source.fetch({ cursor: '0', backward: true, limit: 10, query: undefined });
    expect(backwardAtStart.items).toEqual([]);
    expect(backwardAtStart.startCursor).toBe('0');
    expect(backwardAtStart.endCursor).toBe('0');
    expect(backwardAtStart.hasMoreBackward).toBe(false);

    const forwardAtEnd = await source.fetch({ cursor: '5', backward: false, limit: 10, query: undefined });
    expect(forwardAtEnd.items).toEqual([]);
    expect(forwardAtEnd.hasMoreForward).toBe(false);
  });

  it('C2 远超集合长度的游标被夹紧到末尾，不抛错', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(5) });
    await source.fetch({ backward: false, limit: 5, query: undefined });
    const far = await source.fetch({ cursor: '999999', backward: false, limit: 10, query: undefined });
    expect(far.items).toEqual([]);
    expect(far.startCursor).toBe('5');
    expect(far.endCursor).toBe('5');
  });

  it('C3 负游标两端都被夹紧到 0，得到 [0,0) 空区间（不会产生负下标切片）', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(5) });
    await source.fetch({ backward: false, limit: 5, query: undefined });

    const negForward = await source.fetch({ cursor: '-42', backward: false, limit: 3, query: undefined });
    expect(negForward.items).toEqual([]);
    expect(negForward.startCursor).toBe('0');
    expect(negForward.endCursor).toBe('0');
    // 注意：夹紧后区间为空，但 hasMoreForward 仍按「0 < 5」为真——
    // 这与「空页应当收敛该端 hasMore」的直觉相反，属于 BL-BUG-01 那一类风险的诱因之一。
    expect(negForward.hasMoreForward).toBe(true);

    const negBackward = await source.fetch({ cursor: '-42', backward: true, limit: 3, query: undefined });
    expect(negBackward.items).toEqual([]);
    expect(negBackward.hasMoreBackward).toBe(false);
  });

  it('C4 limit=0 返回空页，游标退化为同一位置的空区间', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(5) });
    const first = await source.fetch({ backward: false, limit: 0, query: undefined });
    expect(first.items).toEqual([]);
    expect(first.startCursor).toBe('0');
    expect(first.endCursor).toBe('0');
    expect(first.hasMoreForward).toBe(true);

    const mid = await source.fetch({ cursor: '2', backward: false, limit: 0, query: undefined });
    expect(mid.items).toEqual([]);
    expect(mid.startCursor).toBe('2');
    expect(mid.hasMoreBackward).toBe(true);
  });

  it('C5 空集合上的任意请求都返回空页且两端都没有更多', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => [] });
    const first = await source.fetch({ backward: false, limit: 10, query: undefined });
    expect(first).toEqual({ items: [], startCursor: '0', endCursor: '0', hasMoreBackward: false, hasMoreForward: false, total: 0 });
    const next = await source.fetch({ cursor: '0', backward: false, limit: 10, query: undefined });
    expect(next.items).toEqual([]);
  });

  it('C6 backward 请求的 limit 超过剩余条目时从 0 起切，而不是产生负区间', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(10) });
    await source.fetch({ backward: false, limit: 10, query: undefined });
    const page = await source.fetch({ cursor: '3', backward: true, limit: 100, query: undefined });
    expect(page.items.map((i) => i.id)).toEqual([0, 1, 2]);
    expect(page.startCursor).toBe('0');
    expect(page.endCursor).toBe('3');
    expect(page.hasMoreBackward).toBe(false);
  });

  it('C8 非法游标（无法解析成有限数）按 0 处理，绝不产出 "NaN" 这种再也翻不动的游标', async () => {
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(5) });
    await source.fetch({ backward: false, limit: 5, query: undefined });

    for (const bad of ['not-a-number', '', 'Infinity', '1e', 'NaN']) {
      const forward = await source.fetch({ cursor: bad, backward: false, limit: 2, query: undefined });
      expect(forward.items.map((i) => i.id)).toEqual([0, 1]);
      expect(forward.startCursor).toBe('0');
      expect(forward.endCursor).toBe('2');

      const backward = await source.fetch({ cursor: bad, backward: true, limit: 2, query: undefined });
      expect(backward.items).toEqual([]);
      expect(backward.startCursor).toBe('0');
      expect(backward.hasMoreBackward).toBe(false);
    }
  });

  it('C7 reload 之后旧下标游标不再指向同一条目，但仍被夹紧到合法区间（不越界、不抛错）', async () => {
    let size = 100;
    const source = localPageSource<Item, void>({ loadAll: async () => makeItems(size) });
    await source.fetch({ backward: false, limit: 10, query: undefined });
    size = 3;
    await source.fetch({ backward: false, limit: 10, query: undefined }); // 重新 loadAll，只剩 3 条
    const stale = await source.fetch({ cursor: '90', backward: false, limit: 10, query: undefined });
    expect(stale.items).toEqual([]);
    expect(stale.startCursor).toBe('3');
    expect(stale.hasMoreForward).toBe(false);
  });
});

// ───────────────────────── D 大数据量 ─────────────────────────

describe('PageSource / D 大数据量', () => {
  it('D1 全量 1000 条时任意时刻窗口内条目数不超过 pageSize × maxPages', async () => {
    const loadAll = vi.fn(async () => makeItems(1000));
    const source = localPageSource<Item, void>({ loadAll });
    const maxPages = 5;
    const pageSize = 40;
    const window = new PageWindow<Item>(maxPages, undefined, (item) => String(item.id));

    window.setInitial(await source.fetch({ backward: false, limit: pageSize, query: undefined }));
    for (let i = 0; i < 30; i++) {
      const page = await source.fetch({ cursor: window.forwardCursor, backward: false, limit: pageSize, query: undefined });
      if (page.items.length === 0) break;
      window.appendForward(page);
      expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
    }
    expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('D2 全量 50000 条 + 拼音式 compare：一次 loadAll 之后翻遍全集只切片，窗口恒有界', async () => {
    const size = 50000;
    const loadAll = vi.fn(async () => Array.from({ length: size }, (_, i) => ({ id: i, name: `u-${(size - i).toString().padStart(6, '0')}` })));
    const source = localPageSource<Item, void>({ loadAll, compare: (a, b) => a.name.localeCompare(b.name) });
    const pageSize = 40;
    const maxPages = 5;
    const window = new PageWindow<Item>(maxPages, undefined, (item) => String(item.id));
    window.setInitial(await source.fetch({ backward: false, limit: pageSize, query: undefined }));

    let pages = 1;
    for (;;) {
      const page = await source.fetch({ cursor: window.forwardCursor, backward: false, limit: pageSize, query: undefined });
      if (page.items.length === 0) break;
      window.appendForward(page);
      pages++;
      expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
    }
    expect(pages).toBe(Math.ceil(size / pageSize));
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(window.hasMoreAfter).toBe(false);
    // 排序按 name 倒序号，因此最后一页的最后一条应该是 id=0（name 最大）。
    expect(window.items[window.count - 1].id).toBe(0);
  });

  it('D3 关键字过滤命中率极低（50000 选 1）时仍只切一页', async () => {
    const source = localPageSource<Item, { keyword: string }>({
      loadAll: async () => makeItems(50000),
      filter: (item, q) => item.name === q.keyword,
    });
    const page = await source.fetch({ backward: false, limit: 40, query: { keyword: 'name-49999' } });
    expect(page.items.map((i) => i.id)).toEqual([49999]);
    expect(page.total).toBe(1);
    expect(page.hasMoreForward).toBe(false);
  });
});
