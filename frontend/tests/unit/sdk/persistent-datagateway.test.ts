/**
 * SDK PersistentDataGateway unit tests — uses MemoryDb for in-memory SQLite.
 * Tests local reads, sync→write→read cycles, and contact sync.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PersistentDataGateway,
  buildPersistentDbName,
} from "../../../src/sdk/datagateway/persistent";
import { MemoryDb, seedMessages, seedConversation } from "../memory-db";
import { encodeSeqCursor as seqCursor } from "../../../src/sdk/internal/page-cursor";
import type { WsTransport } from "../../../src/sdk/transport/connection";
import type {
  BlocklistUser,
  EnrichedContact,
  Message,
  MutelistEntry,
} from "../../../src/types";
import {
  CONTACT_DELETED,
  CONTACT_FRIEND,
  CONTACT_PENDING_INCOMING,
  MSG_TYPE_RECALL,
  MSG_TYPE_TEXT,
  STATUS_DELETED,
} from "../../../src/constants";
import { RequestError } from "../../../src/sdk/errors";
import { actionByType, requestCodec } from "./protocol-test-helpers";

function seqTooOldError(): RequestError {
  return new RequestError("REQUEST_FAILED", "seq_too_old", {
    details: { serverErrorCode: "SEQ_TOO_OLD" },
  });
}

// 各 sync action 对应的条目字段与 seq 字段；mock 据此模拟服务端的 cursor_seq / has_more。
const SYNC_RESPONSE_SHAPES: Record<string, { items: string; seq: string }> = {
  syncMessages: { items: "messages", seq: "seq" },
  syncContacts: { items: "contacts", seq: "seq" },
  syncBlocklist: { items: "users", seq: "seq" },
  syncMutelist: { items: "mutes", seq: "seq" },
  syncConversations: { items: "conversations", seq: "last_seq" },
};

function mockTransport(): WsTransport {
  const send = vi.fn();
  const sendBinary = vi.fn(async (typeId: number, body: Uint8Array) => {
    const decoded = requestCodec(typeId).decode(body) as Record<
      string,
      unknown
    >;
    const request: Record<string, unknown> = {
      action: actionByType(typeId),
      ...decoded,
    };
    for (const key of [
      "offset",
      "limit",
      "status",
      "last_seq",
      "before_seq",
      "after_seq",
      "around_seq",
    ]) {
      if (
        typeof request[key] === "string" &&
        /^\d+$/.test(request[key] as string)
      ) {
        request[key] = Number(request[key]);
      }
    }
    const resp = await send(request);
    // 模拟服务端：sync 响应若未显式给出 cursor_seq / has_more，则按本批最大 seq 推导，
    // 让本地落盘游标改由服务端字段驱动（与真实服务端 respondSyncPage 行为一致）。
    const shape = SYNC_RESPONSE_SHAPES[request.action as string];
    if (shape && resp && typeof resp === "object") {
      const r = resp as Record<string, unknown>;
      const items = r[shape.items];
      if (Array.isArray(items) && items.length > 0) {
        if (r.cursor_seq === undefined) {
          r.cursor_seq = items.reduce(
            (max: number, item) =>
              Math.max(max, Number((item as Record<string, unknown>)[shape.seq] || 0)),
            0,
          );
        }
        if (r.has_more === undefined) r.has_more = false;
      }
    }
    return resp;
  });
  return { send, sendBinary } as unknown as WsTransport;
}

function flushSyncQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 测试专用的内部同步方法访问接口。
 *
 * 生产代码只通过 DataGateway 接口使用读模型和联系人写后刷新入口。
 * 这些 sync 方法是 PersistentDataGateway 的 protected 实现细节。
 */
type PersistentSyncTestAccess = {
  fullSyncConversationsInternal(): Promise<void>;
  syncMessages(params: {
    last_seq: number;
    limit?: number;
  }): Promise<Message[]>;
  syncConversations(params: {
    last_seq: number;
    limit?: number;
  }): Promise<{ items: unknown[]; hasMore: boolean; cursorSeq: number }>;
  syncContacts(params: {
    last_seq?: number;
    limit?: number;
    rebuild?: boolean;
  }): Promise<{ contacts: EnrichedContact[]; error?: string }>;
  syncBlocklist(params: {
    last_seq?: number;
    limit?: number;
    rebuild?: boolean;
  }): Promise<{ users: BlocklistUser[]; error?: string }>;
  syncMutelist(params: {
    last_seq?: number;
    limit?: number;
    rebuild?: boolean;
  }): Promise<{ mutes: MutelistEntry[]; error?: string }>;
};

/**
 * 测试专用类型断言：同步方法已从 DataGateway 接口收敛为 protected 实现细节，
 * 这里仅用于覆盖 PersistentDataGateway 的本地落盘行为。
 */
function syncAccess(gateway: PersistentDataGateway): PersistentSyncTestAccess {
  return gateway as unknown as PersistentSyncTestAccess;
}

