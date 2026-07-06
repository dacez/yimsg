import type {
  BlocklistPageParams,
  BlocklistPageResult,
  ContactPageParams,
  ContactPageResult,
  DataGateway,
  DisplayInfoFetchOptions,
  ConversationPageResult,
  MessagePageResult,
  MutelistPageParams,
  MutelistPageResult,
  TagsPageParams,
  TagsPageResult,
  SyncDomain,
  SyncEvent,
  MaybePromise,
} from "./interface";
import type { PageParams } from "../internal/action-mappers";
import type { ConversationTarget } from "../types";
import type {
  ConversationEntry,
  Message,
  Contact,
  UserInfo,
  GroupInfo,
  Notification,
  OrgInfo,
  TagInfo,
} from "../../types";
import type { ClientTransport } from "../transport/connection";
import * as actions from "../generated/actions.gen";
import * as actionMappers from "../internal/action-mappers";
import { DEFAULT_MAX_BATCH_LIMIT } from "../internal/sdk-defaults";
import {
  clampBatchLimit,
  clampOptionalPageLimit,
  collectSerialBatches,
} from "../internal/limits";

export interface BaseDataGatewayOptions {
  readonly batchMaxLimit?: number;
}

/**
 * BaseDataGateway — shared logic for memory and 持久存储 modes.
 * Uses injected ClientTransport and typed action functions.
 */
export abstract class BaseDataGateway implements DataGateway {
  protected batchMaxLimit: number;
  private syncQueue: Promise<void> = Promise.resolve();
  /**
   * 每种通知类型的待处理标记。
   * enqueue() 被调用时只更新标记，不再新增 Promise 链节点，防止高频通知导致无界队列增长。
   */
  private readonly pendingFlags: Record<string, boolean> = {};
  /** `conversations:clearunread` 需要额外保存待处理的清未读 convKey 集合。 */
  private readonly pendingClearedKeys = new Set<string>();
  /** `conversations:delete` 待处理的被删会话 convKey 集合（去重）。 */
  private readonly pendingDeletedConvKeys = new Set<string>();
  /** `messages:delete` 待处理的被删消息：msg_id → 所在会话 convKey。 */
  private readonly pendingDeletedMsgIds = new Map<string, string>();
  /**
   * 待处理的 messages:received 触发消息 id 集合（去重）。
   * 多个会话的通知在同一调度窗口内合并时，这里累积全部 msg_id，
   * flush 时一次性批量拉取，避免只保留最后一条导致 onMessages 漏消息。
   * 上限为 batchMaxLimit，溢出直接丢弃（重绘信号仍会兜底纠正未读/列表）。
   */
  protected readonly pendingMessageIds = new Set<string>();
  /** 待处理的 org:updated 组织 ID 集合（去重合并，flush 时一次性处理）。 */
  protected readonly pendingOrgIds = new Set<string>();

  private messagesReceivedCb: ((messages: Message[]) => void) | null = null;
  private contactsChangedCb:
    | ((contacts: Contact[], replace?: boolean) => void)
    | null = null;
  private blocklistChangedCb: (() => void) | null = null;
  private mutelistChangedCb: (() => void) | null = null;
  private orgsChangedCb: ((orgIds: string[]) => void) | null = null;
  private unreadClearedCb: ((convKey: string) => void) | null = null;
  private conversationDeletedCb: ((convKey: string) => void) | null = null;
  private messageDeletedCb: ((messageId: string, convKey: string) => void) | null = null;
  private sessionKickedCb: (() => void) | null = null;
  private errorCb: ((error: Error, context: string) => void) | null = null;
  private syncCb: ((event: SyncEvent) => void) | null = null;

  constructor(
    protected transport: ClientTransport,
    options: BaseDataGatewayOptions = {},
  ) {
    this.batchMaxLimit = clampBatchLimit(
      options.batchMaxLimit ?? DEFAULT_MAX_BATCH_LIMIT,
    );
  }

  // ---- Lifecycle ----

  init(
    _uid: string,
  ): Promise<{ lastMsgSeq: number; lastContactSeq: number }> {
    // 默认（memory 基线）：不保存本地副本、不维护同步游标，读取一律直连后端。
    return Promise.resolve({ lastMsgSeq: 0, lastContactSeq: 0 });
  }

