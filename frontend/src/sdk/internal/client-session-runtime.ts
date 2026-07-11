import { MemoryDataGateway } from "../datagateway/memory";
import { DisplayInfoCache } from "../state/cache";
import { SessionLifecycleMachine } from "../state/lifecycle";
import { WsTransport } from "../transport/connection";
import type { ContactPageParams, DataGateway, SyncEvent } from "../datagateway/interface";
import type { PageInfoResult, PageParams } from "./action-mappers";
import { ConnectionError, PreconditionError, wrapError } from "../errors";
import type {
  ConversationTarget,
  SessionFileSystem,
  SessionMode,
  SyncDomain,
  SyncStatus,
  SyncReadiness,
} from "../types";
import { freezeObject } from "./readonly";
import type {
  ConversationEntry as RawConversationEntry,
  Contact as RawContact,
  LocalConversation as RawLocalConversation,
  Message as RawMessage,
} from "../../types";

type ConnectionEventName =
  | "connection:connected"
  | "connection:disconnected"
  | "connection:reconnecting";

interface ClientSessionRuntimeDeps {
  transport: WsTransport;
  cache: DisplayInfoCache;
  lifecycle: SessionLifecycleMachine;
  connectTimeoutMs: number;
  shouldKeepTransportAlive: () => boolean;
  onConnectionEvent: (eventName: ConnectionEventName) => void;
  onMessagesReceived: (messages: RawMessage[]) => void;
  onContactsChanged: (contacts: RawContact[], replace?: boolean) => void;
  onBlocklistChanged: () => void;
  onMutelistChanged: () => void;
  onOrgsChanged: (orgIds: string[]) => void;
  onUnreadCleared: (convKey: string) => void;
  onConversationDeleted: (convKey: string) => void;
  onMessageDeleted: (messageId: string, convKey: string) => void;
  onSessionKicked: () => void;
  onError: (error: unknown, context: string) => void;
  onSync: (event: SyncEvent) => void;
  getBatchMaxLimit: () => number;
}

/** 所有需要在首轮同步中完成的同步域。 */
const ALL_SYNC_DOMAINS: readonly SyncDomain[] = [
  "messages",
  "conversations",
  "contacts",
  "blocklist",
  "mutelist",
];

export class ClientSessionRuntime {
  private dataGateway: DataGateway | null = null;
  private sessionInitId = 0;
  private connectPromise: Promise<void> | null = null;
  /** 各同步域最近一次同步状态。清空 runtime 时重置。 */
  private _syncDomains: Partial<Record<SyncDomain, SyncStatus>> = {};
  /** 首轮同步是否已全部完成；一旦变为 true 不再回退。 */
  private _firstSyncComplete = false;

  constructor(private readonly deps: ClientSessionRuntimeDeps) {
    this.deps.transport.onConnected = () => {
      this.deps.lifecycle.transition(
        { connectionState: "connected" },
        "transport_connected",
      );
      this.deps.onConnectionEvent("connection:connected");
    };
    this.deps.transport.onDisconnected = () => {
      this.connectPromise = null;
      this.deps.lifecycle.transition(
        { connectionState: "disconnected" },
        "transport_disconnected",
      );
      this.deps.onConnectionEvent("connection:disconnected");
      if (!this.deps.shouldKeepTransportAlive()) {
        this.deps.transport.disconnect();
      }
    };
    this.deps.transport.onReconnecting = () => {
      this.deps.lifecycle.transition(
        { connectionState: "reconnecting" },
        "transport_reconnecting",
      );
      this.deps.onConnectionEvent("connection:reconnecting");
    };
    this.deps.transport.onNotification = (notification) => {
      this.dataGateway?.handleNotification(notification);
    };
  }

  getDataGateway(): DataGateway | null {
    return this.dataGateway;
  }

  /**
   * 返回当前同步就绪只读快照。
   *
   * - memory 模式：无后台同步，`firstSyncComplete` 恒为 `true`。
   * - persistent 模式：全部同步域至少完成过一次（success 或 failed）后 `firstSyncComplete` 变为 `true`。
   */
  getSyncReadiness(): SyncReadiness {
    const mode = this.deps.lifecycle.getSnapshot().mode;
    if (mode === "memory") {
      return freezeObject({ domains: {}, firstSyncComplete: true });
    }
    return freezeObject({
      domains: Object.freeze({ ...this._syncDomains }) as Partial<
        Record<SyncDomain, SyncStatus>
      >,
      firstSyncComplete: this._firstSyncComplete,
    });
  }

