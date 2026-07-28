// PageSource 的两种实现（设计方案 §2.2、§4.2）：
// - serverPageSource：服务端 keyset 游标分页，游标原样透传，不解析、不构造；
// - localPageSource：对一次性拉到内存的全量数组做本地切片，游标 = 下标字符串。
//   仅用于「刻意选择在客户端过滤/排序」的场景（提及群成员、添加群成员候选），
//   本地游标不外传给服务端，不违反「游标对客户端不透明」的项目不变量。

import type { FetchPageRequest, PageLoadResult, PageSource } from './types';

/** 服务端分页：fetch 原样透传请求，map 把 SDK 响应整理成窗口要的结构。 */
export function serverPageSource<R, T, Q>(
  fetch: (req: FetchPageRequest<Q>) => Promise<R>,
  map: (raw: R) => PageLoadResult<T>,
): PageSource<T, Q> {
  return {
    fetch: (req) => fetch(req).then(map),
  };
}

export interface LocalPageSourceOptions<T, Q> {
  readonly loadAll: (query: Q, onProgress?: (loaded: number) => void) => Promise<T[]>;
  readonly filter?: (item: T, query: Q) => boolean;
  readonly compare?: (a: T, b: T) => number;
}

/**
 * 本地分页：cursor 未提供（reset）时重新 loadAll 全量、按 filter/compare 处理后
 * 缓存为 entries，随后的 forward/backward 续翻直接对 entries 做下标切片，
 * 不重新 loadAll —— 只有下一次 reset（对应 setQuery）才会重新拉取与处理。
 *
 * 游标编码：字符串化的下标，startCursor/endCursor 分别是该页在 entries 里的
 * [start, end) 半开区间端点。这套编码完全是 localPageSource 内部实现细节，
 * 与服务端不透明游标不共享、不混用。非法游标（无法解析成有限数）按 0 处理，
 * 绝不产出 "NaN" 这种此后永远翻不动的游标。
 */
export function localPageSource<T, Q>(options: LocalPageSourceOptions<T, Q>): PageSource<T, Q> {
  let entries: T[] = [];

  async function reload(query: Q, onProgress?: (loaded: number) => void): Promise<void> {
    const all = await options.loadAll(query, onProgress);
    const filtered = options.filter ? all.filter((item) => options.filter!(item, query)) : all.slice();
    entries = options.compare ? filtered.sort(options.compare) : filtered;
  }

  function slice(start: number, end: number): PageLoadResult<T> {
    const clampedStart = Math.max(0, Math.min(start, entries.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, entries.length));
    return {
      items: entries.slice(clampedStart, clampedEnd),
      startCursor: String(clampedStart),
      endCursor: String(clampedEnd),
      hasMoreBackward: clampedStart > 0,
      hasMoreForward: clampedEnd < entries.length,
      total: entries.length,
    };
  }

  function parseCursor(raw: string): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return {
    async fetch(req: FetchPageRequest<Q>): Promise<PageLoadResult<T>> {
      if (req.cursor === undefined) {
        await reload(req.query, req.onProgress);
        return slice(0, req.limit);
      }
      const cursor = parseCursor(req.cursor);
      if (req.backward) {
        return slice(cursor - req.limit, cursor);
      }
      return slice(cursor, cursor + req.limit);
    },
  };
}
