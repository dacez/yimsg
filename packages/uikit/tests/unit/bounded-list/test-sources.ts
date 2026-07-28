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
          hasMoreBackward: false,
          hasMoreForward: items.length < all.length,
          total: opts?.withTotal ? all.length : undefined,
        };
      }
      const cursor = Number(req.cursor);
      if (req.backward) {
        const start = Math.max(0, cursor - req.limit);
        const items = all.slice(start, cursor);
        return { items, startCursor: String(start), endCursor: String(cursor), hasMoreBackward: start > 0, hasMoreForward: cursor < all.length };
      }
      const end = Math.min(all.length, cursor + req.limit);
      const items = all.slice(cursor, end);
      return { items, startCursor: String(cursor), endCursor: String(end), hasMoreBackward: cursor > 0, hasMoreForward: end < all.length };
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

export function pageOf(items: TestItem[], startCursor: string, endCursor: string, hasMoreBackward: boolean, hasMoreForward: boolean, total?: number): PageLoadResult<TestItem> {
  return { items, startCursor, endCursor, hasMoreBackward, hasMoreForward, total };
}
