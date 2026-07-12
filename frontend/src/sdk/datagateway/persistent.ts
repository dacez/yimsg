import type {
  ConversationEntry,
  Message,
  Contact,
  UserInfo,
  GroupInfo,
  BlocklistUser,
  MutelistEntry,
  Tag,
  OrgInfo,
  TagInfo,
} from "../../types";
import type { WsTransport } from "../transport/connection";
import type {
  BlocklistPageParams,
  BlocklistPageResult,
  ContactPageParams,
  ContactPageResult,
  DisplayInfoFetchOptions,
  ConversationPageResult,
  MessagePageResult,
  MutelistPageParams,
  MutelistPageResult,
  SyncDomain,
  TagsPageParams,
  TagsPageResult,
} from "./interface";
import type { PageInfoResult, PageParams } from "../internal/action-mappers";
import type { ConversationTarget } from "../types";
import { decodeCursor, decodeSeqCursor, encodeCursor, encodeSeqCursor } from "../internal/page-cursor";
import { BaseDataGateway } from "./base";
import { MessageBody } from "../generated/yimsg";
import { messageSearchText } from "../internal/message-search";
import {
  CONTACT_DELETED,
  CONTACT_PENDING_INCOMING,
  CONTACT_PENDING_OUTGOING,
  MSG_TYPE_RECALL,
  STATUS_DELETED,
} from "../../constants";

