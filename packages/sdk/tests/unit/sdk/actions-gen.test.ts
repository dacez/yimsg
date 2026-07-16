import { describe, it, expect, vi } from 'vitest';
import { login, getContacts, sendMessage } from '../../../src/generated/actions.gen';
import type { ClientTransport } from '../../../src/transport/connection';
import {
  GetContactsResponse,
  LoginRequest,
  LoginResponse,
  MessageType,
  SendMessageRequest,
  SendMessageResponse,
  Type,
} from '@yimsg/protocol';

// makeTransport 返回一个捕获调用并按 responder 构造响应的 mock transport。
function makeTransport(responder: (typeId: number, body: Uint8Array, codec: any) => unknown) {
  const sendBinary = vi.fn((typeId: number, body: Uint8Array, responseCodec: any) =>
    Promise.resolve(responder(typeId, body, responseCodec)),
  );
  return { sendBinary } as unknown as ClientTransport & { sendBinary: ReturnType<typeof vi.fn> };
}

describe('generated actions', () => {
  it('login 使用正确的 type/request/response codec', async () => {
    const transport = makeTransport(() => LoginResponse.create({ uid: '7', token: 'tok' }));
    const resp = await login(transport, LoginRequest.create({ username: 'alice', password: 'pw' }));

    expect(transport.sendBinary).toHaveBeenCalledWith(
      Type.TYPE_ACTION_LOGIN,
      expect.any(Uint8Array),
      LoginResponse,
    );
    const sentBody = transport.sendBinary.mock.calls[0][1] as Uint8Array;
    const sent = LoginRequest.decode(sentBody);
    expect(sent.username).toBe('alice');
    expect(sent.password).toBe('pw');
    expect(resp.uid).toBe('7');
    expect(resp.token).toBe('tok');
  });

  it('getContacts 返回 page 游标', async () => {
    const transport = makeTransport((_t, _b, codec) => {
      expect(codec).toBe(GetContactsResponse);
      return GetContactsResponse.create({ page: { has_more_forward: true, end_cursor: 'E' }, contacts: [] });
    });
    const resp = await getContacts(transport, {} as never);
    expect(resp.page?.has_more_forward).toBe(true);
    expect(resp.page?.end_cursor).toBe('E');
  });

  it('sendMessage 不生成 msg_id，只使用传入 request', async () => {
    const transport = makeTransport(() => SendMessageResponse.create({ seq: '1', msg_id: 'server' }));
    await sendMessage(
      transport,
      SendMessageRequest.create({ msg_id: 'client-generated-id', msg_type: MessageType.MESSAGE_TYPE_TEXT }),
    );
    const sent = SendMessageRequest.decode(transport.sendBinary.mock.calls[0][1] as Uint8Array);
    expect(sent.msg_id).toBe('client-generated-id');

    // 未传 msg_id 时也不会自动生成，保持空串。
    const transport2 = makeTransport(() => SendMessageResponse.create({}));
    await sendMessage(transport2, SendMessageRequest.create({ msg_type: MessageType.MESSAGE_TYPE_TEXT }));
    const sent2 = SendMessageRequest.decode(transport2.sendBinary.mock.calls[0][1] as Uint8Array);
    expect(sent2.msg_id).toBe('');
  });
});
