// 对外只导出 createBoundedList 与类型（设计文档 §2 公开导出面）。

export { createBoundedList, BoundedList } from './bounded-list';
export { serverPageSource, localPageSource } from './page-source';
export { SelectionStore } from './selection';
export {
  invalidateAllBoundedLists,
  registerBoundedList,
  unregisterBoundedList,
  registeredBoundedListIds,
} from './registry';

export type {
  BoundedListOptions,
  BoundedListState,
  BoundedListText,
  Direction,
  ErrorPhase,
  FetchPageRequest,
  FreshEdge,
  PageLoadResult,
  PageSource,
  RegisterBoundedList,
  RenderItemContext,
  SelectionConfig,
  SelectionSnapshot,
} from './types';
export type { BoundedListController, Invalidatable } from './registry';
export type { LocalPageSourceOptions } from './page-source';
export type { ToggleResult } from './selection';