function encodeMessageBody(body: Message["body"] | undefined): Uint8Array {
  const bytes = MessageBody.encode((body || {}) as unknown as MessageBody).finish();
  const B = (globalThis as unknown as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  // better-sqlite3 需要 Buffer；浏览器 worker 接受 Uint8Array。
  return B ? B.from(bytes) : bytes;
}

function decodeMessageBody(raw: unknown): Message["body"] {
  if (!raw) return {};
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
  if (bytes.length === 0) return {};
  return MessageBody.decode(bytes) as unknown as Message["body"];
}
import { DEFAULT_SYNC_BATCH_SIZE } from "../internal/sdk-defaults";
import { clampOptionalPageLimit } from "../internal/limits";
import { runIncrementalSync, runPersistentTableSync, type SyncPage } from "./sync-loop";
import { isServerErrorCode } from "../errors";
import * as actions from "../generated/actions.gen";
import * as actionMappers from "../internal/action-mappers";

/** Minimal DB interface for testability (SqliteWorkerApi implements this). */
export interface DbApi {
  open(dbName: string): Promise<void>;
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execBatch(statements: { sql: string; params?: unknown[] }[]): Promise<void>;
  close(): Promise<void>;
  deleteDb(dbName: string): Promise<void>;
  /** 仅浏览器 OPFS 后端（SqliteWorkerApi）实现：终止其专属 Worker 线程，释放句柄之外的线程本身。 */
  terminate?(): void;
}

/** duck-type 调用可选的 terminate()，避免 close() 之后 Worker 线程残留。 */
export function terminateDbApi(db: DbApi): void {
  if (typeof db.terminate === "function") db.terminate();
}

interface PersistentDataGatewayOptions {
  db?: DbApi;
  batchMaxLimit?: number;
  contactDeletedStatus?: number;
  instanceId?: string;
}

type SyncCursorKey =
  | "msg_seq"
  | "contact_seq"
  | "conversation_seq"
  | "blocklist_seq"
  | "mutelist_seq";

function emptyRebuilding(): Record<SyncCursorKey, boolean> {
  return {
    msg_seq: false,
    contact_seq: false,
    conversation_seq: false,
    blocklist_seq: false,
    mutelist_seq: false,
  };
}
type DisplayCacheKind = "user" | "group" | "org" | "tag";
type RebuildSyncParams = { last_seq?: number; rebuild?: boolean };

/** 单个同步域结束后的变更摘要，供 emitDone 决定派发何种 UI 事件。 */
interface DomainSyncOutcome {
  /** 本轮是否发生过任何写入或 reset。 */
  readonly changed: boolean;
  /** 本轮是否至少派发过一次 emitBatch（仅通讯录使用）。 */
  readonly emittedBatch: boolean;
  /** 本轮是否因 seq_too_old 触发过本地重建。 */
  readonly reset: boolean;
}

/**
 * 同步域描述符：把 messages / contacts / blocklist / mutelist 的差异收敛为数据。
 * 通用引擎 syncDomainPage / fullSyncDomain 只依赖这份描述，撤回折叠、字段映射、
 * UI 事件等"特殊逻辑"都通过下列函数参数注入。
 *
 * - TItem：服务端返回并用于推进游标 / 翻页的原始条目。
 * - TEmit：applyPage 落库后回传给调用方的派发条目（消息为撤回折叠后的可见消息，
 *   其余域与 TItem 相同）。
 */
interface SyncDomainSpec<TItem, TEmit = TItem> {
  /** onSync 事件使用的域名（与游标键一一对应）。 */
  readonly domain: "messages" | "contacts" | "blocklist" | "mutelist";
  /** 本地 meta 游标键。 */
  readonly cursorKey: SyncCursorKey;
  /** 本地表名，seq_too_old 重建时按此清表。 */
  readonly table: string;
  /**
   * 调服务端 sync 接口拉一页，返回原始条目与服务端给出的 has_more / cursor_seq；
   * seq_too_old 以抛出 ServerError 表达。
   */
  fetchPage(params: {
    last_seq: number;
    limit?: number;
    rebuild: boolean;
  }): Promise<SyncPage<TItem>>;
  /** 该本地表的唯一写入点；返回供 UI 派发的条目（撤回折叠等特殊逻辑在此实现）。 */
  applyPage(items: TItem[]): Promise<TEmit[]>;
  /** 每批落库后的增量派发（仅通讯录需要带数据，其余域留空）。 */
  emitBatch?(items: TItem[]): void;
  /** 整轮同步结束后的 UI 事件派发。 */
  emitDone?(outcome: DomainSyncOutcome): void;
}

interface DisplayCacheInput {
  uid: string;
  groupId: string;
  orgId: string;
  tagId: string;
  username: string;
  name: string;
  avatar: string;
  remark: string;
  updatedAt: number;
}

export function buildPersistentDbName(
  uid: string,
  instanceId = "default",
): string {
  return `yimsg-${uid}__${instanceId}.db`;
}

function shouldRebuild(
  params: RebuildSyncParams,
  rebuilding: boolean,
): boolean {
  return Boolean(params.rebuild || params.last_seq === 0 || rebuilding);
}

export class PersistentDataGateway extends BaseDataGateway {
  private db: DbApi;
  private uid = "";
  private contactDeletedStatus: number;
  private readonly instanceId: string;
  /** 各域是否处于 rebuild（last_seq=0, rebuild=true）追平过程，跨多批 syncDomainPage 调用保持。 */
  private readonly rebuilding = emptyRebuilding();
  private backgroundSyncRun = 0;
  private backgroundSyncPromise: Promise<void> = Promise.resolve();

  private readonly messagesSpec: SyncDomainSpec<Message, Message>;
  private readonly contactsSpec: SyncDomainSpec<Contact>;
  private readonly blocklistSpec: SyncDomainSpec<BlocklistUser>;
  private readonly mutelistSpec: SyncDomainSpec<MutelistEntry>;

  constructor(transport: WsTransport, options?: PersistentDataGatewayOptions) {
    super(transport, { batchMaxLimit: options?.batchMaxLimit });
    this.contactDeletedStatus =
      options?.contactDeletedStatus ?? CONTACT_DELETED;
    this.instanceId = options?.instanceId ?? "default";

    if (!options?.db) {
      throw new Error(
        "PersistentDataGateway requires a db option (DbApi instance)",
      );
    }
    this.db = options.db;

    // 消息：无 rebuild 语义（请求不带该字段、服务端永不返回 seq_too_old），
    // 但仍走同一套引擎；撤回折叠在 applyMessageSyncBatch 内完成并回传可见消息。
    this.messagesSpec = {
      domain: "messages",
      cursorKey: "msg_seq",
      table: "messages",
      fetchPage: async ({ last_seq, limit }) => {
        const { messages, hasMore, cursorSeq } = actionMappers.mapSyncMessagesResponse(
          await actions.syncMessages(
            this.transport,
            actionMappers.syncMessagesRequest({ last_seq, limit }),
          ),
        );
        return { items: messages, hasMore, cursorSeq };
      },
      applyPage: (items) => this.applyMessageSyncBatch(items),
      emitDone: ({ changed }) => {
        if (changed) this.emitMessagesReceived([]);
      },
    };
    this.contactsSpec = {
      domain: "contacts",
      cursorKey: "contact_seq",
      table: "contacts",
      fetchPage: async ({ last_seq, limit, rebuild }) => {
        const { contacts, hasMore, cursorSeq } = actionMappers.mapSyncContactsResponse(
          await actions.syncContacts(
            this.transport,
            actionMappers.syncContactsRequest({ last_seq, limit, rebuild }),
          ),
        );
        return { items: contacts, hasMore, cursorSeq };
      },
      applyPage: async (items) => {
        await this.applyContactSyncBatch(items);
        return items;
      },
      emitBatch: (items) => this.emitContactsChanged(items),
      emitDone: ({ reset, emittedBatch }) => {
        if (reset && !emittedBatch) this.emitContactsChanged([], true);
      },
    };
    this.blocklistSpec = {
      domain: "blocklist",
      cursorKey: "blocklist_seq",
      table: "blocklist",
      fetchPage: async ({ last_seq, limit, rebuild }) => {
        const { users, hasMore, cursorSeq } = actionMappers.mapSyncBlocklistResponse(
          await actions.syncBlocklist(
            this.transport,
            actionMappers.syncBlocklistRequest({ last_seq, limit, rebuild }),
          ),
        );
        return { items: users, hasMore, cursorSeq };
      },
      applyPage: async (items) => {
        await this.applyBlocklistSyncBatch(items);
        return items;
      },
      emitDone: ({ changed }) => {
        if (changed) this.emitBlocklistChanged();
      },
    };
    this.mutelistSpec = {
      domain: "mutelist",
      cursorKey: "mutelist_seq",
      table: "mutelist",
      fetchPage: async ({ last_seq, limit, rebuild }) => {
        const { mutes, hasMore, cursorSeq } = actionMappers.mapSyncMutelistResponse(
          await actions.syncMutelist(
            this.transport,
            actionMappers.syncMutelistRequest({ last_seq, limit, rebuild }),
          ),
        );
        return { items: mutes, hasMore, cursorSeq };
      },
      applyPage: async (items) => {
        await this.applyMutelistSyncBatch(items);
        return items;
      },
      emitDone: ({ changed }) => {
        if (changed) this.emitMutelistChanged();
      },
    };
  }

  // ---- Lifecycle ----

  async init(
    uid: string,
  ): Promise<{ lastMsgSeq: number; lastContactSeq: number }> {
    this.uid = uid;

    await this.runSyncStage("storage", async () => {
      await this.db.open(buildPersistentDbName(uid, this.instanceId));
    });

    this.startBackgroundSync();

    return {
      lastMsgSeq: await this.cursor("msg_seq"),
      lastContactSeq: await this.cursor("contact_seq"),
    };
  }

  clear(): void {
    this.backgroundSyncRun += 1;
    super.clear();
    this.db
      .close()
      .catch((e) => this.reportError(e, "db close error"))
      .finally(() => terminateDbApi(this.db));
  }

  // ---- Data reads (local SQLite) ----

  /**
   * 本地 seq keyset 分页：与服务端展示通道语义一致，自产自销不透明游标。
   * descTop=true 展示序 新→旧（会话/屏蔽/免打扰）；false 展示序 旧→新（消息）。
   * older(): seq<cursor 按 DESC；newer(): seq>cursor 按 ASC。
   */
  private async seqKeysetPage(opts: {
    table: string;
    where: string;
    binds: unknown[];
    extraOrder?: string;
    descTop: boolean;
    page?: PageParams;
  }): Promise<{ rows: Record<string, unknown>[]; page: PageInfoResult }> {
    const p = opts.page ?? {};
    const backward = Boolean(p.backward);
    const limit = clampOptionalPageLimit(p.limit) ?? 200;
    const cursorSeq = p.cursor ? decodeSeqCursor(p.cursor) : 0;
    const fetchOlder = opts.descTop !== backward;
    let where = opts.where;
    const binds = [...opts.binds];
    let orderBy: string;
    if (fetchOlder) {
      if (cursorSeq > 0) {
        where += " AND seq < ?";
        binds.push(cursorSeq);
      }
      orderBy = "seq DESC";
    } else {
      if (cursorSeq > 0) {
        where += " AND seq > ?";
        binds.push(cursorSeq);
      }
      orderBy = "seq ASC";
    }
    const extra = opts.extraOrder ? `, ${opts.extraOrder}` : "";
    const rows = await this.db.query(
      `SELECT * FROM ${opts.table} WHERE ${where} ORDER BY ${orderBy}${extra} LIMIT ?`,
      [...binds, limit + 1],
    );
    const hasMoreTraveled = rows.length > limit;
    if (hasMoreTraveled) rows.length = limit;
    if (fetchOlder !== opts.descTop) rows.reverse();
    const seqOf = (r: Record<string, unknown>) => Number((r.seq as number) || 0);
    const page: PageInfoResult = {
      startCursor: rows.length ? encodeSeqCursor(seqOf(rows[0])) : "",
      endCursor: rows.length ? encodeSeqCursor(seqOf(rows[rows.length - 1])) : "",
      hasMoreBackward: backward ? hasMoreTraveled : Boolean(p.cursor),
      hasMoreForward: backward ? Boolean(p.cursor) : hasMoreTraveled,
      total: -1,
    };
    return { rows, page };
  }

  async get_conversations(params: { page?: PageParams; targets?: ConversationTarget[] }): Promise<ConversationPageResult> {
    // targets 非空：按目标读取本地仍活跃的会话当前状态（轻通知后定向刷新），不分页。
    if (params.targets && params.targets.length > 0) {
      const conds: string[] = [];
      const binds: unknown[] = [STATUS_DELETED];
      for (const t of params.targets) {
        const groupId = (t as { groupId?: string }).groupId;
        const toUid = (t as { toUid?: string }).toUid;
        conds.push("(to_uid = ? AND group_id = ?)");
        binds.push(groupId ? "0" : toUid || "0", groupId || "0");
      }
      const rows = await this.db.query(
        `SELECT * FROM conversations WHERE status != ? AND (${conds.join(" OR ")})`,
        binds,
      );
      const conversations = await Promise.all(rows.map((r) => this.rowToConversationEntry(r)));
      const empty: PageInfoResult = {
        startCursor: "",
        endCursor: "",
        hasMoreBackward: false,
        hasMoreForward: false,
        total: -1,
      };
      return { conversations, page: empty };
    }
    const { rows, page } = await this.seqKeysetPage({
      table: "conversations",
      where: "status != ?",
      binds: [STATUS_DELETED],
      descTop: true,
      page: params.page,
    });
    const conversations = await Promise.all(rows.map((r) => this.rowToConversationEntry(r)));
    return { conversations, page };
  }

  async get_unread_count(): Promise<number> {
    const rows = await this.db.query(
      "SELECT COALESCE(SUM(unread_count), 0) AS total FROM conversations WHERE status != ?",
      [STATUS_DELETED],
    );
    return Number(rows[0]?.total || 0);
  }

  async get_messages(params: {
    to_uid?: string;
    group_id?: string;
    page?: PageParams;
    msg_ids?: string[];
  }): Promise<MessagePageResult> {
    const empty: PageInfoResult = {
      startCursor: "",
      endCursor: "",
      hasMoreBackward: false,
      hasMoreForward: false,
      total: -1,
    };
    // 按 msg_id 批量读取本地消息：msg_id 在本地表全局唯一，无需会话过滤、不分页。
    if (params.msg_ids && params.msg_ids.length > 0) {
      const placeholders = params.msg_ids.map(() => "?").join(",");
      const rows = await this.db.query(
        `SELECT * FROM messages WHERE msg_id IN (${placeholders}) AND status != ? ORDER BY seq ASC`,
        [...params.msg_ids, STATUS_DELETED],
      );
      return { messages: rows.map((r) => this.rowToMessage(r)), page: empty };
    }

    const { filter, binds } = this.convFilter(params);
    const visibleFilter = `${filter} AND status != ?`;
    const visibleBinds = [...binds, STATUS_DELETED];
    const page = params.page ?? {};

    // around：以 msg_id 为锚点居中定位（jump-to-message）。
    if (page.around) {
      const limit = clampOptionalPageLimit(page.limit) || 30;
      const anchor = await this.db.query(
        `SELECT seq FROM messages WHERE msg_id = ? AND status != ?`,
        [page.around, STATUS_DELETED],
      );
      const aroundSeq = Number(anchor[0]?.seq || 0);
      const before = await this.db.query(
        `SELECT * FROM messages WHERE ${visibleFilter} AND seq <= ? ORDER BY seq DESC LIMIT ?`,
        [...visibleBinds, aroundSeq, Math.ceil(limit / 2)],
      );
      const after = await this.db.query(
        `SELECT * FROM messages WHERE ${visibleFilter} AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [...visibleBinds, aroundSeq, Math.floor(limit / 2)],
      );
      before.reverse();
      const rows = [...before, ...after]; // 展示序 ASC
      const messages = rows.map((r) => this.rowToMessage(r));
      return {
        messages,
        page: {
          startCursor: rows.length ? encodeSeqCursor(Number(rows[0].seq)) : "",
          endCursor: rows.length ? encodeSeqCursor(Number(rows[rows.length - 1].seq)) : "",
          hasMoreBackward: rows.length > 0,
          hasMoreForward: rows.length > 0,
          total: -1,
        },
      };
    }

    const { rows, page: pageInfo } = await this.seqKeysetPage({
      table: "messages",
      where: visibleFilter,
      binds: visibleBinds,
      descTop: false,
      page,
    });
    return { messages: rows.map((r) => this.rowToMessage(r)), page: pageInfo };
  }

  protected async syncMessages(params: {
    last_seq: number;
    limit?: number;
  }): Promise<Message[]> {
    const { emitted } = await this.syncDomainPage(this.messagesSpec, params);
    return emitted.sort((a, b) => a.seq - b.seq);
  }

  /**
   * messages 表的唯一写入点。只写 messages 表，绝不触碰 conversations / 游标 / meta。
   * 会话由 syncConversations 独立同步（domain 边界）。
   * 返回本批次对 UI 可见的消息（撤回事件已折叠为对应原消息的撤回占位）。
   */
  private async applyMessageSyncBatch(messages: Message[]): Promise<Message[]> {
    const stmts: { sql: string; params: unknown[] }[] = [];
    const visibleMessages: Message[] = [];

    const insertMessage = (m: Message, body: Message["body"], msgType: number, seq: number, sendTime: number) => {
      stmts.push({
        sql: `INSERT INTO messages (seq, msg_id, from_uid, to_uid, group_id, msg_type, body, search_text, send_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(msg_id) DO UPDATE SET
                seq = excluded.seq,
                from_uid = excluded.from_uid,
                to_uid = excluded.to_uid,
                group_id = excluded.group_id,
                msg_type = excluded.msg_type,
                body = excluded.body,
                search_text = excluded.search_text,
                send_time = excluded.send_time,
                status = 0`,
        params: [
          seq,
          m.msg_id || "",
          m.from_uid || "0",
          m.to_uid || "0",
          m.group_id || "0",
          msgType,
          encodeMessageBody(body),
          messageSearchText(body),
          sendTime,
        ],
      });
    };

    // 第一遍：收集撤回事件（recall.msg_id 指向被撤回的原消息）。
    const recallByTarget = new Map<string, Message>();
    for (const m of messages) {
      const recall = m.body?.recall;
      if (m.msg_type === MSG_TYPE_RECALL && recall && String(recall.msg_id) !== String(m.msg_id)) {
        recallByTarget.set(String(recall.msg_id), m);
      }
    }

    // 第二遍：普通消息落库；被撤回的原消息折叠为撤回占位；撤回事件本身不单独落库/展示。
    const foldedTargets = new Set<string>();
    for (const m of messages) {
      if (Number(m.status || 0) === STATUS_DELETED) {
        stmts.push({ sql: "DELETE FROM messages WHERE msg_id = ?", params: [m.msg_id] });
        visibleMessages.push(m);
        continue;
      }
      const recall = m.body?.recall;
      if (m.msg_type === MSG_TYPE_RECALL && recall && String(recall.msg_id) !== String(m.msg_id)) {
        continue;
      }
      const event = recallByTarget.get(String(m.msg_id));
      if (event) {
        // 本批次内同时收到原消息与其撤回事件：直接以撤回占位落库（保留原 seq）。
        foldedTargets.add(String(m.msg_id));
        insertMessage(m, event.body, MSG_TYPE_RECALL, m.seq, Number(m.send_time || 0));
        visibleMessages.push({ ...event, msg_id: m.msg_id });
        continue;
      }
      insertMessage(m, m.body, Number(m.msg_type || 0), m.seq, Number(m.send_time || 0));
      visibleMessages.push(m);
    }

    // 原消息不在本批次（早前已落库）：覆盖本地行为撤回占位。
    for (const [targetMsgId, event] of recallByTarget) {
      if (foldedTargets.has(targetMsgId)) continue;
      stmts.push({
        sql: "UPDATE messages SET msg_type = ?, body = ?, search_text = ? WHERE msg_id = ?",
        params: [MSG_TYPE_RECALL, encodeMessageBody(event.body), "", targetMsgId],
      });
      visibleMessages.push({ ...event, msg_id: targetMsgId });
    }

    if (stmts.length > 0) await this.db.execBatch(stmts);
    return visibleMessages;
  }

  async get_contacts(params: ContactPageParams): Promise<ContactPageResult> {
    const { where, binds } = this.contactFilter(params);
    const p = params.page ?? {};
    const backward = Boolean(p.backward);
    const limit = clampOptionalPageLimit(p.limit) ?? 200;
    const pending = params.status === CONTACT_PENDING_OUTGOING || params.status === CONTACT_PENDING_INCOMING;
    const parts = p.cursor ? decodeCursor(p.cursor) : [];
    let w = where;
    const b = [...binds];
    let orderBy: string;
    if (pending) {
      // seq 在本地唯一；展示序 seq DESC。
      orderBy = backward ? "seq ASC" : "seq DESC";
      if (parts.length >= 1) {
        w += backward ? " AND seq > ?" : " AND seq < ?";
        b.push(Number(parts[0]));
      }
    } else {
      orderBy = backward
        ? "sort_key DESC, type DESC, id DESC"
        : "sort_key ASC, type ASC, id ASC";
      if (parts.length >= 3) {
        w += backward
          ? " AND (sort_key, type, id) < (?, ?, ?)"
          : " AND (sort_key, type, id) > (?, ?, ?)";
        b.push(parts[0], Number(parts[1]), String(parts[2]));
      }
    }
    const rows = await this.db.query(
      `SELECT * FROM contacts WHERE ${w} ORDER BY ${orderBy} LIMIT ?`,
      [...b, limit + 1],
    );
    const hasMoreTraveled = rows.length > limit;
    if (hasMoreTraveled) rows.length = limit;
    if (backward) rows.reverse();
    const contacts = rows.map((r) => this.rowToContact(r));
    const cur = (r: Record<string, unknown>) =>
      pending
        ? encodeCursor(String(r.seq ?? "0"))
        : encodeCursor(String(r.sort_key ?? ""), String(r.type ?? "0"), String(r.id ?? "0"));
    const page: PageInfoResult = {
      startCursor: rows.length ? cur(rows[0]) : "",
      endCursor: rows.length ? cur(rows[rows.length - 1]) : "",
      hasMoreBackward: backward ? hasMoreTraveled : Boolean(p.cursor),
      hasMoreForward: backward ? Boolean(p.cursor) : hasMoreTraveled,
      total: -1,
    };
    return { contacts, page };
  }

  async get_contact_count(status: number): Promise<number> {
    const { where, binds } = this.contactFilter({ status });
    const rows = await this.db.query(
      `SELECT COUNT(*) AS total FROM contacts WHERE ${where}`,
      binds,
    );
    return Number(rows[0]?.total || 0);
  }

  protected async syncContacts(params: {
    last_seq?: number;
    limit?: number;
    rebuild?: boolean;
  }): Promise<{ contacts: Contact[]; error?: string }> {
    const { items, error } = await this.syncDomainPage(
      this.contactsSpec,
      params,
    );
    return { contacts: items, error };
  }

  /** contacts 表的唯一写入点。只写 contacts 表，不触碰游标 / meta；组织行 tombstone 时联动清空该组织本地副本与游标（离职清库）。 */
  private async applyContactSyncBatch(contacts: Contact[]): Promise<void> {
    if (contacts.length === 0) return;
    const stmts: { sql: string; params: unknown[] }[] = [];
    const leftOrgIds: string[] = [];
    for (const c of contacts) {
      const target = c.target || {};
      const friendUid = c.friend_uid || target.uid || "0";
      const groupId = c.group_id || target.group_id || "0";
      const orgId = c.org_id || target.org_id || "0";
      const contactType = friendUid !== "0" ? 1 : groupId !== "0" ? 2 : orgId !== "0" ? 3 : 0;
      const contactId = friendUid !== "0" ? friendUid : groupId !== "0" ? groupId : orgId;
      const deleted = Number(c.status || 0) === this.contactDeletedStatus;
      if (deleted && orgId !== "0") leftOrgIds.push(orgId);
      stmts.push({
        sql: deleted
          ? "DELETE FROM contacts WHERE type = ? AND id = ?"
          : `INSERT INTO contacts (type, id, status, remark_name, sort_key, search_text, seq)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(type, id) DO UPDATE SET
                status = excluded.status,
                remark_name = excluded.remark_name,
                sort_key = excluded.sort_key,
                search_text = excluded.search_text,
                seq = excluded.seq`,
        params: deleted
          ? [contactType, contactId]
          : [
              contactType,
              contactId,
              c.status,
              c.remark_name || "",
              c.sort_key || "",
              c.search_text || "",
              c.seq,
            ],
      });
    }
    await this.db.execBatch(stmts);
    for (const orgId of leftOrgIds) {
      await this.purgeLocalOrg(orgId);
    }
  }

  async get_blocklist(
    params: BlocklistPageParams,
  ): Promise<BlocklistPageResult> {
    const { where, binds } = this.blocklistFilter(params);
    const { rows, page } = await this.seqKeysetPage({
      table: "blocklist",
      where,
      binds,
      extraOrder: "uid ASC",
      descTop: true,
      page: params.page,
    });
    return { users: rows.map((r) => this.rowToBlocklistUser(r)), page };
  }

  protected async syncBlocklist(params: {
    last_seq?: number;
    limit?: number;
    rebuild?: boolean;
  }): Promise<{ users: BlocklistUser[]; error?: string }> {
    const { items, error } = await this.syncDomainPage(
      this.blocklistSpec,
      params,
    );
    return { users: items, error };
  }

  async get_mutelist(params: MutelistPageParams): Promise<MutelistPageResult> {
    const { where, binds } = this.mutelistFilter(params);
    const { rows, page } = await this.seqKeysetPage({
      table: "mutelist",
      where,
      binds,
      extraOrder: "to_uid ASC, group_id ASC",
      descTop: true,
      page: params.page,
    });
    return { mutes: rows.map((r) => this.rowToMutelist(r)), page };
  }

  protected async syncMutelist(params: {
    last_seq?: number;
    limit?: number;
    rebuild?: boolean;
  }): Promise<{ mutes: MutelistEntry[]; error?: string }> {
    const { items, error } = await this.syncDomainPage(
      this.mutelistSpec,
      params,
    );
    return { mutes: items, error };
  }

  // ---- Cache support (SQLite persistence) ----

  async get_user_infos(
    uids: string[],
    options: DisplayInfoFetchOptions<UserInfo>,
  ): Promise<UserInfo[]> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.loadDisplayCache("user", uids);
    } catch (error) {
      this.reportError(error, "read user display cache failed");
      void this.refreshUserInfos(
        uids.map((uid) => String(uid)).filter((uid) => uid && uid !== "0"),
        options,
      );
      return [];
    }
    const profiles = rows.map((r) => ({
      uid: String(r.uid),
      username: String(r.username || ""),
      nickname: String(r.name || ""),
      avatar: String(r.avatar || ""),
      remark: String(r.remark_name || ""),
      created_at: 0,
      updated_at: Number(r.updated_at) || 0,
    }));
    const found = new Set(profiles.map((item) => String(item.uid)));
    const now = Date.now();
    const expired = new Set(
      profiles
        .filter(
          (item) => (Number(item.updated_at) || 0) + options.cacheTtlMs <= now,
        )
        .map((item) => String(item.uid)),
    );
    const needServer = uids
      .map((uid) => String(uid))
      .filter((uid) => uid && uid !== "0")
      .filter((uid) => !found.has(uid) || expired.has(uid));
    void this.refreshUserInfos(needServer, options);
    return profiles;
  }

  async get_group_infos(
    groupIds: string[],
    options: DisplayInfoFetchOptions<GroupInfo>,
  ): Promise<GroupInfo[]> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.loadDisplayCache("group", groupIds);
    } catch (error) {
      this.reportError(error, "read group display cache failed");
      void this.refreshGroupInfos(
        groupIds
          .map((groupId) => String(groupId))
          .filter((groupId) => groupId && groupId !== "0"),
        options,
      );
      return [];
    }
    const groups = rows.map((r) => ({
      group_id: String(r.group_id),
      name: String(r.name || ""),
      avatar: String(r.avatar || ""),
      owner_uid: "",
      remark: String(r.remark_name || ""),
      created_at: 0,
      updated_at: Number(r.updated_at) || 0,
    }));
    const found = new Set(groups.map((item) => String(item.group_id)));
    const now = Date.now();
    const expired = new Set(
      groups
        .filter(
          (item) => (Number(item.updated_at) || 0) + options.cacheTtlMs <= now,
        )
        .map((item) => String(item.group_id)),
    );
    const needServer = groupIds
      .map((groupId) => String(groupId))
      .filter((groupId) => groupId && groupId !== "0")
      .filter((groupId) => !found.has(groupId) || expired.has(groupId));
    void this.refreshGroupInfos(needServer, options);
    return groups;
  }

  async get_org_infos(
    orgIds: string[],
    options: DisplayInfoFetchOptions<OrgInfo>,
  ): Promise<OrgInfo[]> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.loadDisplayCache("org", orgIds);
    } catch (error) {
      this.reportError(error, "read org display cache failed");
      void this.refreshOrgInfos(
        orgIds.map((orgId) => String(orgId)).filter((orgId) => orgId && orgId !== "0"),
        options,
      );
      return [];
    }
    const orgs = rows.map((r) => ({
      org_id: String(r.org_id),
      name: String(r.name || ""),
      avatar: String(r.avatar || ""),
      updated_at: Number(r.updated_at) || 0,
    }));
    const found = new Set(orgs.map((item) => String(item.org_id)));
    const now = Date.now();
    const expired = new Set(
      orgs
        .filter((item) => (Number(item.updated_at) || 0) + options.cacheTtlMs <= now)
        .map((item) => String(item.org_id)),
    );
    const needServer = orgIds
      .map((orgId) => String(orgId))
      .filter((orgId) => orgId && orgId !== "0")
      .filter((orgId) => !found.has(orgId) || expired.has(orgId));
    void this.refreshOrgInfos(needServer, options);
    return orgs;
  }

  async get_tag_infos(
    orgId: string,
    tagIds: string[],
    options: DisplayInfoFetchOptions<TagInfo>,
  ): Promise<TagInfo[]> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.loadDisplayCache("tag", tagIds);
    } catch (error) {
      this.reportError(error, "read tag display cache failed");
      void this.refreshTagInfos(
        orgId,
        tagIds.map((tagId) => String(tagId)).filter((tagId) => tagId && tagId !== "0"),
        options,
      );
      return [];
    }
    const tags = rows.map((r) => ({
      tag_id: String(r.tag_id),
      name: String(r.name || ""),
      avatar: String(r.avatar || ""),
      updated_at: Number(r.updated_at) || 0,
    }));
    const found = new Set(tags.map((item) => String(item.tag_id)));
    const now = Date.now();
    const expired = new Set(
      tags
        .filter((item) => (Number(item.updated_at) || 0) + options.cacheTtlMs <= now)
        .map((item) => String(item.tag_id)),
    );
    const needServer = tagIds
      .map((tagId) => String(tagId))
      .filter((tagId) => tagId && tagId !== "0")
      .filter((tagId) => !found.has(tagId) || expired.has(tagId));
    void this.refreshTagInfos(orgId, needServer, options);
    return tags;
  }

  protected override async refreshUserInfos(
    uids: string[],
    options: DisplayInfoFetchOptions<UserInfo>,
  ): Promise<void> {
    if (uids.length === 0) return;
    try {
      const profiles = await this.fetchUserInfosFromServer(uids);
      if (profiles.length > 0) {
        const cacheUpdatedAt = Date.now();
        await this.putDisplayCache(
          profiles.map((e) => ({
            uid: String(e.uid || "0"),
            groupId: "0",
            orgId: "0",
            tagId: "0",
            username: e.username || "",
            name: e.nickname || e.username || "",
            avatar: e.avatar || "",
            remark: e.remark || "",
            updatedAt: cacheUpdatedAt,
          })),
        );
      }
      options.updateDisplayInfos?.(profiles);
    } catch (error) {
      this.reportError(error, "refresh user infos failed");
    }
  }

  protected override async refreshGroupInfos(
    groupIds: string[],
    options: DisplayInfoFetchOptions<GroupInfo>,
  ): Promise<void> {
    if (groupIds.length === 0) return;
    try {
      const groups = await this.fetchGroupInfosFromServer(groupIds);
      if (groups.length > 0) {
        const cacheUpdatedAt = Date.now();
        await this.putDisplayCache(
          groups.map((e) => ({
            uid: "0",
            groupId: String(e.group_id || "0"),
            orgId: "0",
            tagId: "0",
            username: "",
            name: e.name || "",
            avatar: e.avatar || "",
            remark: e.remark || "",
            updatedAt: cacheUpdatedAt,
          })),
        );
      }
      options.updateDisplayInfos?.(groups);
    } catch (error) {
      this.reportError(error, "refresh group infos failed");
    }
  }

  protected override async refreshOrgInfos(
    orgIds: string[],
    options: DisplayInfoFetchOptions<OrgInfo>,
  ): Promise<void> {
    if (orgIds.length === 0) return;
    try {
      const orgs = await this.fetchOrgInfosFromServer(orgIds);
      if (orgs.length > 0) {
        const cacheUpdatedAt = Date.now();
        await this.putDisplayCache(
          orgs.map((e) => ({
            uid: "0",
            groupId: "0",
            orgId: String(e.org_id || "0"),
            tagId: "0",
            username: "",
            name: e.name || "",
            avatar: e.avatar || "",
            remark: "",
            updatedAt: cacheUpdatedAt,
          })),
        );
      }
      options.updateDisplayInfos?.(orgs);
    } catch (error) {
      this.reportError(error, "refresh org infos failed");
    }
  }

  protected override async refreshTagInfos(
    orgId: string,
    tagIds: string[],
    options: DisplayInfoFetchOptions<TagInfo>,
  ): Promise<void> {
    if (tagIds.length === 0) return;
    try {
      const tags = await this.fetchTagInfosFromServer(orgId, tagIds);
      if (tags.length > 0) {
        const cacheUpdatedAt = Date.now();
        await this.putDisplayCache(
          tags.map((e) => ({
            uid: "0",
            groupId: "0",
            orgId: "0",
            tagId: String(e.tag_id || "0"),
            username: "",
            name: e.name || "",
            avatar: e.avatar || "",
            remark: "",
            updatedAt: cacheUpdatedAt,
          })),
        );
      }
      options.updateDisplayInfos?.(tags);
    } catch (error) {
      this.reportError(error, "refresh tag infos failed");
    }
  }

  private async loadDisplayCache(
    kind: DisplayCacheKind,
    ids: string[],
  ): Promise<Record<string, unknown>[]> {
    if (ids.length === 0) return [];
    const ph = ids.map(() => "?").join(",");
    switch (kind) {
      case "user":
        return this.db.query(
          `SELECT * FROM displayinfo WHERE group_id = '0' AND org_id = '0' AND tag_id = '0' AND uid IN (${ph})`,
          ids,
        );
      case "group":
        return this.db.query(
          `SELECT * FROM displayinfo WHERE uid = '0' AND org_id = '0' AND tag_id = '0' AND group_id IN (${ph})`,
          ids,
        );
      case "org":
        return this.db.query(
          `SELECT * FROM displayinfo WHERE uid = '0' AND group_id = '0' AND tag_id = '0' AND org_id IN (${ph})`,
          ids,
        );
      case "tag":
        return this.db.query(
          `SELECT * FROM displayinfo WHERE uid = '0' AND group_id = '0' AND org_id = '0' AND tag_id IN (${ph})`,
          ids,
        );
    }
  }

  private async putDisplayCache(entries: DisplayCacheInput[]): Promise<void> {
    if (entries.length === 0) return;
    const stmts = entries.map((e) => ({
      sql: "INSERT INTO displayinfo (uid, group_id, org_id, tag_id, username, name, avatar, remark_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(uid, group_id, org_id, tag_id) DO UPDATE SET username = excluded.username, name = excluded.name, avatar = excluded.avatar, remark_name = excluded.remark_name, updated_at = excluded.updated_at",
      params: [
        e.uid || "0",
        e.groupId || "0",
        e.orgId || "0",
        e.tagId || "0",
        e.username || "",
        e.name || "",
        e.avatar || "",
        e.remark || "",
        e.updatedAt || 0,
      ],
    }));
    await this.db.execBatch(stmts);
  }

  // ---- Notification handlers ----

  // persistent 模式会把通知触发的变更同步进本地副本，因此对外发出真实的 session:sync 事件。
  protected syncDomain(domain: SyncDomain): SyncDomain {
    return domain;
  }

  protected async handleMessagesReceived(): Promise<void> {
    // 先把新消息同步进本地 SQLite（同步阶段不派发内容 emit=false），再回调 UI。
    await this.fullSyncDomain(this.messagesSpec, false);
    await this.fullSyncConversationsInternal();
    // 按累积的通知 msg_id 从本地批量读取内容，供 onMessages（角标/响铃），并始终派发重绘信号。
    await this.emitNotifiedMessages();
  }

  protected async handleContactChanged(): Promise<void> {
    await this.fullSyncDomain(this.contactsSpec);
  }

  // 清未读只清本地未读、不动 seq，也不触发拉取（避免重排 / 多余网络）。
  protected async clearLocalUnread(convKey: string): Promise<void> {
    const isGroup = convKey.startsWith("g:");
    const toUid = isGroup ? "0" : convKey.slice(2);
    const groupId = isGroup ? convKey.slice(2) : "0";
    await this.db.exec(
      "UPDATE conversations SET unread_count = 0 WHERE to_uid = ? AND group_id = ? AND status != ?",
      [toUid, groupId, STATUS_DELETED],
    );
  }

  // 删除会话只删本地行、不触发拉取。
  protected async deleteLocalConversation(convKey: string): Promise<void> {
    const isGroup = convKey.startsWith("g:");
    const toUid = isGroup ? "0" : convKey.slice(2);
    const groupId = isGroup ? convKey.slice(2) : "0";
    await this.db.exec(
      "DELETE FROM conversations WHERE to_uid = ? AND group_id = ?",
      [toUid, groupId],
    );
  }

  // 删除消息只删本地行、不触发拉取。
  protected async deleteLocalMessage(messageId: string): Promise<void> {
    await this.db.exec("DELETE FROM messages WHERE msg_id = ?", [messageId]);
  }

  protected async handleBlocklistChanged(): Promise<void> {
    await this.fullSyncDomain(this.blocklistSpec);
  }

  protected async handleMutelistChanged(): Promise<void> {
    await this.fullSyncDomain(this.mutelistSpec);
  }

  // ---- 组织关系表：按 org_id 的本地副本与增量同步 ----
  //
  // 组织游标是每组织一个 meta 键（org_seq:<orgId>）；tombstone 即删本地行；
  // seq_too_old 清该组织本地副本后全量重建。org_info / tag_info 是无 seq 的
  // 展示字典，走独立的 get_org_infos / get_tag_infos 缓存通道（见 Cache support），
  // 不进本地副本。

  private orgCursorKey(orgId: string): string {
    return `org_seq:${orgId}`;
  }

  private async orgCursor(orgId: string): Promise<number> {
    const rows = await this.db.query("SELECT value FROM meta WHERE key = ?", [
      this.orgCursorKey(orgId),
    ]);
    return Number(rows[0]?.value || 0);
  }

  private async saveOrgCursor(orgId: string, seq: number): Promise<void> {
    await this.db.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [this.orgCursorKey(orgId), String(seq)],
    );
  }

  /** 清空某组织的本地副本与游标（离职 / seq_too_old 重建）。 */
  private async purgeLocalOrg(orgId: string): Promise<void> {
    await this.db.execBatch([
      { sql: "DELETE FROM tags WHERE org_id = ?", params: [orgId] },
      { sql: "DELETE FROM meta WHERE key = ?", params: [this.orgCursorKey(orgId)] },
    ]);
  }

  /** tags 本地表的唯一写入点：tombstone 即删，无本地 status。 */
  private async applyOrgSyncBatch(
    orgId: string,
    tags: Tag[],
  ): Promise<void> {
    const stmts: { sql: string; params: unknown[] }[] = [];
    for (const t of tags) {
      const deleted = Number(t.status || 0) === STATUS_DELETED;
      stmts.push({
        sql: deleted
          ? "DELETE FROM tags WHERE org_id = ? AND tag_id = ? AND child_id = ? AND child_type = ?"
          : `INSERT INTO tags (org_id, tag_id, child_id, child_type, title, rank, sort_key, role, seq)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(org_id, tag_id, child_id, child_type) DO UPDATE SET
                title = excluded.title, rank = excluded.rank,
                sort_key = excluded.sort_key, role = excluded.role, seq = excluded.seq`,
        params: deleted
          ? [orgId, t.tag_id, t.child_id, t.child_type]
          : [orgId, t.tag_id, t.child_id, t.child_type, t.title || "", t.rank, t.sort_key || "", t.role, t.seq],
      });
    }
    if (stmts.length > 0) await this.db.execBatch(stmts);
  }

  /**
   * 单组织增量追平：分页拉 sync_tags 直到 has_more=false；
   * seq_too_old 清本地副本后从 0 全量重建（rebuild=true），一次为限防死循环。
   */
  private async syncOrgGraph(orgId: string, rebuilt = false): Promise<void> {
    let cursor = await this.orgCursor(orgId);
    let rebuild = cursor === 0;
    for (;;) {
      let page: { tags: Tag[]; hasMore: boolean; cursorSeq: number };
      try {
        page = actionMappers.mapSyncTagsResponse(
          await actions.syncTags(
            this.transport,
            actionMappers.syncTagsRequest({
              org_id: orgId,
              last_seq: cursor,
              limit: DEFAULT_SYNC_BATCH_SIZE,
              rebuild,
            }),
          ),
        );
      } catch (error) {
        if (isServerErrorCode(error, "SEQ_TOO_OLD") && !rebuilt) {
          await this.purgeLocalOrg(orgId);
          this.emitSync({ domain: "orgs", status: "reset", cursor: 0 });
          return this.syncOrgGraph(orgId, true);
        }
        throw error;
      }
      if (page.tags.length === 0) return;
      await this.applyOrgSyncBatch(orgId, page.tags);
      if (page.cursorSeq > 0) {
        cursor = Math.max(cursor, page.cursorSeq);
        await this.saveOrgCursor(orgId, cursor);
      }
      if (!page.hasMore) return;
    }
  }

  protected async handleOrgsUpdated(): Promise<void> {
    // persistent：先把受影响组织增量追平进本地副本，再派发重绘信号。
    const ids = this.takePendingOrgIds();
    for (const orgId of ids) {
      await this.syncOrgGraph(orgId);
    }
    if (ids.length > 0) this.emitOrgsChanged(ids);
  }

  async get_tags(params: TagsPageParams): Promise<TagsPageResult> {
    const orgId = String(params.org_id || "0");
    const cursor = await this.orgCursor(orgId);
    if (cursor === 0) {
      // 副本未就绪：走在线展开 fallback，并后台启动该组织全量同步。
      void this.syncQueuedOrg(orgId);
      return this.fetchTagsFromServer(params);
    }
    return this.localTagsPage(params);
  }

  /** 后台单组织同步（串到通知队列外的独立 promise，失败仅上报）。 */
  private syncQueuedOrg(orgId: string): Promise<void> {
    return this.runSyncStage(
      "orgs",
      () => this.syncOrgGraph(orgId),
      () => Promise.resolve(0),
    ).catch((error) => this.reportError(error, "org sync failed"));
  }

  /** 本地副本展开：与服务端展示通道同构的 (rank, sort_key, child_type, child_id) keyset 分页。 */
  private async localTagsPage(
    params: TagsPageParams,
  ): Promise<TagsPageResult> {
    const p = params.page ?? {};
    const backward = Boolean(p.backward);
    const limit = clampOptionalPageLimit(p.limit) ?? 200;
    const parts = p.cursor ? decodeCursor(p.cursor) : [];
    let where = "org_id = ? AND tag_id = ?";
    const binds: unknown[] = [String(params.org_id), String(params.tag_id)];
    if (parts.length >= 4) {
      where += backward
        ? " AND (rank, sort_key, child_type, child_id) < (?, ?, ?, ?)"
        : " AND (rank, sort_key, child_type, child_id) > (?, ?, ?, ?)";
      binds.push(Number(parts[0]), parts[1], Number(parts[2]), Number(parts[3]));
    }
    const orderBy = backward
      ? "rank DESC, sort_key DESC, child_type DESC, child_id DESC"
      : "rank ASC, sort_key ASC, child_type ASC, child_id ASC";
    const rows = await this.db.query(
      `SELECT * FROM tags WHERE ${where} ORDER BY ${orderBy} LIMIT ?`,
      [...binds, limit + 1],
    );
    const hasMoreTraveled = rows.length > limit;
    if (hasMoreTraveled) rows.length = limit;
    if (backward) rows.reverse();

    const tags: Tag[] = rows.map((r) => ({
      tag_id: String(r.tag_id || "0"),
      child_id: String(r.child_id || "0"),
      child_type: Number(r.child_type || 0),
      title: String(r.title || ""),
      rank: Number(r.rank || 0),
      sort_key: String(r.sort_key || ""),
      role: Number(r.role || 0),
      status: 1,
      seq: Number(r.seq || 0),
    }));

    const cur = (r: Record<string, unknown>) =>
      encodeCursor(
        String(r.rank ?? "0"),
        String(r.sort_key ?? ""),
        String(r.child_type ?? "0"),
        String(r.child_id ?? "0"),
      );
    const page: PageInfoResult = {
      startCursor: rows.length ? cur(rows[0]) : "",
      endCursor: rows.length ? cur(rows[rows.length - 1]) : "",
      hasMoreBackward: backward ? hasMoreTraveled : Boolean(p.cursor),
      hasMoreForward: backward ? Boolean(p.cursor) : hasMoreTraveled,
      total: -1,
    };
    return { tags, page };
  }

  // ---- Private ----

  private startBackgroundSync(): void {
    const runId = ++this.backgroundSyncRun;
    // 后台同步按 runId 串行；clear() 会递增 runId，使未完成任务在阶段间停止。
    this.backgroundSyncPromise = this.backgroundSyncPromise
      .catch(() => undefined)
      .then(() => {
        if (this.backgroundSyncRun !== runId) return undefined;
        return this.runBackgroundSync(runId);
      })
      .catch((error) => this.reportError(error, "background sync failed"));
  }

  private async runBackgroundSync(runId: number): Promise<void> {
    const shouldContinue = () => this.backgroundSyncRun === runId;
    if (!shouldContinue()) return;
    await this.runSyncStage(
      "messages",
      () => this.fullSyncDomain(this.messagesSpec),
      () => this.cursor("msg_seq"),
    );
    if (!shouldContinue()) return;
    await this.runSyncStage(
      "conversations",
      () => this.fullSyncConversationsInternal(),
      () => this.cursor("conversation_seq"),
    );
    if (!shouldContinue()) return;
    await this.runSyncStage(
      "contacts",
      () => this.fullSyncDomain(this.contactsSpec),
      () => this.cursor("contact_seq"),
    );
    if (!shouldContinue()) return;
    await this.runSyncStage(
      "blocklist",
      () => this.fullSyncDomain(this.blocklistSpec),
      () => this.cursor("blocklist_seq"),
    );
    if (!shouldContinue()) return;
    await this.runSyncStage(
      "mutelist",
      () => this.fullSyncDomain(this.mutelistSpec),
      () => this.cursor("mutelist_seq"),
    );
  }

  private async runSyncStage(
    domain: SyncDomain,
    fn: () => Promise<void>,
    cursor?: () => Promise<number>,
  ): Promise<void> {
    this.emitSync({ domain, status: "started", cursor: await cursor?.() });
    try {
      await fn();
      this.emitSync({ domain, status: "success", cursor: await cursor?.() });
    } catch (error) {
      const normalized =
        error instanceof Error
          ? error
          : new Error(String(error ?? "unknown error"));
      this.emitSync({
        domain,
        status: "failed",
        cursor: await cursor?.(),
        error: normalized,
      });
      throw normalized;
    }
  }

  private async fullSyncConversationsInternal(): Promise<void> {
    await runIncrementalSync<ConversationEntry>({
      initialCursor: await this.cursor("conversation_seq"),
      pageSize: DEFAULT_SYNC_BATCH_SIZE,
      getBatch: async (cursor, limit) =>
        this.syncConversations({ last_seq: cursor, limit }),
    });
  }

  protected async syncConversations(params: {
    last_seq: number;
    limit?: number;
  }): Promise<SyncPage<ConversationEntry>> {
    const { conversations, hasMore, cursorSeq } = actionMappers.mapSyncConversationsResponse(
      await actions.syncConversations(
        this.transport,
        actionMappers.syncConversationsRequest({
          last_seq: params.last_seq,
          limit: params.limit,
        }),
      ),
    );
    if (conversations.length > 0) {
      await this.applyConversationSyncBatch(conversations);
      // 游标改由服务端 cursor_seq 推进。
      await this.saveCursor("conversation_seq", cursorSeq);
    }
    return { items: conversations, hasMore, cursorSeq };
  }

  /** conversations 表的唯一写入点。只写 conversations 表，不触碰游标 / meta。 */
  private async applyConversationSyncBatch(
    conversations: ConversationEntry[],
  ): Promise<void> {
    const stmts: { sql: string; params: unknown[] }[] = [];
    for (const c of conversations) {
      const toUid = String(c.friend_uid || "0");
      const groupId = String(c.group_id || "0");
      const last = c.last_msg;
      stmts.push({
        sql:
          Number(c.status || 0) === STATUS_DELETED
            ? "DELETE FROM conversations WHERE to_uid = ? AND group_id = ?"
            : `INSERT INTO conversations (to_uid, group_id, seq, last_msg_id, unread_count, status)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(to_uid, group_id) DO UPDATE SET
                seq = excluded.seq, last_msg_id = excluded.last_msg_id,
                unread_count = excluded.unread_count, status = excluded.status`,
        params:
          Number(c.status || 0) === STATUS_DELETED
            ? [toUid, groupId]
            : [
                toUid,
                groupId,
                c.last_seq || 0,
                last?.msg_id || "",
                Number(c.unread_count || 0),
                Number(c.status || 0),
              ],
      });
    }
    if (stmts.length > 0) await this.db.execBatch(stmts);
  }

  /**
   * 单域单页同步（替代旧 syncMessages/syncContacts/syncBlocklist/syncMutelist 的公共骨架）：
   * 计算 rebuild → 拉一页 → seq_too_old 清表重建 → 落库 → 推进游标 → 维护 rebuild 标记。
   * 撤回折叠、字段映射、UI 事件等差异全部由 spec 注入。
   * 返回原始条目 items（供翻页 / 游标）与落库后的派发条目 emitted（消息为撤回折叠后的可见消息）。
   */
  private async syncDomainPage<TItem, TEmit>(
    spec: SyncDomainSpec<TItem, TEmit>,
    params: { last_seq?: number; limit?: number; rebuild?: boolean },
  ): Promise<{ items: TItem[]; emitted: TEmit[]; hasMore: boolean; cursorSeq: number; error?: "seq_too_old" }> {
    const limit = clampOptionalPageLimit(params.limit);
    const rebuild = shouldRebuild(params, this.rebuilding[spec.cursorKey]);
    let page: SyncPage<TItem>;
    try {
      page = await spec.fetchPage({
        last_seq: params.last_seq ?? 0,
        limit,
        rebuild,
      });
    } catch (error) {
      if (!isServerErrorCode(error, "SEQ_TOO_OLD")) throw error;
      await this.resetDomainForSync(spec);
      return { items: [], emitted: [], hasMore: false, cursorSeq: 0, error: "seq_too_old" };
    }
    if (page.items.length === 0) {
      this.rebuilding[spec.cursorKey] = false;
      return { items: [], emitted: [], hasMore: false, cursorSeq: page.cursorSeq };
    }
    const emitted = await spec.applyPage(page.items);
    // 游标改由服务端 cursor_seq 推进，不再从条目自行推断。
    await this.saveCursor(spec.cursorKey, page.cursorSeq);
    this.rebuilding[spec.cursorKey] = rebuild && page.hasMore;
    return { items: page.items, emitted, hasMore: page.hasMore, cursorSeq: page.cursorSeq };
  }

  /**
   * 单域全量追平（替代旧 fullSyncMessagesInternal/Contacts/Blocklist/Mutelist）：
   * 用 runPersistentTableSync 按原始条目数翻页并管理 rebuild/reset，结束后按 spec 派发 UI 事件。
   * @param emit 是否在结束时派发 emitDone（消息通知路径传 false，内容另走 emitNotifiedMessages）。
   */
  private async fullSyncDomain<TItem, TEmit>(
    spec: SyncDomainSpec<TItem, TEmit>,
    emit = true,
  ): Promise<void> {
    let changed = false;
    let emittedBatch = false;
    let reset = false;
    await runPersistentTableSync<TItem>({
      initialCursor: await this.cursor(spec.cursorKey),
      pageSize: DEFAULT_SYNC_BATCH_SIZE,
      getBatch: async (cursor, limit, rebuild) => {
        const { items, hasMore, cursorSeq, error } = await this.syncDomainPage(spec, {
          last_seq: cursor,
          limit,
          rebuild,
        });
        return { items, hasMore, cursorSeq, error };
      },
      onReset: () => {
        reset = true;
        changed = true;
      },
      onBatch: (items) => {
        changed = true;
        emittedBatch = true;
        spec.emitBatch?.(items);
      },
    });
    if (emit) spec.emitDone?.({ changed, emittedBatch, reset });
  }

  /** seq_too_old 后清空该域本地表与游标，并标记进入 rebuild 重建。 */
  private async resetDomainForSync<TItem, TEmit>(
    spec: SyncDomainSpec<TItem, TEmit>,
  ): Promise<void> {
    await this.db.exec(`DELETE FROM ${spec.table}`);
    await this.db.exec("DELETE FROM meta WHERE key = ?", [spec.cursorKey]);
    this.rebuilding[spec.cursorKey] = true;
    this.emitSync({ domain: spec.domain, status: "reset", cursor: 0 });
  }

  /** 游标不在 JS 堆维护镜像缓存，每次都直接查 meta 表当前值（与 orgCursor 同一模式）。 */
  private async cursor(key: SyncCursorKey): Promise<number> {
    const rows = await this.db.query("SELECT value FROM meta WHERE key = ?", [
      key,
    ]);
    return Number(rows[0]?.value || 0);
  }

  private async saveCursor(key: SyncCursorKey, seq: number): Promise<void> {
    const current = await this.cursor(key);
    const next = Math.max(current, Number(seq) || 0);
    await this.writeMeta(key, next);
  }

  private async writeMeta(key: SyncCursorKey, seq: number): Promise<void> {
    await this.db.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, String(seq)],
    );
  }

  /** blocklist 表的唯一写入点。 */
  private async applyBlocklistSyncBatch(users: BlocklistUser[]): Promise<void> {
    if (users.length === 0) return;
    const stmts = users.map((user) => {
      const uid = String(user.uid || "0");
      const deleted = Number(user.status || 0) === STATUS_DELETED;
      return {
        sql: deleted
          ? "DELETE FROM blocklist WHERE uid = ?"
          : `INSERT INTO blocklist (uid, status, seq, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(uid) DO UPDATE SET
              status = excluded.status,
              seq = excluded.seq,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at`,
        params: deleted
          ? [uid]
          : [
              uid,
              Number(user.status || 0),
              user.seq || 0,
              user.created_at || 0,
              user.updated_at || 0,
            ],
      };
    });
    await this.db.execBatch(stmts);
  }

  /** mutelist 表的唯一写入点。本地表只保留当前开启免打扰的数据，关闭 tombstone 仅推进 seq 游标。 */
  private async applyMutelistSyncBatch(mutes: MutelistEntry[]): Promise<void> {
    if (mutes.length === 0) return;
    const stmts = mutes.map((mutelist) => {
      const groupId = String(mutelist.group_id || "0");
      const toUid = groupId !== "0" ? "0" : String(mutelist.to_uid || "0");
      const status = Number(mutelist.status || 0);
      return {
        sql:
          status === STATUS_DELETED
            ? "DELETE FROM mutelist WHERE to_uid = ? AND group_id = ?"
            : `INSERT INTO mutelist (to_uid, group_id, status, seq, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(to_uid, group_id) DO UPDATE SET
                status = excluded.status,
                seq = excluded.seq,
                updated_at = excluded.updated_at`,
        params:
          status === STATUS_DELETED
            ? [toUid, groupId]
            : [
                toUid,
                groupId,
                status,
                mutelist.seq || 0,
                mutelist.updated_at || 0,
              ],
      };
    });
    await this.db.execBatch(stmts);
  }

  private convFilter(params: { to_uid?: string; group_id?: string }): {
    filter: string;
    binds: unknown[];
  } {
    if (params.group_id && String(params.group_id) !== "0") {
      return { filter: "group_id = ?", binds: [params.group_id] };
    }
    const peer = params.to_uid || "0";
    return {
      filter:
        "group_id = '0' AND ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?))",
      binds: [this.uid, peer, peer, this.uid],
    };
  }

  private contactFilter(params: ContactPageParams): {
    where: string;
    binds: unknown[];
  } {
    let where = "status != ?";
    const binds: unknown[] = [this.contactDeletedStatus];
    if (params.status !== undefined) {
      where += " AND status = ?";
      binds.push(params.status);
    }
    // 单个目标（friend_uid/group_id/org_id）与批量目标（*_uids/*_ids）语义相同、可同时传入，
    // 统一拼成 (type = ? AND id IN (...)) OR ... 的目标过滤子句，与 targets 数组语义对齐。
    const targetClauses: string[] = [];
    const addTargetFilter = (type: number, single: string | undefined, many: readonly string[] | undefined) => {
      const ids = [
        ...(single && String(single) !== "0" ? [String(single)] : []),
        ...(many || []).map((id) => String(id)).filter((id) => id && id !== "0"),
      ];
      if (ids.length === 0) return;
      const unique = [...new Set(ids)];
      targetClauses.push(`(type = ? AND id IN (${unique.map(() => "?").join(", ")}))`);
      binds.push(type, ...unique);
    };
    addTargetFilter(1, params.friend_uid, params.friend_uids);
    addTargetFilter(2, params.group_id, params.group_ids);
    addTargetFilter(3, params.org_id, params.org_ids);
    if (targetClauses.length > 0) {
      where += ` AND (${targetClauses.join(" OR ")})`;
    }
    return { where, binds };
  }

  private blocklistFilter(params: BlocklistPageParams): {
    where: string;
    binds: unknown[];
  } {
    let where = "status = ?";
    const binds: unknown[] = [params.status ?? 1];
    if (params.uids) {
      const uids = params.uids
        .map((uid) => String(uid))
        .filter((uid) => uid && uid !== "0");
      if (uids.length === 0) return { where: "1 = 0", binds: [] };
      where += ` AND uid IN (${uids.map(() => "?").join(", ")})`;
      binds.push(...uids);
    }
    return { where, binds };
  }

  private mutelistFilter(params: MutelistPageParams): {
    where: string;
    binds: unknown[];
  } {
    let where = "status = ?";
    const binds: unknown[] = [params.status ?? 1];
    if (params.to_uid && String(params.to_uid) !== "0") {
      where += " AND to_uid = ?";
      binds.push(String(params.to_uid));
    }
    if (params.group_id && String(params.group_id) !== "0") {
      where += " AND group_id = ?";
      binds.push(String(params.group_id));
    }
    if (params.to_uids) {
      const uids = params.to_uids
        .map((uid) => String(uid))
        .filter((uid) => uid && uid !== "0");
      if (uids.length === 0) return { where: "1 = 0", binds: [] };
      where += ` AND to_uid IN (${uids.map(() => "?").join(", ")})`;
      binds.push(...uids);
    }
    if (params.group_ids) {
      const groupIds = params.group_ids
        .map((groupId) => String(groupId))
        .filter((groupId) => groupId && groupId !== "0");
      if (groupIds.length === 0) return { where: "1 = 0", binds: [] };
      where += ` AND group_id IN (${groupIds.map(() => "?").join(", ")})`;
      binds.push(...groupIds);
    }
    return { where, binds };
  }

  private rowToContact(r: Record<string, unknown>): Contact {
    return {
      friend_uid: Number(r.type || 0) === 1 ? String(r.id || "0") : "0",
      group_id: Number(r.type || 0) === 2 ? String(r.id || "0") : "0",
      org_id: Number(r.type || 0) === 3 ? String(r.id || "0") : "0",
      status: Number(r.status),
      remark_name: String(r.remark_name || ""),
      sort_key: String(r.sort_key || ""),
      search_text: String(r.search_text || ""),
      seq: Number(r.seq),
    };
  }

  private rowToBlocklistUser(r: Record<string, unknown>): BlocklistUser {
    return {
      uid: String(r.uid || "0"),
      status: Number(r.status || 0),
      seq: Number(r.seq || 0),
      created_at: Number(r.created_at || 0),
      updated_at: Number(r.updated_at || 0),
    };
  }

  private rowToMutelist(r: Record<string, unknown>): MutelistEntry {
    return {
      to_uid: String(r.to_uid || "0"),
      group_id: String(r.group_id || "0"),
      status: Number(r.status || 0),
      seq: Number(r.seq || 0),
      updated_at: Number(r.updated_at || 0),
    };
  }

  private rowToMessage(r: Record<string, unknown>): Message {
    return {
      uid: 0,
      seq: Number(r.seq),
      msg_id: String(r.msg_id),
      from_uid: String(r.from_uid),
      to_uid: String(r.to_uid),
      group_id: String(r.group_id),
      msg_type: Number(r.msg_type) as Message["msg_type"],
      body: decodeMessageBody(r.body),
      search_text: String(r.search_text || ""),
      send_time: Number(r.send_time),
      status: Number(r.status || 0),
    };
  }

  private async rowToConversationEntry(
    r: Record<string, unknown>,
  ): Promise<ConversationEntry> {
    const msgRows = await this.db.query(
      "SELECT * FROM messages WHERE msg_id = ? AND status != ? LIMIT 1",
      [String(r.last_msg_id || ""), STATUS_DELETED],
    );
    const lastMsg = msgRows[0] ? this.rowToMessage(msgRows[0]) : null;
    return {
      group_id: String(r.group_id || "0"),
      friend_uid: String(r.to_uid || "0"),
      last_seq: Number(r.seq),
      last_msg: lastMsg,
      unread_count: Number(r.unread_count || 0),
      status: Number(r.status || 0),
    };
  }
}
