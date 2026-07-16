import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YimsgClient } from "../../../src/sdk/client";
import {
  PreconditionError,
  ValidationError,
  isYimsgError,
} from "../../../src/sdk/errors";
import { InstantDataGateway } from "../../../src/sdk/datagateway/instant";
import {
  MSG_TYPE_FORWARD,
  MSG_TYPE_MARKDOWN,
  MSG_TYPE_QUOTE,
  MSG_TYPE_RECALL,
  MSG_TYPE_TEXT,
} from "../../../src/constants";
import { WsTransport } from "../../../src/sdk/transport/connection";
import { actionByType, requestCodec } from "./protocol-test-helpers";
import { LocalSqliteApi } from "../../../src/sdk/datagateway/sqlite-local-api";
import { buildPersistentDbName } from "../../../src/sdk/datagateway/persistent";

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
  for (const key of ["msg_type", "status", "offset", "limit"]) {
    if (
      typeof request[key] === "string" &&
      /^\d+$/.test(request[key] as string)
    ) {
      request[key] = Number(request[key]);
    }
  }
  return request;
}

function decodedTransportRequests(
  transportSend: ReturnType<typeof vi.fn>,
): Record<string, unknown>[] {
  return transportSend.mock.calls.map(decodeBinaryRequest);
}

function setupClientWithMocks(
  options: ConstructorParameters<typeof YimsgClient>[0] = {},
) {
  // 获取 beforeEach 中设置的 sendBinary spy 引用，供测试自定义其行为
  const transportSendBinary = vi.mocked(WsTransport.prototype.sendBinary);
  vi.spyOn(InstantDataGateway.prototype, "init").mockResolvedValue({
    lastMsgSeq: 0,
    lastContactSeq: 0,
  });
  vi.spyOn(InstantDataGateway.prototype, "get_contacts").mockResolvedValue({
    offset: 0,
    total: 0,
    contacts: [],
  });
  vi.spyOn(InstantDataGateway.prototype, "get_conversations").mockResolvedValue({
    offset: 0,
    total: 0,
    conversations: [],
  });
  vi.spyOn(InstantDataGateway.prototype, "get_unread_count").mockResolvedValue(
    0,
  );

  const client = new YimsgClient(options);
  const transport = (
    client as unknown as {
      _transport: {
        sendBinary: typeof transportSendBinary;
        readonly connected: boolean;
        disconnect: () => void;
        onConnected?: () => void;
        onDisconnected?: () => void;
      };
    }
  )._transport;
  vi.spyOn(transport, "connected", "get").mockReturnValue(true);
  transport.onConnected?.();
  return {
    client,
    transportSendBinary,
    transportSend: transportSendBinary,
    transport,
  };
}

/**
 * 设置 transportSendBinary mock 为登录成功的返回值。
 * 因为 auth 模块现在使用 sendBinary（proto 原生路径），
 * 需要单独 mock sendBinary 来模拟登录/鉴权成功。
 */
function mockAuthSuccess(
  transportSendBinary: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  transportSendBinary.mockResolvedValueOnce({
    base: { code: 0 },
    uid: "100",
    token: "tok123",
    ...overrides,
  });
}