  private trackSyncDomain(domain: SyncDomain, status: SyncStatus): void {
    this._syncDomains = { ...this._syncDomains, [domain]: status };
    if (!this._firstSyncComplete) {
      const allDone = ALL_SYNC_DOMAINS.every(
        (d) => this._syncDomains[d] !== undefined,
      );
      if (allDone) {
        this._firstSyncComplete = true;
      }
    }
  }

  requireDataGateway(action: string): DataGateway {
    if (!this.dataGateway) {
      throw new PreconditionError(
        "SESSION_NOT_INITIALIZED",
        `${action} 需要先调用 startSession()`,
        {
          context: action,
        },
      );
    }
    return this.dataGateway;
  }

  requireSessionInitialized(action: string): DataGateway {
    if (
      !this.deps.lifecycle.getSnapshot().isSessionInitialized ||
      !this.dataGateway
    ) {
      throw new PreconditionError(
        "SESSION_NOT_INITIALIZED",
        `${action} 需要先调用 startSession()`,
        {
          context: action,
        },
      );
    }
    return this.dataGateway;
  }

  clearRuntimeState(): void {
    const currentDataGateway = this.dataGateway;
    this.dataGateway = null;
    currentDataGateway?.clear();
    this.deps.cache.clear();
    this._syncDomains = {};
    this._firstSyncComplete = false;
  }

  dispose(): void {
    this.connectPromise = null;
    this.deps.transport.onConnected = null;
    this.deps.transport.onDisconnected = null;
    this.deps.transport.onNotification = null;
    this.deps.transport.onReconnecting = null;
  }

  async ensureConnected(): Promise<void> {
    if (this.deps.transport.connected) return;
    if (!this.connectPromise) {
      this.deps.lifecycle.transition(
        { connectionState: "connecting" },
        "connect_started",
      );
      this.connectPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          this.connectPromise = null;
          reject(
            new ConnectionError("CONNECTION_TIMEOUT", "连接超时", {
              context: "connect",
            }),
          );
        }, this.deps.connectTimeoutMs);

        const onConnected = () => {
          clearTimeout(timeout);
          cleanup();
          this.connectPromise = null;
          resolve();
        };

        const cleanup = () => {
          this.deps.transport.onConnected = originalOnConnected;
        };

        const originalOnConnected = this.deps.transport.onConnected;
        this.deps.transport.onConnected = () => {
          originalOnConnected?.();
          onConnected();
        };

