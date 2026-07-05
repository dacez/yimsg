/**
 * SDK 所有可配置默认值集中在此文件。
 * 可通过 ClientOptions 构造参数传入覆盖，不传则使用此处默认值。
 */

/** WebSocket 请求超时毫秒数。超时后请求被拒绝并从待处理队列移除。默认 15 秒。 */
export const DEFAULT_WS_TIMEOUT_MS = 15_000;

/** WebSocket 断连后自动重连等待毫秒数。默认 2 秒。 */
export const DEFAULT_WS_RECONNECT_INTERVAL_MS = 2_000;

/** WebSocket 心跳（ping）发送间隔毫秒数。设为 0 禁用心跳。默认 30 秒。 */
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket 最大并发未响应请求数。
 * 超出此数量时，新请求立即以 CONNECTION_FAILED 拒绝，防止请求积压过多占用内存。
 * 默认 100。
 */
export const DEFAULT_WS_MAX_PENDING_REQUESTS = 100;

/**
 * 增量同步每批拉取条数（消息同步、联系人同步、屏蔽列表同步、免打扰同步）。
 * 每次网络请求最多拉取这么多条，超出则分批循环拉取。默认 200。
 */
export const DEFAULT_SYNC_BATCH_SIZE = 200;

/** 公开分页读取接口单次最大返回条数。 */
export const DEFAULT_MAX_PAGE_LIMIT = 500;

/** 批量接口单次网络请求最大条数。服务端 client_config 可下发更小值。 */
export const DEFAULT_MAX_BATCH_LIMIT = 500;

/**
 * 显示信息（用户头像/昵称、群名称）本地缓存过期时间（秒）。
 * 超过此时间后缓存项视为过期，下次使用时返回旧值同时触发后台刷新。默认 7 天。
 */
export const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 3600;

/**
 * 显示信息缓存最大条目数。
 * 超出时按 FIFO 策略淘汰最早插入的条目。默认 10000。
 */
export const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

/**
 * 显示信息后台加载队列最大长度。
 * 超出时立即抛 INVALID_ARGUMENT，避免一次渲染或外部调用塞入超大 key 集。
 */
export const DEFAULT_PROFILE_LOAD_QUEUE_MAX_ENTRIES = 2_000;

/**
 * 转发包最大下载字节数。
 * 读取 arrayBuffer 前先检查 Content-Length，防止因恶意响应导致单次内存峰值失控。
 * 默认 1 MB。
 */
export const DEFAULT_MAX_FORWARD_BUNDLE_BYTES = 1 * 1024 * 1024;

/**
 * 消息撤回时限（秒）。
 * 0 表示禁用撤回功能（按钮不显示）。仅影响客户端 UI 逻辑，服务端有独立校验。
 * 默认 120 秒（2 分钟）。
 */
export const DEFAULT_RECALL_WINDOW_SECONDS = 120;

// ── 有界集合（Bounded Collections）容量参数 ───────────────────────────────────
// 这些常量决定 BoundedU64Map / BoundedU64Set 的固定 bucket 布局，是 SDK 内存
// 静态可估算的基础。bucketCount 由「期望容量 / loadFactor / bucketCapacity」向上
// 对齐到 2 的幂得到，运行期不再增长。

/** 显示信息缓存与待拉取队列的每桶槽位数（bucketCapacity）。 */
export const DISPLAY_CACHE_BUCKET_CAPACITY = 8;

/**
 * 显示信息待拉取 / 在飞队列（BoundedU64Set）的目标负载因子。
 * 取 0.5 预留 2× headroom，确保在到达逻辑上限前 bucket 不会因哈希倾斜提前溢出，
 * 从而保证「队列满」语义精确发生在 queueMaxEntries。
 */
export const DISPLAY_QUEUE_LOAD_FACTOR = 0.5;

/** WsTransport pendingRequests（BoundedU64Map）的每桶槽位数。 */
export const PENDING_REQUEST_BUCKET_CAPACITY = 8;

/**
 * pendingRequests 有界 map 的目标负载因子。
 * 取 0.5 预留 2× 物理容量 headroom，避免顺序自增 request_id 在个别 bucket 上倾斜，
 * 导致本可接纳的并发请求被提前拒绝。
 */
export const PENDING_REQUEST_LOAD_FACTOR = 0.5;

// ── estimateMaxMemoryBytes 推导常量 ──────────────────────────────────────────
// 以下常量为对应「值对象」在 V8 JS 堆中的字节上界（不含有界集合的固定 slot 结构开销，
// 后者由 estimateBoundedU64MapBytes / estimateBoundedU64SetBytes 单独计入）。
// 字符串按平均长度推导（UTF-16，每字符 2 字节）；对象头约 64 字节。

/**
 * 单条 DisplayCacheEntry 值对象的字节上界（不含 key / slot 结构开销）。
 * 用户与群各自独立的有界缓存均按用户条目最坏情况估算。
 * 推导（每个字符串值含 32 字节 V8 字符串对象头 + UTF-16 内容）：
 *   对象头 64
 *   + username (头32 + avg 15 chars × 2 = 30) → 62，上取整至 64
 *   + name     (头32 + avg 15 chars × 2 = 30) → 62，上取整至 64
 *   + avatar   (头32 + avg 80 chars × 2 = 160) = 192
 *   + remark   (头32 + avg  5 chars × 2 = 10) → 42，上取整至 48
 *   + expireAt (number) 8
 *   = 440 → 上取整至 448。
 */
export const BYTES_PER_DISPLAY_CACHE_VALUE = 448;

/**
 * 单条 PendingReq 值对象的字节上界（不含 key / slot 结构开销）。
 * 推导：resolve 闭包 128 + reject 闭包 128 + timer handle 16 + responseCodec 引用 8
 *   + 对象头 64 = 344 → 上取整至 384。
 */
export const BYTES_PER_PENDING_REQUEST_VALUE = 384;

/**
 * 消息增量同步单条 Message 对象的字节上界（含对象头与数组槽）。
 * 推导：
 *   uid(number) 8 + seq(number) 8 + msg_id(avg 18 chars) 68 + from_uid(avg 18 chars) 68
 *   + to_uid(avg 18 chars) 68 + group_id(avg 18 chars) 68 + msg_type(number) 8
 *   + content(avg 100 chars) 232 + send_time(number) 8 + 对象头 80 + 数组槽 8 = 624 → 上取整至 640。
 */
export const BYTES_PER_SYNC_MESSAGE = 640;

/**
 * SDK 固定基线开销（字节）。
 * 包含 SessionLifecycleMachine、EventEmitter 监听器表、
 * WsTransport 连接状态与计数器字段、各内部协作对象常驻内存，合计约 64 KB。
 */
export const SDK_BASELINE_BYTES = 64 * 1024;
