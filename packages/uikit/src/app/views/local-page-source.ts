// 本地切片分页源：把一次性拉进内存的全量数组冒充成 BoundedList 的 PageSource。
//
// 它**不属于 BoundedList**：组件的正常形态是「数据在服务端，一次取一页」，而这里的数据
// 一开始就全在内存里，分页只是为了复用组件的渲染、选中与交互能力。放在宿主侧才诚实——
// 是宿主选择了在客户端过滤/排序（提及群成员、添加群成员候选），不是组件提供了这种能力。
//
// 游标编码：字符串化的下标，startCursor/endCursor 分别是该页在 entries 里的
// [start, end) 半开区间端点。这套编码完全是本文件的内部实现细节，与服务端不透明游标
// 不共享、不混用，也不外传给服务端，因此不违反「游标对客户端不透明」的项目不变量。
// 非法游标（无法解析成有限数）按 0 处理，绝不产出 "NaN" 这种此后永远翻不动的游标。

import type { FetchPageRequest, PageLoadResult, PageSource } from '../bounded-list';

export interface LocalPageSourceOptions<T, Q> {
  readonly loadAll: (query: Q) => Promise<T[]>;
  readonly filter?: (item: T, query: Q) => boolean;
  readonly compare?: (a: T, b: T) => number;
}

/**
 * cursor 未提供（reset）时重新 loadAll 全量、按 filter/compare 处理后缓存为 entries，
 * 随后的 forward/backward 续翻直接对 entries 做下标切片，不重新 loadAll —— 只有下一次
 * reset 才会重新拉取与处理。
 *
 * 首页取哪一端由请求里的 `freshEdge` 决定（'backward' 取最前面一页，'forward' 取最后
 * 一页），不再单独配一份展示序：展示序只在 BoundedList 上写一次，两处不一致导致静默
 * 取错端的隐患从根上没有了。
 */
export function localPageSource<T, Q>(options: LocalPageSourceOptions<T, Q>): PageSource<T, Q> {
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
      hasMoreBackward: clampedStart > 0,
      hasMoreForward: clampedEnd < source.length,
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
        return req.freshEdge === 'forward'
          ? slice(snapshot, snapshot.length - req.limit, snapshot.length)
          : slice(snapshot, 0, req.limit);
      }
      const cursor = parseCursor(req.cursor);
      if (req.backward) return slice(entries, cursor - req.limit, cursor);
      return slice(entries, cursor, cursor + req.limit);
    },
  };
}
