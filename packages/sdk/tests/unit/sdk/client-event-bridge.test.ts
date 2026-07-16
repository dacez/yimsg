import { describe, expect, it, vi } from 'vitest';
import { ClientEventBridge } from '../../../src/internal/client-event-bridge';
import type { ClientEvents, SessionSnapshot } from '../../../src/models';
import type { Message } from '../../../src/models';
import { MSG_TYPE_RECALL } from '../../../src/constants';

function makeSnapshot(): SessionSnapshot {
  return {
    sessionState: 'ready',
    connectionState: 'connected',
    mode: 'instant',
    currentUid: '100',
    isAuthenticated: true,
    isSessionInitialized: true,
    syncReadiness: { domains: {}, firstSyncComplete: true },
  };
}

function makeMessage(overrides: Partial<Message> & { seq: number }): Message {
  return {
    uid: 0,
    seq: overrides.seq,
    msg_id: `msg-${overrides.seq}`,
    from_uid: '200',
    to_uid: '100',
    group_id: '0',
    msg_type: 1,
    body: { text: { text: `content-${overrides.seq}` } },
    send_time: 1000 + overrides.seq,
    ...overrides,
  };
}

describe('ClientEventBridge', () => {
  it('在 messages:received 批次到达时只发消息事件，不本地存未读', () => {
    const emitClientEvent = vi.fn<
      <K extends keyof ClientEvents>(event: K, payload: Parameters<ClientEvents[K]>[0]) => void
    >();
    const bridge = new ClientEventBridge({
      emitClientEvent,
      getSessionSnapshot: () => makeSnapshot(),
    });

    bridge.handleMessagesReceived([makeMessage({ seq: 1 })]);

    expect(emitClientEvent).toHaveBeenNthCalledWith(
      1,
      'messages:received',
      expect.objectContaining({
        conversationKeys: ['u:200'],
        messages: [expect.objectContaining({ messageId: 'msg-1', senderId: '200' })],
      }),
    );
    expect(emitClientEvent).toHaveBeenCalledTimes(1);
    const messagesEvent = emitClientEvent.mock.calls[0][1];
    expect(Object.isFrozen(messagesEvent)).toBe(true);
    expect(Object.isFrozen(messagesEvent.messages)).toBe(true);
  });

  it('将 recall event 归一化为原消息更新但不本地存未读', () => {
    const emitClientEvent = vi.fn<
      <K extends keyof ClientEvents>(event: K, payload: Parameters<ClientEvents[K]>[0]) => void
    >();
    const bridge = new ClientEventBridge({
      emitClientEvent,
      getSessionSnapshot: () => makeSnapshot(),
    });

    bridge.handleMessagesReceived([makeMessage({ seq: 1, msg_id: 'msg-1' })]);
    emitClientEvent.mockClear();

    bridge.handleMessagesReceived([makeMessage({
      seq: 2,
      msg_id: 'recall-2',
      msg_type: MSG_TYPE_RECALL,
      body: {
        recall: {
          msg_id: 'msg-1',
          operator_uid: '200',
          recall_time: 2002,
          text: '消息已撤回',
        },
      },
    })]);

    expect(emitClientEvent).toHaveBeenNthCalledWith(
      1,
      'messages:received',
      expect.objectContaining({
        messages: [expect.objectContaining({
          messageId: 'msg-1',
          messageType: MSG_TYPE_RECALL,
        })],
      }),
    );
    const payload = emitClientEvent.mock.calls[0][1] as { messages: Array<{ body: { recall?: { text?: string } } }> };
    expect(payload.messages[0].body.recall?.text).toContain('消息已撤回');
    expect(emitClientEvent).toHaveBeenCalledTimes(1);
  });

  it('把 DataGateway 回调转成 UI 可订阅事件', () => {
    const emitClientEvent = vi.fn<
      <K extends keyof ClientEvents>(event: K, payload: Parameters<ClientEvents[K]>[0]) => void
    >();
    const bridge = new ClientEventBridge({
      emitClientEvent,
      getSessionSnapshot: () => makeSnapshot(),
    });

    bridge.handleBlocklistChanged();
    bridge.handleMutelistChanged();

    expect(emitClientEvent).toHaveBeenNthCalledWith(
      1,
      'blocklist:updated',
      expect.objectContaining({ reason: 'notification' }),
    );
    expect(emitClientEvent).toHaveBeenNthCalledWith(
      2,
      'mutelist:updated',
      expect.objectContaining({ reason: 'notification' }),
    );
  });
});
