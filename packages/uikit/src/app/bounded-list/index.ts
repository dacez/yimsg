// 对外只导出 createBoundedList 与类型（设计方案 §4 目录结构）。

export { createBoundedList, BoundedList } from './bounded-list';
export { serverPageSource, localPageSource } from './page-source';
export { SelectionStore } from './selection';
export { invalidateAllBoundedLists, registeredBoundedListIds } from './registry';

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
  RenderItemContext,
  SelectionConfig,
  SelectionSnapshot,
} from './types';
export type { LocalPageSourceOptions } from './page-source';
export type { ToggleResult } from './selection';
