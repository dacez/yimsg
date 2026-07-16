import type { WsResponse, Notification } from '../models';
import { ConnectionError, RequestError } from '../errors';
import { type MessageCodec } from '../internal/codec';
import {
  dispatchNotificationFrame,
  type NotificationHandler,
} from '../generated/notifications.gen';
import type { ConversationTarget } from '@yimsg/protocol';
import {
  PingRequest,
  PingResponse,
  Type,
  ErrorCode,
} from '@yimsg/protocol';
import {
  decodeFrame,
  encodeFrame,
  websocketDataToBytes,
} from './frame';
import {
  DEFAULT_WS_TIMEOUT_MS,
  DEFAULT_WS_RECONNECT_INTERVAL_MS,
  DEFAULT_WS_RECONNECT_NOTIFY_THRESHOLD,
  DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WS_MAX_PENDING_REQUESTS,
  PENDING_REQUEST_BUCKET_CAPACITY,
  PENDING_REQUEST_LOAD_FACTOR,
} from '../internal/sdk-defaults';
import { BoundedU64Map, type BoundedStats } from '../internal/bounded';

const WS_CONNECTING = 0;
const WS_OPEN = 1;

// legacyNotification 把强类型通知压平为 SDK 既有消费的扁平 Notification 记录。
function legacyNotification(type: string, target?: ConversationTarget, msgId?: string): Record<string, unknown> {
  const rec: Record<string, unknown> = { type };
  if (target) {
    rec.target = target;
    if (target.uid) rec.from_uid = String(target.uid);
    if (target.group_id) rec.group_id = String(target.group_id);
  }
  if (msgId) rec.msg_id = String(msgId);
  return rec;
}

/** ClientTransport 是模块函数依赖的最小传输接口，只暴露 sendBinary。 */
export interface ClientTransport {
  sendBinary<T>(typeId: number, body: Uint8Array, responseCodec: MessageCodec<T>): Promise<T>;
}

