import { describe, expect, it, vi } from 'vitest';
import { runIncrementalSync, runPersistentTableSync, type SyncPage } from '../../../src/sdk/datagateway/sync-loop';

/** 构造一页结果：cursorSeq 默认取本页最大 seq（空页为 0）。 */
function page<T extends { seq: number }>(items: T[], hasMore: boolean, cursorSeq?: number): SyncPage<T> {
  const maxSeq = items.length === 0 ? 0 : Math.max(...items.map(item => item.seq));
  return { items, hasMore, cursorSeq: cursorSeq ?? maxSeq };
}

describe('runIncrementalSync', () => {
  it('按服务端 has_more / cursor_seq 分批同步并报告 changed', async () => {
    const onBatch = vi.fn();
    const result = await runIncrementalSync({
      initialCursor: 0,
      pageSize: 2,
      getBatch: async (cursor) => (cursor === 0
        ? page([{ seq: 1 }, { seq: 2 }], true)
        : page([{ seq: 3 }], false)),
      onBatch,
    });

    expect(result).toBe('changed');
    expect(onBatch).toHaveBeenNthCalledWith(1, [{ seq: 1 }, { seq: 2 }]);
    expect(onBatch).toHaveBeenNthCalledWith(2, [{ seq: 3 }]);
  });

  it('遇到 seq_too_old 时停止后续批次', async () => {
    const onBatch = vi.fn();
    const result = await runIncrementalSync({
      initialCursor: 10,
      pageSize: 2,
      getBatch: async () => ({ items: [], hasMore: false, cursorSeq: 0, error: 'seq_too_old' }),
      onBatch,
    });

    expect(result).toBe('seq_too_old');
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('批处理回调失败时传播异常', async () => {
    await expect(runIncrementalSync({
      initialCursor: 0,
      pageSize: 2,
      getBatch: async () => page([{ seq: 1 }], false),
      onBatch: async () => {
        throw new Error('batch failed');
      },
    })).rejects.toThrow('batch failed');
  });

  it('拒绝负数游标', async () => {
    await expect(runIncrementalSync({
      initialCursor: -1,
      pageSize: 2,
      getBatch: async () => page([], false),
    })).rejects.toThrow('initialCursor');
  });

  it('拒绝不递增的同步游标', async () => {
    await expect(runIncrementalSync({
      initialCursor: 1,
      pageSize: 2,
      // has_more=true 但 cursor_seq 未前进，应抛出。
      getBatch: async () => page([{ seq: 1 }], true, 1),
    })).rejects.toThrow('sync cursor');
  });
});

describe('runPersistentTableSync', () => {
  it('遇到 seq_too_old 时重置游标并从 0 继续同步', async () => {
    const onReset = vi.fn();
    const seen: number[][] = [];
    const calls: Array<[number, boolean]> = [];
    const result = await runPersistentTableSync({
      initialCursor: 10,
      pageSize: 100,
      getBatch: async (cursor, _limit, rebuild) => {
        calls.push([cursor, rebuild]);
        return cursor === 10
          ? { items: [], hasMore: false, cursorSeq: 0, error: 'seq_too_old' }
          : page([{ seq: 50 }], false);
      },
      onReset,
      onBatch: items => {
        seen.push(items.map(item => item.seq));
      },
    });

    expect(result).toBe('changed');
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([[10, false], [0, true]]);
    expect(seen).toEqual([[50]]);
  });

  it('初始游标为 0 时直接进入 rebuild 并持续到重建结束', async () => {
    const calls: Array<[number, boolean]> = [];
    const result = await runPersistentTableSync({
      initialCursor: 0,
      pageSize: 2,
      getBatch: async (cursor, _limit, rebuild) => {
        calls.push([cursor, rebuild]);
        if (cursor === 0) return page([{ seq: 1 }, { seq: 2 }], true);
        return page([{ seq: 3 }], false);
      },
    });

    expect(result).toBe('changed');
    expect(calls).toEqual([[0, true], [2, true]]);
  });

  it('大批量边界按服务端 has_more 继续拉取直到 has_more=false', async () => {
    const seen: number[][] = [];
    const pages = new Map<number, SyncPage<{ seq: number }>>([
      [0, page(Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 })), true)],
      [100, page(Array.from({ length: 100 }, (_, i) => ({ seq: i + 101 })), false)],
    ]);

    const result = await runPersistentTableSync({
      initialCursor: 0,
      pageSize: 100,
      getBatch: async cursor => pages.get(cursor) ?? page([], false),
      onBatch: items => {
        seen.push(items.map(item => item.seq));
      },
    });

    expect(result).toBe('changed');
    expect(seen).toHaveLength(2);
    expect(seen[0][0]).toBe(1);
    expect(seen[1][99]).toBe(200);
  });
});
