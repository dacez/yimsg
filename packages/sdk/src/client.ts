import { EventEmitter } from "./internal/events";
import { freezeMap, freezeObject } from "./internal/readonly";
import { WsTransport } from "./transport/connection";
import { DisplayInfoCache, type BoundedCollectionStats } from "./state/cache";
import { SessionLifecycleMachine } from "./state/lifecycle";
import { ClientEventBridge } from "./internal/client-event-bridge";
import { ClientMessageFacade } from "./internal/client-message-facade";
import type { SendImageInput, SendFileInput } from "./internal/client-message-facade";
import { ClientSessionRuntime } from "./internal/client-session-runtime";
import {
  assertNonEmpty,
  normalizeDisplayInfoKeys,
  requireAuthenticated,
} from "./internal/client-guards";
import {
  updateCreatedGroupDisplayCache,
  updateFavoriteGroupDisplayCache,
  updateGroupInfoDisplayCache,
  updateRemarkDisplayCache,
  updateUnfavoriteGroupDisplayCache,
  updateUserInfoDisplayCache,
} from "./internal/client-cache-updates";
import {
  wrapBlocklistUserPage,
  wrapContactPage,
  wrapTagsPage,
  wrapConversationPage,
  wrapGroupMemberPage,
  wrapMessagePage,
  wrapMutelistEntryPage,
  wrapSentMessage,
} from "./internal/client-pages";
import type {
  AuthResult,
  ClientConfig,
  ClientEvents,
  ClientOptions,
  ConversationDescriptor,
  ConversationTarget,
  ConversationPage,
  ContactPage,
  TagsPage,
  BlocklistUserPage,
  MutelistEntryPage,
  MessageBody,
  MessagePage,
  GroupDisplayInfo,
  OrgDisplayInfo,
  TagDisplayInfo,
  GroupMemberPage,
  LocalConversation as PublicLocalConversation,
  Message as PublicMessage,
  MessageContentDescriptor,
  SendQuotedTextInput,
  SentMessage as PublicSentMessage,
  SessionMode,
  SessionSnapshot,
  SessionLocalDataResetScope,
  SessionFileSystem,
  SessionStartOptions,
  SessionStartResult,
  UpdateGroupInfoInput,
  UpdateUserInfoInput,
  UploadCategory,
  UploadResult,
  UserDisplayInfo,
  UserInfo as PublicUserInfo,
  SdkMaxMemoryEstimate,
} from "./types";
import type { MsgType } from "./models";
import { MSG_TYPE_TEXT } from "./constants";
import {
  DEFAULT_MAX_BATCH_LIMIT,
  DEFAULT_MAX_PAGE_LIMIT,
  DEFAULT_RECALL_WINDOW_SECONDS,
  DEFAULT_SYNC_BATCH_SIZE,
  DEFAULT_MAX_FORWARD_BUNDLE_BYTES,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_PROFILE_LOAD_QUEUE_MAX_ENTRIES,
  DEFAULT_WS_MAX_PENDING_REQUESTS,
  BYTES_PER_DISPLAY_CACHE_VALUE,
  BYTES_PER_PENDING_REQUEST_VALUE,
  BYTES_PER_SYNC_MESSAGE,
  SDK_BASELINE_BYTES,
  DISPLAY_CACHE_BUCKET_CAPACITY,
  DISPLAY_QUEUE_LOAD_FACTOR,
  PENDING_REQUEST_BUCKET_CAPACITY,
  PENDING_REQUEST_LOAD_FACTOR,
} from "./internal/sdk-defaults";
import {
  estimateBoundedU64MapBytes,
  estimateBoundedU64SetBytes,
} from "./internal/bounded";
import { clampBatchLimit, clampOptionalPageLimit } from "./internal/limits";
import {
  mapUserDisplayInfo,
  mapUserInfo,
  mapGroupDisplayInfo,
  mapOrgDisplayInfo,
  mapTagDisplayInfo,
} from "./internal/model-mappers";
import {
  AuthError,
  ConnectionError,
  YimsgError,
  RequestError,
  StorageModeError,
  ValidationError,
  isConnectionIssue,
  isYimsgError,
  wrapError,
} from "./errors";

import * as actions from "./generated/actions.gen";
import * as actionMappers from "./internal/action-mappers";
import * as uploadModule from "./modules/upload";

/** 将 proto ClientConfig（int64 字段为 string）转为 SDK 的 ClientConfig 类型。 */
function mapProtoClientConfig(cc?: {
  cache_ttl_seconds?: string;
  cache_max_entries?: string;
  recall_window_seconds?: string;
  batch_max_limit?: string;
}): ClientConfig | undefined {
  if (!cc) return undefined;
  const ttl = Number(cc.cache_ttl_seconds);
  const maxEntries = Number(cc.cache_max_entries);
  const recall = Number(cc.recall_window_seconds);
  const batch = Number(cc.batch_max_limit);
  if (isNaN(ttl) || isNaN(maxEntries) || isNaN(recall) || isNaN(batch))
    return undefined;
  return {
    cacheTtlSeconds: ttl,
    cacheMaxEntries: maxEntries,
    recallWindowsSeconds: recall,
    batchMaxLimit: batch,
  };
}

/**
 * YimsgClient — SDK 单门面。
 *
 * 对外暴露一个稳定入口，对内把连接生命周期、会话快照、
 * 显示名缓存和 DataGateway 编排拆成独立协作对象。
 */
export class YimsgClient extends EventEmitter<ClientEvents> {
  private readonly _transport: WsTransport;
  private readonly _displayInfoCache: DisplayInfoCache;
  private readonly lifecycle = new SessionLifecycleMachine();
  private readonly eventBridge: ClientEventBridge;
  private readonly messageFacade: ClientMessageFacade;
  private readonly runtime: ClientSessionRuntime;

  private readonly uploadUrl: string;
  private readonly connectTimeoutMs: number;
  private authToken = "";
  private _recallWindowSeconds: number;
  private _batchMaxLimit: number;
  private readonly _clientBatchMaxLimit: number;
  private readonly _cacheTtlSeconds: number;
  private readonly _cacheMaxEntries: number;
  private _serverBatchMaxLimit: number | null = null;

  constructor(options: ClientOptions = {}) {
    super();

    const wsUrl = options.wsUrl ?? this.defaultWsUrl();
    this._transport = new WsTransport({
      url: wsUrl,
      timeout: options.requestTimeout,
      reconnectInterval: options.reconnectInterval,
      reconnectNotifyThreshold: options.reconnectNotifyThreshold,
      heartbeatInterval: options.heartbeatInterval,
      wsFactory: options.wsFactory,
      maxPendingRequests: options.maxPendingRequests,
    });
    this.uploadUrl = options.uploadUrl ?? "/api/upload";
    this.connectTimeoutMs = options.requestTimeout ?? 15000;
    const initialBatchMaxLimit = clampBatchLimit(
      options.batchMaxLimit ?? DEFAULT_MAX_BATCH_LIMIT,
    );
    this._clientBatchMaxLimit = initialBatchMaxLimit;
    this._cacheTtlSeconds = Math.max(
      0,
      options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
    );
    this._cacheMaxEntries = Math.max(
      0,
      options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    );
    this._displayInfoCache = new DisplayInfoCache({
      ttlSeconds: this._cacheTtlSeconds,
      maxEntries: this._cacheMaxEntries,
      batchMaxLimit: initialBatchMaxLimit,
      queueMaxEntries: options.profileLoadQueueMaxEntries,
      // 该函数只在会话初始化后由后台加载路径调用；此时 runtime 已完成赋值。
      dataGateway: () => this.runtime?.getDataGateway() ?? null,
    });
    this._recallWindowSeconds =
      options.recallWindowSeconds ?? DEFAULT_RECALL_WINDOW_SECONDS;
    this._batchMaxLimit = initialBatchMaxLimit;

    this.lifecycle.setTransitionListener((event) => {
      this.emit("session:state-changed", event);
    });

    this.eventBridge = new ClientEventBridge({
      emitClientEvent: (event, payload) => this.emitClientEvent(event, payload),
      getSessionSnapshot: () => this.getSessionSnapshot(),
    });
    this.runtime = new ClientSessionRuntime({
      transport: this._transport,
      cache: this._displayInfoCache,
      lifecycle: this.lifecycle,
      connectTimeoutMs: this.connectTimeoutMs,
      shouldKeepTransportAlive: () => Boolean(this.authToken),
      onConnectionEvent: (eventName) =>
        this.eventBridge.emitConnectionEvent(eventName),
      onMessagesReceived: (messages) =>
        this.eventBridge.handleMessagesReceived(messages),
      onContactsChanged: (contacts, replace) =>
        this.eventBridge.handleContactsChanged(contacts, replace),
      onBlocklistChanged: () => this.eventBridge.handleBlocklistChanged(),
      onMutelistChanged: () => this.eventBridge.handleMutelistChanged(),
      onOrgsChanged: (orgIds) => this.eventBridge.handleOrgsChanged(orgIds),
      onUnreadCleared: (convKey) => this.eventBridge.handleUnreadCleared(convKey),
      onConversationDeleted: (convKey) =>
        this.eventBridge.handleConversationDeleted(convKey),
      onMessageDeleted: (messageId, convKey) =>
        this.eventBridge.handleMessageDeleted(messageId, convKey),
      onSessionKicked: () => this.eventBridge.emitSessionKicked(),
      onError: (error, context) =>
        this.eventBridge.emitError(
          this.normalizeInternalError(error, context),
          context,
        ),
      onSync: (event) =>
        this.emitClientEvent(
          "session:sync",
          freezeObject({
            ...event,
            snapshot: this.getSessionSnapshot(),
          }),
        ),
      getBatchMaxLimit: () => this._batchMaxLimit,
    });

    this.messageFacade = new ClientMessageFacade({
      getSessionSnapshot: () => this.getSessionSnapshot(),
      getUserInfos: (uids) => this.getUserInfos(uids),
      uploadFile: (file, category) => this.uploadFile(file, category),
      sendMessage: (target, body, msgType) =>
        this.sendMessage(target, body, msgType),
    });

    this._displayInfoCache.onDisplayUpdated = (keys, scope) => {
      this.eventBridge.emitDisplayUpdated(keys, scope);
    };
    this._displayInfoCache.onError = (error, context) => {
      this.eventBridge.emitError(
        this.normalizeInternalError(error, context),
        context,
      );
    };
  }

