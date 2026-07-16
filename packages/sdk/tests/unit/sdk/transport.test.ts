import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsTransport } from '../../../src/transport/connection';
import { ConnectionError } from '../../../src/errors';
import {
  actionType,
  decodeActionResponse,
  encodeNotificationFrame,
  encodeResponseFrame,
} from './protocol-test-helpers';
import {
  decodeFrame,
  encodeFrame,
  encodeFrameWithEndian,
  websocketDataToBytes,
} from '../../../src/transport/frame';
import { PingRequest, PingResponse, Type } from '@yimsg/protocol';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = 'arraybuffer';
  sent: unknown[] = [];

  constructor(public url: string) {
    // Auto-open after microtask
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: unknown) { this.sent.push(data); }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }
}

// Inject OPEN/CONNECTING statics for readyState checks
Object.assign(globalThis, {
  WebSocket: Object.assign(MockWebSocket, {
    CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
  }),
});

function checksumForTest(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.byteLength; i++) {
    let value = i === 3 ? 0 : data[i];
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

describe('WsTransport', () => {
  let transport: WsTransport;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 1000,
      reconnectInterval: 500,
      heartbeatInterval: 0, // disable heartbeat in tests by default
      wsFactory: (url) => {
        mockWs = new MockWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });
  });

  afterEach(() => {
    transport.disconnect();
    vi.useRealTimers();
  });

  async function sentFrame(index = 0) {
    return decodeFrame(await websocketDataToBytes(mockWs.sent[index]));
  }

  async function receiveResponse(index: number, payload: Record<string, unknown>) {
    const frame = await sentFrame(index);
    mockWs.onmessage!({ data: encodeResponseFrame(frame.codec, frame.typeId, frame.requestId, payload) });
    await vi.advanceTimersByTimeAsync(0);
  }

  function sendPing() {
    const req = PingRequest.create({});
    return transport.sendBinary(Type.TYPE_ACTION_PING, PingRequest.encode(req).finish(), PingResponse);
  }

  it('connect sets connected to true', async () => {
    const onConnected = vi.fn();
    transport.onConnected = onConnected;
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connected).toBe(true);
    expect(onConnected).toHaveBeenCalled();
  });

  it('send resolves on success response', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    const promise = sendPing();
    await receiveResponse(0, { base: { code: 0, msg: '' } });

    const resp = await promise;
    expect(resp.base?.code).toBe(0);
  });

  it('restores proto3 default IDs in decoded message responses', () => {
    const body = encodeResponseFrame('b', actionType('syncMessages'), '1', {
      base: { code: 0, msg: '' },
      messages: [{ seq: 1, msg_id: '1', from_uid: '200', target: { group_id: '500' }, msg_type: 0, content: 'hi', send_time: 1000 }],
    });
    const payload = decodeActionResponse(decodeFrame(body));
    const message = (payload.messages as Array<Record<string, unknown>>)[0];

    expect(message.target).toMatchObject({ group_id: '500' });
    expect(message.status).toBe(0);
  });

  it('send rejects on error response', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    const promise = sendPing().catch((e: Error) => e);
    await receiveResponse(0, { base: { code: 1301, msg: 'bad request' } });

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('bad request');
    expect(err).toMatchObject({
      details: expect.objectContaining({ serverErrorCode: 'INVALID_ARGUMENT' }),
    });
  });

  it('send rejects on timeout', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    const promise = sendPing();
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow('request timeout');
  });

  it('send rejects when not connected', async () => {
    await expect(sendPing()).rejects.toThrow('not connected');
  });

  it('notification callback', async () => {
    const onNotification = vi.fn();
    transport.onNotification = onNotification;
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    const frameBytes = encodeNotificationFrame('b', { type: 'messages:received' });
    expect(decodeFrame(frameBytes).typeId).toBe(Type.TYPE_NOTIFY_MESSAGES_RECEIVED);
    mockWs.onmessage!({ data: frameBytes });
    await vi.advanceTimersByTimeAsync(0);
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'messages:received' }));
  });

  it('malformed incoming frame is dropped with a console warning, connection stays usable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    mockWs.onmessage!({ data: new Uint8Array([1, 2, 3]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[WsTransport]'));

    const promise = sendPing();
    await receiveResponse(0, { base: { code: 0, msg: '' } });
    await expect(promise).resolves.toMatchObject({ base: { code: 0 } });

    warnSpy.mockRestore();
  });

  it('socket error event logs via console.error without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(() => mockWs.onerror!()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[WsTransport]'));

    errorSpy.mockRestore();
  });

  it('frame body limit keeps whole packet under 64K', () => {
    expect(() => encodeFrame('b', '1', 6, new Uint8Array(0xffff - 16))).not.toThrow();
    expect(() => encodeFrame('b', '1', 6, new Uint8Array(0xffff - 15))).toThrow('frame packet too large');
  });

  it('frame rejects interface id 0', () => {
    expect(() => encodeFrame('b', '1', 0, new Uint8Array())).toThrow('invalid frame interface id');
  });

  it('frame validates magic, reserved byte, codec bits and checksum', () => {
    const frame = encodeFrame('b', '1', 6, new Uint8Array([1, 2, 3]));
    expect(frame.byteLength).toBe(19);
    expect(frame[0]).toBe('M'.charCodeAt(0));
    expect(frame[1]).toBe(0x02);
    expect(frame[2]).toBe(0);
    expect(frame[3]).not.toBe(0);
    expect(decodeFrame(frame)).toMatchObject({ codec: 'b', littleEndian: false, requestId: '1', typeId: 6 });

    const littleEndian = encodeFrameWithEndian('b', true, '7', 6, new Uint8Array([4, 5, 6]));
    expect(littleEndian[1]).toBe(0x03);
    expect(decodeFrame(littleEndian)).toMatchObject({ codec: 'b', littleEndian: true, requestId: '7', typeId: 6 });

    const badMagic = new Uint8Array(frame);
    badMagic[0] = 0;
    expect(() => decodeFrame(badMagic)).toThrow('invalid frame magic');

    const badReservedByte = new Uint8Array(frame);
    badReservedByte[2] = 2;
    expect(() => decodeFrame(badReservedByte)).toThrow('invalid frame reserved byte');

    const badCodecVersion = new Uint8Array(frame);
    badCodecVersion[1] = 0x04;
    badCodecVersion[3] = 0;
    badCodecVersion[3] = checksumForTest(badCodecVersion);
    expect(() => decodeFrame(badCodecVersion)).toThrow('unsupported frame codec version');

    const badCodecReservedBits = new Uint8Array(frame);
    badCodecReservedBits[1] = 0x22;
    badCodecReservedBits[3] = 0;
    badCodecReservedBits[3] = checksumForTest(badCodecReservedBits);
    expect(() => decodeFrame(badCodecReservedBits)).toThrow('invalid frame codec reserved bits');

    const badChecksum = new Uint8Array(frame);
    badChecksum[badChecksum.byteLength - 1] ^= 0xff;
    expect(() => decodeFrame(badChecksum)).toThrow('invalid frame checksum');
  });

  it('disconnect rejects pending requests', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    const promise = sendPing().catch((e: Error) => e);
    transport.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('disconnected');
    expect(transport.connected).toBe(false);
  });

  it('auto-reconnects after close', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connected).toBe(true);

    // Simulate close
    mockWs.onclose!();
    expect(transport.connected).toBe(false);

    // Advance past reconnect interval
    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connected).toBe(true);
  });

  // ---- New: disconnect prevents auto-reconnect ----

  it('disconnect prevents auto-reconnect', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connected).toBe(true);

    transport.disconnect();

    // Advance past reconnect interval — should NOT reconnect
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connected).toBe(false);
  });

  // ---- New: connect() cleans up old socket event handlers ----

  it('connect() cleans up old socket handlers to prevent ghost callbacks', async () => {
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);
    const oldWs = mockWs;

    // Reconnect — old socket should be detached
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    // Old socket's event handlers should be nullified
    expect(oldWs.onopen).toBeNull();
    expect(oldWs.onmessage).toBeNull();
    expect(oldWs.onclose).toBeNull();
    expect(oldWs.onerror).toBeNull();
  });

  // ---- New: reconnecting callback ----

  it('calls onReconnecting once the notify threshold is reached', async () => {
    const thresholdTransport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 1000,
      reconnectInterval: 500,
      heartbeatInterval: 0,
      reconnectNotifyThreshold: 1,
      wsFactory: (url) => {
        mockWs = new MockWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });
    const onReconnecting = vi.fn();
    thresholdTransport.onReconnecting = onReconnecting;
    thresholdTransport.connect();
    await vi.advanceTimersByTimeAsync(0);

    // Simulate server-side close
    mockWs.onclose!();

    expect(onReconnecting).toHaveBeenCalledTimes(1);
    thresholdTransport.disconnect();
  });

  // ManualSocket never auto-opens — the test drives onopen/onclose explicitly,
  // so consecutive failed reconnect attempts can be simulated deterministically
  // (MockWebSocket's queued auto-open would otherwise race with manual onclose calls).
  class ManualSocket {
    readyState = 1; // mimic WS_OPEN so WsTransport.connect() doesn't treat it as still connecting
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    binaryType = 'arraybuffer';
    send() {}
    close() {}
  }

  it('does not call onReconnecting before consecutive failures reach the default threshold (3)', () => {
    const sockets: ManualSocket[] = [];
    const manualTransport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 1000,
      reconnectInterval: 500,
      heartbeatInterval: 0,
      wsFactory: () => {
        const sock = new ManualSocket();
        sockets.push(sock);
        return sock as unknown as WebSocket;
      },
    });
    const onReconnecting = vi.fn();
    manualTransport.onReconnecting = onReconnecting;
    manualTransport.connect();
    sockets[0].onopen!();
    expect(manualTransport.connected).toBe(true);

    // 1st and 2nd failed attempts: still below default threshold, should stay silent
    sockets[0].onclose!();
    expect(onReconnecting).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);

    sockets[1].onclose!();
    expect(onReconnecting).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);

    // 3rd consecutive failed attempt: threshold reached, now notify
    sockets[2].onclose!();
    expect(onReconnecting).toHaveBeenCalledTimes(1);

    manualTransport.disconnect();
  });

  it('resets the reconnect attempt count after a successful reconnect', () => {
    const sockets: ManualSocket[] = [];
    const manualTransport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 1000,
      reconnectInterval: 500,
      heartbeatInterval: 0,
      wsFactory: () => {
        const sock = new ManualSocket();
        sockets.push(sock);
        return sock as unknown as WebSocket;
      },
    });
    const onReconnecting = vi.fn();
    manualTransport.onReconnecting = onReconnecting;
    manualTransport.connect();
    sockets[0].onopen!();

    // 2 failed attempts (below threshold), then a successful reconnect resets the counter
    sockets[0].onclose!();
    vi.advanceTimersByTime(500);
    sockets[1].onclose!();
    vi.advanceTimersByTime(500);
    sockets[2].onopen!();
    expect(manualTransport.connected).toBe(true);
    expect(onReconnecting).not.toHaveBeenCalled();

    // 2 more consecutive failures afterwards should still not reach the threshold
    sockets[2].onclose!();
    vi.advanceTimersByTime(500);
    sockets[3].onclose!();
    expect(onReconnecting).not.toHaveBeenCalled();

    manualTransport.disconnect();
  });

  // ---- New: heartbeat ----

  it('sends heartbeat ping at configured interval', async () => {
    const hbTransport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 1000,
      reconnectInterval: 500,
      heartbeatInterval: 5000,
      wsFactory: (url) => {
        mockWs = new MockWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    hbTransport.connect();
    await vi.advanceTimersByTimeAsync(0);

    // After 5 seconds, a ping should be sent
    vi.advanceTimersByTime(5000);
    expect(mockWs.sent.length).toBe(1);
    const sent = await sentFrame(0);
    expect(sent.typeId).toBe(actionType('ping'));

    // After another 5 seconds, another ping
    vi.advanceTimersByTime(5000);
    expect(mockWs.sent.length).toBe(2);

    hbTransport.disconnect();
  });

  it('stops heartbeat on disconnect', async () => {
    const hbTransport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 1000,
      reconnectInterval: 500,
      heartbeatInterval: 5000,
      wsFactory: (url) => {
        mockWs = new MockWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    hbTransport.connect();
    await vi.advanceTimersByTimeAsync(0);

    hbTransport.disconnect();

    // After 10 seconds, no ping should be sent
    vi.advanceTimersByTime(10000);
    expect(mockWs.sent.length).toBe(0);
  });

  it('超出 maxPendingRequests 时 send 拒绝', async () => {
    const limitedTransport = new WsTransport({
      url: 'ws://test/ws',
      timeout: 5000,
      reconnectInterval: 500,
      heartbeatInterval: 0,
      maxPendingRequests: 2,
      wsFactory: (url) => {
        mockWs = new MockWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    limitedTransport.connect();
    await vi.advanceTimersByTimeAsync(0);

    // 先占用 2 个请求槽（不 await，保持 pending）
    const req = PingRequest.create({});
    const body = PingRequest.encode(req).finish();
    const p1 = limitedTransport.sendBinary(Type.TYPE_ACTION_PING, body, PingResponse).catch(() => {});
    const p2 = limitedTransport.sendBinary(Type.TYPE_ACTION_PING, body, PingResponse).catch(() => {});

    // 第三个应被立即拒绝（验证 ConnectionError 类型和错误信息）
    await expect(limitedTransport.sendBinary(Type.TYPE_ACTION_PING, body, PingResponse)).rejects.toThrow('请求队列已满');
    await expect(limitedTransport.sendBinary(Type.TYPE_ACTION_PING, body, PingResponse)).rejects.toBeInstanceOf(ConnectionError);

    limitedTransport.disconnect();
    await Promise.allSettled([p1, p2]);
  });
});
