import type {
  MsgType as RawMsgType,
  GroupRole as RawGroupRole,
  MessageBody as RawMessageBody,
  TextBody,
  MarkdownBody,
  ImageBody,
  FileBody,
  SystemBody,
  RecallBody,
  QuoteBody,
  ForwardBody,
} from "../types";

export type {
  TextBody,
  MarkdownBody,
  ImageBody,
  FileBody,
  SystemBody,
  RecallBody,
  QuoteBody,
  ForwardBody,
} from "../types";
export type MessageBody = RawMessageBody;
export type { SendImageInput, SendFileInput } from "./internal/client-message-facade";

export type MsgType = RawMsgType;
export type GroupRole = RawGroupRole;
export type ConversationKind = "direct" | "group";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";
export type SessionState =
  | "idle"
  | "authenticated"
  | "initializing"
  | "ready"
  | "destroyed";
export type SessionMode = "memory" | "persistent";
export type SessionStorageMode = "memory" | "persistent";
export type SessionFileSystem = "opfs" | "local";
export type SessionLocalDataResetScope = "none" | "current-user" | "all";
export interface SessionStartOptions {
  readonly storage?: SessionStorageMode;
  readonly fileSystem?: SessionFileSystem;
  readonly resetLocalData?: false | SessionLocalDataResetScope;
  readonly instanceId?: string;
}
export interface SessionStartResult {
  readonly requestedStorage: SessionStorageMode;
  readonly actualStorage: SessionStorageMode;
  readonly requestedFileSystem: SessionFileSystem | null;
  readonly actualFileSystem: SessionFileSystem | null;
  readonly mode: SessionMode;
  readonly degraded: boolean;
  readonly persistentStorageAvailable: boolean;
  readonly resetLocalData: SessionLocalDataResetScope;
  readonly resetLocalDataError: Error | null;
}
export type UploadCategory = "avatar" | "image" | "file";
export type SessionTransitionReason =
  | "connect_started"
  | "transport_connected"
  | "transport_disconnected"
  | "transport_reconnecting"
  | "authenticated"
  | "session_initializing"
  | "session_init_failed"
  | "session_ready"
  | "logout"
  | "destroyed";
export type SyncDomain =
  | "storage"
  | "messages"
  | "conversations"
  | "contacts"
  | "blocklist"
  | "mutelist"
  | "orgs";
export type SyncStatus = "started" | "success" | "failed" | "reset";
export type ContactsUpdateReason = "notification_sync" | "display_reordered";
export type DisplayInfoScope = "user" | "group" | "org" | "tag" | "mixed";

export interface ClientOptions {
  /** WebSocket URL. Defaults to auto-detect from location. */
  readonly wsUrl?: string;
  /** File upload URL. Defaults to '/api/upload'. */
  readonly uploadUrl?: string;
  /** Auto-reconnect interval in ms. Default 2000. */
  readonly reconnectInterval?: number;
  /** Request timeout in ms. Default 15000. */
  readonly requestTimeout?: number;
  /** Heartbeat (ping) interval in ms. Default 30000. Set 0 to disable. */
  readonly heartbeatInterval?: number;
  /** WebSocket factory for testing. Defaults to native WebSocket. */
  readonly wsFactory?: (url: string) => WebSocket;
  /** 显示信息缓存过期秒数。默认 DEFAULT_CACHE_TTL_SECONDS（7 天）。 */
  readonly cacheTtlSeconds?: number;
  /** 显示信息缓存最大条目数，用户和群合计计算。默认 DEFAULT_CACHE_MAX_ENTRIES（10000）。 */
  readonly cacheMaxEntries?: number;
  /**
   * 消息撤回时限初始值（秒）。登录 / 鉴权成功后以后端 client_config 为准。
   * 0 表示禁用撤回按钮。默认 DEFAULT_RECALL_WINDOW_SECONDS（120 秒）。
   */
  readonly recallWindowSeconds?: number;
  /** 批量接口单次请求最大条数。默认 DEFAULT_MAX_BATCH_LIMIT（500）。 */
  readonly batchMaxLimit?: number;
  /**
   * WebSocket 最大并发未响应请求数。超出后 send() 立即以 CONNECTION_FAILED 拒绝。
   * 默认 DEFAULT_WS_MAX_PENDING_REQUESTS（100）。
   */
  readonly maxPendingRequests?: number;
  /**
   * 显示信息后台加载队列最大长度，用户和群合计计算。
   * 超出时立即抛 INVALID_ARGUMENT，避免一次渲染或外部调用塞入超大 key 集。
   * 默认 DEFAULT_PROFILE_LOAD_QUEUE_MAX_ENTRIES（2000）。
   */
  readonly profileLoadQueueMaxEntries?: number;
}

