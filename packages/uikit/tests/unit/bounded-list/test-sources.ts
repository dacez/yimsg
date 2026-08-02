// bounded-list 集成测试共用的测试数据源：模拟服务端 keyset 游标分页（数组 + 下标游标），
// 以及可手动控制 resolve/reject 时机的数据源（用于并发/错误处理的精确断言）。

import type { FetchPageRequest, PageLoadResult, PageSource } from '../../../src/app/bounded-list/types';

export interface TestItem {
  readonly id: number;
  readonly label: string;
}

export function makeTestItems(n: number, offset = 0): TestItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: offset + i, label: `item-${offset + i}` }));
}

export const idOf = (item: TestItem): string => String(item.id);

/**
 * 每次 fetch 都读取 getAll() 当前值（不缓存），模拟「服务端数据会变」的场景——
 * 测试可以直接修改传入的数组来模拟服务端增删，配合 fetchByIdentity / invalidate 断言。
 */
export function createInstantSource(getAll: () => TestItem[], opts?: { withTotal?: boolean }): PageSource<TestItem, void> {
  return {
    async fetch(req: FetchPageRequest<void>): Promise<PageLoadResult<TestItem>> {
      const all = getAll();
      if (req.cursor === undefined) {
        const items = all.slice(0, req.limit);
        return {
          items,
          startCursor: '0',
          endCursor: String(items.length),
          hasMoreHead: false,
          hasMoreTail: items.length < all.length,
          total: opts?.withTotal ? all.length : undefined,
        };
      }
      const cursor = Number(req.cursor);
      if (req.backward) {
        const start = Math.max(0, cursor - req.limit);
        const items = all.slice(start, cursor);
        return { items, startCursor: String(start), endCursor: String(cursor), hasMoreHead: start > 0, hasMoreTail: cursor < all.length };
      }
      const end = Math.min(all.length, cursor + req.limit);
      const items = all.slice(cursor, end);
      return { items, startCursor: String(cursor), endCursor: String(end), hasMoreHead: cursor > 0, hasMoreTail: end < all.length };
    },
  };
}

/**
 * 以「窗口中部」为起点的数据源：首页从 anchor 处切，两端都还有更多。
 * 用于双向续翻、双向裁剪、以及 around 锚点加载的场景。
 */
export function createAnchoredSource(getAll: () => TestItem[], anchorIndex: number): PageSource<TestItem, void> {
  return {
    async fetch(req: FetchPageRequest<void>): Promise<PageLoadResult<TestItem>> {
      const all = getAll();
      const clamp = (n: number) => Math.max(0, Math.min(n, all.length));
      let start: number;
      let end: number;
      if (req.cursor === undefined) {
        start = clamp(anchorIndex);
        end = clamp(anchorIndex + req.limit);
      } else if (req.backward) {
        end = clamp(Number(req.cursor));
        start = clamp(end - req.limit);
      } else {
        start = clamp(Number(req.cursor));
        end = clamp(start + req.limit);
      }
      return {
        items: all.slice(start, end),
        startCursor: String(start),
        endCursor: String(end),
        hasMoreHead: start > 0,
        hasMoreTail: end < all.length,
      };
    },
  };
}

/**
 * 「乐观 hasMore」数据源：满页时先乐观认为可能还有更多（真实 keyset 分页在拿到一整页
 * 之前无法确定是否已到末尾），只有真正拿到一页空结果才收敛为 false。
 * 用于覆盖「触界续翻拿到空页」这条路径。
 */
export function createOptimisticSource(getAll: () => TestItem[]): PageSource<TestItem, void> {
  return {
    async fetch(req: FetchPageRequest<void>): Promise<PageLoadResult<TestItem>> {
      const all = getAll();
      const cursor = req.cursor === undefined ? 0 : Number(req.cursor);
      const end = Math.min(all.length, cursor + req.limit);
      const page = all.slice(cursor, end);
      return {
        items: page,
        startCursor: String(cursor),
        endCursor: String(end),
        hasMoreHead: cursor > 0,
        hasMoreTail: page.length === req.limit,
      };
    },
  };
}

export interface PendingFetch<T, Q> {
  readonly req: FetchPageRequest<Q>;
  resolve: (page: PageLoadResult<T>) => void;
  reject: (err: unknown) => void;
}

/** 手动控制 resolve/reject 时机的数据源：用于精确断言并发丢弃、错误处理路径。 */
export function createControllableSource<T, Q = void>(): { source: PageSource<T, Q>; pending: PendingFetch<T, Q>[] } {
  const pending: PendingFetch<T, Q>[] = [];
  const source: PageSource<T, Q> = {
    fetch(req: FetchPageRequest<Q>): Promise<PageLoadResult<T>> {
      return new Promise((resolve, reject) => {
        pending.push({ req, resolve, reject });
      });
    },
  };
  return { source, pending };
}

/** 手动控制的定向拉取（fetchByIdentity），配合 invalidate 的竞态与失败路径断言。 */
export function createControllableFetcher<T>(): {
  fetchByIdentity: (ids: readonly string[]) => Promise<readonly T[]>;
  calls: string[][];
  settle: (index: number, result: readonly T[]) => void;
  fail: (index: number, err: unknown) => void;
} {
  const calls: string[][] = [];
  const settlers: Array<{ resolve: (v: readonly T[]) => void; reject: (e: unknown) => void }> = [];
  return {
    calls,
    fetchByIdentity: (ids: readonly string[]) => {
      calls.push([...ids]);
      return new Promise<readonly T[]>((resolve, reject) => {
        settlers.push({ resolve, reject });
      });
    },
    settle: (index, result) => settlers[index].resolve(result),
    fail: (index, err) => settlers[index].reject(err),
  };
}

export function pageOf(items: TestItem[], startCursor: string, endCursor: string, hasMoreHead: boolean, hasMoreTail: boolean, total?: number): PageLoadResult<TestItem> {
  return { items, startCursor, endCursor, hasMoreHead, hasMoreTail, total };
}
