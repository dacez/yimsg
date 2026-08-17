// BoundedList 组件的公共类型定义。
// 接口口径单一事实源：packages/uikit/docs/boundedlist/组件设计.md。

/**
 * 展示序：列表按什么方向排列，与协议文档「展示序」用词一致（同步机制方案.md）。
 * 'asc' = 旧→新（如消息），'desc' = 新→旧（如会话/联系人/群成员）。
 *
 * 它只决定一件事：哪一端是新鲜端。'asc' 时新数据出现在 forward 端，'desc' 时出现在
 * backward 端。组件内部一律用 Edge 表达端，`order` 只在构造时转换成一次 Edge 取值。
 */
export type DisplayOrder = 'asc' | 'desc';

/**
 * 列表的一端，直接沿用 wire 协议的方向词汇（`protocol/yimsg.proto` 的 `PageDirection`）：
 *
 * - `'backward'`：逆展示序的那一端，也就是数组头部、DOM 上方；
 * - `'forward'`：沿展示序的那一端，也就是数组尾部、DOM 下方。
 *
 * 全项目只有这一套方向词汇：SDK 的 `hasMoreBackward`/`hasMoreForward`、组件内部状态和
 * 续翻请求用的是同样两个词，中间没有任何映射。展示序不改变这个对应关系——列表永远
 * 自上而下按展示序渲染，所以 backward 端恒在上方。
 */
export type Edge = 'backward' | 'forward';

/**
 * 分页请求参数：cursor 未提供表示拉首页。
 *
 * `backward` 就是 SDK 分页方法的同名参数，调用方原样透传即可，不需要翻译成别的词。
 */
export interface FetchPageRequest<Q> {
  readonly cursor?: string;
  readonly backward: boolean;
  readonly limit: number;
  readonly query: Q;
}

/**
 * 一页分页结果；total 未提供时视为未知（组件对外呈现为 -1）。
 *
 * `hasMoreBackward`/`hasMoreForward` 与 SDK `PageInfo` 的同名字段完全一致，原样搬过来即可。
 */
export interface PageLoadResult<T> {
  readonly items: readonly T[];
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  readonly total?: number;
}

/** 数据源抽象：「怎么取一页」。见 page-source.ts 的 sdkPageSource / localPageSource。 */
export interface PageSource<T, Q> {
  fetch(req: FetchPageRequest<Q>): Promise<PageLoadResult<T>>;
}

export interface RenderItemContext<T> {
  readonly identity: string;
  readonly selected: boolean;
  readonly selectable: boolean;
  readonly previous: T | undefined;
}

export interface BoundedListText {
  readonly loading?: () => string;
  /**
   * 空态文案。「无数据」与「无搜索结果」的区分由调用方自己给（它手里就握着搜索框），
   * 组件不判断「什么算已过滤」——那需要把查询条件深比较一遍，既慢又容易误判。
   */
  readonly empty?: () => string;
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

export type ErrorPhase = 'reset' | 'backward' | 'forward' | 'refresh';

export interface SelectionConfig {
  readonly mode: 'single' | 'multi';
  /** 多选上限；与 store 互斥（同时给出会在构造时抛错）。 */
  readonly max?: number;
  readonly store?: import('./selection').SelectionStore;
  readonly onExceed?: () => void;
}

/**
 * 宿主侧的有界列表刷新契约：会话列表、当前会话消息、好友/请求列表等所有「有界列表」
 * 通过 invalidate() 注册自己的追平动作。invalidate 语义等价于「收到一条属于本列表的
 * 新数据通知」——具体是立即重拉追平还是推迟（点亮「有更新」提示），由各列表自己按
 * 贴顶/可见性规则决定。调用方（例如重连成功）只管广播 invalidate。
 */
export interface BoundedListController {
  readonly id: string;
  invalidate(): void | Promise<void>;
}

/** 宿主注册表契约：注册一个实例并返回注销函数。 */
export type RegisterBoundedList = (instance: BoundedListController) => () => void;

export interface BoundedListOptions<T, Q = void> {
  readonly id: string;
  readonly scrollElement: HTMLElement;
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
  /**
   * 距某一端多少像素以内触发自动补页，默认 160。
   * 传负值等价于关掉自动补页——测试要逐页断言时用它，生产不传。
   */
  readonly reachPx?: number;

  /**
   * 每一轮渲染开始前调用一次，带上本轮要渲染的完整序列（序列为空时不调用）。
   *
   * 给「渲染前先按整批数据准备一次上下文」的调用方用（批量预取展示名、算一次分组基准）。
   * 有它才不必让 `renderItem` 靠「这是不是第 0 行」反推批次开始——那种写法会把行下标
   * 绑进复用判定里，头部插一页就让整窗口失去复用。
   */
  readonly beforeRender?: (items: readonly T[]) => void;
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
