// 服务端分页源：keyset 游标分页，游标原样透传，不解析、不构造。
//
// 这是组件自带的唯一 PageSource 实现，因为它对应「有界列表」的正常形态：数据在服务端，
// 一次只取一页。「把一次性拉进内存的全量数组冒充成分页源」是宿主的选择而不是组件能力，
// 那份适配器在 `packages/uikit/src/app/views/local-page-source.ts`。

import type { FetchPageRequest, PageLoadResult, PageSource } from './types';

/** SDK 所有分页响应共有的翻页信息（`packages/sdk/src/types.ts` 的 `PageInfo`）。 */
interface SdkPageInfo {
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly total?: number;
}

/**
 * 服务端分页：请求原样透传给 SDK，响应里的 `page` 也按同名字段搬进窗口要的结构，
 * 全程没有方向词汇的翻译（组件与 wire 用的是同一套 `backward`/`forward`）。
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
      hasMoreBackward: raw.page.hasMoreBackward,
      hasMoreForward: raw.page.hasMoreForward,
      total: selectTotal ? selectTotal(raw) : raw.page.total,
    })),
  };
}
