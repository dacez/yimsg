// 对外只导出实际有调用方的东西（设计文档 §2 公开导出面）。
//
// 判定口径：一个名字只有在 `packages/uikit/src/app/views/`（生产）或
// `packages/uikit/tests/` / `apps/web/tests/`（测试与 harness）真的被引用时才出现在这里。
// 只被本目录内部使用的类型（BoundedListText、Edge、DisplayOrder、SelectionConfig、
// RegisterBoundedList、LocalPageSourceOptions、ToggleResult）不再导出：它们是
// BoundedListOptions 等已导出类型的组成部分，结构类型下调用方无需单独 import 也能用。
// PageWindow / LocalOverlay / ListRenderer 是实现分层，同样不导出。
//
// BoundedList 只作为类型出现在调用方（`type BoundedList` 持有实例引用），没有任何
// `new BoundedList(...)` 或静态成员访问，因此按类型导出，实例统一从 createBoundedList 来。

export { createBoundedList } from './bounded-list';
export { serverPageSource, localPageSource } from './page-source';
export { SelectionStore } from './selection';
export { standaloneList } from './registry';

export type { BoundedList } from './bounded-list';
export type {
  BoundedListOptions,
  BoundedListState,
  ErrorPhase,
  FetchPageRequest,
  PageLoadResult,
  PageSource,
  RenderItemContext,
  SelectionSnapshot,
} from './types';
export type { BoundedListController } from './registry';
