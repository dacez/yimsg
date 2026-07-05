import { describe, expect, it } from 'vitest';
import {
	mapMessagesResponse,
	sendMessageRequest,
} from '../../../src/sdk/internal/action-mappers';
import {
	ACTION_RESPONSE_SCHEMAS,
	CORE_ACTION_NAMES,
	CORE_NOTIFICATION_TYPES,
	SERVER_ERROR_CODES,
	parseActionResponse,
} from './protocol-test-helpers';
import { MSG_TYPE_TEXT } from '../../../src/constants';

describe('SDK action response schemas', () => {
  it('覆盖所有 SDK 使用的 WebSocket action', () => {
    expect(Object.keys(ACTION_RESPONSE_SCHEMAS).sort()).toEqual([...CORE_ACTION_NAMES].sort());
  });

  it('导出服务端错误码和核心通知类型', () => {
    expect(SERVER_ERROR_CODES).toContain('INVALID_ARGUMENT');
    expect(SERVER_ERROR_CODES).toContain('BATCH_LIMIT_EXCEEDED');
    expect(CORE_NOTIFICATION_TYPES).toContain('messages:received');
    expect(CORE_NOTIFICATION_TYPES).toContain('mutelist:updated');
  });

  it('校验 login 响应并保留标准字段', () => {
    const parsed = parseActionResponse('login', {
      ok: true,
      request_id: '1',
      uid: '100',
      token: 'tok',
    });

    expect(parsed.uid).toBe('100');
    expect(parsed.token).toBe('tok');
  });

  it('校验 register 使用独立响应模型返回 uid', () => {
    const parsed = parseActionResponse('register', {
      ok: true,
      request_id: '1',
      uid: '101',
    });

    expect(parsed.uid).toBe('101');
  });

  it('校验 user info 与 group info 响应模型', () => {
    const users = parseActionResponse('getUserInfos', {
      ok: true,
      request_id: '1',
      profiles: [{ uid: '100', username: 'alice', nickname: 'Alice', avatar: '', created_at: 1, updated_at: 2 }],
    });
    const groups = parseActionResponse('getGroupInfos', {
      ok: true,
      request_id: '2',
      groups: [{ group_id: '500', name: '群', avatar: '', owner_uid: '100', created_at: 1, updated_at: 2 }],
    });

    expect(users.profiles?.[0].uid).toBe('100');
    expect(groups.groups?.[0].group_id).toBe('500');
  });

  it('action-mappers 请求整形器生成 msg_id 与 target', () => {
    const send = sendMessageRequest({ toUid: '200' }, { text: 'hi' } as never, MSG_TYPE_TEXT);

    expect(send.target?.uid).toBe('200');
    expect(send.msg_type).toBe(MSG_TYPE_TEXT);
    // msg_id 为 UUIDv7 base64url，固定 22 字符，由 SDK 唯一生成点产出。
    expect(send.msg_id).toHaveLength(22);
  });

  it('response mapper 可脱离 transport 使用', () => {
    const messages = mapMessagesResponse({
      base: { code: 0, msg: '' },
      messages: [{
        uid: '0',
        seq: '9',
        msg_id: 'm9',
        from_uid: '100',
        to_uid: '200',
        group_id: '0',
        msg_type: String(MSG_TYPE_TEXT),
        content: 'hi',
        send_time: '123',
        status: '0',
      }],
    } as never);

    expect(messages[0].seq).toBe(9);
    expect(messages[0].msg_type).toBe(MSG_TYPE_TEXT);
  });
});