  clear(): void {
    this.syncQueue = Promise.resolve();
    for (const key of Object.keys(this.pendingFlags)) {
      this.pendingFlags[key] = false;
    }
    this.pendingClearedKeys.clear();
    this.pendingDeletedConvKeys.clear();
    this.pendingDeletedMsgIds.clear();
    this.pendingMessageIds.clear();
    this.pendingOrgIds.clear();
    this.messagesReceivedCb = null;
    this.contactsChangedCb = null;
    this.blocklistChangedCb = null;
    this.mutelistChangedCb = null;
    this.orgsChangedCb = null;
    this.unreadClearedCb = null;
    this.conversationDeletedCb = null;
    this.messageDeletedCb = null;
    this.sessionKickedCb = null;
    this.errorCb = null;
    this.syncCb = null;
  }

  // ---- Data reads ----

  async get_conversations(params: { page?: PageParams; targets?: ConversationTarget[] }): Promise<ConversationPageResult> {
    return actionMappers.mapGetConversationsResponse(
      await actions.getConversations(this.transport, actionMappers.getConversationsRequest(params)),
    );
  }

  async get_unread_count(): Promise<number> {
    return Number(
      (await actions.getUnreadCount(this.transport, {})).unread_count,
    );
  }

  async get_messages(params: {
    to_uid?: string;
    group_id?: string;
    page?: PageParams;
    msg_ids?: string[];
  }): Promise<MessagePageResult> {
    return actionMappers.mapGetMessagesResponse(
      await actions.getMessages(this.transport, actionMappers.getMessagesRequest(params)),
    );
  }

  async get_contacts(params: ContactPageParams): Promise<ContactPageResult> {
    // get_contacts 是展示通道 keyset 分页；通讯录增量 seq 游标由 sync_contacts 维护。
    return actionMappers.mapGetContactsResponse(
      await actions.getContacts(this.transport, actionMappers.getContactsRequest(params)),
    );
  }

  async get_contact_count(status: number): Promise<number> {
    return Number(
      (
        await actions.getContactCount(
          this.transport,
          actionMappers.contactCountRequest(status),
        )
      ).total || 0,
    );
  }

  async get_tags(params: TagsPageParams): Promise<TagsPageResult> {
    // memory 基线恒走在线展开；persistent 覆盖为本地副本优先。
    return this.fetchTagsFromServer(params);
  }

  protected async fetchTagsFromServer(
    params: TagsPageParams,
  ): Promise<TagsPageResult> {
    return actionMappers.mapGetTagsResponse(
      await actions.getTags(this.transport, actionMappers.getTagsRequest(params)),
    );
  }

  async get_blocklist(
    params: BlocklistPageParams,
  ): Promise<BlocklistPageResult> {
    return actionMappers.mapGetBlocklistResponse(
      await actions.getBlocklist(this.transport, actionMappers.getBlocklistRequest(params)),
    );
  }

  async get_mutelist(params: MutelistPageParams): Promise<MutelistPageResult> {
    return actionMappers.mapGetMutelistResponse(
      await actions.getMutelist(this.transport, actionMappers.getMutelistRequest(params)),
    );
  }

  // ---- Cache support ----

  get_user_infos(
    uids: string[],
    options: DisplayInfoFetchOptions<UserInfo>,
  ): MaybePromise<UserInfo[]> {
    void this.refreshUserInfos(uids, options);
    return [];
  }

  get_group_infos(
    groupIds: string[],
    options: DisplayInfoFetchOptions<GroupInfo>,
  ): MaybePromise<GroupInfo[]> {
    void this.refreshGroupInfos(groupIds, options);
    return [];
  }

  get_org_infos(
    orgIds: string[],
    options: DisplayInfoFetchOptions<OrgInfo>,
  ): MaybePromise<OrgInfo[]> {
    void this.refreshOrgInfos(orgIds, options);
    return [];
  }

  get_tag_infos(
    orgId: string,
    tagIds: string[],
    options: DisplayInfoFetchOptions<TagInfo>,
  ): MaybePromise<TagInfo[]> {
    void this.refreshTagInfos(orgId, tagIds, options);
    return [];
  }

  protected async fetchUserInfosFromServer(
    uids: string[],
  ): Promise<UserInfo[]> {
    return collectSerialBatches(uids, this.batchMaxLimit, async (batch) => {
      return actionMappers.mapGetUserInfosResponse(
        await actions.getUserInfos(this.transport, { uids: batch }),
      );
    });
  }

  protected async fetchGroupInfosFromServer(
    groupIds: string[],
  ): Promise<GroupInfo[]> {
    return collectSerialBatches(groupIds, this.batchMaxLimit, async (batch) => {
      return actionMappers.mapGetGroupInfosResponse(
        await actions.getGroupInfos(this.transport, { group_ids: batch }),
      );
    });
  }

