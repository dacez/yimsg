/**
 * 同步 domain 边界与 SQLite 幂等性单测。
 *
 * 重构后每个 sync 方法只维护自己 domain 的本地表与游标：
 *   - syncMessages 只写 messages 表与 msg_seq，不写 conversations、不级联会话同步；
 *   - syncConversations 只写 conversations 表；
 *   - syncBlocklist / syncMutelist / syncContacts 各自只写对应表。
 * 另外校验 messages.msg_id 的 UNIQUE 约束 + ON CONFLICT 覆盖，
 * 同一 msg_id 多次落库不产生重复行。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PersistentDataGateway,
} from "../../../src/datagateway/persistent";
import { MemoryDb } from "../memory-db";
import type { WsTransport } from "../../../src/transport/connection";
import type {
  BlocklistUser,
  EnrichedContact,
  Message,
  MutelistEntry,
} from "../../../src/models";
import { MSG_TYPE_TEXT } from "../../../src/constants";
import { actionByType, requestCodec } from "./protocol-test-helpers";

// 各 sync action 的条目字段与 seq 字段，用于模拟服务端 cursor_seq / has_more。
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
    for (const key of ["offset", "limit", "last_seq", "before_seq"]) {
      if (
        typeof request[key] === "string" &&
        /^\d+$/.test(request[key] as string)
      ) {
        request[key] = Number(request[key]);
      }
    }
    const resp = await send(request);
    // 模拟服务端：sync 响应未显式给出 cursor_seq / has_more 时，按本批最大 seq 推导。
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

type PersistentSyncTestAccess = {
  syncMessages(params: { last_seq: number; limit?: number }): Promise<Message[]>;
  syncConversations(params: {
    last_seq: number;
    limit?: number;
  }): Promise<unknown[]>;
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

function syncAccess(gateway: PersistentDataGateway): PersistentSyncTestAccess {
  return gateway as unknown as PersistentSyncTestAccess;
}

function textMessage(seq: number, msgId: string): Record<string, unknown> {
  return {
    seq,
    msg_id: msgId,
    from_uid: "200",
    to_uid: "100",
    group_id: "0",
    msg_type: MSG_TYPE_TEXT,
    body: { text: { text: `m${seq}` } },
    send_time: 1000 + seq,
  };
}

async function countRows(db: MemoryDb, table: string): Promise<number> {
  const rows = await db.query(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(rows[0]?.count || 0);
}

describe("SDK 同步 domain 边界", () => {
  let ds: PersistentDataGateway;
  let db: MemoryDb;
  let transport: ReturnType<typeof mockTransport>;

  beforeEach(async () => {
    db = new MemoryDb();
    transport = mockTransport();
    ds = new PersistentDataGateway(transport, { db });
    (transport.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, messages: [] })
      .mockResolvedValueOnce({ ok: true, conversations: [] })
      .mockResolvedValueOnce({ ok: true, contacts: [] })
      .mockResolvedValueOnce({ ok: true, users: [] })
      .mockResolvedValueOnce({ ok: true, mutes: [] });
    await ds.init("100");
    await flushSyncQueue();
    (transport.send as ReturnType<typeof vi.fn>).mockReset();
  });

  it("syncMessages 只写 messages 表，conversations 表不被写入", async () => {
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      messages: [textMessage(1, "msg_1"), textMessage(2, "msg_2")],
    });

    await syncAccess(ds).syncMessages({ last_seq: 0, limit: 100 });

    expect(await countRows(db, "messages")).toBe(2);
    expect(await countRows(db, "conversations")).toBe(0);

    // 只触发 syncMessages，不级联会话同步
    const actions = (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (args) => (args[0] as Record<string, unknown>).action,
    );
    expect(actions).toEqual(["syncMessages"]);

    // 游标只推进 msg_seq，conversation_seq 不被写入
    const metaRows = await db.query(
      "SELECT key, value FROM meta WHERE key IN ('msg_seq', 'conversation_seq') ORDER BY key",
    );
    expect(metaRows).toMatchObject([{ key: "msg_seq", value: "2" }]);
  });

  it("conversations 表只在调用 syncConversations 后才有数据", async () => {
    expect(await countRows(db, "conversations")).toBe(0);

    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      conversations: [
        {
          friend_uid: "200",
          group_id: "0",
          last_seq: 7,
          last_msg: null,
          unread_count: 2,
          status: 1,
        },
      ],
    });

    await syncAccess(ds).syncConversations({ last_seq: 0, limit: 100 });

    expect(await countRows(db, "conversations")).toBe(1);
    expect(await countRows(db, "messages")).toBe(0);
    const metaRows = await db.query(
      "SELECT key, value FROM meta WHERE key = 'conversation_seq'",
    );
    expect(metaRows).toMatchObject([{ key: "conversation_seq", value: "7" }]);
  });

  it("syncBlocklist 只写 blocklist 表", async () => {
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      users: [
        { uid: "200", status: 1, seq: 1, created_at: 1000, updated_at: 1000 },
      ],
    });

    await syncAccess(ds).syncBlocklist({ last_seq: 0, limit: 100 });

    expect(await countRows(db, "blocklist")).toBe(1);
    expect(await countRows(db, "mutelist")).toBe(0);
    expect(await countRows(db, "contacts")).toBe(0);
    expect(await countRows(db, "messages")).toBe(0);
    expect(await countRows(db, "conversations")).toBe(0);
  });

  it("syncMutelist 只写 mutelist 表", async () => {
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      mutes: [
        { to_uid: "200", group_id: "0", status: 1, seq: 1, updated_at: 1000 },
      ],
    });

    await syncAccess(ds).syncMutelist({ last_seq: 0, limit: 100 });

    expect(await countRows(db, "mutelist")).toBe(1);
    expect(await countRows(db, "blocklist")).toBe(0);
    expect(await countRows(db, "contacts")).toBe(0);
    expect(await countRows(db, "messages")).toBe(0);
    expect(await countRows(db, "conversations")).toBe(0);
  });

  it("syncContacts 只写 contacts 表", async () => {
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      contacts: [
        {
          friend_uid: "200",
          group_id: "0",
          status: 1,
          seq: 1,
          remark_name: "",
          sort_key: "Bob",
        },
      ],
    });

    await syncAccess(ds).syncContacts({ last_seq: 0, limit: 100 });

    expect(await countRows(db, "contacts")).toBe(1);
    expect(await countRows(db, "blocklist")).toBe(0);
    expect(await countRows(db, "mutelist")).toBe(0);
    expect(await countRows(db, "messages")).toBe(0);
    expect(await countRows(db, "conversations")).toBe(0);
  });
});

describe("SDK SQLite 幂等性", () => {
  let ds: PersistentDataGateway;
  let db: MemoryDb;
  let transport: ReturnType<typeof mockTransport>;

  beforeEach(async () => {
    db = new MemoryDb();
    transport = mockTransport();
    ds = new PersistentDataGateway(transport, { db });
    (transport.send as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, messages: [] })
      .mockResolvedValueOnce({ ok: true, conversations: [] })
      .mockResolvedValueOnce({ ok: true, contacts: [] })
      .mockResolvedValueOnce({ ok: true, users: [] })
      .mockResolvedValueOnce({ ok: true, mutes: [] });
    await ds.init("100");
    await flushSyncQueue();
    (transport.send as ReturnType<typeof vi.fn>).mockReset();
  });

  it("相同 msg_id 两次 syncMessages 不产生重复行（msg_id UNIQUE 覆盖）", async () => {
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      messages: [textMessage(1, "dup_msg")],
    });
    await syncAccess(ds).syncMessages({ last_seq: 0, limit: 100 });
    expect(await countRows(db, "messages")).toBe(1);

    // 同一 msg_id 再次落库（即便 seq 不同），ON CONFLICT(msg_id) 覆盖而非新增。
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      messages: [{ ...textMessage(2, "dup_msg"), body: { text: { text: "覆盖后的内容" } } }],
    });
    await syncAccess(ds).syncMessages({ last_seq: 1, limit: 100 });

    expect(await countRows(db, "messages")).toBe(1);
    const rows = await db.query(
      "SELECT msg_id, seq, search_text FROM messages WHERE msg_id = ?",
      ["dup_msg"],
    );
    expect(rows).toMatchObject([{ msg_id: "dup_msg", seq: 2 }]);
    expect(String(rows[0].search_text)).toContain("覆盖后的内容");
  });
});
