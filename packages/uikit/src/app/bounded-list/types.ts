// BoundedList 组件的公共类型定义。
// 单一事实源：packages/uikit/docs/有界消息流窗口设计方案.md §4「组件契约 BoundedList」。

/** 续翻方向：forward = 更靠后/更新，backward = 更靠前/更旧。 */
export type Direction = 'forward' | 'backward';

/** 列表的「新鲜端」：新数据从哪一端进来（设计方案 §2.7）。 */
export type FreshEdge = 'head' | 'tail';

/** 分页请求参数：cursor 未提供表示 reset（拉首页）。 */
export interface FetchPageRequest<Q> {
  readonly cursor?: string;
  readonly backward: boolean;
  readonly limit: number;
  readonly query: Q;
}

/** 一页分页结果，与 SDK PageInfo 同构；total 未提供时视为未知（组件对外呈现为 -1）。 */
export interface PageLoadResult<T> {
  readonly items: readonly T[];
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly total?: number;
}

/** 数据源抽象：「怎么取一页」。见 page-source.ts 的 serverPageSource / localPageSource。 */
export interface PageSource<T, Q> {
  fetch(req: FetchPageRequest<Q>): Promise<PageLoadResult<T>>;
}

export interface RenderItemContext<T> {
  readonly index: number;
  readonly identity: string;
  readonly selected: boolean;
  readonly selectable: boolean;
  readonly previous: T | undefined;
}

export interface BoundedListText {
  readonly loading?: () => string;
  readonly empty?: () => string;
  readonly emptyFiltered?: () => string;
  readonly headBoundary?: () => string;
  readonly tailBoundary?: () => string;
  readonly updatePill?: (count: number) => string;
}

export interface BoundedListState {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingBefore: boolean;
  readonly loadingAfter: boolean;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly count: number;
  readonly total: number;
  readonly stale: boolean;
  readonly pendingCount: number;
  readonly atFreshEdge: boolean;
}

export interface SelectionSnapshot<T> {
  readonly ids: ReadonlySet<string>;
  readonly count: number;
  readonly items: readonly T[];
}

export type ErrorPhase = 'reset' | 'forward' | 'backward' | 'refresh';

export interface SelectionConfig<T> {
  readonly mode: 'single' | 'multi';
  readonly max?: number;
  readonly store?: import('./selection').SelectionStore;
  readonly onExceed?: () => void;
}

export interface BoundedListOptions<T, Q = void> {
  readonly id: string;
  readonly scrollElement: HTMLElement;
  readonly contentElement?: HTMLElement;
  readonly pillHost?: HTMLElement | false;
  readonly isActive?: () => boolean;

  readonly pageSize: number;
  readonly maxPages: number;
  readonly source: PageSource<T, Q>;
  readonly fetchByIdentity?: (ids: readonly string[]) => Promise<readonly T[]>;
  readonly normalize?: (items: readonly T[]) => T[];

  readonly identityOf: (item: T) => string;

  readonly freshEdge?: FreshEdge;
  readonly stickyPx?: number;
  readonly reachPx?: number;
  readonly settleFrames?: number;

  readonly renderItem: (item: T, ctx: RenderItemContext<T>) => readonly HTMLElement[];
  readonly pinnedItems?: () => readonly T[];
  readonly text: BoundedListText;

  readonly selection?: SelectionConfig<T>;

  readonly initialQuery?: Q;

  readonly onActivate?: (item: T, ev: Event) => void;
  readonly onSelectionChange?: (snapshot: SelectionSnapshot<T>) => void;
  readonly onLoadStateChange?: (state: BoundedListState) => void;
  readonly onStaleChange?: (stale: boolean, pendingCount: number) => void;
  readonly onItemsChanged?: (items: readonly T[]) => void;
  readonly onError?: (error: unknown, phase: ErrorPhase) => void;
  readonly onEmptyPage?: (dir: Direction) => void;
}