describe("SDK PersistentDataGateway", () => {
  let ds: PersistentDataGateway;
  let db: MemoryDb;
  let transport: ReturnType<typeof mockTransport>;

  beforeEach(async () => {
    db = new MemoryDb();
    transport = mockTransport();
    ds = new PersistentDataGateway(transport, { db });
    // init() triggers sync for messages, conversations, contacts, blocklist, mutelist
    (transport.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, messages: [] }) // fullSyncMessagesInternal
      .mockResolvedValueOnce({ ok: true, conversations: [] }) // fullSyncConversationsInternal
      .mockResolvedValueOnce({ ok: true, contacts: [] }) // fullSyncContactsInternal
      .mockResolvedValueOnce({ ok: true, users: [] }) // fullSyncBlocklistInternal
      .mockResolvedValueOnce({ ok: true, mutes: [] }); // fullSyncMutelistInternal
    await ds.init("100");
    await flushSyncQueue();
    // Reset so individual tests start with a clean transport mock
    (transport.send as ReturnType<typeof vi.fn>).mockReset();
  });

  it("init 打开本地库后立即返回，并通过 onSync 上报后台同步失败", async () => {
    const db2 = new MemoryDb();
    const t2 = mockTransport();
    const ds2 = new PersistentDataGateway(t2, { db: db2 });
    const progress: Array<{ domain: string; status: string; error?: Error }> =
      [];
    const errorCb = vi.fn();
    ds2.onSync((event) =>
      progress.push({
        domain: event.domain,
        status: event.status,
        error: event.error,
      }),
    );
    ds2.onError(errorCb);
    (t2.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, messages: [] })
      .mockRejectedValueOnce(new Error("conversation sync failed"));

    await expect(ds2.init("100")).resolves.toEqual({
      lastMsgSeq: 0,
      lastContactSeq: 0,
    });
    await flushSyncQueue();

    expect(progress).toMatchObject([
      { domain: "storage", status: "started" },
      { domain: "storage", status: "success" },
      { domain: "messages", status: "started" },
      { domain: "messages", status: "success" },
      { domain: "conversations", status: "started" },
      { domain: "conversations", status: "failed" },
    ]);
    const actions = (t2.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].action,
    );
    expect(actions).toContain("syncMessages");
    expect(actions).toContain("syncConversations");
    expect(progress[5].error?.message).toBe("conversation sync failed");
    expect(errorCb).toHaveBeenCalledWith(
      expect.any(Error),
      "background sync failed",
    );
  });

  // persistent 模式覆盖 syncDomain 返回真实域：通知触发的同步会带域上报 session:sync
  // started/success（与 memory 基线「不发 session:sync」相对）。
  it("contacts:updated 通知会带 contacts 域上报 session:sync", async () => {
    const events: Array<{ domain: string; status: string }> = [];
    ds.onSync((event) => events.push({ domain: event.domain, status: event.status }));
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      contacts: [],
    });

    ds.handleNotification({ type: "contacts:updated" } as never);
    await flushSyncQueue();

    expect(events).toEqual([
      { domain: "contacts", status: "started" },
      { domain: "contacts", status: "success" },
    ]);
  });

  // ---- get_messages ----

  describe("getMessages", () => {
    it("returns messages for private conversation", async () => {
      await seedMessages(db, [
        { seq: 1, fromUid: "100", toUid: "200" },
        { seq: 2, fromUid: "200", toUid: "100" },
        { seq: 3, fromUid: "100", toUid: "300" },
        { seq: 4, fromUid: "100", toUid: "200", status: STATUS_DELETED },
      ]);
      const msgs = await ds.get_messages({ to_uid: "200" });
      expect(msgs.messages).toHaveLength(2);
    });

    it("returns messages for group conversation", async () => {
      await seedMessages(db, [
        { seq: 1, fromUid: "100", groupId: "500" },
        { seq: 2, fromUid: "200", groupId: "500" },
        { seq: 3, fromUid: "100", toUid: "200" },
      ]);
      const msgs = await ds.get_messages({ group_id: "500" });
      expect(msgs.messages).toHaveLength(2);
    });

    it("supports backward (older) pagination", async () => {
      await seedMessages(
        db,
        Array.from({ length: 10 }, (_, i) => ({
          seq: i + 1,
          fromUid: "100",
          toUid: "200",
        })),
      );
      const r = await ds.get_messages({
        to_uid: "200",
        page: { cursor: seqCursor(5), backward: true, limit: 3 },
      });
      // 展示序旧→新：seq<5 取最近 3 条 = 2,3,4 升序返回。
      expect(r.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
    });

    it("supports forward (newer) pagination", async () => {
      await seedMessages(
        db,
        Array.from({ length: 10 }, (_, i) => ({
          seq: i + 1,
          fromUid: "100",
          toUid: "200",
        })),
      );
      const r = await ds.get_messages({
        to_uid: "200",
        page: { cursor: seqCursor(5), limit: 3 },
      });
      expect(r.messages.map((message) => message.seq)).toEqual([6, 7, 8]);
    });

    it("supports around anchor", async () => {
      await seedMessages(
        db,
        Array.from({ length: 20 }, (_, i) => ({
          seq: i + 1,
          fromUid: "100",
          toUid: "200",
        })),
      );
      const r = await ds.get_messages({
        to_uid: "200",
        page: { around: "msg_10", limit: 6 },
      });
      expect(r.messages.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ---- get_conversations ----

  describe("getConversations", () => {
    it("returns conversations sorted by last_seq desc", async () => {
      await seedConversation(db, "200", "0", 10);
      await seedConversation(db, "300", "0", 20);
      const page = await ds.get_conversations({ limit: 10 });
      expect(page.conversations).toHaveLength(2);
      expect(page.conversations[0].last_seq).toBe(20);
    });

    it("get_conversations({targets}) returns only requested active conversations, no pagination", async () => {
      await seedConversation(db, "200", "0", 10);
      await seedConversation(db, "300", "0", 20);
      await seedConversation(db, "0", "500", 30);

      const page = await ds.get_conversations({
        targets: [{ toUid: "300" }, { groupId: "500" }],
      });
      const ids = page.conversations
        .map((c) => `${c.friend_uid}:${c.group_id}`)
        .sort();
      expect(ids).toEqual(["0:500", "300:0"]);
      // targets 模式不分页：返回空游标。
      expect(page.page.startCursor).toBe("");
      expect(transport.send).not.toHaveBeenCalled();
    });

    it("excludes soft-deleted conversations from pages and unread total", async () => {
      await seedConversation(db, "200", "0", 10);
      await seedConversation(db, "300", "0", 20);
      await db.exec(
        "UPDATE conversations SET status = ?, unread_count = 5 WHERE to_uid = ?",
        [STATUS_DELETED, "300"],
      );

      const page = await ds.get_conversations({ limit: 10 });

      expect(page.conversations).toHaveLength(1);
      await expect(ds.get_unread_count()).resolves.toBe(0);
      expect(page.conversations.map((c) => c.friend_uid)).toEqual(["200"]);
    });

    it("supports cursor pages", async () => {
      await seedConversation(db, "200", "0", 10);
      await seedConversation(db, "300", "0", 20);
      await seedConversation(db, "400", "0", 30);
      // 会话展示序新→旧：cursor=30 向下(FORWARD)取更旧一条 = seq 20。
      const page = await ds.get_conversations({ page: { cursor: seqCursor(30), limit: 1 } });
      expect(page.conversations).toHaveLength(1);
      expect(page.conversations[0].friend_uid).toBe("300");
      expect(page.page.hasMoreForward).toBe(true);
    });

    it("supports backward (newer) cursor pages and reports has_more flags", async () => {
      await seedConversation(db, "200", "0", 10);
      await seedConversation(db, "300", "0", 20);
      await seedConversation(db, "400", "0", 30);
      // 首页（空游标 + FORWARD）取最新两条，展示序新→旧 = [30, 20]。
      const first = await ds.get_conversations({ page: { limit: 2 } });
      expect(first.conversations.map((c) => c.friend_uid)).toEqual(["400", "300"]);
      expect(first.page.hasMoreForward).toBe(true);
      expect(first.page.hasMoreBackward).toBe(false);
      // 向上(BACKWARD)：从首页顶部 start_cursor(=seq 30) 取更新条目，已到顶 → 空。
      const up = await ds.get_conversations({
        page: { cursor: first.page.startCursor, backward: true, limit: 2 },
      });
      expect(up.conversations).toHaveLength(0);
      // 向下(FORWARD)续翻：从首页底部 end_cursor(=seq 20) 取更旧一条 = seq 10。
      const down = await ds.get_conversations({
        page: { cursor: first.page.endCursor, limit: 2 },
      });
      expect(down.conversations.map((c) => c.friend_uid)).toEqual(["200"]);
      expect(down.page.hasMoreForward).toBe(false);
      expect(down.page.hasMoreBackward).toBe(true);
    });

    it("clamps oversized conversation page limit to 500", async () => {
      for (let i = 0; i < 510; i += 1) {
        await seedConversation(db, String(1000 + i), "0", i + 1);
      }

      const page = await ds.get_conversations({ page: { limit: 999 } });

      expect(page.conversations).toHaveLength(500);
    });
  });

  // ---- syncMessages ----

  describe("syncMessages", () => {
    it("loads from server and writes to local DB", async () => {
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            {
              seq: 1,
              msg_id: "msg_1",
              from_uid: "100",
              to_uid: "200",
              group_id: "0",
              msg_type: 1,
              body: { text: { text: "hi" } },
              send_time: 1000,
            },
            {
              seq: 2,
              msg_id: "msg_2",
              from_uid: "200",
              to_uid: "100",
              group_id: "0",
              msg_type: 1,
              body: { text: { text: "hey" } },
              send_time: 1001,
            },
          ],
        });

      const msgs = await syncAccess(ds).syncMessages({
        last_seq: 0,
        limit: 100,
      });
      expect(msgs).toHaveLength(2);

      // Should be persisted
      const local = await ds.get_messages({ to_uid: "200" });
      expect(local.messages).toHaveLength(2);

      // domain 边界：syncMessages 只写 messages，conversations 表不应被写入
      const page = await ds.get_conversations({});
      expect(page.conversations).toHaveLength(0);
      // 仅触发 syncMessages 这一个 action，不级联会话同步
      const calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncMessages", last_seq: 0, limit: 100 },
      ]);
    });

    it("sync_messages 落库时把省略的单聊/群聊默认 ID 补为 0", async () => {
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            {
              seq: 1,
              msg_id: "msg_1",
              from_uid: "200",
              to_uid: "100",
              msg_type: MSG_TYPE_TEXT,
              body: { text: { text: "dm" } },
              send_time: 1000,
            },
            {
              seq: 2,
              msg_id: "msg_2",
              from_uid: "200",
              group_id: "500",
              msg_type: MSG_TYPE_TEXT,
              body: { text: { text: "group" } },
              send_time: 1001,
            },
          ],
        });

      await syncAccess(ds).syncMessages({ last_seq: 0, limit: 100 });

      const rows = await db.query(
        "SELECT msg_id, to_uid, group_id, status FROM messages ORDER BY seq",
      );
      expect(rows).toMatchObject([
        { msg_id: "msg_1", to_uid: "100", group_id: "0", status: 0 },
        { msg_id: "msg_2", to_uid: "0", group_id: "500", status: 0 },
      ]);
    });

    it("domain 边界：syncMessages 只写 messages，会话未读/游标由 syncConversations 独立对齐", async () => {
      const message = {
        seq: 5,
        msg_id: "msg_5",
        from_uid: "200",
        to_uid: "100",
        group_id: "0",
        msg_type: 1,
        body: { text: { text: "hi" } },
        send_time: 1005,
      };
      // 第一阶段：syncMessages 只落 messages，不写 conversations、不触发会话同步
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        messages: [message],
      });

      await syncAccess(ds).syncMessages({ last_seq: 0, limit: 100 });

      // syncMessages 之后 conversations 表仍为空
      expect((await ds.get_conversations({})).conversations).toHaveLength(0);
      let metaRows = await db.query(
        "SELECT key, value FROM meta WHERE key IN ('msg_seq', 'conversation_seq') ORDER BY key",
      );
      expect(metaRows).toMatchObject([{ key: "msg_seq", value: "5" }]);
      let calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncMessages", last_seq: 0, limit: 100 },
      ]);

      // 第二阶段：syncConversations 独立对齐会话未读和游标
      (transport.send as ReturnType<typeof vi.fn>).mockReset();
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        conversations: [
          {
            friend_uid: "200",
            group_id: "0",
            last_seq: 5,
            last_msg: message,
            unread_count: 3,
            status: 1,
          },
        ],
      });

      await syncAccess(ds).syncConversations({ last_seq: 0, limit: 100 });

      const page = await ds.get_conversations({});
      expect(page.conversations).toHaveLength(1);
      expect(page.conversations[0]).toMatchObject({
        friend_uid: "200",
        last_seq: 5,
        unread_count: 3,
      });
      metaRows = await db.query(
        "SELECT key, value FROM meta WHERE key IN ('msg_seq', 'conversation_seq') ORDER BY key",
      );
      expect(metaRows).toMatchObject([
        { key: "conversation_seq", value: "5" },
        { key: "msg_seq", value: "5" },
      ]);
      calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncConversations", last_seq: 0 },
      ]);
    });

    it("treats recall event as patch instead of persisting a second visible message", async () => {
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            {
              seq: 1,
              msg_id: "1",
              from_uid: "100",
              to_uid: "200",
              group_id: "0",
              msg_type: MSG_TYPE_TEXT,
              body: { text: { text: "hi" } },
              send_time: 1000,
            },
            {
              seq: 2,
              msg_id: "2",
              from_uid: "100",
              to_uid: "200",
              group_id: "0",
              msg_type: MSG_TYPE_RECALL,
              body: {
                recall: {
                  msg_id: "1",
                  operator_uid: "100",
                  recall_time: 1002,
                  text: "你撤回了一条消息",
                },
              },
              send_time: 1002,
            },
          ],
        });

      const msgs = await syncAccess(ds).syncMessages({
        last_seq: 0,
        limit: 100,
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        seq: 2,
        msg_id: "1",
        msg_type: MSG_TYPE_RECALL,
      });
      expect(msgs[0].body.recall?.text).toContain("你撤回了一条消息");

      const local = await ds.get_messages({ to_uid: "200" });
      expect(local.messages).toHaveLength(1);
      expect(local.messages[0]).toMatchObject({
        seq: 1,
        msg_id: "1",
        msg_type: MSG_TYPE_RECALL,
      });
      expect(local.messages[0].body.recall?.text).toContain("你撤回了一条消息");

      const rows = await db.query("SELECT COUNT(*) AS count FROM messages");
      expect(Number(rows[0]?.count)).toBe(1);

      // domain 边界：syncMessages 不写 conversations，会话表保持为空
      const page = await ds.get_conversations({});
      expect(page.conversations).toHaveLength(0);
    });

    it("deletes local messages when sync receives a deleted tombstone", async () => {
      await seedMessages(db, [{ seq: 1, fromUid: "100", toUid: "200" }]);
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            {
              seq: 2,
              msg_id: "msg_1",
              from_uid: "100",
              to_uid: "200",
              group_id: "0",
              msg_type: MSG_TYPE_TEXT,
              body: { text: { text: "" } },
              send_time: 1001,
              status: STATUS_DELETED,
            },
          ],
        });

      const messages = await syncAccess(ds).syncMessages({
        last_seq: 1,
        limit: 100,
      });

      expect(messages).toEqual([
        expect.objectContaining({
          msg_id: "msg_1",
          status: STATUS_DELETED,
          seq: 2,
        }),
      ]);
      expect((await ds.get_messages({ to_uid: "200" })).messages).toHaveLength(0);
      const rows = await db.query("SELECT * FROM messages WHERE msg_id = ?", [
        "msg_1",
      ]);
      expect(rows).toEqual([]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'msg_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "2" }]);
    });
  });

  // ---- get_contacts ----

  describe("getContacts", () => {
    it("excludes deleted contacts and orders by sort_key", async () => {
      await db.execBatch([
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "200", 2, "Charlie", 1],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "300", CONTACT_DELETED, "Alice", 2],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "400", 3, "Bob", 3],
        },
      ]);
      const page = await ds.get_contacts({ page: { limit: 10 } });
      expect(page.page.hasMoreForward).toBe(false);
      expect(page.contacts.map((c) => c.friend_uid)).toEqual(["400", "200"]);
      expect(page.contacts.map((c) => c.sort_key)).toEqual([
        "Bob",
        "Charlie",
      ]);
    });

    it("orders pending contacts by seq desc", async () => {
      await db.execBatch([
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "200", CONTACT_PENDING_INCOMING, "Charlie", 1],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "300", CONTACT_PENDING_INCOMING, "Alice", 3],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "400", CONTACT_PENDING_INCOMING, "Bob", 2],
        },
      ]);

      const page = await ds.get_contacts({
        status: CONTACT_PENDING_INCOMING,
        offset: 0,
        limit: 10,
      });

      expect(page.contacts.map((c) => c.friend_uid)).toEqual([
        "300",
        "400",
        "200",
      ]);
      expect(page.contacts.map((c) => c.seq)).toEqual([3, 2, 1]);
    });

    it("clamps oversized contact page limit to 500", async () => {
      const statements = Array.from({ length: 510 }, (_, i) => ({
        sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
        params: [1, String(1000 + i), 0, `User ${i}`, i + 1],
      }));
      await db.execBatch(statements);

      const page = await ds.get_contacts({ page: { limit: 999 } });

      expect(page.page.hasMoreForward).toBe(true);
      expect(page.contacts).toHaveLength(500);
    });

    it("contact summary helpers read local contacts only", async () => {
      await db.execBatch([
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "200", CONTACT_PENDING_INCOMING, "Bob", 1],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "300", CONTACT_DELETED, "Alice", 2],
        },
      ]);

      await expect(ds.get_contact_count(CONTACT_PENDING_INCOMING)).resolves.toBe(1);
      await expect(
        ds.get_contacts({
          friend_uid: "200",
          status: CONTACT_PENDING_INCOMING,
          page: { limit: 1 },
        }),
      ).resolves.toMatchObject({ page: { hasMoreForward: false }, contacts: [expect.objectContaining({ friend_uid: "200" })] });
      await expect(
        ds.get_contacts({
          friend_uid: "999",
          status: CONTACT_PENDING_INCOMING,
          page: { limit: 1 },
        }),
      ).resolves.toMatchObject({ page: { hasMoreForward: false }, contacts: [] });
      expect(transport.send).not.toHaveBeenCalled();
    });

    it("filters by org_id and by batched friend_uids/group_ids/org_ids", async () => {
      await db.execBatch([
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "200", CONTACT_FRIEND, "Bob", 1],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [1, "300", CONTACT_FRIEND, "Alice", 2],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [2, "500", CONTACT_FRIEND, "Group500", 3],
        },
        {
          sql: "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
          params: [3, "900", CONTACT_FRIEND, "Org900", 4],
        },
      ]);

      await expect(
        ds.get_contacts({ org_id: "900", status: CONTACT_FRIEND, page: { limit: 10 } }),
      ).resolves.toMatchObject({
        contacts: [expect.objectContaining({ org_id: "900" })],
      });

      const batched = await ds.get_contacts({
        friend_uids: ["200"],
        group_ids: ["500"],
        org_ids: ["900"],
        status: CONTACT_FRIEND,
        page: { limit: 10 },
      });
      const ids = (c: (typeof batched.contacts)[number]) =>
        [c.friend_uid, c.group_id, c.org_id].find((id) => id && id !== "0");
      expect(batched.contacts.map(ids).sort()).toEqual(
        ["200", "500", "900"].sort(),
      );
    });

    it("sync_contacts persists remark_name and sort_key", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        contacts: [
          {
            friend_uid: "200",
            group_id: "0",
            status: 1,
            seq: 8,
            remark_name: "",
            sort_key: "Bob",
          },
        ],
      });

      const result = await syncAccess(ds).syncContacts({
        last_seq: 7,
        limit: 100,
      });
      expect(result.contacts).toHaveLength(1);

      const page = await ds.get_contacts({ page: { limit: 10 } });
      expect(page.contacts[0]).toMatchObject({
        friend_uid: "200",
        sort_key: "Bob",
        remark_name: "",
      });
    });

    it("sync_contacts deletes local rows for contact tombstones and advances cursor", async () => {
      await db.exec(
        "INSERT INTO contacts (type, id, status, sort_key, seq) VALUES (?, ?, ?, ?, ?)",
        [1, "200", 1, "Bob", 1],
      );
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        contacts: [
          {
            friend_uid: "200",
            group_id: "0",
            status: CONTACT_DELETED,
            seq: 9,
            remark_name: "",
            sort_key: "Bob",
          },
        ],
      });

      await syncAccess(ds).syncContacts({ last_seq: 8, limit: 100 });

      const page = await ds.get_contacts({ page: { limit: 10 } });
      expect(page.contacts).toHaveLength(0);
      const rows = await db.query(
        "SELECT status, seq FROM contacts WHERE type = 1 AND id = ?",
        ["200"],
      );
      expect(rows).toEqual([]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'contact_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "9" }]);
    });

    it("sync_contacts does not store contact tombstones when no local row exists", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        contacts: [
          {
            friend_uid: "404",
            group_id: "0",
            status: CONTACT_DELETED,
            seq: 12,
            remark_name: "",
            sort_key: "Ghost",
          },
        ],
      });

      const result = await syncAccess(ds).syncContacts({
        last_seq: 11,
        limit: 100,
      });

      expect(result.contacts).toHaveLength(1);
      await expect(
        ds.get_contacts({ friend_uid: "404", page: { limit: 1 } }),
      ).resolves.toMatchObject({ page: { hasMoreForward: false }, contacts: [] });
      const rows = await db.query(
        "SELECT * FROM contacts WHERE type = 1 AND id = ?",
        ["404"],
      );
      expect(rows).toEqual([]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'contact_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "12" }]);
    });

    it("seq_too_old clears contacts and restarts sync_contacts from zero", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        contacts: [
          {
            friend_uid: "old",
            group_id: "0",
            status: 1,
            seq: 10,
            remark_name: "",
            sort_key: "Old",
          },
        ],
      });
      await syncAccess(ds).syncContacts({ last_seq: 0, limit: 100 });
      (transport.send as ReturnType<typeof vi.fn>).mockReset();
      (transport.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(seqTooOldError())
        .mockResolvedValueOnce({
          ok: true,
          contacts: [
            {
              friend_uid: "new",
              group_id: "0",
              status: 1,
              seq: 50,
              remark_name: "",
              sort_key: "New",
            },
          ],
        });

      ds.handleNotification({ type: "contacts:updated" });
      await flushSyncQueue();

      const rows = await db.query(
        "SELECT id AS friend_uid, seq FROM contacts ORDER BY id",
      );
      expect(rows).toMatchObject([{ friend_uid: "new", seq: 50 }]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'contact_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "50" }]);
      const calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncContacts", last_seq: 10 },
        { action: "syncContacts", last_seq: 0 },
      ]);
    });
  });

  // ---- blocklist / mutelist ----

  describe("blocklist and mutelist", () => {
    it("stores blocklist locally, hides deleted rows, and reads active entries", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        users: [
          { uid: "200", status: 1, seq: 1, created_at: 1000, updated_at: 1000 },
          {
            uid: "300",
            status: STATUS_DELETED,
            seq: 2,
            created_at: 1000,
            updated_at: 1001,
          },
        ],
      });

      const { users } = await syncAccess(ds).syncBlocklist({
        last_seq: 0,
        limit: 100,
      });
      const page = await ds.get_blocklist({ limit: 10 });

      expect(users).toHaveLength(2);
      expect(page.users.map((user) => user.uid)).toEqual(["200"]);
      expect(
        (await ds.get_blocklist({ uids: ["200"], limit: 1 })).users,
      ).toHaveLength(1);
      expect(
        (await ds.get_blocklist({ uids: ["300"], limit: 1 })).users,
      ).toHaveLength(0);
      const rows = await db.query(
        "SELECT uid, status FROM blocklist ORDER BY seq ASC",
      );
      expect(rows).toMatchObject([{ uid: "200", status: 1 }]);
    });

    it("stores mutelist locally, hides deleted rows, and checks active entries", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        mutes: [
          { to_uid: "200", group_id: "0", status: 1, seq: 1, updated_at: 1000 },
          {
            to_uid: "0",
            group_id: "900",
            status: STATUS_DELETED,
            seq: 2,
            updated_at: 1001,
          },
        ],
      });

      const { mutes: entries } = await syncAccess(ds).syncMutelist({
        last_seq: 0,
        limit: 100,
      });
      const page = await ds.get_mutelist({ offset: 0, limit: 10 });

      expect(entries).toHaveLength(2);
      expect(
        page.mutes.map((entry) => `${entry.to_uid}:${entry.group_id}`),
      ).toEqual(["200:0"]);
      expect(
        (await ds.get_mutelist({ to_uid: "200", limit: 1 })).mutes,
      ).toHaveLength(1);
      expect(
        (await ds.get_mutelist({ group_id: "900", limit: 1 })).mutes,
      ).toHaveLength(0);
      const rows = await db.query(
        "SELECT to_uid, group_id, status FROM mutelist ORDER BY seq ASC",
      );
      expect(rows).toMatchObject([{ to_uid: "200", group_id: "0", status: 1 }]);
    });

    it("applies mutelist active-to-deleted transitions in one sync batch", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        mutes: [
          { to_uid: "200", group_id: "0", status: 1, seq: 1, updated_at: 1000 },
          {
            to_uid: "200",
            group_id: "0",
            status: STATUS_DELETED,
            seq: 2,
            updated_at: 1001,
          },
        ],
      });

      await syncAccess(ds).syncMutelist({ last_seq: 0, limit: 100 });

      expect(
        (await ds.get_mutelist({ to_uid: "200", limit: 1 })).mutes,
      ).toHaveLength(0);
      expect(
        (await ds.get_mutelist({ offset: 0, limit: 10 })).mutes,
      ).toHaveLength(0);
      const rows = await db.query(
        "SELECT to_uid, status, seq FROM mutelist WHERE to_uid = ?",
        ["200"],
      );
      expect(rows).toEqual([]);
    });

    it("seq_too_old clears blocklist and restarts sync_blocklist from zero", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        users: [
          { uid: "old", status: 1, seq: 1, created_at: 1000, updated_at: 1000 },
        ],
      });
      await syncAccess(ds).syncBlocklist({ last_seq: 0, limit: 100 });
      (transport.send as ReturnType<typeof vi.fn>).mockReset();
      (transport.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(seqTooOldError())
        .mockResolvedValueOnce({
          ok: true,
          users: [
            {
              uid: "new",
              status: 1,
              seq: 50,
              created_at: 2000,
              updated_at: 2000,
            },
          ],
        });

      ds.handleNotification({ type: "blocklist:updated" });
      await flushSyncQueue();

      const rows = await db.query(
        "SELECT uid, seq FROM blocklist ORDER BY uid",
      );
      expect(rows).toMatchObject([{ uid: "new", seq: 50 }]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'blocklist_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "50" }]);
      const calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncBlocklist", last_seq: 1 },
        { action: "syncBlocklist", last_seq: 0 },
      ]);
    });

    it("sync_conversations 按消息式游标同步，历史缺口不清空本地会话", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        conversations: [
          {
            friend_uid: "old",
            group_id: "0",
            last_seq: 10,
            last_msg: null,
            unread_count: 0,
            status: 1,
          },
        ],
      });
      await syncAccess(ds).fullSyncConversationsInternal();
      (transport.send as ReturnType<typeof vi.fn>).mockReset();
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        conversations: [
          {
            friend_uid: "new",
            group_id: "0",
            last_seq: 50,
            last_msg: null,
            unread_count: 0,
            status: 1,
          },
        ],
      });

      await syncAccess(ds).fullSyncConversationsInternal();

      const rows = await db.query(
        "SELECT to_uid, seq FROM conversations ORDER BY to_uid",
      );
      expect(rows).toMatchObject([
        { to_uid: "new", seq: 50 },
        { to_uid: "old", seq: 10 },
      ]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'conversation_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "50" }]);
      const calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncConversations", last_seq: 10 },
      ]);
    });

    it("seq_too_old clears mutelist and restarts sync_mutelist from zero", async () => {
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        mutes: [
          {
            to_uid: "old",
            group_id: "0",
            status: 1,
            seq: 10,
            updated_at: 1000,
          },
        ],
      });
      await syncAccess(ds).syncMutelist({ last_seq: 0, limit: 100 });
      (transport.send as ReturnType<typeof vi.fn>).mockReset();
      (transport.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(seqTooOldError())
        .mockResolvedValueOnce({
          ok: true,
          mutes: [
            {
              to_uid: "new",
              group_id: "0",
              status: 1,
              seq: 50,
              updated_at: 2000,
            },
          ],
        });

      ds.handleNotification({ type: "mutelist:updated" });
      await flushSyncQueue();

      const rows = await db.query(
        "SELECT to_uid, seq FROM mutelist ORDER BY to_uid",
      );
      expect(rows).toMatchObject([{ to_uid: "new", seq: 50 }]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'mutelist_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "50" }]);
      const calls = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args) => args[0] as Record<string, unknown>,
      );
      expect(calls).toMatchObject([
        { action: "syncMutelist", last_seq: 10 },
        { action: "syncMutelist", last_seq: 0 },
      ]);
    });

    it("conversation delete sync removes local row without storing tombstone", async () => {
      await seedConversation(db, "200", "0", 10);
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          conversations: [
            {
              friend_uid: "200",
              group_id: "0",
              last_seq: 11,
              last_msg: null,
              unread_count: 0,
              status: STATUS_DELETED,
            },
          ],
        })
        .mockResolvedValueOnce({ ok: true, conversations: [] });

      await syncAccess(ds).fullSyncConversationsInternal();

      const page = await ds.get_conversations({ offset: 0, limit: 10 });
      expect(page.conversations).toHaveLength(0);
      const rows = await db.query(
        "SELECT * FROM conversations WHERE to_uid = ?",
        ["200"],
      );
      expect(rows).toEqual([]);
      const metaRows = await db.query(
        "SELECT value FROM meta WHERE key = 'conversation_seq'",
      );
      expect(metaRows).toMatchObject([{ value: "11" }]);
    });

    it("conversations:clearunread clears local unread without any pull", async () => {
      await seedConversation(db, "200", "0", 10);
      await db.exec(
        "UPDATE conversations SET status = 1, unread_count = 7 WHERE to_uid = ?",
        ["200"],
      );
      const readCb = vi.fn();
      ds.onUnreadCleared(readCb);

      ds.handleNotification({ type: "conversations:clearunread", from_uid: "200" });
      await flushSyncQueue();

      const rows = await db.query(
        "SELECT unread_count FROM conversations WHERE to_uid = ?",
        ["200"],
      );
      expect(rows).toMatchObject([{ unread_count: 0 }]);
      // 标记已读绝不触发拉取（无 syncConversations 等网络请求）。
      expect(transport.send).not.toHaveBeenCalled();
      expect(readCb).toHaveBeenCalledWith("u:200");
    });

    it("conversations:delete removes local row without any pull", async () => {
      await seedConversation(db, "200", "0", 10);
      await seedConversation(db, "300", "0", 20);
      const deletedCb = vi.fn();
      ds.onConversationDeleted(deletedCb);

      ds.handleNotification({ type: "conversations:delete", from_uid: "200" });
      await flushSyncQueue();

      const rows = await db.query("SELECT to_uid FROM conversations ORDER BY to_uid");
      expect(rows).toMatchObject([{ to_uid: "300" }]);
      // 删除会话绝不触发拉取。
      expect(transport.send).not.toHaveBeenCalled();
      expect(deletedCb).toHaveBeenCalledWith("u:200");
    });

    it("messages:delete removes local message without any pull", async () => {
      await seedMessages(db, [
        { seq: 1, fromUid: "100", toUid: "200" },
        { seq: 2, fromUid: "200", toUid: "100" },
      ]);
      const deletedCb = vi.fn();
      ds.onMessageDeleted(deletedCb);

      ds.handleNotification({ type: "messages:delete", msg_id: "msg_1", from_uid: "200" });
      await flushSyncQueue();

      const rows = await db.query("SELECT msg_id FROM messages ORDER BY seq");
      expect(rows).toMatchObject([{ msg_id: "msg_2" }]);
      // 删除消息绝不触发拉取。
      expect(transport.send).not.toHaveBeenCalled();
      // 回调带 (msgId, convKey)，convKey 由通知 target 推出（u:200）。
      expect(deletedCb).toHaveBeenCalledWith("msg_1", "u:200");
    });
  });

  // ---- Cache support ----

  describe("cache support", () => {
    it("get_user_infos 立即返回本地 displayinfo 数据", async () => {
      await db.exec(
        "INSERT INTO displayinfo (uid, group_id, username, name, avatar, remark_name, updated_at) VALUES (?, '0', ?, ?, ?, ?, ?)",
        ["100", "alice", "Alice", "a.png", "A", Date.now()],
      );

      const cached = await ds.get_user_infos(["100"], { cacheTtlMs: 86400000 });
      expect(cached).toHaveLength(1);
      expect(cached[0].nickname).toBe("Alice");
      expect(cached[0].remark).toBe("A");
      expect(transport.send).not.toHaveBeenCalled();
    });

    it("get_group_infos 立即返回本地 displayinfo 数据", async () => {
      await db.exec(
        "INSERT INTO displayinfo (uid, group_id, username, name, avatar, remark_name, updated_at) VALUES ('0', ?, '', ?, ?, ?, ?)",
        ["10", "Team", "g.png", "G", Date.now()],
      );

      const cached = await ds.get_group_infos(["10"], { cacheTtlMs: 86400000 });
      expect(cached).toHaveLength(1);
      expect(cached[0].name).toBe("Team");
      expect(cached[0].remark).toBe("G");
      expect(transport.send).not.toHaveBeenCalled();
    });

    it("uses displayinfo uid/group_id keys to keep user and group ids independent", async () => {
      await db.exec(
        "INSERT INTO displayinfo (uid, group_id, username, name, avatar, remark_name, updated_at) VALUES (?, '0', ?, ?, ?, ?, ?)",
        ["42", "alice", "Alice", "a.png", "A", Date.now()],
      );
      await db.exec(
        "INSERT INTO displayinfo (uid, group_id, username, name, avatar, remark_name, updated_at) VALUES ('0', ?, '', ?, ?, ?, ?)",
        ["42", "Team 42", "g.png", "G", Date.now()],
      );

      const rows = await db.query(
        "SELECT uid, group_id, username, name, remark_name FROM displayinfo WHERE uid = ? OR group_id = ? ORDER BY uid, group_id",
        ["42", "42"],
      );
      expect(rows).toEqual([
        {
          uid: "0",
          group_id: "42",
          username: "",
          name: "Team 42",
          remark_name: "G",
        },
        {
          uid: "42",
          group_id: "0",
          username: "alice",
          name: "Alice",
          remark_name: "A",
        },
      ]);

      const users = await ds.get_user_infos(["42"], { cacheTtlMs: 86400000 });
      const groups = await ds.get_group_infos(["42"], { cacheTtlMs: 86400000 });
      expect(users[0]).toMatchObject({
        uid: "42",
        username: "alice",
        nickname: "Alice",
        remark: "A",
      });
      expect(groups[0]).toMatchObject({
        group_id: "42",
        name: "Team 42",
        remark: "G",
      });
    });

    it("本地未命中时异步请求后端、写回本地并回调 DisplayInfoCache", async () => {
      const updated = vi.fn();
      const cacheWriteTime = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(cacheWriteTime);
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        profiles: [
          {
            uid: "200",
            username: "bob",
            nickname: "Bob",
            avatar: "b.png",
            updated_at: 123,
          },
        ],
      });

      try {
        const immediate = await ds.get_user_infos(["200"], {
          cacheTtlMs: 86400000,
          updateDisplayInfos: updated,
        });
        expect(immediate).toEqual([]);
        await flushSyncQueue();

        expect(transport.send).toHaveBeenCalledWith({
          action: "getUserInfos",
          uids: ["200"],
        });
        expect(updated).toHaveBeenCalledWith([
          {
            uid: "200",
            username: "bob",
            nickname: "Bob",
            avatar: "b.png",
            updated_at: 123,
          },
        ]);
        const rows = await db.query(
          "SELECT uid, username, name, avatar, updated_at FROM displayinfo WHERE uid = ? AND group_id = ?",
          ["200", "0"],
        );
        expect(rows).toEqual([
          {
            uid: "200",
            username: "bob",
            name: "Bob",
            avatar: "b.png",
            updated_at: cacheWriteTime,
          },
        ]);

        (transport.send as ReturnType<typeof vi.fn>).mockClear();
        const cached = await ds.get_user_infos(["200"], {
          cacheTtlMs: 86400000,
          updateDisplayInfos: updated,
        });
        expect(cached).toHaveLength(1);
        await flushSyncQueue();
        expect(transport.send).not.toHaveBeenCalled();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("本地过期数据仍立即返回，同时异步刷新", async () => {
      const updated = vi.fn();
      await db.exec(
        "INSERT INTO displayinfo (uid, group_id, username, name, avatar, remark_name, updated_at) VALUES (?, '0', ?, ?, ?, ?, ?)",
        ["300", "old", "Old", "old.png", "", 1],
      );
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        profiles: [
          {
            uid: "300",
            username: "new",
            nickname: "New",
            avatar: "new.png",
            updated_at: 10,
          },
        ],
      });

      const immediate = await ds.get_user_infos(["300"], {
        cacheTtlMs: 1,
        updateDisplayInfos: updated,
      });
      expect(immediate[0]).toMatchObject({
        uid: "300",
        username: "old",
        nickname: "Old",
      });
      await flushSyncQueue();

      expect(transport.send).toHaveBeenCalledWith({
        action: "getUserInfos",
        uids: ["300"],
      });
      expect(updated).toHaveBeenCalledWith([
        {
          uid: "300",
          username: "new",
          nickname: "New",
          avatar: "new.png",
          updated_at: 10,
        },
      ]);
    });

    it("本地缓存读取失败时仍异步回退请求后端", async () => {
      const updated = vi.fn();
      const errorCb = vi.fn();
      ds.onError(errorCb);
      vi.spyOn(db, "query").mockRejectedValueOnce(
        new Error("local cache failed"),
      );
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        profiles: [
          {
            uid: "400",
            username: "remote",
            nickname: "Remote",
            avatar: "r.png",
            updated_at: 20,
          },
        ],
      });

      const immediate = await ds.get_user_infos(["400"], {
        cacheTtlMs: 86400000,
        updateDisplayInfos: updated,
      });
      expect(immediate).toEqual([]);
      await flushSyncQueue();

      expect(errorCb).toHaveBeenCalledWith(
        expect.any(Error),
        "read user display cache failed",
      );
      expect(transport.send).toHaveBeenCalledWith({
        action: "getUserInfos",
        uids: ["400"],
      });
      expect(updated).toHaveBeenCalledWith([
        {
          uid: "400",
          username: "remote",
          nickname: "Remote",
          avatar: "r.png",
          updated_at: 20,
        },
      ]);
    });
  });

  // ---- init ----

  describe("init", () => {
    it("uses default instance namespace when opening the uid-scoped database", async () => {
      const db2 = new MemoryDb();
      const ds2 = new PersistentDataGateway(transport, { db: db2 });
      const openSpy = vi.spyOn(db2, "open");
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, messages: [] })
        .mockResolvedValueOnce({ ok: true, conversations: [] })
        .mockResolvedValueOnce({ ok: true, contacts: [] })
        .mockResolvedValueOnce({ ok: true, users: [] })
        .mockResolvedValueOnce({ ok: true, mutes: [] });

      await ds2.init("200");

      expect(openSpy).toHaveBeenCalledWith(buildPersistentDbName("200"));
    });

    it("uses custom instance namespace during init", async () => {
      const db2 = new MemoryDb();
      const ds2 = new PersistentDataGateway(transport, {
        db: db2,
        instanceId: "grid-1",
      });
      const openSpy = vi.spyOn(db2, "open");
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, messages: [] })
        .mockResolvedValueOnce({ ok: true, conversations: [] })
        .mockResolvedValueOnce({ ok: true, contacts: [] })
        .mockResolvedValueOnce({ ok: true, users: [] })
        .mockResolvedValueOnce({ ok: true, mutes: [] });

      await ds2.init("200");

      expect(openSpy).toHaveBeenCalledWith(
        buildPersistentDbName("200", "grid-1"),
      );
    });

    it("restores seq from meta table", async () => {
      // Insert meta into the already-open db (from beforeEach init)
      await db.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('msg_seq', '42')",
      );
      await db.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('contact_seq', '15')",
      );
      // Create a non-resetting MemoryDb wrapper that skips open (db is already open)
      const noResetDb: MemoryDb = Object.create(db);
      noResetDb.open = async () => {};
      const ds3 = new PersistentDataGateway(transport, { db: noResetDb });
      // init() will try fullSync with lastMsgSeq=42, lastContactSeq=15
      // syncMessages and syncContacts will be called; return empty responses
      (transport.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, messages: [] }) // syncMessages (last_seq=42)
        .mockResolvedValueOnce({ ok: true, conversations: [] }) // syncConversations
        .mockResolvedValueOnce({ ok: true, contacts: [] }) // syncContacts (last_seq=15)
        .mockResolvedValueOnce({ ok: true, users: [] })
        .mockResolvedValueOnce({ ok: true, mutes: [] });
      const result = await ds3.init("100");
      expect(result.lastMsgSeq).toBe(42);
      expect(result.lastContactSeq).toBe(15);
    });

    it("init() 后台触发 sync actions without get reloads", async () => {
      const db2 = new MemoryDb();
      const t2 = mockTransport();
      const ds2 = new PersistentDataGateway(t2, { db: db2 });

      (t2.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, messages: [] }) // syncMessages
        .mockResolvedValueOnce({ ok: true, conversations: [] }) // syncConversations
        .mockResolvedValueOnce({ ok: true, contacts: [] }) // syncContacts
        .mockResolvedValueOnce({ ok: true, users: [] }) // syncBlocklist
        .mockResolvedValueOnce({ ok: true, mutes: [] }); // syncMutelist

      await ds2.init("user1");
      await flushSyncQueue();

      const actions = (t2.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (args: unknown[]) => (args[0] as Record<string, unknown>).action,
      );
      expect(actions).toContain("syncMessages");
      expect(actions).toContain("syncConversations");
      expect(actions).toContain("syncContacts");
      expect(actions).toContain("syncBlocklist");
      expect(actions).toContain("syncMutelist");
      expect(actions).not.toContain("getConversations");
      expect(actions).not.toContain("getContacts");
      expect(actions).not.toContain("getBlocklist");
      expect(actions).not.toContain("getMutelist");
    });
  });
});