export interface ClientConfig {
  readonly cacheTtlSeconds: number;
  readonly cacheMaxEntries: number;
  readonly recallWindowsSeconds: number;
  readonly batchMaxLimit: number;
}

export interface AuthResult {
  readonly uid: string;
  readonly token: string;
  readonly clientConfig?: ClientConfig;
}

export interface ConvTarget {
  readonly toUid: string;
  readonly groupId?: never;
}

export interface GroupConvTarget {
  readonly groupId: string;
  readonly toUid?: never;
}

export type ConversationTarget = ConvTarget | GroupConvTarget;

/** 组织通讯录条目目标：组织不是会话目标，仅在通讯录条目上出现。 */
export interface OrgContactTarget {
  readonly orgId: string;
  readonly toUid?: never;
  readonly groupId?: never;
}

export type ContactTarget = ConversationTarget | OrgContactTarget;

export interface ConversationDescriptor {
  readonly key: string;
  readonly kind: ConversationKind;
  readonly id: string;
  readonly target: ConversationTarget;
}

export interface Message {
  readonly seq: number;
  readonly messageId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly groupId: string;
  readonly messageType: MsgType;
  readonly body: RawMessageBody;
  readonly sentAt: number;
  readonly status?: number;
}

export interface MessageQuoteInfo {
  readonly messageId: string;
  readonly preview: string;
  readonly text: string;
}

export interface ForwardAttachmentInfo {
  readonly messageIds: ReadonlyArray<string>;
  readonly title: string;
}

export interface MessageContentDescriptor {
  readonly text: string;
  readonly html: string | null;
  readonly bodyKind: MsgType;
  readonly quote: MessageQuoteInfo | null;
  readonly forward: ForwardAttachmentInfo | null;
  readonly image: ImageBody | null;
  readonly file: FileBody | null;
  readonly recall: RecallBody | null;
}

export interface SendQuotedTextInput {
  readonly text: string;
  readonly quoteMsgId: string;
  readonly quotePreview?: string;
}

export interface ConversationEntry {
  readonly groupId: string;
  readonly friendUid: string;
  readonly lastSeq: number;
  readonly lastMessage: Message | null;
  readonly unreadCount?: number;
  readonly status?: number;
}

export interface LocalConversation {
  readonly groupId: string;
  readonly friendUid: string;
  readonly lastSeq: number;
  readonly lastMessage: Message | null;
  readonly unreadCount?: number;
  readonly status?: number;
}

/**
 * PageInfo 是展示通道统一分页信息：游标对调用方不透明，原样回传即可续翻。
 * 续翻：向 FORWARD（向下/向尾）用 endCursor，向 BACKWARD（向上/向头）用 startCursor。
 */
export interface PageInfo {
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
  /** 集合总数；小于 0 表示未知/未统计。 */
  readonly total: number;
}

export interface MessagePage {
  readonly messages: ReadonlyArray<Message>;
  readonly page: PageInfo;
}

export interface ConversationPage {
  readonly conversations: ReadonlyArray<LocalConversation>;
  readonly page: PageInfo;
}

export interface Contact {
  readonly target: ContactTarget;
  /** @deprecated 使用 target。 */
  readonly friendUid?: string;
  /** @deprecated 使用 target。 */
  readonly groupId?: string;
  /** @deprecated 使用 target。 */
  readonly orgId?: string;
  readonly status: number;
  readonly seq: number;
  readonly remarkName?: string;
  /** 通讯录排序键投影（服务端下发）。 */
  readonly sortKey?: string;
  /** 通讯录搜索投影（服务端下发，不含 username）。 */
  readonly searchText?: string;
}

export interface ContactPage {
  readonly contacts: ReadonlyArray<Contact>;
  readonly page: PageInfo;
}

/** 组织展示资料字典：仅名字/头像，不参与同步（与 GroupInfo 同构）。 */
export interface OrgInfo {
  readonly orgId: string;
  readonly name: string;
  readonly avatarUrl: string;
}

