/**
 * 组织域单测：action 映射、instant 基线（在线展开 + org:updated 重绘信号）、
 * persistent 本地副本（增量落盘、tombstone 即删、本地展开排序、离职清库、seq_too_old 重建）。
 *
 * org_info / tag_info 是无 seq 的展示字典（get_org_infos / get_tag_infos 走
 * DisplayInfoCache，另有单测覆盖），本文件只覆盖 tags（组织关系表）这一个同步域。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseDataGateway } from "../../../src/sdk/datagateway/base";
import { PersistentDataGateway } from "../../../src/sdk/datagateway/persistent";
import { MemoryDb } from "../memory-db";
import * as actionMappers from "../../../src/sdk/internal/action-mappers";
import type { WsTransport } from "../../../src/sdk/transport/connection";
import type { Notification } from "../../../src/types";
import { RequestError } from "../../../src/sdk/errors";
import { actionByType, requestCodec } from "./protocol-test-helpers";

const ORG_RANK_UNSET = 2147483647;
const TAG_CHILD_PERSON = 1;
const TAG_CHILD_TAG = 2;

function mockTransport(): WsTransport {
  const send = vi.fn();
  const sendBinary = vi.fn(async (typeId: number, body: Uint8Array) => {
    const decoded = requestCodec(typeId).decode(body) as Record<string, unknown>;
    return send({ action: actionByType(typeId), ...decoded });
  });
  return { send, sendBinary } as unknown as WsTransport;
}

function sendMock(transport: WsTransport): ReturnType<typeof vi.fn> {
  return transport.send as ReturnType<typeof vi.fn>;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// instant 基线用 BaseDataGateway 的具体子类。
class InstantGateway extends BaseDataGateway {}

describe("组织 action 映射", () => {
  it("sync_tags 响应归一化：child_id/child_type、tombstone、游标", () => {
    const mapped = actionMappers.mapSyncTagsResponse({
      tags: [
        { tag_id: "100", child_id: "200", child_type: TAG_CHILD_TAG, rank: "10", sort_key: "a", status: 1, seq: "2" },
        { tag_id: "200", child_id: "42", child_type: TAG_CHILD_PERSON, title: "组长", rank: "1", sort_key: "n", status: 255, seq: "3" },
      ],
      has_more: true,
      cursor_seq: "3",
    } as never);
    expect(mapped.tags[0]).toMatchObject({ tag_id: "100", child_id: "200", child_type: TAG_CHILD_TAG, rank: 10, status: 1 });
    expect(mapped.tags[1]).toMatchObject({ child_id: "42", title: "组长", rank: 1, status: 255, seq: 3 });
    expect(mapped.hasMore).toBe(true);
    expect(mapped.cursorSeq).toBe(3);
  });

  it("通讯录条目归一化：org 目标条目 friend/group 归零", () => {
    const mapped = actionMappers.mapGetContactsResponse({
      contacts: [{ target: { org_id: "900" }, status: 1, seq: "5", sort_key: "org" }],
      page: undefined,
    } as never);
    expect(mapped.contacts[0]).toMatchObject({ org_id: "900", friend_uid: "0", group_id: "0" });
  });
});

describe("组织 instant 基线", () => {
  let gateway: InstantGateway;
  let transport: WsTransport;

  beforeEach(() => {
    transport = mockTransport();
    gateway = new InstantGateway(transport);
  });

  it("get_tags 在线展开并透传排序结果", async () => {
    sendMock(transport).mockResolvedValueOnce({
      tags: [
        { tag_id: "100", child_id: "1", child_type: TAG_CHILD_PERSON, title: "总经理", rank: "10", sort_key: "boss", status: 1, seq: "4" },
        { tag_id: "100", child_id: "2", child_type: TAG_CHILD_PERSON, rank: String(ORG_RANK_UNSET), sort_key: "amy", status: 1, seq: "5" },
      ],
      page: undefined,
    });
    const result = await gateway.get_tags({ org_id: "100", tag_id: "100" });
    expect(result.tags.map((t) => t.child_id)).toEqual(["1", "2"]);
    expect(result.tags[0].title).toBe("总经理");
  });

  it("org:updated 通知合并去重后派发重绘信号", async () => {
    const changed = vi.fn();
    gateway.onOrgsChanged(changed);
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    gateway.handleNotification({ type: "org:updated", org_id: "200" } as Notification);
    await flush();
    expect(changed).toHaveBeenCalled();
    const allIds = changed.mock.calls.flatMap((c) => c[0] as string[]);
    expect(new Set(allIds)).toEqual(new Set(["100", "200"]));
  });
});

describe("组织 persistent 本地副本", () => {
  let gateway: PersistentDataGateway;
  let db: MemoryDb;
  let transport: WsTransport;

  beforeEach(async () => {
    db = new MemoryDb();
    transport = mockTransport();
    gateway = new PersistentDataGateway(transport, { db });
    // init() 触发固定域首轮同步：五个域各回一页空。
    sendMock(transport)
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ conversations: [] })
      .mockResolvedValueOnce({ contacts: [] })
      .mockResolvedValueOnce({ users: [] })
      .mockResolvedValueOnce({ mutes: [] });
    await gateway.init("9");
    await flush();
    sendMock(transport).mockReset();
  });

  function orgGraphPage() {
    // 根(100) → 公司领导(200 rank10, TAG)、xx部门(300 rank20, TAG)；
    // boss(1) 领导 rank=10；A(2) 领导沉底、部门 rank=1；staff(3) 部门按名字。
    // 名字字典（org_info/tag_info）不进入这里，走独立的 get_org_infos/get_tag_infos。
    return {
      tags: [
        { tag_id: "100", child_id: "200", child_type: TAG_CHILD_TAG, rank: "10", sort_key: "公司领导", status: 1, seq: "1" },
        { tag_id: "100", child_id: "300", child_type: TAG_CHILD_TAG, rank: "20", sort_key: "xx部门", status: 1, seq: "2" },
        { tag_id: "200", child_id: "1", child_type: TAG_CHILD_PERSON, title: "总经理", rank: "10", sort_key: "boss", status: 1, seq: "3" },
        { tag_id: "200", child_id: "2", child_type: TAG_CHILD_PERSON, title: "副总", rank: String(ORG_RANK_UNSET), sort_key: "zz-a", status: 1, seq: "4" },
        { tag_id: "300", child_id: "2", child_type: TAG_CHILD_PERSON, title: "部门负责人", rank: "1", sort_key: "zz-a", status: 1, seq: "5" },
        { tag_id: "300", child_id: "3", child_type: TAG_CHILD_PERSON, rank: String(ORG_RANK_UNSET), sort_key: "bob", status: 1, seq: "6" },
      ],
      has_more: false,
      cursor_seq: "6",
    };
  }

  it("org:updated → 增量落盘 → 本地展开（绝对排序 + 一人多岗）", async () => {
    sendMock(transport).mockResolvedValueOnce(orgGraphPage());
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    await flush();
    await flush();

    // 同步后展开走本地副本，不再发网络请求。
    sendMock(transport).mockClear();
    const root = await gateway.get_tags({ org_id: "100", tag_id: "100" });
    expect(sendMock(transport)).not.toHaveBeenCalled();
    expect(root.tags.map((t) => t.child_id)).toEqual(["200", "300"]);
    expect(root.tags[0].child_type).toBe(TAG_CHILD_TAG);

    const leaders = await gateway.get_tags({ org_id: "100", tag_id: "200" });
    expect(leaders.tags.map((t) => t.child_id)).toEqual(["1", "2"]); // boss rank=10 第一，A 名字沉底
    const dept = await gateway.get_tags({ org_id: "100", tag_id: "300" });
    expect(dept.tags.map((t) => t.child_id)).toEqual(["2", "3"]); // A rank=1 排第一（一人多岗独立排序）
  });

  it("增量 tombstone 即删本地行", async () => {
    sendMock(transport).mockResolvedValueOnce(orgGraphPage());
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    await flush();
    await flush();

    // 第二次通知：摘掉 A 的部门边（tombstone）。
    sendMock(transport).mockResolvedValueOnce({
      tags: [
        { tag_id: "300", child_id: "2", child_type: TAG_CHILD_PERSON, rank: "1", sort_key: "zz-a", status: 255, seq: "7" },
      ],
      has_more: false,
      cursor_seq: "7",
    });
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    await flush();
    await flush();

    const dept = await gateway.get_tags({ org_id: "100", tag_id: "300" });
    expect(dept.tags.map((t) => t.child_id)).toEqual(["3"]);
    // 增量请求应携带上一轮游标。
    const syncCalls = sendMock(transport).mock.calls.filter((c) => c[0].action === "syncTags");
    expect(Number(syncCalls[syncCalls.length - 1][0].last_seq)).toBe(6);
  });

  it("副本未就绪时在线展开 fallback 并触发后台同步", async () => {
    sendMock(transport)
      .mockResolvedValueOnce({
        tags: [{ tag_id: "100", child_id: "1", child_type: TAG_CHILD_PERSON, rank: "1", sort_key: "b", status: 1, seq: "1" }],
        page: undefined,
      })
      .mockResolvedValueOnce(orgGraphPage());
    const result = await gateway.get_tags({ org_id: "100", tag_id: "100" });
    expect(result.tags).toHaveLength(1); // 在线 fallback 结果
    await flush();
    await flush();
    const actions = sendMock(transport).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("getTags");
    expect(actions).toContain("syncTags");
  });

  it("组织行 tombstone（离职）联动清空该组织本地副本与游标", async () => {
    sendMock(transport).mockResolvedValueOnce(orgGraphPage());
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    await flush();
    await flush();

    // contacts:updated 增量同步下发组织行 tombstone。
    sendMock(transport).mockResolvedValueOnce({
      contacts: [{ target: { org_id: "100" }, status: 255, seq: "20" }],
      has_more: false,
      cursor_seq: "20",
    });
    gateway.handleNotification({ type: "contacts:updated" } as Notification);
    await flush();
    await flush();

    const tagRows = await db.query("SELECT COUNT(*) AS n FROM tags WHERE org_id = ?", ["100"]);
    const meta = await db.query("SELECT COUNT(*) AS n FROM meta WHERE key = ?", ["org_seq:100"]);
    expect(Number(tagRows[0].n)).toBe(0);
    expect(Number(meta[0].n)).toBe(0);
  });

  it("seq_too_old 清本地重建后全量追平", async () => {
    sendMock(transport).mockResolvedValueOnce(orgGraphPage());
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    await flush();
    await flush();

    // 下一轮增量：先回 seq_too_old，再回全量重建页。
    sendMock(transport)
      .mockRejectedValueOnce(
        new RequestError("REQUEST_FAILED", "seq_too_old", {
          details: { serverErrorCode: "SEQ_TOO_OLD" },
        }),
      )
      .mockResolvedValueOnce(orgGraphPage());
    gateway.handleNotification({ type: "org:updated", org_id: "100" } as Notification);
    await flush();
    await flush();

    const root = await gateway.get_tags({ org_id: "100", tag_id: "100" });
    expect(root.tags).toHaveLength(2);
    // 重建请求 last_seq=0 且 rebuild=true。
    const syncCalls = sendMock(transport).mock.calls.filter((c) => c[0].action === "syncTags");
    const rebuildCall = syncCalls[syncCalls.length - 1][0];
    expect(Number(rebuildCall.last_seq)).toBe(0);
    expect(Boolean(rebuildCall.rebuild)).toBe(true);
  });
});
