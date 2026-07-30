// BoundedList 组件的公共类型定义。
// 接口口径单一事实源：packages/uikit/docs/boundedlist/组件设计.md。

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
  readonly backwardBoundary?: () => string;
  readonly forwardBoundary?: () => string;
  /** 「背景有更新」提示条文案。刻意不带数量：见 BoundedListState.stale 的说明。 */
  readonly updatePill?: () => string;
  /** 首屏加载失败时代替空态显示的文案；不提供则退化为空态文案。 */
  readonly error?: (error: unknown) => string;
  /** 首屏加载失败时提示条上的重试文案；不提供则失败后不显示重试入口。 */
  readonly retry?: () => string;
}

export interface BoundedListState {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingBackward: boolean;
  readonly loadingForward: boolean;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly count: number;
  readonly total: number;
  /**
   * 有未追平的变化，提示条该亮起。
   *
   * 刻意是**布尔而不是计数**：「有几条待处理更新」「首屏刷新失败了」「被硬预算裁掉了
   * 几条看不见的」是三件不同的事，用一个数字表达它们必须约定各自怎么合并（累加 /
   * 至少 1 / 取较大者），得到的数字对用户既不准也没意义。用户需要知道的只是
   * 「下面还有没看到的东西」，那是一个布尔。需要精确条数的调用方自己数最准。
   */
  readonly stale: boolean;
  readonly atFreshEdge: boolean;
  /** 首屏是否加载失败（成功一次即回到 false）。 */
  readonly failed: boolean;
}

export interface SelectionSnapshot<T> {
  readonly ids: ReadonlySet<string>;
  readonly count: number;
  readonly items: readonly T[];
}

export type ErrorPhase = 'reset' | 'forward' | 'backward' | 'refresh';

export interface SelectionConfig {
  readonly mode: 'single' | 'multi';
  /** 多选上限；与 store 互斥（同时给出会在构造时抛错）。 */
  readonly max?: number;
  readonly store?: import('./selection').SelectionStore;
  readonly onExceed?: () => void;
}

/** 宿主注册表契约：注册一个实例并返回注销函数。 */
export type RegisterBoundedList = (instance: { readonly id: string; invalidate(): void | Promise<void> }) => () => void;

export interface BoundedListOptions<T, Q = void> {
  readonly id: string;
  readonly scrollElement: HTMLElement;
  readonly contentElement?: HTMLElement;
  readonly pillHost?: HTMLElement | false;
  readonly isActive?: () => boolean;
  /**
   * 把自己登记到宿主的注册表，返回注销函数。
   *
   * 必填：同一页面可以并存多个 AppInstance（嵌入式 UIKit 的多格子场景），它们的列表 id
   * 完全相同。曾经允许省略并退化到一份进程级注册表，结果是同名列表互相覆盖，且省略者
   * 永远收不到宿主的重连广播。改为必填后「注册到哪个宿主」在编译期就是确定的。
   */
  readonly register: RegisterBoundedList;

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

  readonly selection?: SelectionConfig;

  readonly initialQuery?: Q;

  readonly onActivate?: (item: T, ev: Event) => void;
  readonly onSelectionChange?: (snapshot: SelectionSnapshot<T>) => void;
  readonly onLoadStateChange?: (state: BoundedListState) => void;
  readonly onItemsChanged?: (items: readonly T[]) => void;
  readonly onError?: (error: unknown, phase: ErrorPhase) => void;
}