type PendingReq = {
  resolve: (v: WsResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  responseCodec?: MessageCodec;
};

function serverErrorCodeName(code: number): string | number {
  switch (code) {
    case ErrorCode.ERROR_INVALID_FRAME: return 'INVALID_FRAME';
    case ErrorCode.ERROR_FRAME_TOO_LARGE: return 'FRAME_TOO_LARGE';
    case ErrorCode.ERROR_INVALID_PROTOBUF: return 'INVALID_PROTOBUF';
    case ErrorCode.ERROR_AUTH_REQUIRED: return 'AUTH_REQUIRED';
    case ErrorCode.ERROR_AUTH_FAILED: return 'AUTH_FAILED';
    case ErrorCode.ERROR_UNKNOWN_ACTION: return 'UNKNOWN_ACTION';
    case ErrorCode.ERROR_INVALID_ARGUMENT: return 'INVALID_ARGUMENT';
    case ErrorCode.ERROR_NOT_FOUND: return 'NOT_FOUND';
    case ErrorCode.ERROR_ALREADY_EXISTS: return 'ALREADY_EXISTS';
    case ErrorCode.ERROR_CONFLICT: return 'CONFLICT';
    case ErrorCode.ERROR_FORBIDDEN: return 'FORBIDDEN';
    case ErrorCode.ERROR_SEQ_TOO_OLD: return 'SEQ_TOO_OLD';
    case ErrorCode.ERROR_BATCH_LIMIT_EXCEEDED: return 'BATCH_LIMIT_EXCEEDED';
    case ErrorCode.ERROR_INTERNAL_ERROR: return 'INTERNAL_ERROR';
    default: return code;
  }
}

interface WsTransportOptions {
  url: string;
  timeout?: number;
  reconnectInterval?: number;
  heartbeatInterval?: number;
  wsFactory?: (url: string) => WebSocket;
  /** 最大并发未响应请求数。超出后 send() 立即以 CONNECTION_FAILED 拒绝。默认 100。 */
  maxPendingRequests?: number;
  /** 连续重连尝试达到该次数后才触发 onReconnecting。默认 3。 */
  reconnectNotifyThreshold?: number;
}

/**
 * WsTransport — manages WebSocket connection, request-response pairing,
 * and auto-reconnect. No DOM dependency except WebSocket constructor.
 */
export class WsTransport implements ClientTransport {
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reqIdCounter = 0;
  private readonly pendingRequests: BoundedU64Map<PendingReq>;
  private intentionalClose = false;
  /** 连续重连尝试计数；成功建连后清零。 */
  private reconnectAttempts = 0;

  private readonly url: string;
  private readonly timeout: number;
  private readonly reconnectInterval: number;
  private readonly heartbeatInterval: number;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly maxPendingRequests: number;
  private readonly reconnectNotifyThreshold: number;

  onNotification: ((n: Notification) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onReconnecting: (() => void) | null = null;
  /** 通知解码或 handler 处理失败时上报，不静默吞掉。 */
  onNotificationError: ((err: Error, typeId: number) => void) | null = null;

  // 默认 handler 把生成的强类型通知适配为 onNotification 消费的扁平 Notification，
  // 保持 SDK 既有消费路径不变；调用方可通过 setNotificationHandler 覆盖。
  private readonly defaultNotificationHandler: NotificationHandler = {
    onMessagesReceived: (n) => this.emitNotification(legacyNotification('messages:received', n.target, n.msg_id)),
    onContactsUpdated: () => this.emitNotification(legacyNotification('contacts:updated')),
    onSessionKicked: () => this.emitNotification(legacyNotification('session:kicked')),
    onConversationsClearunread: (n) => this.emitNotification(legacyNotification('conversations:clearunread', n.target)),
    onConversationsDelete: (n) => this.emitNotification(legacyNotification('conversations:delete', n.target)),
    onMessagesDelete: (n) => this.emitNotification(legacyNotification('messages:delete', n.target, n.msg_id)),
    onBlocklistUpdated: () => this.emitNotification(legacyNotification('blocklist:updated')),
    onMutelistUpdated: () => this.emitNotification(legacyNotification('mutelist:updated')),
    onOrgUpdated: (n) => this.emitNotification({ type: 'org:updated', org_id: String(n.org_id || '0') }),
  };
  private notificationHandler: NotificationHandler = this.defaultNotificationHandler;

  /** 设置自定义通知 handler；传 null 恢复默认适配器。 */
  setNotificationHandler(handler: NotificationHandler | null): void {
    this.notificationHandler = handler ?? this.defaultNotificationHandler;
  }

  private emitNotification(n: Record<string, unknown>): void {
    this.onNotification?.(n as unknown as Notification);
  }

  constructor(options: WsTransportOptions) {
    this.url = options.url;
    this.timeout = options.timeout ?? DEFAULT_WS_TIMEOUT_MS;
    this.reconnectInterval = options.reconnectInterval ?? DEFAULT_WS_RECONNECT_INTERVAL_MS;
    this.heartbeatInterval = options.heartbeatInterval ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS;
    this.wsFactory = options.wsFactory ?? ((u: string) => new WebSocket(u));
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_WS_MAX_PENDING_REQUESTS;
    this.reconnectNotifyThreshold = options.reconnectNotifyThreshold ?? DEFAULT_WS_RECONNECT_NOTIFY_THRESHOLD;
    // 待响应请求采用固定容量有界 map：reject 策略 + headroom，size 永不超过 maxPendingRequests。
    this.pendingRequests = new BoundedU64Map<PendingReq>({
      capacity: this.maxPendingRequests,
      bucketCapacity: PENDING_REQUEST_BUCKET_CAPACITY,
      eviction: 'reject',
      loadFactor: PENDING_REQUEST_LOAD_FACTOR,
    });
  }

  /** 待响应请求有界 map 的运行时统计，用于内存诊断。 */
  pendingRequestsStats(): BoundedStats {
    return this.pendingRequests.stats();
  }

  get connected(): boolean {
    return this.wsConnected;
  }

  connect(): void {
    if (this.ws && this.ws.readyState === WS_CONNECTING) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try { old.close(); } catch (_) {}
    }

    this.intentionalClose = false;
    const socket = this.wsFactory(this.url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.wsConnected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.onConnected?.();
    };

    socket.onmessage = (e) => {
      if (this.ws !== socket) return;
      void this.handleMessage(socket, e.data);
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.wsConnected = false;
      this.stopHeartbeat();
      this.onDisconnected?.();
      this.pendingRequests.forEach((p) => {
        clearTimeout(p.timer);
        p.reject(new ConnectionError('CONNECTION_FAILED', 'connection closed'));
      });
      this.pendingRequests.clear();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {};
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try { old.close(); } catch (_) {}
    }
    this.wsConnected = false;
    this.pendingRequests.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new ConnectionError('CONNECTION_FAILED', 'disconnected'));
    });
    this.pendingRequests.clear();
  }

  /** sendBinary 直接发送 proto 编码的二进制请求。 */
  sendBinary<T>(typeId: number, body: Uint8Array, responseCodec: MessageCodec<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) {
        reject(new ConnectionError('CONNECTION_FAILED', 'not connected'));
        return;
      }
      if (this.pendingRequests.size >= this.maxPendingRequests) {
        reject(new ConnectionError('CONNECTION_FAILED', `请求队列已满（最多 ${this.maxPendingRequests} 个并发请求）`));
        return;
      }
      const requestId = String(++this.reqIdCounter);
      let frame: Uint8Array;
      try {
        frame = encodeFrame('b', requestId, typeId, body);
      } catch (err) {
        reject(new ConnectionError('CONNECTION_FAILED', err instanceof Error ? err.message : String(err)));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new ConnectionError('CONNECTION_TIMEOUT', 'request timeout', { details: { requestId } }));
      }, this.timeout);
      this.pendingRequests.set(requestId, { resolve: resolve as (v: WsResponse) => void, reject, timer, responseCodec });
      const data = new ArrayBuffer(frame.byteLength);
      new Uint8Array(data).set(frame);
      this.ws.send(data);
    });
  }

  private async handleMessage(socket: WebSocket, raw: unknown): Promise<void> {
    if (this.ws !== socket) return;
    let frame;
    try {
      frame = decodeFrame(await websocketDataToBytes(raw));
    } catch (_) {
      return;
    }

    try {
      if (frame.requestId === '0') {
        const result = await dispatchNotificationFrame(this.notificationHandler, frame);
        if (!result.ok) {
          this.onNotificationError?.(result.error, result.typeId);
        }
        return;
      }

      const reqId = frame.requestId;
      if (!reqId || !this.pendingRequests.has(reqId)) return;
      const p = this.pendingRequests.get(reqId)!;
      this.pendingRequests.delete(reqId);
      clearTimeout(p.timer);

      // 所有请求均走 sendBinary 路径，直接用 responseCodec 解码 proto
      try {
        const decoded = p.responseCodec!.decode(frame.body) as Record<string, unknown>;
        const base = (decoded.base && typeof decoded.base === 'object') ? decoded.base as Record<string, unknown> : {};
        const code = typeof base.code === 'number' ? base.code : 0;
        if (code === 0) {
          p.resolve(decoded as unknown as WsResponse);
        } else {
          const msg = typeof base.msg === 'string' ? base.msg : 'server error';
          p.reject(new RequestError('REQUEST_FAILED', msg, {
            details: { requestId: reqId, serverErrorCode: serverErrorCodeName(code) },
          }));
        }
        return;
    } catch (err) {
        p.reject(new RequestError('REQUEST_FAILED', err instanceof Error ? err.message : String(err), {
          details: { requestId: reqId },
        }));
        return;
      }
    } catch (err) {
      const reqId = frame.requestId;
      const p = this.pendingRequests.get(reqId);
      if (!p) return;
      this.pendingRequests.delete(reqId);
      clearTimeout(p.timer);
      p.reject(new RequestError('REQUEST_FAILED', err instanceof Error ? err.message : String(err), {
        details: { requestId: reqId },
      }));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatInterval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        const req = PingRequest.create({});
        this.sendBinary(Type.TYPE_ACTION_PING, PingRequest.encode(req).finish(), PingResponse).catch(() => {});
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts >= this.reconnectNotifyThreshold) {
      this.onReconnecting?.();
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }
}
