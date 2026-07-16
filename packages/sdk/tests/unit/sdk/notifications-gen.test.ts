import { describe, it, expect, vi } from 'vitest';
import {
  NoopNotificationHandler,
  dispatchNotificationFrame,
} from '../../../src/generated/notifications.gen';
import type { Frame } from '../../../src/transport/frame';
import { MessagesReceivedNotification, Type } from '@yimsg/protocol';

function notifFrame(typeId: number, body: Uint8Array, requestId = '0'): Frame {
  return { codec: 'b', littleEndian: false, requestId, typeId, body } as Frame;
}

describe('generated notifications dispatch', () => {
  it('解码 messages:received 并调用 onMessagesReceived', async () => {
    const handler = new NoopNotificationHandler();
    const spy = vi.spyOn(handler, 'onMessagesReceived');
    const body = MessagesReceivedNotification.encode(
      MessagesReceivedNotification.create({ target: { group_id: '42' } }),
    ).finish();

    const result = await dispatchNotificationFrame(handler, notifFrame(Type.TYPE_NOTIFY_MESSAGES_RECEIVED, body));

    expect(result).toEqual({ ok: true, handled: true, typeId: Type.TYPE_NOTIFY_MESSAGES_RECEIVED });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].target?.group_id).toBe('42');
  });

  it('request_id 非 0 时不处理', async () => {
    const handler = new NoopNotificationHandler();
    const result = await dispatchNotificationFrame(handler, notifFrame(Type.TYPE_NOTIFY_MESSAGES_RECEIVED, new Uint8Array(), '5'));
    expect(result).toEqual({ ok: true, handled: false });
  });

  it('未知通知 type 返回 handled:false', async () => {
    const handler = new NoopNotificationHandler();
    const result = await dispatchNotificationFrame(handler, notifFrame(99999, new Uint8Array()));
    expect(result).toEqual({ ok: true, handled: false });
  });

  it('body 解码失败返回 ok:false', async () => {
    const handler = new NoopNotificationHandler();
    const result = await dispatchNotificationFrame(
      handler,
      notifFrame(Type.TYPE_NOTIFY_MESSAGES_RECEIVED, new Uint8Array([0xff, 0xff, 0xff, 0xff])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.typeId).toBe(Type.TYPE_NOTIFY_MESSAGES_RECEIVED);
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('handler 抛错返回 ok:false', async () => {
    const handler = new NoopNotificationHandler();
    vi.spyOn(handler, 'onContactsUpdated').mockImplementation(() => {
      throw new Error('boom');
    });
    const result = await dispatchNotificationFrame(handler, notifFrame(Type.TYPE_NOTIFY_CONTACTS_UPDATED, new Uint8Array()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('boom');
    }
  });
});