describe("YimsgClient", () => {
  beforeEach(() => {
    // 全局 mock sendBinary，因为 auth 模块现在使用 proto 原生路径
    vi.spyOn(WsTransport.prototype, "sendBinary").mockResolvedValue({
      base: { code: 0 },
      uid: "100",
      token: "tok123",
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not touch localStorage when constructing or authenticating", async () => {
    const localStorageAccess = {
      getItem: vi.fn(() => {
        throw new Error("should not read localStorage");
      }),
      setItem: vi.fn(() => {
        throw new Error("should not write localStorage");
      }),
      removeItem: vi.fn(() => {
        throw new Error("should not clear localStorage");
      }),
    };
    vi.stubGlobal("localStorage", localStorageAccess);

    const { client } = setupClientWithMocks();

    await client.authenticate("tok123");
    expect(client.getSessionSnapshot().currentUid).toBe("100");

    await client.logout();
    expect(localStorageAccess.getItem).not.toHaveBeenCalled();
    expect(localStorageAccess.setItem).not.toHaveBeenCalled();
    expect(localStorageAccess.removeItem).not.toHaveBeenCalled();
  });

  it("uses storage passed by the application during startSession", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    await client.startSession({ storage: "instant" });

    expect(client.getSessionSnapshot().mode).toBe("instant");
  });

  it("getClientConfig 认证前返回构造时传入的初始值", () => {
    const client = new YimsgClient({
      cacheTtlSeconds: 9,
      cacheMaxEntries: 99,
      recallWindowSeconds: 60,
      batchMaxLimit: 123,
    });
    expect(client.getClientConfig().cacheTtlSeconds).toBe(9);
    expect(client.getClientConfig().cacheMaxEntries).toBe(99);
    expect(client.getClientConfig().recallWindowsSeconds).toBe(60);
    expect(client.getClientConfig().batchMaxLimit).toBe(123);
  });

  it("getClientConfig 登录后只运行期更新 recall 和 batch，缓存配置保持构造值", async () => {
    const { client, transportSendBinary } = setupClientWithMocks();
    transportSendBinary.mockResolvedValueOnce({
      base: { code: 0 },
      uid: "100",
      token: "tok123",
      client_config: {
        cache_ttl_seconds: "11",
        cache_max_entries: "22",
        recall_window_seconds: "3",
        batch_max_limit: "2",
      },
    } as any);

    const result = await client.login("alice", "password");

    expect(client.getClientConfig().recallWindowsSeconds).toBe(3);
    expect(client.getClientConfig().batchMaxLimit).toBe(2);
    expect(client.getClientConfig().cacheTtlSeconds).toBe(604800);
    expect(client.getClientConfig().cacheMaxEntries).toBe(10000);
    expect(result.clientConfig?.recallWindowsSeconds).toBe(3);
    expect(result.clientConfig?.batchMaxLimit).toBe(2);
    expect(result.clientConfig?.cacheTtlSeconds).toBe(604800);
    expect(result.clientConfig?.cacheMaxEntries).toBe(10000);
  });

  it("getClientConfig 批量上限同时有本地和后端配置时取较小值", async () => {
    const { client, transportSendBinary } = setupClientWithMocks({
      batchMaxLimit: 2,
    });
    transportSendBinary.mockResolvedValueOnce({
      base: { code: 0 },
      uid: "100",
      token: "tok123",
      client_config: {
        cache_ttl_seconds: "11",
        cache_max_entries: "22",
        recall_window_seconds: "3",
        batch_max_limit: "5",
      },
    } as any);

    const result = await client.login("alice", "password");

    expect(client.getClientConfig().batchMaxLimit).toBe(2);
    expect(result.clientConfig?.batchMaxLimit).toBe(2);
  });

  it("getClientConfig token 鉴权后只运行期更新 recall 和 batch，缓存配置保持构造值", async () => {
    const { client, transportSendBinary } = setupClientWithMocks();
    transportSendBinary.mockResolvedValueOnce({
      base: { code: 0 },
      uid: "100",
      client_config: {
        cache_ttl_seconds: "12",
        cache_max_entries: "23",
        recall_window_seconds: "4",
        batch_max_limit: "3",
      },
    } as any);

    const result = await client.authenticate("tok123");

    expect(client.getClientConfig().recallWindowsSeconds).toBe(4);
    expect(client.getClientConfig().batchMaxLimit).toBe(3);
    expect(client.getClientConfig().cacheTtlSeconds).toBe(604800);
    expect(client.getClientConfig().cacheMaxEntries).toBe(10000);
    expect(result.clientConfig?.recallWindowsSeconds).toBe(4);
    expect(result.clientConfig?.batchMaxLimit).toBe(3);
    expect(result.clientConfig?.cacheTtlSeconds).toBe(604800);
    expect(result.clientConfig?.cacheMaxEntries).toBe(10000);
  });

  it("getConversations 使用后端下发批量上限裁剪 limit", async () => {
    const { client, transportSendBinary } = setupClientWithMocks();
    transportSendBinary.mockResolvedValueOnce({
      base: { code: 0 },
      uid: "100",
      token: "tok123",
      client_config: {
        cache_ttl_seconds: "11",
        cache_max_entries: "22",
        recall_window_seconds: "3",
        batch_max_limit: "2",
      },
    } as any);
    await client.login("alice", "password");
    await client.startSession({ storage: "instant" });
    const getSpy = InstantDataGateway.prototype
      .get_conversations as unknown as ReturnType<typeof vi.fn>;
    getSpy.mockClear();

    await client.getConversations({ limit: 999 });

    expect(getSpy).toHaveBeenCalledWith({
      page: { cursor: undefined, backward: undefined, limit: 2 },
    });
  });

  it("getUnreadCount 会按会话状态选择本地数据源或后端 action", async () => {
    const { client, transportSend } = setupClientWithMocks();
    transportSend
      .mockResolvedValueOnce({ base: { code: 0 }, uid: "100", token: "tok123" })
      .mockResolvedValueOnce({ ok: true, unread_count: 7 });

    await client.login("alice", "password");
    await expect(client.getUnreadCount()).resolves.toBe(7);
    expect(decodedTransportRequests(transportSend).at(-1)).toMatchObject({
      action: "getUnreadCount",
    });

    await client.startSession({ storage: "instant" });
    const getUnreadCountSpy = InstantDataGateway.prototype
      .get_unread_count as unknown as ReturnType<typeof vi.fn>;
    getUnreadCountSpy.mockResolvedValueOnce(3);

    await expect(client.getUnreadCount()).resolves.toBe(3);
    expect(getUnreadCountSpy).toHaveBeenCalledOnce();
  });

  it("favoriteGroup 和 unfavoriteGroup 通过独立 action 管理群收藏", async () => {
    const { client, transportSend, transportSendBinary } =
      setupClientWithMocks();
    transportSendBinary.mockResolvedValueOnce({
      base: { code: 0 },
      uid: "100",
      token: "tok123",
    });
    transportSend
      .mockResolvedValueOnce({ ok: true, seq: 1 })
      .mockResolvedValueOnce({ ok: true, seq: 2 });

    await client.login("alice", "password");
    await expect(
      client.favoriteGroup("500", "群备注"),
    ).resolves.toBeUndefined();
    await expect(client.unfavoriteGroup("500")).resolves.toBeUndefined();

    const requests = decodedTransportRequests(transportSend).filter(
      (request) => request.action !== "login",
    );
    expect(requests[0]).toMatchObject({
      action: "favoriteGroup",
      group_id: "500",
      remark_name: "群备注",
    });
    expect(requests[1]).toMatchObject({
      action: "unfavoriteGroup",
      group_id: "500",
    });
  });

  it("muteConversation 和 unmuteConversation 通过独立 action 管理免打扰", async () => {
    const { client, transportSendBinary, transportSend } =
      setupClientWithMocks();
    transportSendBinary.mockResolvedValueOnce({
      base: { code: 0 },
      uid: "100",
      token: "tok123",
    });
    transportSend
      .mockResolvedValueOnce({ ok: true, seq: 8 })
      .mockResolvedValueOnce({ ok: true, seq: 9 });

    await client.login("alice", "password");
    await expect(client.muteConversation({ toUid: "200" })).resolves.toBe(8);
    await expect(client.unmuteConversation({ toUid: "200" })).resolves.toBe(9);

    const requests = decodedTransportRequests(transportSend).filter(
      (request) => request.action !== "login",
    );
    expect(requests[0]).toMatchObject({
      action: "muteConversation",
      to_uid: "200",
    });
    expect(requests[1]).toMatchObject({
      action: "unmuteConversation",
      to_uid: "200",
    });
  });

  it("getClientConfig 无选项时返回默认值", () => {
    const client = new YimsgClient();
    expect(client.getClientConfig().recallWindowsSeconds).toBeGreaterThan(0);
  });

  it("exposes session lifecycle snapshot", async () => {
    const { client } = setupClientWithMocks();

    expect(client.getSessionSnapshot()).toMatchObject({
      sessionState: "idle",
      connectionState: "connected",
      isAuthenticated: false,
      isSessionInitialized: false,
    });

    await client.authenticate("tok123");

    expect(client.getSessionSnapshot()).toMatchObject({
      sessionState: "authenticated",
      connectionState: "connected",
      isAuthenticated: true,
      isSessionInitialized: false,
    });

    await client.startSession({ storage: "instant" });

    expect(client.getSessionSnapshot()).toMatchObject({
      sessionState: "ready",
      isAuthenticated: true,
      isSessionInitialized: true,
    });

    await client.logout();

    expect(client.getSessionSnapshot()).toMatchObject({
      sessionState: "idle",
      connectionState: "disconnected",
      isAuthenticated: false,
      isSessionInitialized: false,
    });
  });

  it("requires authentication before startSession", async () => {
    const client = new YimsgClient();

    await expect(
      client.startSession({ storage: "instant" }),
    ).rejects.toBeInstanceOf(PreconditionError);
    await expect(
      client.startSession({ storage: "instant" }),
    ).rejects.toMatchObject({
      kind: "precondition",
      code: "AUTH_REQUIRED",
      message: "startSession 需要先完成登录或 token 认证",
    });
  });

  it("clears the previous datagateway before reinitializing a session", async () => {
    const clearSpy = vi.spyOn(InstantDataGateway.prototype, "clear");
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");

    await client.startSession({ storage: "instant" });
    await client.startSession({ storage: "instant" });

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  // ---- P0: destroy() cleans up all callback references ----

  it("destroy() clears transport and cache callbacks", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    await client.startSession({ storage: "instant" });

    const transport = (
      client as unknown as {
        _transport: {
          onConnected: unknown;
          onDisconnected: unknown;
          onNotification: unknown;
          onReconnecting: unknown;
        };
      }
    )._transport;
    const cache = (
      client as unknown as { _displayInfoCache: { onDisplayUpdated: unknown } }
    )._displayInfoCache;

    // Before destroy, callbacks are wired
    expect(transport.onConnected).not.toBeNull();
    expect(transport.onDisconnected).not.toBeNull();
    expect(transport.onNotification).not.toBeNull();
    expect(transport.onReconnecting).not.toBeNull();
    expect(cache.onDisplayUpdated).not.toBeNull();

    client.destroy();

    // After destroy, all callbacks should be null
    expect(transport.onConnected).toBeNull();
    expect(transport.onDisconnected).toBeNull();
    expect(transport.onNotification).toBeNull();
    expect(transport.onReconnecting).toBeNull();
    expect(cache.onDisplayUpdated).toBeNull();
  });

  it("destroy() clears dataGateway and store", async () => {
    const clearSpy = vi.spyOn(InstantDataGateway.prototype, "clear");
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    await client.startSession({ storage: "instant" });

    client.destroy();

    expect(clearSpy).toHaveBeenCalled();
    expect(client.getSessionSnapshot().currentUid).toBe("");
  });

  // ---- P0: startSession concurrency protection ----

  it("concurrent startSession: second call cancels first", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");

    // Make first init slow so the second startSession can overtake it.
    let resolveFirstInit!: () => void;
    const initMock = InstantDataGateway.prototype.init as unknown as ReturnType<
      typeof vi.fn
    >;
    initMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstInit = () =>
              resolve({ lastMsgSeq: 0, lastContactSeq: 0 });
          }),
      )
      .mockResolvedValue({ lastMsgSeq: 0, lastContactSeq: 0 });

    // Start first startSession (will hang on data gateway init)
    const p1 = client.startSession({ storage: "instant" });

    // Start second startSession immediately
    const p2 = client.startSession({ storage: "instant" });

    await Promise.resolve();

    // Resolve the first session after the second one has already started.
    resolveFirstInit();
    await p1;
    await p2;

    // The second session should be the active one
    expect(client.getSessionSnapshot().mode).toBe("instant");
    // The conversations_updated event should have been emitted
    // (no crash from first session trying to use cleared dataGateway)
  });

  // ---- reconnecting event ----

  it("emits reconnecting event", () => {
    const client = new YimsgClient();
    const handler = vi.fn();
    client.on("connection:reconnecting", handler);

    // Trigger via transport callback
    const transport = (
      client as unknown as {
        _transport: { onReconnecting: (() => void) | null };
      }
    )._transport;
    transport.onReconnecting?.();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      snapshot: expect.objectContaining({ connectionState: "reconnecting" }),
    });
    client.destroy();
  });

  it("emits error event from internal components", () => {
    const client = new YimsgClient();
    const handler = vi.fn();
    client.on("error", handler);

    const cache = (
      client as unknown as {
        _displayInfoCache: {
          onError: ((error: Error, context: string) => void) | null;
        };
      }
    )._displayInfoCache;
    cache.onError?.(new Error("boom"), "unit-test");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(isYimsgError(handler.mock.calls[0][0].error)).toBe(true);
    expect(handler.mock.calls[0][0].context).toBe("unit-test");
    client.destroy();
  });

  it("getUserInfos returns a readonly map view", async () => {
    const { client } = setupClientWithMocks();
    const cache = (
      client as unknown as {
        _displayInfoCache: {
          setUserInfos: (
            entries: Array<{ uid: string; nickname: string; avatar: string }>,
          ) => void;
        };
      }
    )._displayInfoCache;
    cache.setUserInfos([{ uid: "100", nickname: "Alice", avatar: "/a.png" }]);

    const infos = client.getUserInfos(["100"]);

    expect(Object.isFrozen(infos)).toBe(true);
    expect("set" in infos).toBe(false);
    expect(infos.get("100")?.nickname).toBe("Alice");
  });

  it("getUserInfos 去重后未超过上限时返回去重后的只读视图", () => {
    const client = new YimsgClient({ batchMaxLimit: 2 });

    const infos = client.getUserInfos(["100", "100", "200"]);

    expect([...infos.keys()]).toEqual(["100", "200"]);
    client.destroy();
  });

  it("getUserInfos 去重后超过上限时抛 INVALID_ARGUMENT", () => {
    const client = new YimsgClient({ batchMaxLimit: 2 });

    expect(() => client.getUserInfos(["100", "100", "200", "300"])).toThrow(
      ValidationError,
    );
    try {
      client.getUserInfos(["100", "100", "200", "300"]);
    } catch (error) {
      expect(isYimsgError(error)).toBe(true);
      expect((error as ValidationError).code).toBe("INVALID_ARGUMENT");
      expect((error as ValidationError).context).toBe("getUserInfos");
    }
    client.destroy();
  });

  it("getGroupInfos 去重后未超过上限时返回去重后的只读视图", () => {
    const client = new YimsgClient({ batchMaxLimit: 2 });

    const infos = client.getGroupInfos(["g1", "g1", "g2"]);

    expect([...infos.keys()]).toEqual(["g1", "g2"]);
    client.destroy();
  });

  it("getGroupInfos 去重后超过上限时抛 INVALID_ARGUMENT", () => {
    const client = new YimsgClient({ batchMaxLimit: 2 });

    expect(() => client.getGroupInfos(["g1", "g1", "g2", "g3"])).toThrow(
      ValidationError,
    );
    try {
      client.getGroupInfos(["g1", "g1", "g2", "g3"]);
    } catch (error) {
      expect(isYimsgError(error)).toBe(true);
      expect((error as ValidationError).code).toBe("INVALID_ARGUMENT");
      expect((error as ValidationError).context).toBe("getGroupInfos");
    }
    client.destroy();
  });

  it("preserves ready session state when reconnect auth succeeds", async () => {
    const { client, transportSend, transport } = setupClientWithMocks();
    await client.authenticate("tok123");
    await client.startSession({ storage: "instant" });

    transportSend.mockResolvedValueOnce({ ok: true, uid: "100" });
    transport.onDisconnected?.();
    transport.onConnected?.();
    await client.authenticate("tok123");

    expect(client.getSessionSnapshot()).toMatchObject({
      sessionState: "ready",
      isSessionInitialized: true,
    });
  });

  it("login auto-connects before sending auth request", async () => {
    const client = new YimsgClient();
    const transport = (
      client as unknown as {
        _transport: {
          connect: () => void;
          send: (msg: unknown) => Promise<unknown>;
          onConnected: (() => void) | null;
          readonly connected: boolean;
        };
      }
    )._transport;
    let connected = false;
    vi.spyOn(transport, "connected", "get").mockImplementation(() => connected);
    const connectSpy = vi.spyOn(transport, "connect").mockImplementation(() => {
      queueMicrotask(() => {
        connected = true;
        transport.onConnected?.();
      });
    });
    const sendSpy = vi
      .spyOn(WsTransport.prototype, "sendBinary")
      .mockResolvedValue({
        base: { code: 0 },
        uid: "101",
        token: "tok101",
      } as any);

    const result = await client.login("alice", "pass");

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ uid: "101", token: "tok101" });
    expect(client.getSessionSnapshot().connectionState).toBe("connected");
  });

  it("logout disconnects transport and clears state", async () => {
    const { client, transport, transportSend } = setupClientWithMocks();
    const disconnectSpy = vi
      .spyOn(transport, "disconnect")
      .mockImplementation(() => {});
    transportSend
      .mockResolvedValueOnce({ ok: true, uid: "100" })
      .mockResolvedValueOnce({ ok: true });

    await client.authenticate("tok123");
    await client.logout();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(client.getSessionSnapshot().currentUid).toBe("");
  });

  it("startSession resetLocalData=all removes every persistent session entry", async () => {
    const removed: string[] = [];
    const root = {
      entries: async function* () {
        yield ["yimsg-100.db", {}];
        yield ["yimsg-100.db-journal", {}];
      },
      removeEntry: vi.fn(async (name: string) => {
        removed.push(name);
      }),
    };
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn(async () => root),
      },
    });

    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    const result = await client.startSession({
      storage: "instant",
      resetLocalData: "all",
    });

    expect(root.removeEntry).toHaveBeenCalledTimes(2);
    expect(removed).toEqual(["yimsg-100.db", "yimsg-100.db-journal"]);
    expect(result.resetLocalData).toBe("all");
    expect(result.resetLocalDataError).toBeNull();
  });

  it("startSession starts instant session through the business API", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");

    const result = await client.startSession({ storage: "instant" });

    expect(result).toMatchObject({
      requestedStorage: "instant",
      actualStorage: "instant",
      mode: "instant",
      degraded: false,
      resetLocalData: "none",
      resetLocalDataError: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(client.getSessionSnapshot().mode).toBe("instant");
  });

  it("startSession resetLocalData=false 会规范化为 none", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");

    const result = await client.startSession({
      storage: "instant",
      resetLocalData: false,
    });

    expect(result.resetLocalData).toBe("none");
    expect(result.resetLocalDataError).toBeNull();
  });

  it("startSession 在指定 opfs 且不可用时降级到 instant", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    vi.stubGlobal("navigator", { storage: {} });

    const result = await client.startSession({
      storage: "persistent",
      fileSystem: "opfs",
    });

    expect(result).toMatchObject({
      requestedStorage: "persistent",
      actualStorage: "instant",
      requestedFileSystem: "opfs",
      actualFileSystem: null,
      mode: "instant",
      degraded: true,
      persistentStorageAvailable: false,
    });
    expect(client.getSessionSnapshot().mode).toBe("instant");
  });

  it("startSession 在 Node 环境可使用 local 持久化文件系统", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    const runtime = (
      client as unknown as {
        runtime: { initializeSession: ReturnType<typeof vi.fn> };
      }
    ).runtime;
    runtime.initializeSession = vi.fn().mockResolvedValue(undefined);

    const result = await client.startSession({
      storage: "persistent",
      fileSystem: "local",
    });

    expect(result).toMatchObject({
      requestedStorage: "persistent",
      actualStorage: "persistent",
      requestedFileSystem: "local",
      actualFileSystem: "local",
      mode: "persistent",
      degraded: false,
      persistentStorageAvailable: true,
    });
  });

  it("startSession resetLocalData=current-user 只删除当前用户当前实例的本地库", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");
    const runtime = (
      client as unknown as {
        runtime: { initializeSession: ReturnType<typeof vi.fn> };
      }
    ).runtime;
    runtime.initializeSession = vi.fn().mockResolvedValue(undefined);
    const deleteDbSpy = vi
      .spyOn(LocalSqliteApi.prototype, "deleteDb")
      .mockResolvedValue(undefined);

    const result = await client.startSession({
      storage: "persistent",
      fileSystem: "local",
      resetLocalData: "current-user",
    });

    expect(deleteDbSpy).toHaveBeenCalledWith(buildPersistentDbName("100"));
    expect(result.resetLocalData).toBe("current-user");
    expect(result.resetLocalDataError).toBeNull();
  });

  it("startSession fileSystem 参数非法时抛出校验错误", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");

    await expect(
      client.startSession({
        storage: "persistent",
        fileSystem: "bad" as unknown as "local",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "INVALID_ARGUMENT" });
  });

  it("describes conversations and message content through facade methods", async () => {
    const { client } = setupClientWithMocks();
    await client.authenticate("tok123");

    const directConversation = client.describeConversation({ toUid: "200" });
    expect(directConversation).toEqual({
      key: "u:200",
      kind: "direct",
      id: "200",
      target: { toUid: "200" },
    });
    expect(Object.isFrozen(directConversation)).toBe(true);

    const markdownMessage = {
      seq: 1,
      messageId: "m1",
      senderId: "200",
      recipientId: "100",
      groupId: "0",
      messageType: MSG_TYPE_MARKDOWN,
      body: { markdown: { markdown: "**hello**" } },
      sentAt: 123,
    } as const;

    const descriptor = client.describeMessage(markdownMessage);
    expect(descriptor).toMatchObject({
      text: "**hello**",
      bodyKind: MSG_TYPE_MARKDOWN,
    });
    expect(descriptor.html).toContain("<strong>hello</strong>");
    expect(Object.isFrozen(descriptor)).toBe(true);

    const quoteMessage = {
      seq: 2,
      messageId: "m2",
      senderId: "200",
      recipientId: "100",
      groupId: "0",
      messageType: MSG_TYPE_QUOTE,
      body: { quote: { quote_msg_id: "quoted-1", quote_preview: "hi", text: { text: "re" } } },
      sentAt: 124,
    } as const;
    const quoteDescriptor = client.describeMessage(quoteMessage);
    expect(quoteDescriptor).toMatchObject({
      text: "re",
      bodyKind: MSG_TYPE_QUOTE,
      quote: { messageId: "quoted-1", preview: "hi", text: "re" },
    });

    const messageConversation = client.describeMessageConversation(markdownMessage);
    expect(messageConversation).toEqual({
      key: "u:200",
      kind: "direct",
      id: "200",
      target: { toUid: "200" },
    });
  });

  it("sendQuotedTextMessage builds a QuoteBody through the facade", async () => {
    const { client, transportSend } = setupClientWithMocks();
    await client.authenticate("tok123");

    transportSend.mockResolvedValueOnce({
      ok: true,
      seq: 9,
      msg_id: "quoted-msg",
    });

    const result = await client.sendQuotedTextMessage(
      { toUid: "200" },
      {
        text: "reply",
        quoteMsgId: "1",
        quotePreview: "hello",
      },
    );

    expect(result.message.messageType).toBe(MSG_TYPE_QUOTE);
    const sent = decodedTransportRequests(transportSend).at(-1) as Record<string, unknown>;
    expect(sent).toMatchObject({ action: "sendMessage", msg_type: MSG_TYPE_QUOTE, to_uid: "200" });
    expect((sent.body as { quote?: { quote_msg_id?: string; text?: { text?: string } } }).quote)
      .toMatchObject({ quote_msg_id: "1", text: { text: "reply" } });
  });

  it("forwardMessages builds a ForwardBody of message ids", async () => {
    const { client, transportSend } = setupClientWithMocks();
    await client.authenticate("tok123");

    transportSend.mockResolvedValueOnce({
      ok: true,
      seq: 10,
      msg_id: "forward-msg",
    });

    const sourceMessage = {
      seq: 8,
      messageId: "5",
      senderId: "100",
      recipientId: "200",
      groupId: "0",
      messageType: MSG_TYPE_MARKDOWN,
      body: { markdown: { markdown: "hello" } },
      sentAt: 1000,
    };

    const result = await client.forwardMessages(
      { toUid: "200" },
      [sourceMessage],
      "转发附言",
    );

    expect(result.message.messageType).toBe(MSG_TYPE_FORWARD);
    const sent = decodedTransportRequests(transportSend).at(-1) as Record<string, unknown>;
    expect(sent).toMatchObject({ action: "sendMessage", msg_type: MSG_TYPE_FORWARD, to_uid: "200" });
    expect((sent.body as { forward?: { msg_ids?: string[]; title?: string } }).forward)
      .toMatchObject({ msg_ids: ["5"], title: "转发附言" });
  });


  it("exposes blocklist and conversation mutelist APIs as readonly pages", async () => {
    const { client, transportSend } = setupClientWithMocks();
    await client.authenticate("tok123");

    transportSend
      .mockResolvedValueOnce({
        ok: true,
        total: 1,
        users: [
          { uid: "200", status: 1, seq: 7, created_at: 10, updated_at: 20 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        total: 1,
        mutes: [
          { to_uid: "200", group_id: "0", status: 1, seq: 9, updated_at: 30 },
        ],
      });

    const blocklist = await client.getBlocklist();
    const mutes = await client.getMutelist();

    expect(blocklist.users).toEqual([
      expect.objectContaining({
        uid: "200",
        createdAt: 10,
        updatedAt: 20,
      }),
    ]);
    expect(mutes.mutes).toEqual([
      expect.objectContaining({
        toUid: "200",
        status: 1,
        updatedAt: 30,
      }),
    ]);
    expect(Object.isFrozen(blocklist)).toBe(true);
    expect(Object.isFrozen(blocklist.users)).toBe(true);
    expect(Object.isFrozen(mutes)).toBe(true);
    expect(Object.isFrozen(mutes.mutes)).toBe(true);
  });

  it("recallMessage derives target from the message itself", async () => {
    const { client, transportSend } = setupClientWithMocks();
    await client.authenticate("tok123");

    transportSend.mockResolvedValueOnce({ ok: true, seq: 2, msg_id: "1" });
    await client.recallMessage({
      seq: 1,
      messageId: "1",
      senderId: "100",
      recipientId: "200",
      groupId: "0",
      messageType: MSG_TYPE_TEXT,
      body: { text: { text: "hello" } },
      sentAt: 1000,
    });

    const sent = decodedTransportRequests(transportSend).at(-1) as Record<string, unknown>;
    expect(sent).toMatchObject({
      action: "sendMessage",
      msg_type: MSG_TYPE_RECALL,
      to_uid: "200",
    });
    expect((sent.body as { recall?: { msg_id?: string } }).recall).toMatchObject({ msg_id: "1" });
  });

  it("getMessages 将服务端返回的 recall event 折叠为原消息占位", async () => {
    const { client, transportSend } = setupClientWithMocks();
    await client.authenticate("tok123");
    await client.startSession({ storage: "instant" });

    transportSend.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          uid: 100,
          seq: 2,
          msg_id: "2",
          from_uid: "200",
          to_uid: "100",
          group_id: "0",
          msg_type: MSG_TYPE_RECALL,
          body: {
            recall: {
              msg_id: "1",
              operator_uid: "200",
              recall_time: 2002,
              text: "对方撤回了一条消息",
            },
          },
          send_time: 2002,
        },
        {
          uid: 100,
          seq: 1,
          msg_id: "1",
          from_uid: "200",
          to_uid: "100",
          group_id: "0",
          msg_type: MSG_TYPE_TEXT,
          body: { text: { text: "hello" } },
          send_time: 1001,
        },
      ],
    });

    const result = await client.getMessages({
      target: { toUid: "200" },
      limit: 10,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      seq: 2,
      messageId: "1",
      messageType: MSG_TYPE_RECALL,
    });
    expect(result.messages[0].body.recall?.text).toContain("对方撤回了一条消息");
  });

  // ── estimateMaxMemoryBytes ────────────────────────────────────────────────

  describe("estimateMaxMemoryBytes", () => {
    it("使用默认选项时各分项均为正数且总和正确", () => {
      const est = YimsgClient.estimateMaxMemoryBytes();
      const b = est.breakdown;

      expect(b.profileUserCacheBytes).toBeGreaterThan(0);
      // 用户与群缓存已拆分为两套独立有界集合，群分项不再恒为 0。
      expect(b.profileGroupCacheBytes).toBeGreaterThan(0);
      expect(b.profileQueueBytes).toBeGreaterThan(0);
      expect(b.pendingRequestsBytes).toBeGreaterThan(0);
      expect(b.syncBatchBytes).toBeGreaterThan(0);
      expect(b.forwardBundleBytes).toBeGreaterThan(0);
      expect(b.baselineBytes).toBeGreaterThan(0);

      const sum =
        b.profileUserCacheBytes +
        b.profileGroupCacheBytes +
        b.profileQueueBytes +
        b.pendingRequestsBytes +
        b.syncBatchBytes +
        b.forwardBundleBytes +
        b.baselineBytes;
      expect(est.totalBytes).toBe(sum);
    });

    it("cacheMaxEntries=0 时 displayInfoCache 分项为 0，其余不变", () => {
      const est = YimsgClient.estimateMaxMemoryBytes({ cacheMaxEntries: 0 });
      expect(est.breakdown.profileUserCacheBytes).toBe(0);
      expect(est.breakdown.profileGroupCacheBytes).toBe(0);
      // 固定分项不受影响
      expect(est.breakdown.syncBatchBytes).toBeGreaterThan(0);
      expect(est.breakdown.forwardBundleBytes).toBeGreaterThan(0);
      expect(est.breakdown.baselineBytes).toBeGreaterThan(0);
    });

    it("用户与群缓存分项相等（同一 cacheMaxEntries 下两套独立有界集合容量一致）", () => {
      const est = YimsgClient.estimateMaxMemoryBytes({ cacheMaxEntries: 5000 });
      expect(est.breakdown.profileGroupCacheBytes).toBe(
        est.breakdown.profileUserCacheBytes,
      );
    });

    it("maxPendingRequests=0 时 pendingRequestsBytes 为 0", () => {
      const est = YimsgClient.estimateMaxMemoryBytes({
        maxPendingRequests: 0,
      });
      expect(est.breakdown.pendingRequestsBytes).toBe(0);
    });

    it("profileLoadQueueMaxEntries=0 时 profileQueueBytes 为 0", () => {
      const est = YimsgClient.estimateMaxMemoryBytes({
        profileLoadQueueMaxEntries: 0,
      });
      expect(est.breakdown.profileQueueBytes).toBe(0);
    });

    it("cacheMaxEntries 翻倍时 displayInfoCache 字节数精确翻倍", () => {
      const base = YimsgClient.estimateMaxMemoryBytes({
        cacheMaxEntries: 1000,
      });
      const doubled = YimsgClient.estimateMaxMemoryBytes({
        cacheMaxEntries: 2000,
      });
      expect(doubled.breakdown.profileUserCacheBytes).toBe(
        base.breakdown.profileUserCacheBytes * 2,
      );
      // 群缓存与用户缓存对称，同样精确翻倍。
      expect(doubled.breakdown.profileGroupCacheBytes).toBe(
        base.breakdown.profileGroupCacheBytes * 2,
      );
    });

    it("syncBatchBytes 和 forwardBundleBytes 不受配置影响（常量分项）", () => {
      const a = YimsgClient.estimateMaxMemoryBytes({ cacheMaxEntries: 1 });
      const b = YimsgClient.estimateMaxMemoryBytes({
        cacheMaxEntries: 100000,
      });
      expect(a.breakdown.syncBatchBytes).toBe(b.breakdown.syncBatchBytes);
      expect(a.breakdown.forwardBundleBytes).toBe(
        b.breakdown.forwardBundleBytes,
      );
      expect(a.breakdown.baselineBytes).toBe(b.breakdown.baselineBytes);
    });

    it("返回值和 breakdown 均被冻结", () => {
      const est = YimsgClient.estimateMaxMemoryBytes();
      expect(Object.isFrozen(est)).toBe(true);
      expect(Object.isFrozen(est.breakdown)).toBe(true);
    });

    it("默认配置下 totalBytes 在合理量级（1 MB ~ 50 MB）", () => {
      const est = YimsgClient.estimateMaxMemoryBytes();
      expect(est.totalBytes).toBeGreaterThan(1024 * 1024); // > 1 MB
      expect(est.totalBytes).toBeLessThan(50 * 1024 * 1024); // < 50 MB
    });

    it("不传参与传 {} 结果相同", () => {
      const a = YimsgClient.estimateMaxMemoryBytes();
      const b = YimsgClient.estimateMaxMemoryBytes({});
      expect(a.totalBytes).toBe(b.totalBytes);
    });
  });

  // ── getBoundedCollectionStats ─────────────────────────────────────────────

  describe("getBoundedCollectionStats", () => {
    it("暴露用户/群缓存与待响应请求的有界集合统计且容量为正", () => {
      const client = new YimsgClient({ wsUrl: "ws://localhost:1/ws" });
      const stats = client.getBoundedCollectionStats();

      expect(stats.displayInfoCache.user.cache.capacity).toBeGreaterThan(0);
      expect(stats.displayInfoCache.group.cache.capacity).toBeGreaterThan(0);
      expect(stats.displayInfoCache.user.pending.size).toBe(0);
      expect(stats.pendingRequests.capacity).toBeGreaterThan(0);
      expect(stats.pendingRequests.size).toBe(0);
      // size 永不超过 capacity 的不变式从初始即成立。
      expect(stats.pendingRequests.loadFactor).toBe(0);
      expect(Object.isFrozen(stats)).toBe(true);
    });
  });
});