export interface OrgDisplayInfo {
  readonly name: string;
  readonly avatarUrl: string;
}

/** tag（部门/横向分组）展示资料字典：仅名字/头像，不参与同步。 */
export interface TagInfo {
  readonly tagId: string;
  readonly name: string;
  readonly avatarUrl: string;
}

export interface TagDisplayInfo {
  readonly name: string;
  readonly avatarUrl: string;
}

/**
 * tags（组织关系表）条目：组织架构唯一的同步域。childType 区分 childId 是人还是 tag
 * （子项展示名走 getUserInfos / getTagInfos，不在此内嵌）。
 * rank 越小越靠前；未显式排序为 2147483647，按 sortKey（名字）字典序沉底。
 * role 标识该子项在这个节点下是否为管理员。
 */
export interface Tag {
  readonly tagId: string;
  readonly childId: string;
  readonly childType: number;
  /** 本节点下的职务展示文本（仅人条目常用）。 */
  readonly title: string;
  readonly rank: number;
  readonly sortKey: string;
  readonly role: number;
  readonly seq: number;
}

export interface TagsPage {
  readonly tags: ReadonlyArray<Tag>;
  readonly page: PageInfo;
}

export interface BlocklistUser {
  readonly uid: string;
  readonly status?: number;
  readonly seq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BlocklistUserPage {
  readonly users: ReadonlyArray<BlocklistUser>;
  readonly page: PageInfo;
}

export interface MutelistEntry {
  readonly target: ConversationTarget;
  /** @deprecated 使用 target。 */
  readonly toUid?: string;
  /** @deprecated 使用 target。 */
  readonly groupId?: string;
  readonly status: number;
  readonly seq: number;
  readonly updatedAt?: number;
}

export interface MutelistEntryPage {
  readonly mutes: ReadonlyArray<MutelistEntry>;
  readonly page: PageInfo;
}

export interface UserInfo {
  readonly uid: string;
  readonly username: string;
  readonly nickname: string;
  readonly avatarUrl: string;
  readonly remarkName?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UserDisplayInfo {
  readonly username: string;
  readonly nickname: string;
  readonly avatarUrl: string;
  readonly remarkName: string;
}

export interface GroupInfo {
  readonly groupId: string;
  readonly name: string;
  readonly avatarUrl: string;
  readonly ownerUid: string;
  readonly remarkName?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GroupDisplayInfo {
  readonly name: string;
  readonly avatarUrl: string;
  readonly remarkName: string;
}

export interface GroupMember {
  readonly userId: string;
  readonly role: GroupRole;
  readonly joinedAt: number;
}

export interface GroupMemberPage {
  readonly members: ReadonlyArray<GroupMember>;
  readonly page: PageInfo;
  readonly total: number;
}

/**
 * 后台同步就绪状态。
 *
 * - memory 模式下无后台同步，`firstSyncComplete` 恒为 `true`，`domains` 为空。
 * - persistent 模式下，`init()` 启动后台首轮同步后各域逐步完成；
 *   全部同步域（messages / conversations / contacts / blocklist / mutelist）
 *   至少完成过一次（status 为 success 或 failed）后 `firstSyncComplete` 变为 `true`，
 *   且之后不再回退为 `false`。
 * - `domains` 记录各域最近一次 `session:sync` 事件的 status，用于诊断和调试。
 */
export interface SyncReadiness {
  /** 各同步域最近一次同步状态。首次同步前对应域为 undefined。 */
  readonly domains: Partial<Record<SyncDomain, SyncStatus>>;
  /** 所有同步域是否至少完成过一次首轮同步。 */
  readonly firstSyncComplete: boolean;
}

export interface SessionSnapshot {
  readonly sessionState: SessionState;
  readonly connectionState: ConnectionState;
  readonly mode: SessionMode;
  readonly currentUid: string;
  readonly isAuthenticated: boolean;
  readonly isSessionInitialized: boolean;
  /** 后台同步就绪辅助状态，只读。 */
  readonly syncReadiness: SyncReadiness;
}

export interface SessionStateChangedEvent {
  readonly from: SessionSnapshot;
  readonly to: SessionSnapshot;
  readonly reason: SessionTransitionReason;
}

export interface ConnectionEvent {
  readonly snapshot: SessionSnapshot;
}

export interface AuthenticatedEvent extends ConnectionEvent {
  readonly uid: string;
}

export interface SessionKickedEvent extends ConnectionEvent {}

export interface SessionSyncEvent extends ConnectionEvent {
  readonly domain: SyncDomain;
  readonly status: SyncStatus;
  readonly cursor?: number;
  readonly error?: Error;
}

export interface MessagesReceivedEvent {
  readonly messages: ReadonlyArray<Message>;
  readonly conversationKeys: ReadonlyArray<string>;
}

export interface MessagesDeletedEvent {
  /** 被删除的消息 id；UI 应据此就地从消息数据窗口删除该消息。 */
  readonly messageId: string;
  /** 该消息所在会话 key（形如 `u:<uid>` / `g:<gid>`）；UI 据此定向刷新会话预览。 */
  readonly key: string;
}

/**
 * 会话清未读事件：keys 为被清未读的会话 key（`u:<uid>` / `g:<gid>`）。
 * UI 若这些会话在数据窗口内，应调用 `getConversations({ targets })` 拉取当前状态并更新窗口；不在窗口则忽略。
 */
export interface ConversationsClearunreadEvent {
  readonly keys: ReadonlyArray<string>;
}

/** 会话删除事件：keys 为被删除的会话 key。处理方式同上（拉取后命中删除态则从窗口移除）。 */
export interface ConversationsDeleteEvent {
  readonly keys: ReadonlyArray<string>;
}

/**
 * 会话变化事件：本端发送消息成功后触发，`keys` 为发出消息所在会话 key。
 * UI 据此让该会话「移动到顶部」（重拉首页 + 滚回顶部）。他端来消息走 `messages:received`。
 */
export interface ConversationsSentEvent {
  readonly keys: ReadonlyArray<string>;
}

export interface UnreadUpdatedEvent {
  readonly target: ConversationTarget;
  readonly count: number;
}

export interface ContactsUpdatedEvent {
  readonly reason: ContactsUpdateReason;
}

export interface BlocklistUpdatedEvent extends ConnectionEvent {
  readonly reason: "notification";
}

export interface MutelistUpdatedEvent extends ConnectionEvent {
  readonly reason: "notification";
}

/** org:updated 客户端事件：组织架构发生变化，UI 应重拉受影响组织的展开数据。 */
export interface OrgUpdatedEvent extends ConnectionEvent {
  /** 发生变化的组织 ID 列表（通知合并后去重）。 */
  readonly orgIds: ReadonlyArray<string>;
}

export interface DisplayInfoUpdatedEvent {
  readonly keys: ReadonlyArray<string>;
  readonly scope: DisplayInfoScope;
}

export interface SentMessage {
  readonly seq: number;
  readonly messageId: string;
  readonly message: Message;
}

export interface UploadResult {
  /** 媒体 ID，消息 body 仅用 media_id 引用媒体。 */
  readonly mediaId: string;
  /** 兼容用途的访问地址（如头像）；消息媒体应优先使用 mediaId。 */
  readonly url: string;
  readonly size?: number;
}

export interface UpdateUserInfoInput {
  readonly nickname?: string;
  readonly avatarUrl?: string;
}

export interface UpdateGroupInfoInput {
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface ClientErrorEvent {
  readonly error: import("./errors").YimsgError;
  readonly context: string;
  readonly snapshot: SessionSnapshot;
}

/**
 * SDK 最大内存估算分项明细。
 * 每项均为当前 ClientOptions 配置下的 JS 堆上界（字节），包含对象自身及其字符串、Map/Set 条目开销。
 * 持久存储模式下 本地磁盘副本不计入本估算。
 */
export interface SdkMaxMemoryBreakdown {
  /**
   * 用户显示信息缓存（独立 BoundedU64Map，FIFO 淘汰）满载上界字节数。
   * 上界 = 固定容量 × (slot 结构开销 + DisplayCacheEntry 值字节)，
   * 容量由 cacheMaxEntries 向上对齐到 bucketCount(2^n) × bucketCapacity 决定。
   * 单值 DisplayCacheEntry ≈ 448 字节（对象头64 + username64 + name64 + avatar192 + remark48 + expireAt8）。
   */
  readonly profileUserCacheBytes: number;
  /**
   * 群显示信息缓存（与用户缓存对称的独立 BoundedU64Map）满载上界字节数。
   * 用户 / 群已拆分为两套纯 uint64 key 的有界集合，本字段不再恒为 0；
   * 同一 cacheMaxEntries 下与 profileUserCacheBytes 相等。
   */
  readonly profileGroupCacheBytes: number;
  /**
   * 显示信息后台加载队列上界字节数。
   * 用户与群各有 pending + loading 两个固定容量 BoundedU64Set，共 4 个，
   * reject 策略保证每个域 pending.size + loading.size ≤ profileLoadQueueMaxEntries。
   * 上界 = 4 × (固定容量 × 每 slot 9 字节)，容量含 2× headroom 并对齐到 2 的幂。
   */
  readonly profileQueueBytes: number;
  /**
   * WsTransport 最大并发未响应请求上界字节数。
   * 待响应请求存于固定容量 BoundedU64Map（reject 淘汰）；sendBinary() 在
   * size ≥ maxPendingRequests 时立即拒绝，底层有界容量进一步保证 size ≤ capacity。
   * 上界 = 固定容量 × (slot 结构开销 + 单值 PendingReq ≈ 384 字节)，容量含 2× headroom。
   */
  readonly pendingRequestsBytes: number;
  /**
   * 消息增量同步单批瞬态缓冲上界字节数（不受 ClientOptions 影响）。
   * = DEFAULT_SYNC_BATCH_SIZE（200）× BYTES_PER_SYNC_MESSAGE（640 字节/条）= 128,000 字节。
   * 推导：Message（uid + seq + msg_id + from_uid + to_uid + group_id + msg_type + content + send_time）+ 对象头 + 数组槽
   * ≈ 8+8+68+68+68+68+8+232+8+80+8 = 624 字节，上取整至 640。
   * handleMessagesReceived 每批派发后立即释放，不累积。
   */
  readonly syncBatchBytes: number;
  /**
   * 转发包单次下载缓冲上界字节数（不受 ClientOptions 影响）。
   * = DEFAULT_MAX_FORWARD_BUNDLE_BYTES（1 048 576 字节 = 1 MB）。
   * loadForwardedMessages 在读取 arrayBuffer 前校验 Content-Length，超限抛错。
   */
  readonly forwardBundleBytes: number;
  /**
   * SDK 固定基线开销（字节）。
   * 包含：SessionLifecycleMachine、EventEmitter 监听器表、
   * WsTransport 连接状态与计数器、各内部协作对象固定字段，合计约 64 KB。
   */
  readonly baselineBytes: number;
}

/**
 * SDK 最大内存估算结果。
 * 由 `YimsgClient.estimateMaxMemoryBytes(options)` 静态方法返回。
 */
export interface SdkMaxMemoryEstimate {
  /**
   * 各分项之和（字节）。
   * 该值是 JS 堆占用的理论上界，实际峰值因 V8 内部优化、GC 时机和字段实际内容长度而不同。
   * 持久存储模式下 本地磁盘副本不计入本估算。
   */
  readonly totalBytes: number;
  /** 各分项明细，用于诊断哪个参数主导了内存使用。 */
  readonly breakdown: SdkMaxMemoryBreakdown;
}

export interface ClientEvents {
  "session:state-changed": (event: SessionStateChangedEvent) => void;
  "connection:connected": (event: ConnectionEvent) => void;
  "connection:disconnected": (event: ConnectionEvent) => void;
  "connection:reconnecting": (event: ConnectionEvent) => void;
  "auth:authenticated": (event: AuthenticatedEvent) => void;
  "session:sync": (event: SessionSyncEvent) => void;
  "session:kicked": (event: SessionKickedEvent) => void;
  "messages:received": (event: MessagesReceivedEvent) => void;
  "messages:deleted": (event: MessagesDeletedEvent) => void;
  "conversations:clearunread": (event: ConversationsClearunreadEvent) => void;
  "conversations:delete": (event: ConversationsDeleteEvent) => void;
  "conversations:sent": (event: ConversationsSentEvent) => void;
  "contacts:updated": (event: ContactsUpdatedEvent) => void;
  "blocklist:updated": (event: BlocklistUpdatedEvent) => void;
  "mutelist:updated": (event: MutelistUpdatedEvent) => void;
  "org:updated": (event: OrgUpdatedEvent) => void;
  "display:updated": (event: DisplayInfoUpdatedEvent) => void;
  error: (event: ClientErrorEvent) => void;
}
