// PageSource 的两种实现（设计方案 §2.2、§4.2）：
// - sdkPageSource：服务端 keyset 游标分页，游标原样透传，不解析、不构造；
// - localPageSource：对一次性拉到内存的全量数组做本地切片，游标 = 下标字符串。
//   仅用于「刻意选择在客户端过滤/排序」的场景（提及群成员、添加群成员候选），
//   本地游标不外传给服务端，不违反「游标对客户端不透明」的项目不变量。

import type { DisplayOrder, FetchPageRequest, PageLoadResult, PageSource } from './types';

/** SDK 所有分页响应共有的翻页信息（`packages/sdk/src/types.ts` 的 `PageInfo`）。 */
interface SdkPageInfo {
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly total?: number;
}

/**
 * 服务端分页：请求原样透传给 SDK，响应里的 `page` 按固定规则映射成窗口要的结构。
 *
 * 方向词汇的转换（`backward → head`、`forward → tail`）全项目只在这里发生一次；
 * 调用方只需回答一个问题：这次响应里的条目在哪个字段（`selectItems`）。
 *
 * `selectTotal` 只给「总数不在 `page.total` 里」的接口用（如 `getGroupMembers`
 * 的总数在响应顶层），其余一律不传。
 */
export function sdkPageSource<R extends { readonly page: SdkPageInfo }, T, Q>(
  fetch: (req: FetchPageRequest<Q>) => Promise<R>,
  selectItems: (raw: R) => readonly T[],
  selectTotal?: (raw: R) => number,
): PageSource<T, Q> {
  return {
    fetch: (req) => fetch(req).then((raw): PageLoadResult<T> => ({
      items: selectItems(raw),
      startCursor: raw.page.startCursor,
      endCursor: raw.page.endCursor,
      hasMoreHead: raw.page.hasMoreBackward,
      hasMoreTail: raw.page.hasMoreForward,
      total: selectTotal ? selectTotal(raw) : raw.page.total,
    })),
  };
}

export interface LocalPageSourceOptions<T, Q> {
  readonly loadAll: (query: Q) => Promise<T[]>;
  readonly filter?: (item: T, query: Q) => boolean;
  readonly compare?: (a: T, b: T) => number;
  /**
   * 展示序，必须与所属 BoundedList 的 `order` 一致，默认 'desc'。
   * reset（cursor 未提供）要取的是新鲜端那一页：'desc' 新鲜端在头部，取 entries
   * 最前面一页；'asc' 新鲜端在尾部，取最后一页。与所属 BoundedList 的 `order` 不一致
   * 会静默取错端，必须显式传入，不能只靠调用方自行保证。
   */
  readonly order?: DisplayOrder;
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
  const freshEdge = (options.order ?? 'desc') === 'desc' ? 'head' : 'tail';
  let entries: T[] = [];
  let reloadGeneration = 0;

  async function reload(query: Q): Promise<T[]> {
    const generation = ++reloadGeneration;
    const all = await options.loadAll(query);
    const filtered = options.filter ? all.filter((item) => options.filter!(item, query)) : all.slice();
    const prepared = options.compare ? filtered.sort(options.compare) : filtered;
    // 两个 reset 可能并发：旧查询晚返回时，它自己的首页结果仍可交给上层世代守卫丢弃，
    // 但绝不能覆盖新查询已经建立的共享续翻快照。
    if (generation === reloadGeneration) entries = prepared;
    return prepared;
  }

  function slice(source: readonly T[], start: number, end: number): PageLoadResult<T> {
    const clampedStart = Math.max(0, Math.min(start, source.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, source.length));
    return {
      items: source.slice(clampedStart, clampedEnd),
      startCursor: String(clampedStart),
      endCursor: String(clampedEnd),
      hasMoreHead: clampedStart > 0,
      hasMoreTail: clampedEnd < source.length,
      total: source.length,
    };
  }

  function parseCursor(raw: string): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return {
    async fetch(req: FetchPageRequest<Q>): Promise<PageLoadResult<T>> {
      if (req.cursor === undefined) {
        const snapshot = await reload(req.query);
        // reset 取新鲜端那一页：head 取最前面一页，tail 取最后一页。
        return freshEdge === 'tail'
          ? slice(snapshot, snapshot.length - req.limit, snapshot.length)
          : slice(snapshot, 0, req.limit);
      }
      const cursor = parseCursor(req.cursor);
      if (req.backward) {
        return slice(entries, cursor - req.limit, cursor);
      }
      return slice(entries, cursor, cursor + req.limit);
    },
  };
}