  private defaultWsUrl(): string {
    if (typeof location === "undefined") return "ws://localhost:8080/ws";
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  private emitClientEvent<K extends keyof ClientEvents>(
    event: K,
    payload: Parameters<ClientEvents[K]>[0],
  ): void {
    const args = [payload] as unknown as Parameters<ClientEvents[K]>;
    this.emit(event, ...args);
  }

  getSessionSnapshot(): SessionSnapshot {
    const lifecycle = this.lifecycle.getSnapshot();
    return freezeObject({
      ...lifecycle,
      syncReadiness: this.runtime.getSyncReadiness(),
    });
  }

  /**
   * 返回当前生效客户端配置。
   *
   * `batchMaxLimit` 认证前来自构造参数或 SDK 默认值；认证后若服务端也返回
   * `client_config.batch_max_limit`，则取两者较小值。
   */
  getClientConfig(): ClientConfig {
    return freezeObject({
      cacheTtlSeconds: this._cacheTtlSeconds,
      cacheMaxEntries: this._cacheMaxEntries,
      recallWindowsSeconds: this._recallWindowSeconds,
      batchMaxLimit: this._batchMaxLimit,
    });
  }

  /**
   * 返回所有长期驻留有界集合的实时运行时统计（size / capacity / loadFactor /
   * rejectCount / evictionCount 等），用于 benchmark、内存诊断与回归监控。
   * 与 estimateMaxMemoryBytes() 的「理论上界」互补：本方法反映「当前实际占用」。
   */
  getBoundedCollectionStats(): BoundedCollectionStats {
    return freezeObject({
      displayInfoCache: this._displayInfoCache.stats(),
      pendingRequests: this._transport.pendingRequestsStats(),
    });
  }

  /**
   * 静态计算当前 ClientOptions 配置下 SDK 的最大 JS 堆内存用量（字节）。
   *
   * 该方法纯静态、无副作用，可在构造实例前调用，用于容量评估或配置合理性检查。
   * 返回值是理论上界：所有有界数据结构同时达到上限时的估算总和；
   * 实际峰值因 V8 内部优化（内联缓存、压缩指针、GC）、字段真实长度和使用路径不同而更低。
   *
   * ## 计算公式
   * ```
   * totalBytes
   *   = profileUserCacheBytes  (= 用户显示信息 BoundedU64Map 满载字节，由 cacheMaxEntries 决定)
   *   + profileGroupCacheBytes (= 群显示信息 BoundedU64Map 满载字节，由 cacheMaxEntries 决定)
   *   + profileQueueBytes      (= 4 × 待拉取/在飞 BoundedU64Set 满载字节，由 profileLoadQueueMaxEntries 决定)
   *   + pendingRequestsBytes   (= 待响应请求 BoundedU64Map 满载字节，由 maxPendingRequests 决定)
   *   + syncBatchBytes         (= 200 × 640 = 128,000  — 常量，不受配置影响)
   *   + forwardBundleBytes     (= 1,048,576           — 常量，不受配置影响)
   *   + baselineBytes          (= 65,536              — 常量，不受配置影响)
   * ```
   *
   * ## 论证
   * 所有长期驻留集合均为固定容量有界结构（BoundedU64Map / BoundedU64Set），容量在
   * 构造时由配置决定并向上对齐到 `bucketCount(2^n) × bucketCapacity`，运行期不再增长。
   * 每项满载字节 = `capacity × (固定 slot 结构开销 + 值/引用字节)`，由
   * `estimateBoundedU64MapBytes` / `estimateBoundedU64SetBytes` 计算。
   * - `profileUserCacheBytes` / `profileGroupCacheBytes`：用户与群各一套 FIFO BoundedU64Map，
   *   单值 DisplayCacheEntry ≈ 448 字节（对象头64 + username64 + name64 + avatar192 + remark48 + expireAt8）。
   *   FIFO 淘汰保证 size ≤ capacity（见 cache.ts ScopeStore）。
   * - `profileQueueBytes`：用户与群各有 pending + loading 两个 BoundedU64Set，共 4 个，
   *   reject 策略保证「队列满」精确发生在 profileLoadQueueMaxEntries（见 cache.ts enqueue）。
   * - `pendingRequestsBytes`：WsTransport.sendBinary() 在 size ≥ maxPendingRequests 时立即拒绝，
   *   底层 BoundedU64Map(reject) 进一步保证 size ≤ capacity（见 connection.ts），
   *   单值 PendingReq ≈ 384 字节（resolve+reject 闭包256 + timer16 + codec 引用8 + 对象头64）。
   * - `syncBatchBytes`：handleMessagesReceived 每次 syncMessages 最多拉取 DEFAULT_SYNC_BATCH_SIZE=200 条，
   *   立即通过 emitMessagesReceived 派发后释放，不累积（见 base.ts）。
   *   每条 Message ≈ 624 字节，上取整至 640，共 200×640 = 128,000 字节。
   * - `forwardBundleBytes`：loadForwardedMessages 在 arrayBuffer() 前校验 Content-Length ≤
   *   DEFAULT_MAX_FORWARD_BUNDLE_BYTES=1 MB，超限抛错，瞬态峰值有界。
   * - `baselineBytes`：固定对象（SessionLifecycleMachine、EventEmitter、
   *   WsTransport 基础字段、各协作对象）常驻内存，经实测约 64 KB。
   *
   * 持久存储模式下 本地磁盘副本属于 `StorageManager` 管辖，不计入 JS 堆，本方法不涵盖。
   *
   * @param options 与构造 YimsgClient 使用相同的选项对象；未传则使用所有 SDK 默认值。
   * @returns 只读的 SdkMaxMemoryEstimate，包含总字节数和各分项明细。
   */
  static estimateMaxMemoryBytes(
    options: ClientOptions = {},
  ): SdkMaxMemoryEstimate {
    const cacheMaxEntries = Math.max(
      0,
      options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    );
    const profileLoadQueueMaxEntries = Math.max(
      0,
      options.profileLoadQueueMaxEntries ??
        DEFAULT_PROFILE_LOAD_QUEUE_MAX_ENTRIES,
    );
    const maxPendingRequests = Math.max(
      0,
      options.maxPendingRequests ?? DEFAULT_WS_MAX_PENDING_REQUESTS,
    );

    // 用户与群显示信息缓存现为两套独立的固定容量 BoundedU64Map（FIFO 淘汰）。
    const profileUserCacheBytes = estimateBoundedU64MapBytes(
      cacheMaxEntries, BYTES_PER_DISPLAY_CACHE_VALUE, DISPLAY_CACHE_BUCKET_CAPACITY, 'fifo',
    );
    const profileGroupCacheBytes = estimateBoundedU64MapBytes(
      cacheMaxEntries, BYTES_PER_DISPLAY_CACHE_VALUE, DISPLAY_CACHE_BUCKET_CAPACITY, 'fifo',
    );
    // 待拉取 / 在飞队列：用户与群各 2 个 BoundedU64Set（pending + loading），共 4 个。
    const profileQueueBytes = 4 * estimateBoundedU64SetBytes(
      profileLoadQueueMaxEntries, DISPLAY_CACHE_BUCKET_CAPACITY, DISPLAY_QUEUE_LOAD_FACTOR,
    );
    // 待响应请求：固定容量 BoundedU64Map（reject 淘汰）。
    const pendingRequestsBytes = estimateBoundedU64MapBytes(
      maxPendingRequests, BYTES_PER_PENDING_REQUEST_VALUE, PENDING_REQUEST_BUCKET_CAPACITY, 'reject', PENDING_REQUEST_LOAD_FACTOR,
    );
    const syncBatchBytes = DEFAULT_SYNC_BATCH_SIZE * BYTES_PER_SYNC_MESSAGE;
    const forwardBundleBytes = DEFAULT_MAX_FORWARD_BUNDLE_BYTES;
    const baselineBytes = SDK_BASELINE_BYTES;

    const totalBytes =
      profileUserCacheBytes +
      profileGroupCacheBytes +
      profileQueueBytes +
      pendingRequestsBytes +
      syncBatchBytes +
      forwardBundleBytes +
      baselineBytes;

    return Object.freeze({
      totalBytes,
      breakdown: Object.freeze({
        profileUserCacheBytes,
        profileGroupCacheBytes,
        profileQueueBytes,
        pendingRequestsBytes,
        syncBatchBytes,
        forwardBundleBytes,
        baselineBytes,
      }),
    });
  }

  private applyClientConfig(config: AuthResult["clientConfig"]): void {
    if (!config) return;
    this._recallWindowSeconds = config.recallWindowsSeconds;
    this._serverBatchMaxLimit = clampBatchLimit(config.batchMaxLimit);
    this.applyEffectiveBatchMaxLimit();
  }

  private applyEffectiveBatchMaxLimit(): void {
    const nextLimit =
      this._serverBatchMaxLimit === null
        ? this._clientBatchMaxLimit
        : Math.min(this._clientBatchMaxLimit, this._serverBatchMaxLimit);
    this._batchMaxLimit = nextLimit;
  }

  describeConversation(
    source: PublicLocalConversation | ConversationTarget | string,
  ): ConversationDescriptor {
    return this.messageFacade.describeConversation(source);
  }

  describeMessageConversation(message: PublicMessage): ConversationDescriptor {
    return this.messageFacade.describeMessageConversation(message);
  }

  describeMessage(message: PublicMessage): MessageContentDescriptor {
    return this.messageFacade.describeMessage(message);
  }

  validateTextMessage(content: string): void {
    this.messageFacade.validateTextMessage(content);
  }

  private normalizeInternalError(
    error: unknown,
    context: string,
  ): YimsgError {
    if (isYimsgError(error)) return error;
    if (
      context.includes("db") ||
      context.includes("cache") ||
      context.includes("group batch load") ||
      context.includes("uid batch load")
    ) {
      return wrapError(
        error,
        new StorageModeError("STORAGE_FAILED", "本地存储处理失败", { context }),
      );
    }
    if (isConnectionIssue(error)) {
      return wrapError(
        error,
        new ConnectionError("CONNECTION_FAILED", "连接失败", { context }),
      );
    }
    return wrapError(
      error,
      new RequestError("REQUEST_FAILED", "请求处理失败", { context }),
    );
  }

  private requireAuthenticated(action: string): { uid: string; token: string } {
    return requireAuthenticated(
      this.getSessionSnapshot(),
      this.authToken,
      action,
    );
  }

  private assertNonEmpty(value: string, field: string, action: string): void {
    assertNonEmpty(value, field, action);
  }

  private notifyContactsAfterMutation(): void {
    this.runtime.notifyContactsChangedAfterMutation();
  }

  destroy(): void {
    this._transport.disconnect();
    this.runtime.clearRuntimeState();
    this.authToken = "";
    this.lifecycle.transition(
      {
        sessionState: "destroyed",
        connectionState: "disconnected",
        mode: "instant",
        currentUid: "",
      },
      "destroyed",
    );
    this.runtime.dispose();
    this._displayInfoCache.onDisplayUpdated = null;
    this._displayInfoCache.onError = null;
    this.lifecycle.setTransitionListener(null);
    this.removeAllListeners();
  }

  async register(
    username: string,
    password: string,
    nickname: string,
  ): Promise<void> {
    this.assertNonEmpty(username, "username", "register");
    this.assertNonEmpty(password, "password", "register");
    this.assertNonEmpty(nickname, "nickname", "register");
    try {
      await this.runtime.ensureConnected();
      await actions.register(this._transport, {
        username,
        password,
        nickname,
      });
    } catch (error) {
      throw wrapError(
        error,
        new AuthError("注册失败", { context: "register" }),
      );
    }
  }

  async login(username: string, password: string): Promise<AuthResult> {
    this.assertNonEmpty(username, "username", "login");
    this.assertNonEmpty(password, "password", "login");
    try {
      await this.runtime.ensureConnected();
      const resp = await actions.login(this._transport, { username, password });
      const serverConfig = mapProtoClientConfig(resp.client_config);
      this.applyClientConfig(serverConfig);
      this.authToken = resp.token;
      const nextState =
        this.runtime.getDataGateway() &&
        this.getSessionSnapshot().isSessionInitialized
          ? "ready"
          : "authenticated";
      this.lifecycle.transition(
        {
          sessionState: nextState,
          currentUid: resp.uid,
        },
        "authenticated",
      );
      this.eventBridge.emitAuthenticated(resp.uid);
      const clientConfig = serverConfig ? this.getClientConfig() : undefined;
      return freezeObject({
        uid: resp.uid,
        token: resp.token,
        ...(clientConfig ? { clientConfig } : {}),
      });
    } catch (error) {
      throw wrapError(error, new AuthError("登录失败", { context: "login" }));
    }
  }

  async authenticate(token: string): Promise<AuthResult> {
    this.assertNonEmpty(token, "token", "authenticate");
    try {
      await this.runtime.ensureConnected();
      const resp = await actions.authenticate(this._transport, { token });
      const serverConfig = mapProtoClientConfig(resp.client_config);
      this.applyClientConfig(serverConfig);
      this.authToken = token;
      const nextState =
        this.runtime.getDataGateway() &&
        this.getSessionSnapshot().isSessionInitialized
          ? "ready"
          : "authenticated";
      this.lifecycle.transition(
        {
          sessionState: nextState,
          currentUid: resp.uid,
        },
        "authenticated",
      );
      this.eventBridge.emitAuthenticated(resp.uid);
      const clientConfig = serverConfig ? this.getClientConfig() : undefined;
      return freezeObject({
        uid: resp.uid,
        token,
        ...(clientConfig ? { clientConfig } : {}),
      });
    } catch (error) {
      throw wrapError(
        error,
        new AuthError("token 认证失败", { context: "authenticate" }),
      );
    }
  }

  async logout(): Promise<void> {
    try {
      if (this._transport.connected && this.authToken) {
        await actions.logout(this._transport, { token: this.authToken });
      }
    } catch (error) {
      this.eventBridge.emitError(
        this.normalizeInternalError(error, "logout"),
        "logout",
      );
    }
    this._transport.disconnect();
    this.runtime.clearRuntimeState();
    this.authToken = "";
    this.lifecycle.transition(
      {
        sessionState: "idle",
        connectionState: "disconnected",
        mode: "instant",
        currentUid: "",
      },
      "logout",
    );
  }

  private async initializeSession(options: {
    mode: SessionMode;
    instanceId?: string;
    fileSystem?: SessionFileSystem;
  }): Promise<void> {
    const { uid } = this.requireAuthenticated("startSession");
    if (options.mode !== "instant" && options.mode !== "persistent") {
      throw new ValidationError(
        "startSession 只支持 instant 或 persistent 模式",
        {
          context: "startSession",
          details: { mode: options.mode },
        },
      );
    }

    try {
      await this.runtime.initializeSession(uid, options.mode, {
        instanceId: options.instanceId,
        fileSystem: options.fileSystem,
      });
    } catch (error) {
      if (options.mode === "persistent") {
        throw wrapError(
          error,
          new StorageModeError("STORAGE_FAILED", "持久存储会话初始化失败", {
            context: "startSession",
          }),
        );
      }
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "会话初始化失败", {
          context: "startSession",
        }),
      );
    }
  }

  async startSession(
    options: SessionStartOptions = {},
  ): Promise<SessionStartResult> {
    const { uid } = this.requireAuthenticated("startSession");
    const requestedStorage = options.storage ?? "instant";
    if (requestedStorage !== "instant" && requestedStorage !== "persistent") {
      throw new ValidationError(
        "startSession 只支持 instant 或 persistent 存储",
        {
          context: "startSession",
          details: { storage: requestedStorage },
        },
      );
    }

    const resetLocalData = this.normalizeResetLocalData(options.resetLocalData);
    const requestedFileSystem = options.fileSystem ?? null;
    if (
      requestedFileSystem !== null &&
      requestedFileSystem !== "opfs" &&
      requestedFileSystem !== "local"
    ) {
      throw new ValidationError(
        "startSession fileSystem 只支持 opfs 或 local",
        {
          context: "startSession",
          details: { fileSystem: requestedFileSystem },
        },
      );
    }

    let persistentStorageAvailable = true;
    let actualStorage = requestedStorage;
    let mode: SessionMode =
      requestedStorage === "persistent" ? "persistent" : "instant";
    let actualFileSystem: SessionFileSystem | null = null;
    let resetLocalDataError: Error | null = null;

    if (requestedStorage === "persistent") {
      const resolved =
        await this.resolvePersistentFileSystem(requestedFileSystem);
      persistentStorageAvailable = resolved.available;
      if (!persistentStorageAvailable) {
        actualStorage = "instant";
        mode = "instant";
      } else {
        actualFileSystem = resolved.fileSystem;
      }
    }

    const shouldResetLocalData =
      resetLocalData !== "none" &&
      !(requestedStorage === "persistent" && actualStorage === "instant");
    if (shouldResetLocalData) {
      try {
        const scope: Exclude<SessionLocalDataResetScope, "none"> =
          resetLocalData;
        await this.clearSessionLocalData({
          scope,
          uid,
          instanceId: options.instanceId,
          fileSystem: actualFileSystem,
        });
      } catch (error) {
        resetLocalDataError =
          error instanceof Error ? error : new Error(String(error));
      }
    }

    await this.initializeSession({
      mode,
      instanceId: options.instanceId,
      fileSystem: actualFileSystem ?? undefined,
    });

    return freezeObject({
      requestedStorage,
      actualStorage,
      requestedFileSystem,
      actualFileSystem,
      mode,
      degraded: requestedStorage !== actualStorage,
      persistentStorageAvailable,
      resetLocalData,
      resetLocalDataError,
    });
  }

  private async clearSessionLocalData(options: {
    scope: Exclude<SessionLocalDataResetScope, "none">;
    uid?: string;
    instanceId?: string;
    fileSystem: SessionFileSystem | null;
  }): Promise<void> {
    if (options.scope === "current-user") {
      const uid = options.uid || this.requireAuthenticated("startSession").uid;
      this.assertNonEmpty(uid, "uid", "startSession");
      await this.clearPersistentSessionData({
        uid,
        instanceId: options.instanceId,
        fileSystem: options.fileSystem,
      });
      return;
    }
    if (options.scope === "all") {
      await this.clearAllPersistentSessionData(options.fileSystem);
      return;
    }
    throw new ValidationError(
      "startSession resetLocalData 只支持 current-user 或 all 范围",
      {
        context: "startSession",
        details: { scope: options.scope },
      },
    );
  }

  private normalizeResetLocalData(
    value: SessionStartOptions["resetLocalData"],
  ): SessionLocalDataResetScope {
    if (value === undefined || value === false) return "none";
    if (value === "none" || value === "current-user" || value === "all")
      return value;
    throw new ValidationError(
      "startSession resetLocalData 只支持 none、current-user 或 all",
      {
        context: "startSession",
        details: { resetLocalData: value },
      },
    );
  }

  private async resolvePersistentFileSystem(
    requested: SessionFileSystem | null,
  ): Promise<{ fileSystem: SessionFileSystem; available: boolean }> {
    const { isPersistentFileSystemAvailable, isNodeRuntime } =
      await import("./datagateway/sqlite-db-factory");
    const candidates: SessionFileSystem[] = requested
      ? [requested]
      : isNodeRuntime()
        ? ["local", "opfs"]
        : ["opfs", "local"];

    for (const candidate of candidates) {
      const available = await isPersistentFileSystemAvailable(candidate);
      if (available) {
        return { fileSystem: candidate, available: true };
      }
    }

    return { fileSystem: candidates[0] ?? "opfs", available: false };
  }

  private async clearPersistentSessionData(options: {
    uid: string;
    instanceId?: string;
    fileSystem: SessionFileSystem | null;
  }): Promise<void> {
    if (!options.fileSystem) return;
    const { createPersistentDbApi } =
      await import("./datagateway/sqlite-db-factory");
    const { buildPersistentDbName, terminateDbApi } = await import(
      "./datagateway/persistent"
    );
    const db = await createPersistentDbApi(options.fileSystem);
    try {
      await db.deleteDb(
        buildPersistentDbName(options.uid, options.instanceId ?? "default"),
      );
    } finally {
      terminateDbApi(db);
    }
  }

  private async clearAllPersistentSessionData(
    fileSystem: SessionFileSystem | null,
  ): Promise<void> {
    const { clearAllPersistentDataByFileSystem } =
      await import("./datagateway/sqlite-db-factory");
    const targets: SessionFileSystem[] = fileSystem
      ? [fileSystem]
      : ["opfs", "local"];
    for (const target of targets) {
      try {
        await clearAllPersistentDataByFileSystem(target);
      } catch {
        // Ignore unavailable backend failures.
      }
    }
  }

  async sendMessage(
    target: ConversationTarget,
    body: MessageBody,
    msgType: MsgType = MSG_TYPE_TEXT,
  ): Promise<PublicSentMessage> {
    const { uid } = this.requireAuthenticated("sendMessage");
    try {
      const groupId = (target as { groupId?: string }).groupId;
      const toUid =
        typeof groupId === "string" ? "0" : (target as { toUid: string }).toUid;
      const gid = typeof groupId === "string" ? groupId : "0";
      const resp = await actions.sendMessage(
        this._transport,
        actionMappers.sendMessageRequest(target, body, msgType),
      );
      const seq = Number(resp.seq);
      const msgId = resp.msg_id;
      // 发送成功：定向刷新该会话（预览 / 排序）。
      this.eventBridge.emitConversationsSent([gid !== "0" ? "g:" + gid : "u:" + toUid]);
      return wrapSentMessage({
        seq,
        messageId: msgId,
        rawMessage: {
          seq,
          msg_id: msgId,
          from_uid: uid,
          to_uid: toUid,
          group_id: gid,
          msg_type: Number(msgType),
          body,
          send_time: Date.now(),
          uid: 0,
        } as any,
      });
    } catch (error) {
      if (isYimsgError(error)) throw error;
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "发送消息失败", {
          context: "sendMessage",
        }),
      );
    }
  }

  sendText(target: ConversationTarget, text: string): Promise<PublicSentMessage> {
    this.requireAuthenticated("sendText");
    return this.messageFacade.sendText(target, text);
  }

  sendMarkdown(target: ConversationTarget, markdown: string): Promise<PublicSentMessage> {
    this.requireAuthenticated("sendMarkdown");
    return this.messageFacade.sendMarkdown(target, markdown);
  }

  sendImage(target: ConversationTarget, input: SendImageInput): Promise<PublicSentMessage> {
    this.requireAuthenticated("sendImage");
    return this.messageFacade.sendImage(target, input);
  }

  sendFile(target: ConversationTarget, input: SendFileInput): Promise<PublicSentMessage> {
    this.requireAuthenticated("sendFile");
    return this.messageFacade.sendFile(target, input);
  }

  async sendQuotedTextMessage(
    target: ConversationTarget,
    input: SendQuotedTextInput,
  ): Promise<PublicSentMessage> {
    this.requireAuthenticated("sendQuotedTextMessage");
    return this.messageFacade.sendQuotedTextMessage(target, input);
  }

  async recallMessage(message: PublicMessage): Promise<void> {
    this.requireAuthenticated("recallMessage");
    try {
      await actions.sendMessage(
        this._transport,
        actionMappers.recallMessageRequest(
          this.describeMessageConversation(message).target,
          message.messageId,
        ),
      );
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "撤回消息失败", {
          context: "recallMessage",
        }),
      );
    }
  }

  async deleteMessage(messageId: string): Promise<number> {
    this.requireAuthenticated("deleteMessage");
    this.assertNonEmpty(messageId, "messageId", "deleteMessage");
    try {
      const resp = await actions.deleteMessage(this._transport, {
        msg_id: messageId,
      });
      // 走与远端 messages:delete 通知相同的路径：删本地副本 + 就地从数据窗口删除，绝不拉取。
      this.runtime.notifyMessageDeleted(messageId);
      return Number(resp.seq);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "删除消息失败", {
          context: "deleteMessage",
        }),
      );
    }
  }

  async deleteConversation(target: ConversationTarget): Promise<number> {
    this.requireAuthenticated("deleteConversation");
    try {
      const resp = await actions.deleteConversation(
        this._transport,
        actionMappers.targetParams(target),
      );
      // 走与远端 conversations:delete 通知相同的路径：删本地副本 + 就地从数据窗口删除，绝不拉取。
      this.runtime.notifyConversationDeleted(target);
      return Number(resp.seq);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "删除会话失败", {
          context: "deleteConversation",
        }),
      );
    }
  }

  async forwardMessages(
    target: ConversationTarget,
    messages: ReadonlyArray<PublicMessage>,
    title: string,
  ): Promise<PublicSentMessage> {
    this.requireAuthenticated("forwardMessages");
    return this.messageFacade.forwardMessages(target, messages, title);
  }

  async getMessages(params: {
    target: ConversationTarget;
    cursor?: string;
    backward?: boolean;
    around?: string;
    limit?: number;
  }): Promise<MessagePage> {
    this.requireAuthenticated("getMessages");
    try {
      const result = await this.runtime
        .requireSessionInitialized("getMessages")
        .get_messages({
          to_uid: params.target.toUid,
          group_id: params.target.groupId,
          page: {
            cursor: params.cursor,
            backward: params.backward,
            around: params.around,
            limit: clampOptionalPageLimit(params.limit, this._batchMaxLimit),
          },
        });
      return wrapMessagePage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拉取消息分页失败", {
          context: "getMessages",
        }),
      );
    }
  }

  async clearUnread(target: ConversationTarget): Promise<void> {
    this.requireAuthenticated("clearUnread");
    await actions.clearUnread(this._transport, actionMappers.targetParams(target));
    // 走与远端 conversations:clearunread 通知相同的路径：清本地未读副本 + 就地清红点，绝不拉取列表。
    this.runtime.notifyConversationCleared(target);
  }

  async getConversations(
    params: { cursor?: string; backward?: boolean; limit?: number; targets?: ConversationTarget[] } = {},
  ): Promise<ConversationPage> {
    this.requireAuthenticated("getConversations");
    try {
      // targets 非空：按目标精确读取若干会话当前状态（轻通知后定向刷新），忽略分页。
      if (params.targets && params.targets.length > 0) {
        const result = await this.runtime.get_conversations({ targets: params.targets });
        return wrapConversationPage(result);
      }
      const result = await this.runtime.get_conversations({
        page: {
          cursor: params.cursor,
          backward: params.backward,
          limit: clampOptionalPageLimit(params.limit, this._batchMaxLimit),
        },
      });
      return wrapConversationPage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拉取会话分页失败", {
          context: "getConversations",
        }),
      );
    }
  }

  /**
   * 同步读取用户显示信息缓存视图。
   *
   * 先按字符串值去重；去重后 key 数量超过 `getClientConfig().batchMaxLimit`
   * 时抛 `ValidationError`，错误码为 `INVALID_ARGUMENT`。调用方应按该上限
   * 循环分批调用，而不是一次传入超大 key 集。
   */
  getUserInfos(uids: string[]): ReadonlyMap<string, UserDisplayInfo> {
    const input = this.normalizeDisplayInfoKeys(uids, "getUserInfos");
    const raw = this._displayInfoCache.getUserInfos(input);
    const result = new Map<string, UserDisplayInfo>();
    for (const [key, value] of raw) {
      result.set(key, mapUserDisplayInfo(value));
    }
    return freezeMap(result);
  }

  /**
   * 同步读取群显示信息缓存视图。
   *
   * 先按字符串值去重；去重后 key 数量超过 `getClientConfig().batchMaxLimit`
   * 时抛 `ValidationError`，错误码为 `INVALID_ARGUMENT`。调用方应按该上限
   * 循环分批调用，而不是一次传入超大 key 集。
   */
  getGroupInfos(groupIds: string[]): ReadonlyMap<string, GroupDisplayInfo> {
    const input = this.normalizeDisplayInfoKeys(groupIds, "getGroupInfos");
    const raw = this._displayInfoCache.getGroupInfos(input);
    const result = new Map<string, GroupDisplayInfo>();
    for (const [key, value] of raw) {
      result.set(key, mapGroupDisplayInfo(value));
    }
    return freezeMap(result);
  }

  /**
   * 同步读取组织显示信息缓存视图（与 getUserInfos/getGroupInfos 同构）。
   *
   * 先按字符串值去重；去重后 key 数量超过 `getClientConfig().batchMaxLimit`
   * 时抛 `ValidationError`，错误码为 `INVALID_ARGUMENT`。调用方应按该上限
   * 循环分批调用，而不是一次传入超大 key 集。
   */
  getOrgInfos(orgIds: string[]): ReadonlyMap<string, OrgDisplayInfo> {
    const input = this.normalizeDisplayInfoKeys(orgIds, "getOrgInfos");
    const raw = this._displayInfoCache.getOrgInfos(input);
    const result = new Map<string, OrgDisplayInfo>();
    for (const [key, value] of raw) {
      result.set(key, mapOrgDisplayInfo(value));
    }
    return freezeMap(result);
  }

  /**
   * 同步读取 tag（部门/横向分组）显示信息缓存视图。
   *
   * 先按字符串值去重；去重后 key 数量超过 `getClientConfig().batchMaxLimit`
   * 时抛 `ValidationError`，错误码为 `INVALID_ARGUMENT`。调用方应按该上限
   * 循环分批调用，而不是一次传入超大 key 集。
   */
  getTagInfos(orgId: string, tagIds: string[]): ReadonlyMap<string, TagDisplayInfo> {
    const input = this.normalizeDisplayInfoKeys(tagIds, "getTagInfos");
    const raw = this._displayInfoCache.getTagInfos(orgId, input);
    const result = new Map<string, TagDisplayInfo>();
    for (const [key, value] of raw) {
      result.set(key, mapTagDisplayInfo(value));
    }
    return freezeMap(result);
  }

  private normalizeDisplayInfoKeys(
    keys: string[],
    action: "getUserInfos" | "getGroupInfos" | "getOrgInfos" | "getTagInfos",
  ): string[] {
    return normalizeDisplayInfoKeys(keys, action, this._batchMaxLimit);
  }

  async addFriend(friendUid: string, remarkName?: string): Promise<void> {
    this.requireAuthenticated("addFriend");
    this.assertNonEmpty(friendUid, "friendUid", "addFriend");
    try {
      await actions.addFriend(this._transport, {
        friend_uid: friendUid,
        remark_name: remarkName || "",
      });
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "添加好友失败", {
          context: "addFriend",
        }),
      );
    }
  }

  async acceptFriend(friendUid: string): Promise<void> {
    this.requireAuthenticated("acceptFriend");
    this.assertNonEmpty(friendUid, "friendUid", "acceptFriend");
    try {
      await actions.acceptFriend(this._transport, { friend_uid: friendUid });
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "接受好友失败", {
          context: "acceptFriend",
        }),
      );
    }
  }

  async rejectFriend(friendUid: string): Promise<void> {
    this.requireAuthenticated("rejectFriend");
    this.assertNonEmpty(friendUid, "friendUid", "rejectFriend");
    try {
      await actions.rejectFriend(this._transport, { friend_uid: friendUid });
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拒绝好友失败", {
          context: "rejectFriend",
        }),
      );
    }
  }

  async deleteFriend(friendUid: string): Promise<void> {
    this.requireAuthenticated("deleteFriend");
    this.assertNonEmpty(friendUid, "friendUid", "deleteFriend");
    try {
      await actions.deleteFriend(this._transport, { friend_uid: friendUid });
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "删除好友失败", {
          context: "deleteFriend",
        }),
      );
    }
  }

  async updateRemark(
    target: ConversationTarget,
    remarkName: string,
  ): Promise<void> {
    this.requireAuthenticated("updateRemark");
    try {
      await actions.updateRemark(this._transport, {
        ...actionMappers.targetParams(target),
        remark_name: remarkName,
      });
      updateRemarkDisplayCache(this._displayInfoCache, target, remarkName);
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "更新备注失败", {
          context: "updateRemark",
        }),
      );
    }
  }

  async favoriteGroup(groupId: string, remarkName?: string): Promise<void> {
    this.requireAuthenticated("favoriteGroup");
    this.assertNonEmpty(groupId, "groupId", "favoriteGroup");
    try {
      await actions.favoriteGroup(this._transport, {
        group_id: groupId,
        remark_name: remarkName || "",
      });
      updateFavoriteGroupDisplayCache(
        this._displayInfoCache,
        groupId,
        remarkName,
      );
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "收藏群失败", {
          context: "favoriteGroup",
        }),
      );
    }
  }

  async unfavoriteGroup(groupId: string): Promise<void> {
    this.requireAuthenticated("unfavoriteGroup");
    this.assertNonEmpty(groupId, "groupId", "unfavoriteGroup");
    try {
      await actions.unfavoriteGroup(this._transport, { group_id: groupId });
      updateUnfavoriteGroupDisplayCache(this._displayInfoCache, groupId);
      this.notifyContactsAfterMutation();
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "取消群收藏失败", {
          context: "unfavoriteGroup",
        }),
      );
    }
  }

  async getContacts(
    params: {
      cursor?: string;
      backward?: boolean;
      around?: string;
      limit?: number;
      status?: number;
      friendUid?: string;
      groupId?: string;
      orgId?: string;
      friendUids?: readonly string[];
      groupIds?: readonly string[];
      orgIds?: readonly string[];
    } = {},
  ): Promise<ContactPage> {
    this.requireAuthenticated("getContacts");
    try {
      const result = await this.runtime.get_contacts({
        page: {
          cursor: params.cursor,
          backward: params.backward,
          around: params.around,
          limit: clampOptionalPageLimit(params.limit, this._batchMaxLimit),
        },
        status: params.status,
        friend_uid: params.friendUid,
        group_id: params.groupId,
        org_id: params.orgId,
        friend_uids: params.friendUids,
        group_ids: params.groupIds,
        org_ids: params.orgIds,
      });
      return wrapContactPage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拉取通讯录分页失败", {
          context: "getContacts",
        }),
      );
    }
  }

  async searchUser(username: string): Promise<PublicUserInfo | null> {
    this.requireAuthenticated("searchUser");
    this.assertNonEmpty(username, "username", "searchUser");
    try {
      const resp = await actions.searchUser(this._transport, { username });
      return resp.profile
        ? mapUserInfo(resp.profile as unknown as Parameters<typeof mapUserInfo>[0])
        : null;
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "搜索用户失败", {
          context: "searchUser",
        }),
      );
    }
  }

  async getContactCount(status: number): Promise<number> {
    this.requireAuthenticated("getContactCount");
    try {
      return await this.runtime.getContactCount(status);
    } catch {
      return 0;
    }
  }

  /**
   * 展开某个 tag 节点的直接子项（子 tag 与人按绝对排序混合返回）；
   * 展开组织根传 tagId=orgId；persistent 模式优先读本地副本，instant 模式在线展开。
   * 子项展示名（tag 名 / 人昵称）不内嵌在返回结果里，走 getTagInfos / getUserInfos 按需补齐。
   */
  async getTags(params: {
    orgId: string;
    tagId: string;
    cursor?: string;
    backward?: boolean;
    limit?: number;
  }): Promise<TagsPage> {
    this.requireAuthenticated("getTags");
    this.assertNonEmpty(params.orgId, "orgId", "getTags");
    this.assertNonEmpty(params.tagId, "tagId", "getTags");
    try {
      const result = await this.runtime.getTags({
        org_id: params.orgId,
        tag_id: params.tagId,
        page: {
          cursor: params.cursor,
          backward: params.backward,
          limit: clampOptionalPageLimit(params.limit, this._batchMaxLimit),
        },
      });
      return wrapTagsPage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "展开 tags 失败", {
          context: "getTags",
        }),
      );
    }
  }

  /**
   * 创建组织，任意登录用户都可以调用——这是权限链条唯一的自举点，调用方
   * 自动成为新组织根的初始管理员。返回新组织 ID。
   */
  async createOrg(name: string, avatar?: string): Promise<string> {
    this.requireAuthenticated("createOrg");
    this.assertNonEmpty(name, "name", "createOrg");
    try {
      const resp = await actions.createOrg(this._transport, { name, avatar: avatar || "" });
      return String(resp.org_id);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "创建组织失败", {
          context: "createOrg",
        }),
      );
    }
  }

  // ---- 组织管理面：以下写方法均要求调用方对目标节点（或其祖先）持有管理员
  // 授权，否则服务端返回 FORBIDDEN。写成功后不做本地乐观更新，依赖既有
  // org:updated 轻通知 + sync_tags/get_org_infos/get_tag_infos 重新拉取。----

  /** 在 parentTagId 下新建一个 tag（部门/横向分组），返回新 tag ID。 */
  async createOrgTag(
    orgId: string,
    parentTagId: string,
    name: string,
    params?: { avatar?: string; rank?: number },
  ): Promise<string> {
    this.requireAuthenticated("createOrgTag");
    this.assertNonEmpty(orgId, "orgId", "createOrgTag");
    this.assertNonEmpty(parentTagId, "parentTagId", "createOrgTag");
    this.assertNonEmpty(name, "name", "createOrgTag");
    try {
      const resp = await actions.createOrgTag(this._transport, {
        org_id: orgId,
        parent_tag_id: parentTagId,
        name,
        avatar: params?.avatar || "",
        rank: params?.rank === undefined ? undefined : String(params.rank),
      });
      return String(resp.tag_id);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "创建部门失败", {
          context: "createOrgTag",
        }),
      );
    }
  }

  /** 重命名一个 tag（部门/横向分组）的展示资料。 */
  async renameOrgTag(
    orgId: string,
    tagId: string,
    name: string,
    avatar?: string,
  ): Promise<void> {
    this.requireAuthenticated("renameOrgTag");
    this.assertNonEmpty(orgId, "orgId", "renameOrgTag");
    this.assertNonEmpty(tagId, "tagId", "renameOrgTag");
    this.assertNonEmpty(name, "name", "renameOrgTag");
    try {
      await actions.renameOrgTag(this._transport, {
        org_id: orgId,
        tag_id: tagId,
        name,
        avatar: avatar || "",
      });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "重命名部门失败", {
          context: "renameOrgTag",
        }),
      );
    }
  }

  /** 删除一个 tag 及其两个方向的关联边；受影响成员若因此失去全部边则联动离职。 */
  async deleteOrgTag(orgId: string, tagId: string): Promise<void> {
    this.requireAuthenticated("deleteOrgTag");
    this.assertNonEmpty(orgId, "orgId", "deleteOrgTag");
    this.assertNonEmpty(tagId, "tagId", "deleteOrgTag");
    try {
      await actions.deleteOrgTag(this._transport, { org_id: orgId, tag_id: tagId });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "删除部门失败", {
          context: "deleteOrgTag",
        }),
      );
    }
  }

  /** 把已存在的 tag 额外挂到另一个父节点下（DAG 多父）；服务端校验防环。 */
  async linkOrgTag(
    orgId: string,
    parentTagId: string,
    childTagId: string,
    rank?: number,
  ): Promise<void> {
    this.requireAuthenticated("linkOrgTag");
    this.assertNonEmpty(orgId, "orgId", "linkOrgTag");
    this.assertNonEmpty(parentTagId, "parentTagId", "linkOrgTag");
    this.assertNonEmpty(childTagId, "childTagId", "linkOrgTag");
    try {
      await actions.linkOrgTag(this._transport, {
        org_id: orgId,
        parent_tag_id: parentTagId,
        child_tag_id: childTagId,
        rank: rank === undefined ? undefined : String(rank),
      });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "挂载部门失败", {
          context: "linkOrgTag",
        }),
      );
    }
  }

  /** 把人挂进组织节点（组织根传 tagId=orgId）；uid 为内部路由键，供已知 uid 的程序化调用（如创建者自挂）使用。 */
  async addOrgMember(
    orgId: string,
    tagId: string,
    uid: string,
    params?: { title?: string; rank?: number },
  ): Promise<void> {
    this.requireAuthenticated("addOrgMember");
    this.assertNonEmpty(orgId, "orgId", "addOrgMember");
    this.assertNonEmpty(tagId, "tagId", "addOrgMember");
    this.assertNonEmpty(uid, "uid", "addOrgMember");
    try {
      await actions.addOrgMember(this._transport, {
        org_id: orgId,
        tag_id: tagId,
        uid,
        title: params?.title || "",
        rank: params?.rank === undefined ? undefined : String(params.rank),
      });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "添加组织成员失败", {
          context: "addOrgMember",
        }),
      );
    }
  }

  /** 按用户名把人挂进组织节点：界面层不应该也不需要知道对方 uid，SDK 内部解析后落地到 addOrgMember。 */
  async addOrgMemberByUsername(
    orgId: string,
    tagId: string,
    username: string,
    params?: { title?: string; rank?: number },
  ): Promise<void> {
    this.assertNonEmpty(username, "username", "addOrgMemberByUsername");
    const uid = await this.resolveUidByUsername(username, "addOrgMemberByUsername");
    await this.addOrgMember(orgId, tagId, uid, params);
  }

  /** 把人从组织节点移除；若因此失去在该组织的全部边则视为离职。 */
  async removeOrgMember(orgId: string, tagId: string, uid: string): Promise<void> {
    this.requireAuthenticated("removeOrgMember");
    this.assertNonEmpty(orgId, "orgId", "removeOrgMember");
    this.assertNonEmpty(tagId, "tagId", "removeOrgMember");
    this.assertNonEmpty(uid, "uid", "removeOrgMember");
    try {
      await actions.removeOrgMember(this._transport, { org_id: orgId, tag_id: tagId, uid });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "移除组织成员失败", {
          context: "removeOrgMember",
        }),
      );
    }
  }

  /**
   * 调整一条边的排序 / 职务展示：childType=1（PERSON）传 uid，childType=2（TAG）传 tagId。
   * rank 是必填的显式排序值（与 createOrgTag / addOrgMember 的可选 rank 不同）。
   */
  async setOrgItemRank(
    orgId: string,
    tagId: string,
    childId: string,
    childType: number,
    rank: number,
    title?: string,
  ): Promise<void> {
    this.requireAuthenticated("setOrgItemRank");
    this.assertNonEmpty(orgId, "orgId", "setOrgItemRank");
    this.assertNonEmpty(tagId, "tagId", "setOrgItemRank");
    this.assertNonEmpty(childId, "childId", "setOrgItemRank");
    try {
      await actions.setOrgItemRank(this._transport, {
        org_id: orgId,
        tag_id: tagId,
        child_id: childId,
        child_type: childType,
        title: title || "",
        rank: String(rank),
      });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "调整排序失败", {
          context: "setOrgItemRank",
        }),
      );
    }
  }

  /** 重命名组织展示资料，需对组织根持有管理员授权。 */
  async renameOrg(orgId: string, name: string, avatar?: string): Promise<void> {
    this.requireAuthenticated("renameOrg");
    this.assertNonEmpty(orgId, "orgId", "renameOrg");
    this.assertNonEmpty(name, "name", "renameOrg");
    try {
      await actions.renameOrg(this._transport, { org_id: orgId, name, avatar: avatar || "" });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "重命名组织失败", {
          context: "renameOrg",
        }),
      );
    }
  }

  /**
   * 授予 uid 管理 scopeTagId 为根子树的权限（组织根传 scopeTagId=orgId 即全组织管理员）。
   * 调用方自己必须已经对 scopeTagId（或其祖先）持有管理权限。uid 为内部路由键，供程序化调用使用。
   */
  async grantOrgAdmin(orgId: string, scopeTagId: string, uid: string): Promise<void> {
    this.requireAuthenticated("grantOrgAdmin");
    this.assertNonEmpty(orgId, "orgId", "grantOrgAdmin");
    this.assertNonEmpty(scopeTagId, "scopeTagId", "grantOrgAdmin");
    this.assertNonEmpty(uid, "uid", "grantOrgAdmin");
    try {
      await actions.grantOrgAdmin(this._transport, { org_id: orgId, scope_tag_id: scopeTagId, uid });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "授予管理员失败", {
          context: "grantOrgAdmin",
        }),
      );
    }
  }

  /** 按用户名授予管理权限：界面层不应该也不需要知道对方 uid，SDK 内部解析后落地到 grantOrgAdmin。 */
  async grantOrgAdminByUsername(orgId: string, scopeTagId: string, username: string): Promise<void> {
    this.assertNonEmpty(username, "username", "grantOrgAdminByUsername");
    const uid = await this.resolveUidByUsername(username, "grantOrgAdminByUsername");
    await this.grantOrgAdmin(orgId, scopeTagId, uid);
  }

  /** 把用户名解析为 uid；找不到时抛出携带 context 的 RequestError，供各 ByUsername 方法复用。 */
  private async resolveUidByUsername(username: string, context: string): Promise<string> {
    const profile = await this.searchUser(username);
    if (!profile) {
      throw new RequestError("REQUEST_FAILED", `用户不存在：${username}`, { context });
    }
    return profile.uid;
  }

  /** 撤销 uid 对 scopeTagId 为根子树的管理权限。 */
  async revokeOrgAdmin(orgId: string, scopeTagId: string, uid: string): Promise<void> {
    this.requireAuthenticated("revokeOrgAdmin");
    this.assertNonEmpty(orgId, "orgId", "revokeOrgAdmin");
    this.assertNonEmpty(scopeTagId, "scopeTagId", "revokeOrgAdmin");
    this.assertNonEmpty(uid, "uid", "revokeOrgAdmin");
    try {
      await actions.revokeOrgAdmin(this._transport, { org_id: orgId, scope_tag_id: scopeTagId, uid });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "撤销管理员失败", {
          context: "revokeOrgAdmin",
        }),
      );
    }
  }

  /**
   * 删除整个组织，需对组织根持有管理权限。结构（部门/成员/管理员授权）立即
   * 清空；成员通讯录组织行异步清理，不可撤销。
   */
  async deleteOrg(orgId: string): Promise<void> {
    this.requireAuthenticated("deleteOrg");
    this.assertNonEmpty(orgId, "orgId", "deleteOrg");
    try {
      await actions.deleteOrg(this._transport, { org_id: orgId });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "删除组织失败", {
          context: "deleteOrg",
        }),
      );
    }
  }

  /**
   * 列出直接挂在 scopeTagId 上的管理员 uid（不含挂在祖先节点、递归覆盖到此的管理员）。
   * 调用方自己必须已对 scopeTagId（或其祖先）持有管理权限，否则 FORBIDDEN。
   */
  async listOrgAdmins(orgId: string, scopeTagId: string): Promise<string[]> {
    this.requireAuthenticated("listOrgAdmins");
    this.assertNonEmpty(orgId, "orgId", "listOrgAdmins");
    this.assertNonEmpty(scopeTagId, "scopeTagId", "listOrgAdmins");
    try {
      const resp = await actions.listOrgAdmins(this._transport, { org_id: orgId, scope_tag_id: scopeTagId });
      return (resp.admin_uids || []).map((u) => String(u));
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "读取管理员名单失败", {
          context: "listOrgAdmins",
        }),
      );
    }
  }

  async blockUser(uid: string): Promise<number> {
    this.requireAuthenticated("blockUser");
    this.assertNonEmpty(uid, "uid", "blockUser");
    try {
      const resp = await actions.blockUser(this._transport, { uid });
      return Number(resp.seq);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "屏蔽用户失败", {
          context: "blockUser",
        }),
      );
    }
  }

  async unblockUser(uid: string): Promise<number> {
    this.requireAuthenticated("unblockUser");
    this.assertNonEmpty(uid, "uid", "unblockUser");
    try {
      const resp = await actions.unblockUser(this._transport, { uid });
      return Number(resp.seq);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "取消屏蔽失败", {
          context: "unblockUser",
        }),
      );
    }
  }

  async getBlocklist(
    params: {
      cursor?: string;
      backward?: boolean;
      limit?: number;
      status?: number;
      uids?: readonly string[];
    } = {},
  ): Promise<BlocklistUserPage> {
    this.requireAuthenticated("getBlocklist");
    try {
      const gatewayParams = {
        page: {
          cursor: params.cursor,
          backward: params.backward,
          limit: clampOptionalPageLimit(params.limit, this._batchMaxLimit),
        },
        status: params.status,
        uids: params.uids,
      };
      const dataGateway = this.runtime.getDataGateway();
      const result = dataGateway
        ? await dataGateway.get_blocklist(gatewayParams)
        : actionMappers.mapGetBlocklistResponse(
            await actions.getBlocklist(
              this._transport,
              actionMappers.getBlocklistRequest(gatewayParams),
            ),
          );
      return wrapBlocklistUserPage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拉取屏蔽列表分页失败", {
          context: "getBlocklist",
        }),
      );
    }
  }

  async muteConversation(target: ConversationTarget): Promise<number> {
    this.requireAuthenticated("muteConversation");
    try {
      const resp = await actions.muteConversation(
        this._transport,
        actionMappers.targetParams(target),
      );
      return Number(resp.seq);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "更新免打扰失败", {
          context: "muteConversation",
        }),
      );
    }
  }

  async unmuteConversation(target: ConversationTarget): Promise<number> {
    this.requireAuthenticated("unmuteConversation");
    try {
      const resp = await actions.unmuteConversation(
        this._transport,
        actionMappers.targetParams(target),
      );
      return Number(resp.seq);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "关闭免打扰失败", {
          context: "unmuteConversation",
        }),
      );
    }
  }

  async getUnreadCount(): Promise<number> {
    this.requireAuthenticated("getUnreadCount");
    try {
      const dataGateway = this.runtime.getDataGateway();
      return dataGateway
        ? await dataGateway.get_unread_count()
        : Number(
            (await actions.getUnreadCount(this._transport, {})).unread_count,
          );
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "读取未读总数失败", {
          context: "getUnreadCount",
        }),
      );
    }
  }

  async getMutelist(
    params: {
      cursor?: string;
      backward?: boolean;
      limit?: number;
      status?: number;
      toUid?: string;
      groupId?: string;
      toUids?: readonly string[];
      groupIds?: readonly string[];
    } = {},
  ): Promise<MutelistEntryPage> {
    this.requireAuthenticated("getMutelist");
    try {
      const gatewayParams = {
        page: {
          cursor: params.cursor,
          backward: params.backward,
          limit: clampOptionalPageLimit(params.limit, this._batchMaxLimit),
        },
        status: params.status,
        to_uid: params.toUid,
        group_id: params.groupId,
        to_uids: params.toUids,
        group_ids: params.groupIds,
      };
      const dataGateway = this.runtime.getDataGateway();
      const result = dataGateway
        ? await dataGateway.get_mutelist(gatewayParams)
        : actionMappers.mapGetMutelistResponse(
            await actions.getMutelist(
              this._transport,
              actionMappers.getMutelistRequest(gatewayParams),
            ),
          );
      return wrapMutelistEntryPage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拉取免打扰分页失败", {
          context: "getMutelist",
        }),
      );
    }
  }

  async createGroup(name: string, memberUids: string[]): Promise<string> {
    this.requireAuthenticated("createGroup");
    this.assertNonEmpty(name, "name", "createGroup");
    const maxMembers = Math.min(this._batchMaxLimit, DEFAULT_MAX_PAGE_LIMIT);
    if (memberUids.length > maxMembers) {
      throw new ValidationError(`createGroup 最多支持 ${maxMembers} 名成员`, {
        context: "createGroup",
        details: { max: maxMembers, actual: memberUids.length },
      });
    }
    try {
      const resp = await actions.createGroup(this._transport, {
        name,
        member_uids: memberUids,
      });
      const groupId = String(resp.group_id);
      updateCreatedGroupDisplayCache(this._displayInfoCache, groupId, name);
      return groupId;
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "创建群聊失败", {
          context: "createGroup",
        }),
      );
    }
  }

  async getGroupMembers(
    groupId: string,
    params?: { cursor?: string; backward?: boolean; limit?: number },
  ): Promise<GroupMemberPage> {
    this.requireAuthenticated("getGroupMembers");
    this.assertNonEmpty(groupId, "groupId", "getGroupMembers");
    try {
      const result = actionMappers.mapGetGroupMembersResponse(
        await actions.getGroupMembers(
          this._transport,
          actionMappers.groupMembersRequest(groupId, {
            page: {
              cursor: params?.cursor,
              backward: params?.backward,
              limit: params?.limit,
            },
          }),
        ),
      );
      return wrapGroupMemberPage(result);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "拉取群成员分页失败", {
          context: "getGroupMembers",
        }),
      );
    }
  }

  async updateGroupInfo(
    groupId: string,
    info: UpdateGroupInfoInput,
  ): Promise<void> {
    this.requireAuthenticated("updateGroupInfo");
    this.assertNonEmpty(groupId, "groupId", "updateGroupInfo");
    try {
      const avatar = info.avatarUrl;
      await actions.updateGroupInfo(this._transport, {
        group_id: groupId,
        name: info.name || "",
        avatar: avatar || "",
      });
      updateGroupInfoDisplayCache(this._displayInfoCache, groupId, info);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "更新群资料失败", {
          context: "updateGroupInfo",
        }),
      );
    }
  }

  async addGroupMember(groupId: string, uid: string): Promise<void> {
    this.requireAuthenticated("addGroupMember");
    this.assertNonEmpty(groupId, "groupId", "addGroupMember");
    this.assertNonEmpty(uid, "uid", "addGroupMember");
    try {
      await actions.addGroupMember(this._transport, { group_id: groupId, uid });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "添加群成员失败", {
          context: "addGroupMember",
        }),
      );
    }
  }

  async removeGroupMember(groupId: string, uid: string): Promise<void> {
    this.requireAuthenticated("removeGroupMember");
    this.assertNonEmpty(groupId, "groupId", "removeGroupMember");
    this.assertNonEmpty(uid, "uid", "removeGroupMember");
    try {
      await actions.removeGroupMember(this._transport, {
        group_id: groupId,
        uid,
      });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "移除群成员失败", {
          context: "removeGroupMember",
        }),
      );
    }
  }

  async updateUserInfo(params: UpdateUserInfoInput): Promise<void> {
    const { uid } = this.requireAuthenticated("updateUserInfo");
    try {
      const avatar = params.avatarUrl;
      await actions.updateUserInfo(this._transport, {
        nickname: params.nickname || "",
        avatar: avatar || "",
      });
      updateUserInfoDisplayCache(this._displayInfoCache, uid, params);
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "更新个人资料失败", {
          context: "updateUserInfo",
        }),
      );
    }
  }

  async updatePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    this.requireAuthenticated("updatePassword");
    this.assertNonEmpty(oldPassword, "oldPassword", "updatePassword");
    this.assertNonEmpty(newPassword, "newPassword", "updatePassword");
    try {
      await actions.updatePassword(this._transport, {
        old_password: oldPassword,
        new_password: newPassword,
      });
    } catch (error) {
      throw wrapError(
        error,
        new RequestError("REQUEST_FAILED", "修改密码失败", {
          context: "updatePassword",
        }),
      );
    }
  }

  async uploadFile(
    file: File,
    category: UploadCategory,
  ): Promise<UploadResult> {
    this.requireAuthenticated("uploadFile");
    return freezeObject(
      await uploadModule.uploadFile(
        file,
        category,
        this.authToken,
        this.uploadUrl,
      ),
    );
  }
}