  protected async fetchOrgInfosFromServer(
    orgIds: string[],
  ): Promise<OrgInfo[]> {
    return collectSerialBatches(orgIds, this.batchMaxLimit, async (batch) =>
      actionMappers.mapGetOrgInfosResponse(
        await actions.getOrgInfos(this.transport, actionMappers.getOrgInfosRequest(batch)),
      ),
    );
  }

  protected async fetchTagInfosFromServer(
    orgId: string,
    tagIds: string[],
  ): Promise<TagInfo[]> {
    return collectSerialBatches(tagIds, this.batchMaxLimit, async (batch) =>
      actionMappers.mapGetTagInfosResponse(
        await actions.getTagInfos(this.transport, actionMappers.getTagInfosRequest(orgId, batch)),
      ),
    );
  }

  protected async refreshUserInfos(
    uids: string[],
    options: DisplayInfoFetchOptions<UserInfo>,
  ): Promise<void> {
    if (uids.length === 0) return;
    try {
      const profiles = await this.fetchUserInfosFromServer(uids);
      if (profiles.length > 0) options.updateDisplayInfos?.(profiles);
    } catch (error) {
      this.reportError(error, "refresh user infos failed");
    }
  }

  protected async refreshGroupInfos(
    groupIds: string[],
    options: DisplayInfoFetchOptions<GroupInfo>,
  ): Promise<void> {
    if (groupIds.length === 0) return;
    try {
      const groups = await this.fetchGroupInfosFromServer(groupIds);
      if (groups.length > 0) options.updateDisplayInfos?.(groups);
    } catch (error) {
      this.reportError(error, "refresh group infos failed");
    }
  }

  protected async refreshOrgInfos(
    orgIds: string[],
    options: DisplayInfoFetchOptions<OrgInfo>,
  ): Promise<void> {
    if (orgIds.length === 0) return;
    try {
      const orgs = await this.fetchOrgInfosFromServer(orgIds);
      if (orgs.length > 0) options.updateDisplayInfos?.(orgs);
    } catch (error) {
      this.reportError(error, "refresh org infos failed");
    }
  }

  protected async refreshTagInfos(
    orgId: string,
    tagIds: string[],
    options: DisplayInfoFetchOptions<TagInfo>,
  ): Promise<void> {
    if (tagIds.length === 0) return;
    try {
      const tags = await this.fetchTagInfosFromServer(orgId, tagIds);
      if (tags.length > 0) options.updateDisplayInfos?.(tags);
    } catch (error) {
      this.reportError(error, "refresh tag infos failed");
    }
  }

  // ---- Event callbacks ----

  onMessagesReceived(cb: (messages: Message[]) => void): void {
    this.messagesReceivedCb = cb;
  }
  onContactsChanged(
    cb: (contacts: Contact[], replace?: boolean) => void,
  ): void {
    this.contactsChangedCb = cb;
  }
  onBlocklistChanged(cb: () => void): void {
    this.blocklistChangedCb = cb;
  }
  onMutelistChanged(cb: () => void): void {
    this.mutelistChangedCb = cb;
  }
  onOrgsChanged(cb: (orgIds: string[]) => void): void {
    this.orgsChangedCb = cb;
  }
  onUnreadCleared(cb: (convKey: string) => void): void {
    this.unreadClearedCb = cb;
  }
  onConversationDeleted(cb: (convKey: string) => void): void {
    this.conversationDeletedCb = cb;
  }
  onMessageDeleted(cb: (messageId: string, convKey: string) => void): void {
    this.messageDeletedCb = cb;
  }
  onSessionKicked(cb: () => void): void {
    this.sessionKickedCb = cb;
  }
  onError(cb: (error: Error, context: string) => void): void {
    this.errorCb = cb;
  }
  onSync(cb: (event: SyncEvent) => void): void {
    this.syncCb = cb;
  }

  // ---- Notification dispatch ----

  /**
   * 通知处理映射到的同步域：返回非 null 时，处理过程会包在 `session:sync`
   * started/success/failed 事件里。memory 基线**不做任何同步操作**，因此一律返回 null
   * （不发 session:sync、不显示"同步中"，也不触发 session:sync 驱动的重渲染）；
   * 只有 persistent 模式覆盖此方法返回真实域，因为只有它会把数据同步进本地副本。
   */
  protected syncDomain(_domain: SyncDomain): SyncDomain | null {
    return null;
  }

