import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstantDataGateway } from "../../../src/datagateway/instant";
import { BaseDataGateway } from "../../../src/datagateway/base";
import type { Message } from "../../../src/models";
import type { WsTransport } from "../../../src/transport/connection";
import { actionByType, requestCodec } from "./protocol-test-helpers";

class TestDataGateway extends BaseDataGateway {
  messageNotificationHandler: () => Promise<void> = async () => {};
  contactNotificationHandler: () => Promise<void> = async () => {};


  protected async handleMessagesReceived(): Promise<void> {
    await this.messageNotificationHandler();
    this.emitMessagesReceived([
      {
        uid: 1,
        msg_id: "test-message",
        from_uid: "1",
        seq: 1,
        msg_type: 1,
        body: { text: { text: "hi" } },
        send_time: 1700000000,
      } satisfies Message,
    ]);
  }

  protected async handleContactChanged(): Promise<void> {
    await this.contactNotificationHandler();
    this.emitContactsChanged([]);
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockTransport(): WsTransport {
  const sendBinary = vi
    .fn()
    .mockResolvedValue({ base: { code: 0 }, messages: [], contacts: [] });
  return { send: vi.fn(), sendBinary } as unknown as WsTransport;
}

function decodeBinaryRequest(call: unknown[]): Record<string, unknown> {
  const [typeId, body] = call as [number, Uint8Array];
  const decoded = requestCodec(typeId).decode(body) as Record<string, unknown>;
  const request: Record<string, unknown> = {
    action: actionByType(typeId),
    ...decoded,
  };
  const target = request.target as
    | { uid?: string; group_id?: string }
    | undefined;
  if (target?.uid) request.to_uid = target.uid;
  if (target?.uid) request.friend_uid = target.uid;
  if (target?.group_id) request.group_id = target.group_id;
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
  return request;
}

function binaryRequests(transport: WsTransport): Record<string, unknown>[] {
  return (transport.sendBinary as ReturnType<typeof vi.fn>).mock.calls.map(
    decodeBinaryRequest,
  );
}

describe("BaseDataGateway notification queue", () => {
  let ds: TestDataGateway;
  let transport: WsTransport;

  beforeEach(() => {
    transport = mockTransport();
    ds = new TestDataGateway(transport);
  });

  // ---- syncQueue error recovery ----

  it("syncQueue continues processing after a handler error", async () => {
    const cb = vi.fn();
    const errorCb = vi.fn();
    ds.onMessagesReceived(cb);
    ds.onError(errorCb);

    // 第一次通知处理器抛错，第二次恢复成功。
    ds.messageNotificationHandler = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(undefined);

    // 第一条通知——此次 sync 会失败
    ds.handleNotification({ type: "messages:received" } as any);

    await flushPromises();
    await flushPromises();

    // 第一次处理失败，应上报错误
    expect(errorCb).toHaveBeenCalledWith(expect.any(Error), expect.any(String));

    // 第二条通知在第一次处理完成后到达——队列应能正常继续处理
    ds.handleNotification({ type: "messages:received" } as any);

    await flushPromises();
    await flushPromises();

    // 第二次处理成功，cb 应被调用
    expect(cb).toHaveBeenCalled();
  });

  it("syncQueue processes notifications in order", async () => {
    const order: string[] = [];
    ds.onMessagesReceived(() => order.push("msg"));
    ds.onContactsChanged(() => order.push("contact"));

    ds.handleNotification({ type: "messages:received" } as any);
    ds.handleNotification({ type: "contacts:updated" } as any);

    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(order[0]).toBe("msg");
    expect(order[1]).toBe("contact");
  });

  // instant 基线：处理任何通知都不得发出 session:sync 事件（内存模式无同步操作，
  // 不显示"同步中"，也不触发 session:sync 驱动的会话列表重渲染）。只有 persistent 覆盖
  // syncDomain 后才会带域上报。
  it("instant 基线处理通知不发出任何 session:sync 事件", async () => {
    const syncCb = vi.fn();
    ds.onSync(syncCb);
    ds.onMessagesReceived(() => {});
    ds.onContactsChanged(() => {});

    ds.handleNotification({ type: "messages:received" } as any);
    ds.handleNotification({ type: "contacts:updated" } as any);
    ds.handleNotification({ type: "blocklist:updated" } as any);
    ds.handleNotification({ type: "mutelist:updated" } as any);

    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(syncCb).not.toHaveBeenCalled();
  });

  // ---- clear() resets callbacks ----

  it("clear() nullifies all callbacks and resets queue", async () => {
    const msgCb = vi.fn();
    const contactCb = vi.fn();
    const readCb = vi.fn();
    const kickCb = vi.fn();

    ds.onMessagesReceived(msgCb);
    ds.onContactsChanged(contactCb);
    ds.onUnreadCleared(readCb);
    ds.onSessionKicked(kickCb);

    ds.clear();

    // After clear, notifications should not invoke callbacks
    ds.handleNotification({ type: "messages:received" } as any);
    ds.handleNotification({ type: "session:kicked" } as any);

    await flushPromises();

    // Callbacks should not fire after clear (since they are nullified)
    // Note: the enqueue still runs but the callbacks are null
    expect(kickCb).not.toHaveBeenCalled();
  });

  it("get_contacts returns page keyset cursor", async () => {
    (transport.sendBinary as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      page: { has_more_forward: true, end_cursor: "E2" },
      contacts: [
        {
          friend_uid: "200",
          group_id: "0",
          status: 1,
          seq: 3,
          cache_name: "Bob",
        },
      ],
    });

    const page = await ds.get_contacts({ status: 1, page: { limit: 1 } });

    expect(page.page.hasMoreForward).toBe(true);
    expect(page.page.endCursor).toBe("E2");
    expect(page.contacts[0].cache_name).toBe("Bob");
    expect(binaryRequests(transport)).toContainEqual(
      expect.objectContaining({
        action: "getContacts",
        status: 1,
      }),
    );
  });

  it("contact summary helpers call backend actions", async () => {
    (transport.sendBinary as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, total: 3 })
      .mockResolvedValueOnce({
        ok: true,
        contacts: [{ friend_uid: "200", group_id: "0", status: 2, seq: 9 }],
        page: { has_more_forward: false, end_cursor: "E1" },
      });

    await expect(ds.get_contact_count(2)).resolves.toBe(3);
    const page2 = await ds.get_contacts({ friend_uid: "200", status: 2, page: { limit: 1 } });
    expect(page2.page.hasMoreForward).toBe(false);
    expect(page2.page.endCursor).toBe("E1");
    expect(binaryRequests(transport)[0]).toMatchObject({
      action: "getContactCount",
    });
    expect(binaryRequests(transport)[1]).toMatchObject({
      action: "getContacts",
      targets: [{ uid: "200" }],
      status: 2,
    });
  });

  it("get_user_infos 立即返回空并按下发上限异步分批请求", async () => {
    ds = new TestDataGateway(transport, { batchMaxLimit: 2 });
    const updated = vi.fn();
    (transport.sendBinary as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        profiles: [{ uid: "1", nickname: "A" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        profiles: [{ uid: "3", nickname: "C" }],
      });

    const result = await ds.get_user_infos(["1", "2", "3"], {
      cacheTtlMs: 60_000,
      updateDisplayInfos: updated,
    });
    await flushPromises();

    expect(result).toEqual([]);
    expect(updated).toHaveBeenCalledWith([
      { uid: "1", nickname: "A" },
      { uid: "3", nickname: "C" },
    ]);
    expect(binaryRequests(transport)[0]).toMatchObject({
      action: "getUserInfos",
      uids: ["1", "2"],
    });
    expect(binaryRequests(transport)[1]).toMatchObject({
      action: "getUserInfos",
      uids: ["3"],
    });
  });
});

describe("InstantDataGateway notifications", () => {
  let ds: InstantDataGateway;
  let transport: WsTransport;

  beforeEach(() => {
    transport = mockTransport();
    ds = new InstantDataGateway(transport);
  });

  it("messages:received 按通知 msg_id 拉取内容并派发，不扫描会话、不调用 sync_messages", async () => {
    const message = {
      uid: 100,
      seq: 2,
      msg_id: "m2",
      from_uid: "200",
      to_uid: "100",
      group_id: "0",
      msg_type: 1,
      content: "hi",
      send_time: 1700000000,
    };
    const cb = vi.fn();
    await ds.init("100");
    ds.onMessagesReceived(cb);
    (transport.sendBinary as ReturnType<typeof vi.fn>).mockImplementation(
      (...args) => {
        const request = decodeBinaryRequest(args);
        if (request.action === "getMessages") {
          return Promise.resolve({ ok: true, messages: [message] });
        }
        return Promise.resolve({ ok: true });
      },
    );

    ds.handleNotification({
      type: "messages:received",
      from_uid: "200",
      msg_id: "m2",
    } as any);

    await flushPromises();
    await flushPromises();

    expect(cb).toHaveBeenCalledWith([expect.objectContaining(message)]);
    const actions = binaryRequests(transport).map((call) => call.action);
    expect(actions).toEqual(["getMessages"]);
    expect(actions.some((action) => String(action).startsWith("sync_"))).toBe(
      false,
    );
  });

  it("messages:received 无 msg_id 时仍发出空的重绘信号，不请求后端", async () => {
    const cb = vi.fn();
    await ds.init("100");
    ds.onMessagesReceived(cb);

    ds.handleNotification({
      type: "messages:received",
      from_uid: "200",
    } as any);

    await flushPromises();
    await flushPromises();

    expect(cb).toHaveBeenCalledWith([]);
    expect(binaryRequests(transport).map((call) => call.action)).toEqual([]);
  });

  it("messages:received 通过 get_messages 接收 recall event，不调用 sync_messages", async () => {
    const recallEvent = {
      uid: 100,
      seq: 3,
      msg_id: "recall-3",
      from_uid: "200",
      to_uid: "100",
      group_id: "0",
      msg_type: 5,
      content:
        '{"version":1,"body":{"kind":"text","text":""},"ext":{"recall":{"kind":"event","target_msg_id":"m1","placeholder_text":"对方撤回了一条消息"}}}',
      send_time: 1700000001,
    };
    const cb = vi.fn();
    await ds.init("100");
    ds.onMessagesReceived(cb);
    (transport.sendBinary as ReturnType<typeof vi.fn>).mockImplementation(
      (...args) => {
        const request = decodeBinaryRequest(args);
        if (request.action === "getMessages") {
          return Promise.resolve({ ok: true, messages: [recallEvent] });
        }
        return Promise.resolve({ ok: true });
      },
    );

    ds.handleNotification({
      type: "messages:received",
      from_uid: "200",
      msg_id: "recall-3",
    } as any);

    await flushPromises();
    await flushPromises();

    expect(cb).toHaveBeenCalledWith([expect.objectContaining(recallEvent)]);
    const actions = binaryRequests(transport).map((call) => call.action);
    expect(actions).toEqual(["getMessages"]);
    expect(actions.some((action) => String(action).startsWith("sync_"))).toBe(
      false,
    );
  });

  it("messages:received 合并多个会话的通知时累积全部 msg_id 一次批量拉取", async () => {
    const messages = [
      {
        uid: 100,
        seq: 2,
        msg_id: "m2",
        from_uid: "200",
        to_uid: "100",
        group_id: "0",
        msg_type: 1,
        content: "a",
        send_time: 1700000000,
      },
      {
        uid: 100,
        seq: 3,
        msg_id: "g3",
        from_uid: "300",
        to_uid: "0",
        group_id: "900",
        msg_type: 1,
        content: "b",
        send_time: 1700000001,
      },
    ];
    const cb = vi.fn();
    await ds.init("100");
    ds.onMessagesReceived(cb);
    (transport.sendBinary as ReturnType<typeof vi.fn>).mockImplementation(
      (...args) => {
        const request = decodeBinaryRequest(args);
        if (request.action === "getMessages") {
          return Promise.resolve({ ok: true, messages });
        }
        return Promise.resolve({ ok: true });
      },
    );

    // 两条来自不同会话的通知在同一 tick 内合并：私聊 m2 + 群聊 g3。
    ds.handleNotification({
      type: "messages:received",
      from_uid: "200",
      msg_id: "m2",
    } as any);
    ds.handleNotification({
      type: "messages:received",
      group_id: "900",
      msg_id: "g3",
    } as any);

    await flushPromises();
    await flushPromises();

    // 只发起一次 getMessages，msg_ids 携带两个 id，无 target。
    const getCalls = binaryRequests(transport).filter(
      (call) => call.action === "getMessages",
    );
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].msg_ids).toEqual(["m2", "g3"]);
    expect(cb).toHaveBeenLastCalledWith([
      expect.objectContaining(messages[0]),
      expect.objectContaining(messages[1]),
    ]);
  });

  it("contacts:updated 只发失效事件，不调用 sync_contacts", async () => {
    const cb = vi.fn();
    ds.onContactsChanged(cb);

    ds.handleNotification({ type: "contacts:updated" } as any);

    await flushPromises();
    await flushPromises();

    expect(cb).toHaveBeenCalledWith([], true);
    expect(transport.sendBinary).not.toHaveBeenCalled();
  });
});
