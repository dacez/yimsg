// BoundedList 组件的公共类型定义。
// 接口口径单一事实源：packages/uikit/docs/boundedlist/组件设计.md。

/**
 * 展示序：列表按什么方向排列，与协议文档「展示序」用词一致（同步机制方案.md）。
 * 'asc' = 旧→新（如消息），'desc' = 新→旧（如会话/联系人/群成员）。
 *
 * 它只决定一件事：哪一端是新鲜端。'asc' 时新数据出现在尾部，'desc' 时出现在头部。
 * 组件内部一律用 Edge 表达端，`order` 只在构造时转换成一次 Edge 取值。
 */
export type DisplayOrder = 'asc' | 'desc';

/**
 * 列表的一端：数组 / DOM 的头部还是尾部。
 *
 * wire 协议的 `backward`/`forward`（续翻请求朝哪边）与组件内部的 head/tail 是同一根轴：
 * backward 恒等于 head、forward 恒等于 tail，没有例外。组件内部只用 Edge 一套词汇，
 * 只在发出 `FetchPageRequest` 时转换成 `backward` 一次。
 */
export type Edge = 'head' | 'tail';

/** 分页请求参数：cursor 未提供表示拉首页。 */
export interface FetchPageRequest<Q> {
  readonly cursor?: string;
  readonly backward: boolean;
  readonly limit: number;
  readonly query: Q;
}

/**
 * 一页分页结果；total 未提供时视为未知（组件对外呈现为 -1）。
 *
 * `hasMoreHead`/`hasMoreTail` 与组件内部用的是同一套 Edge 词汇；调用方从 SDK `PageInfo`
 * （`hasMoreBackward`/`hasMoreForward`）映射过来时按 `backward→head`、`forward→tail`
 * 一次性转换，不随展示序变化。
 */
export interface PageLoadResult<T> {
  readonly items: readonly T[];
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreHead: boolean;
  readonly hasMoreTail: boolean;
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
  readonly loadingHead: boolean;
  readonly loadingTail: boolean;
  readonly hasMoreHead: boolean;
  readonly hasMoreTail: boolean;
  /** 当前渲染序列的条目数（含 pinnedItems 与本地层）。 */
  readonly count: number;
  readonly total: number;
  /**
   * 提示条该不该亮：有已知的变化但当前没有追平。
   *
   * 刻意是**布尔而不是计数**：「有几条待处理更新」对用户既不准也没意义，用户需要知道的
   * 只是「上面还有没看到的东西」。需要精确条数的调用方自己数最准。
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

export type ErrorPhase = 'reset' | 'head' | 'tail' | 'refresh';

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
   * 完全相同。若省略并退化到一份进程级注册表，同名列表会互相覆盖，且拿不到宿主的重连
   * 广播。不接入广播的一次性列表显式传 `standaloneList`。
   */
  readonly register: RegisterBoundedList;

  readonly pageSize: number;
  readonly maxPages: number;
  readonly source: PageSource<T, Q>;
  /** 定向刷新：只更新窗口内这些身份，不重排。不提供则收到 identities 通知时只亮提示条。 */
  readonly fetchByIdentity?: (ids: readonly string[]) => Promise<readonly T[]>;
  /** 每页归一化（排序 / 去重 / 过滤），只作用于服务端返回的整页，不作用于本地层。 */
  readonly normalize?: (items: readonly T[]) => T[];

  readonly identityOf: (item: T) => string;

  /** 展示序，默认 'desc'（新鲜端在头部，如会话/联系人）。见 DisplayOrder 的说明。 */
  readonly order?: DisplayOrder;
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
  /** 渲染序列变化时上报，与真正渲染出来的是同一份序列（含 pinnedItems 与本地层）。 */
  readonly onItemsChanged?: (items: readonly T[]) => void;
  readonly onError?: (error: unknown, phase: ErrorPhase) => void;
}
