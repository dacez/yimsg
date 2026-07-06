import type {
  ConversationEntry,
  Message,
  Contact,
  UserInfo,
  GroupInfo,
  Notification,
  BlocklistUser,
  MutelistEntry,
  OrgInfo,
  TagInfo,
  Tag,
} from "../../types";
import type { PageInfoResult, PageParams } from "../internal/action-mappers";
import type { ConversationTarget } from "../types";

// 展示通道统一分页：所有 get_* 返回 { items, page }，page 为不透明 keyset 游标信息。
// 与 sync_* 的 seq 同步游标相互独立。

export interface ConversationPageResult {
  readonly conversations: ConversationEntry[];
  readonly page: PageInfoResult;
}

export interface MessagePageResult {
  readonly messages: Message[];
  readonly page: PageInfoResult;
}

export interface ContactPageResult {
  readonly contacts: Contact[];
  readonly page: PageInfoResult;
}

export interface ContactPageParams {
  readonly page?: PageParams;
  readonly status?: number;
  readonly friend_uid?: string;
  readonly group_id?: string;
  readonly org_id?: string;
  readonly friend_uids?: readonly string[];
  readonly group_ids?: readonly string[];
  readonly org_ids?: readonly string[];
}

export interface TagsPageParams {
  readonly org_id: string;
  readonly tag_id: string;
  readonly page?: PageParams;
}

export interface TagsPageResult {
  readonly tags: Tag[];
  readonly page: PageInfoResult;
}

export interface BlocklistPageResult {
  readonly users: BlocklistUser[];
  readonly page: PageInfoResult;
}

export interface BlocklistPageParams {
  readonly page?: PageParams;
  readonly status?: number;
  readonly uids?: readonly string[];
}

export interface MutelistPageResult {
  readonly mutes: MutelistEntry[];
  readonly page: PageInfoResult;
}

export interface MutelistPageParams {
  readonly page?: PageParams;
  readonly status?: number;
  readonly to_uid?: string;
  readonly group_id?: string;
  readonly to_uids?: readonly string[];
  readonly group_ids?: readonly string[];
}

export type SyncDomain =
  | "storage"
  | "messages"
  | "conversations"
  | "contacts"
  | "blocklist"
  | "mutelist"
  | "orgs";
export type SyncStatus = "started" | "success" | "failed" | "reset";

export interface SyncEvent {
  readonly domain: SyncDomain;
  readonly status: SyncStatus;
  readonly cursor?: number;
  readonly error?: Error;
}

export type MaybePromise<T> = T | Promise<T>;

export interface DisplayInfoFetchOptions<TInfo> {
  readonly cacheTtlMs: number;
  readonly updateDisplayInfos?: (entries: TInfo[]) => void;
}

/**
 * DataGateway — memory 和持久存储共用的数据读取接口。
 *
 * **核心约定：持久存储本地副本与服务端数据同步，
 * 所有读取方法的返回格式必须与服务端一致。**
 */
export interface DataGateway {
  // ---- Lifecycle ----
  init(uid: string): Promise<{ lastMsgSeq: number; lastContactSeq: number }>;
  clear(): void;

  // ---- Data reads ----
  get_conversations(params: { page?: PageParams; targets?: ConversationTarget[] }): Promise<ConversationPageResult>;
  get_unread_count(): Promise<number>;
  get_messages(params: {
    to_uid?: string;
    group_id?: string;
    page?: PageParams;
    msg_ids?: string[];
  }): Promise<MessagePageResult>;
  get_contacts(params: ContactPageParams): Promise<ContactPageResult>;
  get_contact_count(status: number): Promise<number>;
  get_tags(params: TagsPageParams): Promise<TagsPageResult>;
  get_blocklist(params: BlocklistPageParams): Promise<BlocklistPageResult>;
  get_mutelist(params: MutelistPageParams): Promise<MutelistPageResult>;

  // ---- Cache support ----
  get_user_infos(
    uids: string[],
    options: DisplayInfoFetchOptions<UserInfo>,
  ): MaybePromise<UserInfo[]>;
  get_group_infos(
    groupIds: string[],
    options: DisplayInfoFetchOptions<GroupInfo>,
  ): MaybePromise<GroupInfo[]>;
  get_org_infos(
    orgIds: string[],
    options: DisplayInfoFetchOptions<OrgInfo>,
  ): MaybePromise<OrgInfo[]>;
  get_tag_infos(
    orgId: string,
    tagIds: string[],
    options: DisplayInfoFetchOptions<TagInfo>,
  ): MaybePromise<TagInfo[]>;

  // ---- Event callbacks ----
  onMessagesReceived(cb: (messages: Message[]) => void): void;
  onContactsChanged(cb: (contacts: Contact[], replace?: boolean) => void): void;
  onBlocklistChanged(cb: () => void): void;
  onMutelistChanged(cb: () => void): void;
  onOrgsChanged(cb: (orgIds: string[]) => void): void;
  onUnreadCleared(cb: (convKey: string) => void): void;
  onConversationDeleted(cb: (convKey: string) => void): void;
  onMessageDeleted(cb: (messageId: string, convKey: string) => void): void;
  onSessionKicked(cb: () => void): void;
  onError(cb: (error: Error, context: string) => void): void;
  onSync(cb: (event: SyncEvent) => void): void;

  // ---- Notification dispatch ----
  handleNotification(n: Notification): void;
}