        try {
          this.deps.transport.connect();
        } catch (error) {
          clearTimeout(timeout);
          cleanup();
          this.connectPromise = null;
          reject(
            wrapError(
              error,
              new ConnectionError("CONNECTION_FAILED", "连接失败", {
                context: "connect",
              }),
            ),
          );
        }
      });
    }
    try {
      await this.connectPromise;
    } catch (error) {
      throw wrapError(
        error,
        new ConnectionError("CONNECTION_FAILED", "连接失败", {
          context: "connect",
        }),
      );
    }
  }

  async initializeSession(
    uid: string,
    mode: SessionMode,
    options: { instanceId?: string; fileSystem?: SessionFileSystem } = {},
  ): Promise<void> {
    const sessionId = ++this.sessionInitId;
    this.clearRuntimeState();
    this.deps.lifecycle.transition(
      {
        sessionState: "initializing",
        mode,
      },
      "session_initializing",
    );

    try {
      this.dataGateway = await this.createDataGateway(mode, options);
      this.bindDataGatewayCallbacks(this.dataGateway);

      await this.dataGateway.init(uid);
      if (this.sessionInitId !== sessionId) return;

      this.deps.lifecycle.transition(
        {
          sessionState: "ready",
          mode,
        },
        "session_ready",
      );
    } catch (error) {
      if (this.sessionInitId !== sessionId) return;
      const failedDataGateway = this.dataGateway;
      this.dataGateway = null;
      failedDataGateway?.clear();
      this.deps.lifecycle.transition(
        {
          sessionState: "authenticated",
          mode,
        },
        "session_init_failed",
      );
      throw error;
    }
  }

  async get_conversations(params?: { page?: PageParams; targets?: ConversationTarget[] }): Promise<{
    conversations: RawLocalConversation[];
    page: PageInfoResult;
  }> {
    const result = await this.requireDataGateway(
      "getConversations",
    ).get_conversations({ page: params?.page, targets: params?.targets });
    const conversations = this.mapConversationPage(result.conversations);
    conversations.sort((a, b) => b.last_seq - a.last_seq);
    return { conversations, page: result.page };
  }

  async getUnreadCount(): Promise<number> {
    return this.requireSessionInitialized("getUnreadCount").get_unread_count();
  }

  async get_contacts(params: ContactPageParams): Promise<{
    contacts: RawContact[];
    page: PageInfoResult;
  }> {
    const result = await this.requireDataGateway("getContacts").get_contacts(params);
    return { contacts: result.contacts, page: result.page };
  }

  async getContactCount(status: number): Promise<number> {
    return this.requireSessionInitialized(
      "getContactCount",
    ).get_contact_count(status);
  }

  async getTags(params: Parameters<DataGateway["get_tags"]>[0]) {
    return this.requireDataGateway("getTags").get_tags(params);
  }

  notifyContactsChangedAfterMutation(): void {
    this.dataGateway?.handleNotification({ type: "contacts:updated" } as never);
  }

  // 本地清未读：复用 conversations:clearunread 通知路径（清本地未读副本 + 回调 UI 清红点），不拉取列表。
  notifyConversationCleared(target: ConversationTarget): void {
    const groupId = (target as { groupId?: string }).groupId;
    const toUid = (target as { toUid?: string }).toUid;
    this.dataGateway?.handleNotification({
      type: "conversations:clearunread",
      from_uid: groupId ? undefined : toUid,
      group_id: groupId,
    } as never);
  }

  // 本地删除会话：复用 conversations:delete 通知路径（删本地副本 + 回调 UI 就地删除），不拉取列表。
  notifyConversationDeleted(target: ConversationTarget): void {
    const groupId = (target as { groupId?: string }).groupId;
    const toUid = (target as { toUid?: string }).toUid;
    this.dataGateway?.handleNotification({
      type: "conversations:delete",
      from_uid: groupId ? undefined : toUid,
      group_id: groupId,
    } as never);
  }

  // 本地删除消息：复用 messages:delete 通知路径（删本地副本 + 回调 UI 就地删除），不拉取列表。
  notifyMessageDeleted(messageId: string): void {
    this.dataGateway?.handleNotification({
      type: "messages:delete",
      msg_id: messageId,
    } as never);
  }

  private async createDataGateway(
    mode: SessionMode,
    options: { instanceId?: string; fileSystem?: SessionFileSystem } = {},
  ): Promise<DataGateway> {
    if (mode === "persistent") {
      const { createPersistentDbApi } =
        await import("../datagateway/sqlite-db-factory");
      const { PersistentDataGateway } =
        await import("../datagateway/persistent");
      const db = await createPersistentDbApi(options.fileSystem ?? "opfs");
      return new PersistentDataGateway(this.deps.transport, {
        db,
        batchMaxLimit: this.deps.getBatchMaxLimit(),
        instanceId: options.instanceId,
      });
    }
    return new MemoryDataGateway(this.deps.transport, {
      batchMaxLimit: this.deps.getBatchMaxLimit(),
    });
  }

  private bindDataGatewayCallbacks(dataGateway: DataGateway): void {
    dataGateway.onMessagesReceived((messages) =>
      this.deps.onMessagesReceived(messages),
    );
    dataGateway.onContactsChanged((contacts, replace) =>
      this.deps.onContactsChanged(contacts, replace),
    );
    dataGateway.onBlocklistChanged(() => this.deps.onBlocklistChanged());
    dataGateway.onMutelistChanged(() => this.deps.onMutelistChanged());
    dataGateway.onOrgsChanged((orgIds) => this.deps.onOrgsChanged(orgIds));
    dataGateway.onUnreadCleared((convKey) => this.deps.onUnreadCleared(convKey));
    dataGateway.onConversationDeleted((convKey) => this.deps.onConversationDeleted(convKey));
    dataGateway.onMessageDeleted((messageId, convKey) => this.deps.onMessageDeleted(messageId, convKey));
    dataGateway.onSessionKicked(() => this.deps.onSessionKicked());
    dataGateway.onError((error, context) => this.deps.onError(error, context));
    dataGateway.onSync((event) => {
      // 先更新内部同步就绪追踪，再透传给上层
      if (event.status === "success" || event.status === "failed") {
        this.trackSyncDomain(event.domain, event.status);
      }
      this.deps.onSync(event);
    });
  }

  private mapConversationPage(
    entries: RawConversationEntry[],
  ): RawLocalConversation[] {
    return entries.map((conversation) => {
      const target = conversation.target as
        | { uid?: string; group_id?: string; groupId?: string }
        | undefined;
      return {
        group_id: String(
          target?.group_id || target?.groupId || conversation.group_id || "0",
        ),
        friend_uid: String(target?.uid || conversation.friend_uid || "0"),
        last_seq: conversation.last_seq || 0,
        last_msg: conversation.last_msg || null,
        unread_count: Number(conversation.unread_count || 0),
        status: Number(conversation.status || 0),
      };
    });
  }
}
