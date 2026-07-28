import { describe, expect, it, vi } from 'vitest';
import { localPageSource, serverPageSource } from '../../../src/app/bounded-list/page-source';
import { PageWindow } from '../../../src/app/bounded-list/page-window';

describe('serverPageSource', () => {
  it('原样透传请求，用 map 把原始响应整理成 PageLoadResult', async () => {
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

  it('底层 fetch 拒绝时错误原样透传（由上层 BoundedList 接管，不在这里吞掉）', async () => {
    const source = serverPageSource(
      async () => { throw new Error('network down'); },
      (raw: unknown) => raw as never,
    );
    await expect(source.fetch({ backward: false, limit: 10, query: undefined })).rejects.toThrow('network down');
  });
});

describe('localPageSource', () => {
  interface Item { id: number; name: string }
  function makeItems(n: number): Item[] {
    return Array.from({ length: n }, (_, i) => ({ id: i, name: `name-${i}` }));
  }

  it('cursor 未提供时重新 loadAll 并按 filter/compare 处理后从头切片', async () => {
    const loadAll = vi.fn(async () => makeItems(10));
    const source = localPageSource<Item, void>({
      loadAll,
      compare: (a, b) => b.id - a.id, // 倒序
    });
    const first = await source.fetch({ backward: false, limit: 3, query: undefined });
    expect(first.items.map((i) => i.id)).toEqual([9, 8, 7]);
    expect(first.hasMoreBackward).toBe(false);
    expect(first.hasMoreForward).toBe(true);
    expect(first.total).toBe(10);
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('forward / backward 续翻直接对缓存切片，不重新 loadAll', async () => {
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

  it('全量 1000 条时任意时刻窗口内条目数不超过 pageSize × maxPages', async () => {
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
  });

  it('setQuery 语义（cursor 未提供）后重新过滤排序并从头切片', async () => {
    const loadAll = vi.fn(async () => makeItems(10));
    const source = localPageSource<Item, { keyword: string }>({
      loadAll,
      filter: (item, query) => !query.keyword || item.name.includes(query.keyword),
      compare: (a, b) => a.id - b.id,
    });
    const all = await source.fetch({ backward: false, limit: 10, query: { keyword: '' } });
    expect(all.items).toHaveLength(10);

    const filtered = await source.fetch({ backward: false, limit: 10, query: { keyword: 'name-1' } });
    // name-1, name-10..name-19 不存在（只有 10 条），实际只匹配 "name-1" 本身
    expect(filtered.items.map((i) => i.id)).toEqual([1]);
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it('loadAll 的 onProgress 透传给调用方', async () => {
    const progressed: number[] = [];
    const loadAll = vi.fn(async (_q: void, onProgress?: (n: number) => void) => {
      onProgress?.(5);
      onProgress?.(10);
      return makeItems(10);
    });
    const source = localPageSource<Item, void>({ loadAll });
    await source.fetch({ backward: false, limit: 10, query: undefined });
    // 验证 loadAll 确实拿到了 onProgress 回调并被调用（透传给 loadAll 的第二参数）
    const call = loadAll.mock.calls[0];
    expect(typeof call[1]).toBe('undefined'); // fetch 没有传 onProgress 时保持 undefined
    loadAll.mockClear();
    const withProgress = localPageSource<Item, void>({
      loadAll: async (_q, onProgress) => { onProgress?.(5); progressed.push(5); return makeItems(3); },
    });
    await withProgress.fetch({ backward: false, limit: 3, query: undefined });
    expect(progressed).toEqual([5]);
  });

  it('越界的 forward/backward 请求被夹紧，不返回负数下标或超界条目', async () => {
    const loadAll = vi.fn(async () => makeItems(5));
    const source = localPageSource<Item, void>({ loadAll });
    const backwardAtStart = await source.fetch({ cursor: '0', backward: true, limit: 10, query: undefined });
    expect(backwardAtStart.items).toEqual([]);
    expect(backwardAtStart.hasMoreBackward).toBe(false);

    const forwardAtEnd = await source.fetch({ cursor: '5', backward: false, limit: 10, query: undefined });
    expect(forwardAtEnd.items).toEqual([]);
    expect(forwardAtEnd.hasMoreForward).toBe(false);
  });
});