  handleNotification(n: Notification): void {
    switch (n.type) {
      case "messages:received": {
        // 累积触发本次通知的 msg_id；按 msg_ids 取消息只认 uid、忽略 target，故无需记录会话目标。
        const msgId = n.msg_id ? String(n.msg_id) : "";
        if (msgId && this.pendingMessageIds.size < this.batchMaxLimit) {
          this.pendingMessageIds.add(msgId);
        }
        this.enqueue("messages:received", this.syncDomain("messages"), () =>
          this.handleMessagesReceived(),
        );
        break;
      }
      case "contacts:updated":
        this.enqueue("contacts:updated", this.syncDomain("contacts"), () =>
          this.handleContactChanged(),
        );
        break;
      case "conversations:clearunread": {
        // 会话未读被清除：只清红点，绝不触发拉取（domain=null）。
        const toUid = n.from_uid ? String(n.from_uid) : "0";
        const gid = n.group_id ? String(n.group_id) : "0";
        const convKey = gid !== "0" ? "g:" + gid : "u:" + toUid;
        this.pendingClearedKeys.add(convKey);
        this.enqueue("conversations:clearunread", null, async () => {
          const keys = [...this.pendingClearedKeys];
          this.pendingClearedKeys.clear();
          for (const key of keys) {
            await this.clearLocalUnread(key);
            this.unreadClearedCb?.(key);
          }
        });
        break;
      }
      case "conversations:delete": {
        // 会话被删除：命中数据窗口则就地删除，绝不触发拉取（domain=null）。
        const toUid = n.from_uid ? String(n.from_uid) : "0";
        const gid = n.group_id ? String(n.group_id) : "0";
        const convKey = gid !== "0" ? "g:" + gid : "u:" + toUid;
        this.pendingDeletedConvKeys.add(convKey);
        this.enqueue("conversations:delete", null, async () => {
          const keys = [...this.pendingDeletedConvKeys];
          this.pendingDeletedConvKeys.clear();
          for (const key of keys) {
            await this.deleteLocalConversation(key);
            this.conversationDeletedCb?.(key);
          }
        });
        break;
      }
      case "messages:delete": {
        // 消息被删除：删本地副本并回调 UI 就地删除 + 定向刷新会话预览，绝不触发拉取（domain=null）。
        const msgId = n.msg_id ? String(n.msg_id) : "";
        if (!msgId) break;
        const toUid = n.from_uid ? String(n.from_uid) : "0";
        const gid = n.group_id ? String(n.group_id) : "0";
        const convKey = gid !== "0" ? "g:" + gid : "u:" + toUid;
        this.pendingDeletedMsgIds.set(msgId, convKey);
        this.enqueue("messages:delete", null, async () => {
          const entries = [...this.pendingDeletedMsgIds];
          this.pendingDeletedMsgIds.clear();
          for (const [id, key] of entries) {
            await this.deleteLocalMessage(id);
            this.messageDeletedCb?.(id, key);
          }
        });
        break;
      }
      case "blocklist:updated":
        this.enqueue("blocklist:updated", this.syncDomain("blocklist"), () =>
          this.handleBlocklistChanged(),
        );
        break;
      case "mutelist:updated":
        this.enqueue("mutelist:updated", this.syncDomain("mutelist"), () =>
          this.handleMutelistChanged(),
        );
        break;
      case "org:updated": {
        // 轻通知只带 org_id：累积去重后按组织增量追平（persistent）或直接派发重拉信号（memory）。
        const orgId = n.org_id ? String(n.org_id) : "";
        if (orgId && orgId !== "0") this.pendingOrgIds.add(orgId);
        this.enqueue("org:updated", this.syncDomain("orgs"), () =>
          this.handleOrgsUpdated(),
        );
        break;
      }
      case "session:kicked":
        this.enqueue("session:kicked", null, () =>
          this.handleSessionKickedInternal(),
        );
        break;
    }
  }

  // ---- Protected ----

  /**
   * 有界通知调度：每种 type 最多在队列中存在一个待处理闭包。
   * 若该 type 已在等待，只更新标记，不新增 Promise 链节点；
   * 当前轮次完成后会自动检查标记并重跑，确保不丢通知。
   */
  protected enqueue(
    notificationType: string,
    domain: SyncDomain | null,
    fn: () => Promise<void>,
  ): void {
    if (this.pendingFlags[notificationType]) {
      // 已有待处理节点，只标记"需要再跑一轮"，不追加新闭包
      return;
    }
    this.pendingFlags[notificationType] = true;
    this.syncQueue = this.syncQueue.then(async () => {
      while (this.pendingFlags[notificationType]) {
        this.pendingFlags[notificationType] = false;
        await this.runSyncTask(domain, fn).catch((e) =>
          this.reportError(e, `syncQueue ${notificationType} handler error`),
        );
      }
    });
  }

