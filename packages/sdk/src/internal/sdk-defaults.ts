/**
 * SDK 所有可配置默认值集中在此文件。
 * 可通过 ClientOptions 构造参数传入覆盖，不传则使用此处默认值。
 */

/** WebSocket 请求超时毫秒数。超时后请求被拒绝并从待处理队列移除。默认 15 秒。 */
export const DEFAULT_WS_TIMEOUT_MS = 15_000;

/** WebSocket 断连后自动重连等待毫秒数。默认 2 秒。 */
export const DEFAULT_WS_RECONNECT_INTERVAL_MS = 2_000;

/**
 * 连续重连尝试达到该次数后，才对外触发 `connection:reconnecting`（UI 才据此显示"正在重连"）。
 * 避免网络抖动导致的单次瞬时断线在界面上频繁闪烁提示。`connection:disconnected` 仍在每次断开时立即触发。
 * 默认 3 次。
 */
export const DEFAULT_WS_RECONNECT_NOTIFY_THRESHOLD = 3;

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
 * 消息撤回时限（秒）。
 * 0 表示禁用撤回功能（按钮不显示）。仅影响客户端 UI 逻辑，服务端有独立校验。
 * 默认 120 秒（2 分钟）。
 */
export const DEFAULT_RECALL_WINDOW_SECONDS = 120;

/** 单次合并转发最多包含的原消息数量。 */
export const DEFAULT_FORWARD_MAX_ITEMS = 20;

/**
 * SqliteWorkerApi（persistent 模式 OPFS worker）单实例最大并发未完成调用数。
 * 超出此数量时，新调用立即以 Error 拒绝，防止调用方 bug（连续发起但不 await）
 * 导致待响应 Promise 无限积压。默认 256（本地 IPC 往返远快于网络请求，
 * 上限高于 DEFAULT_WS_MAX_PENDING_REQUESTS）。
 */
export const DEFAULT_SQLITE_WORKER_MAX_PENDING_CALLS = 256;
