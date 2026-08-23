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
 * 首页请求恒为 `false`（SDK 首页没有方向概念），要取哪一端由 `freshEdge` 单独给出。
 */
export interface FetchPageRequest<Q> {
  readonly cursor?: string;
  readonly backward: boolean;
  readonly limit: number;
  readonly query: Q;
  /**
   * 所属列表的新鲜端，由 `order` 换算而来，每次请求都带上。
   *
   * 只有「自己决定首页取哪一端」的数据源用得上它（本地切片源：'backward' 取数组最前面
   * 一页，'forward' 取最后一页；消息列表用它把首页请求翻译成 SDK 的「取最新一页」）。
   * 它不是 wire 字段：`sdkPageSource` 把整个请求原样交给调用方的 fetch 函数，调用方按需
   * 解构自己要的字段，不需要的自然不会传给 SDK。
   *
   * 有了它，数据源就不必再单独配一份展示序，也就没有「两处 order 必须一致、不一致
   * 静默取错端」这种跨对象隐式契约。
   */
  readonly freshEdge: Edge;
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
  /** 首屏加载失败时代替空态显示的文案；不提供则退化为空态文案。 */
  readonly error?: (error: unknown) => string;
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
   * 有已知的变化但当前没有追平，也就是「上面还有没看到的东西」。
   *
   * 刻意是**布尔而不是计数**：「有几条待处理更新」对用户既不准也没意义，用户需要知道的
   * 只是有没有。需要精确条数的调用方自己数最准。
   *
   * 组件只报这个状态，不画任何提示条 DOM：要不要提示、长什么样、点了做什么，都是宿主
   * 的事（宿主在 `onLoadStateChange` 里读它，点击时调 `catchUp()`）。
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

/**
 * 出错时正在做什么。`reset` 与 `catchup` 发的是同一种首页请求，但对宿主是两回事：
 * `reset` 失败意味着**用户面前这块列表没内容**（该弹提示），`catchup` 失败只是后台追平
 * 没成功、旧内容还好好摆着（该静默，提示条仍是重试入口）。合成一个取值，宿主就只能
 * 在「网络抖一下也弹一次错」和「首屏空白却一声不吭」之间二选一。
 */
export type ErrorPhase = 'reset' | 'catchup' | 'backward' | 'forward' | 'refresh';

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
   * 触界自动补页总开关，默认 true。
   *
   * 关掉之后只有显式 `loadMore(edge)` 能续翻，滚动不再触发任何请求——要逐页断言的
   * 测试用它。它与 `reachPx` 是两件事：一个决定「补不补」，一个决定「多近算触界」，
   * 所以不合并成「reachPx 传负值即关闭」那种魔法值。
   */
  readonly autoLoad?: boolean;
  /** 距某一端多少像素以内算触界、触发自动补页，默认 160。 */
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