  private async runSyncTask(
    domain: SyncDomain | null,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (!domain) {
      await fn();
      return;
    }
    this.emitSync({ domain, status: "started" });
    try {
      await fn();
      this.emitSync({ domain, status: "success" });
    } catch (error) {
      const normalized =
        error instanceof Error
          ? error
          : new Error(String(error ?? "unknown error"));
      this.emitSync({ domain, status: "failed", error: normalized });
      throw normalized;
    }
  }

  protected reportError(error: unknown, context: string): void {
    const normalized =
      error instanceof Error
        ? error
        : new Error(String(error ?? "unknown error"));
    this.errorCb?.(normalized, context);
  }

  protected emitSync(event: SyncEvent): void {
    this.syncCb?.(Object.freeze({ ...event }));
  }

  protected emitMessagesReceived(messages: Message[]): void {
    this.messagesReceivedCb?.(messages);
  }

  protected emitContactsChanged(contacts: Contact[], replace = false): void {
    this.contactsChangedCb?.(contacts, replace);
  }

  protected emitBlocklistChanged(): void {
    this.blocklistChangedCb?.();
  }

  protected emitMutelistChanged(): void {
    this.mutelistChangedCb?.();
  }

  protected emitOrgsChanged(orgIds: string[]): void {
    this.orgsChangedCb?.(orgIds);
  }

  /**
   * 读取并清空 pendingMessageIds，按 msg_id 批量拉取内容后派发。
   * memory 直接调用；persistent 在本地同步完成后调用，从本地读取。
   * get_messages 按 msg_ids 取消息只认 uid、忽略 target，故无需会话目标。
   */
  protected async emitNotifiedMessages(): Promise<void> {
    const ids = [...this.pendingMessageIds];
    this.pendingMessageIds.clear();
    let messages: Message[] = [];
    if (ids.length > 0) {
      try {
        messages = (await this.get_messages({ msg_ids: ids })).messages;
      } catch (error) {
        this.reportError(error, "fetch notified messages failed");
      }
    }
    this.emitMessagesReceived(messages);
  }

  protected async handleMessagesReceived(): Promise<void> {
    // 默认（memory 基线）：不维护游标、不扫描会话，按通知 msg_id 批量直读内容后派发。
    await this.emitNotifiedMessages();
  }

  protected async handleContactChanged(): Promise<void> {
    // 默认（memory 基线）：仅发出“通讯录已变更、请重拉”的重绘信号，与 block/mute 一致。
    this.emitContactsChanged([], true);
  }

  protected async handleBlocklistChanged(): Promise<void> {
    this.emitBlocklistChanged();
  }

  /**
   * 清除本地副本中某会话的未读计数（convKey 形如 `u:<uid>` / `g:<gid>`）。
   * memory 模式无本地副本，为空操作；persistent 模式覆盖此方法直接改本地表。
   */
  protected async clearLocalUnread(_convKey: string): Promise<void> {}

  /**
   * 删除本地副本中某会话行（convKey 形如 `u:<uid>` / `g:<gid>`）。
   * memory 模式无本地副本，为空操作；persistent 模式覆盖直接删本地表。
   */
  protected async deleteLocalConversation(_convKey: string): Promise<void> {}

  /**
   * 删除本地副本中某条消息（按 msg_id）。
   * memory 模式无本地副本，为空操作；persistent 模式覆盖直接删本地表。
   */
  protected async deleteLocalMessage(_messageId: string): Promise<void> {}

  protected async handleMutelistChanged(): Promise<void> {
    this.emitMutelistChanged();
  }

  /** 读取并清空 pendingOrgIds。 */
  protected takePendingOrgIds(): string[] {
    const ids = [...this.pendingOrgIds];
    this.pendingOrgIds.clear();
    return ids;
  }

  protected async handleOrgsUpdated(): Promise<void> {
    // 默认（memory 基线）：无本地副本，仅派发"组织已变更、请重拉"的重绘信号。
    const ids = this.takePendingOrgIds();
    if (ids.length > 0) this.emitOrgsChanged(ids);
  }

  private async handleSessionKickedInternal(): Promise<void> {
    this.sessionKickedCb?.();
  }
}
