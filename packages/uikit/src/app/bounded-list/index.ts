// 对外只导出用得上的东西（设计文档 §2 公开导出面）。
//
// 判定口径两条，满足其一才导出：
// 1. 在 `packages/uikit/src/app/views/`（生产）或 `packages/uikit/tests/` /
//    `apps/web/tests/`（测试与 harness）真的被引用；
// 2. 出现在公开方法的签名里 —— 调用方要包一层就得能写出这个类型名。Edge 属于这一条
//    （`loadMore(edge: Edge)`），目前生产没有直接调用方，但少了它宿主写不出「加载更多」
//    按钮的形参类型。
// 只被本目录内部使用、且只作为已导出类型组成部分出现的类型（BoundedListText、
// DisplayOrder、SelectionConfig、RegisterBoundedList、ToggleResult）不导出：结构类型下
// 调用方无需单独 import 也能用。
// PageWindow / LocalOverlay / ListRenderer 是实现分层，同样不导出。
//
// BoundedList 只作为类型出现在调用方（`type BoundedList` 持有实例引用），没有任何
// `new BoundedList(...)` 或静态成员访问，因此按类型导出，实例统一从 createBoundedList 来。
//
// 提示条 DOM（`views/list-pill.ts`）与本地切片分页源（`views/local-page-source.ts`）
// 都在宿主侧，不从这里导出：见各自文件头的理由。

export { createBoundedList, standaloneList } from './bounded-list';
export { sdkPageSource } from './page-source';
export { SelectionStore } from './selection';

export type { BoundedList } from './bounded-list';
export type {
  BoundedListController,
  BoundedListOptions,
  BoundedListState,
  Edge,
  ErrorPhase,
  FetchPageRequest,
  PageLoadResult,
  PageSource,
  RenderItemContext,
  SelectionSnapshot,
} from './types';
