import { describe, expect, it } from 'vitest';
import { conversationKeyFromMessage } from '../../../src/internal/model-mappers';
import type { Message } from '../../../src/models';

function makeMessage(overrides: Partial<Message> & { seq: number }): Message {
  return {
    uid: 0,
    msg_id: `msg_${overrides.seq}`,
    from_uid: '100',
    to_uid: '200',
    group_id: '0',
    msg_type: 1,
    content: `content_${overrides.seq}`,
    send_time: 1000 + overrides.seq,
    seq: overrides.seq,
    ...overrides,
  };
}

describe('conversationKeyFromMessage 会话 key 计算', () => {
  it('私聊消息使用对端 uid 生成会话 key', () => {
    const msg = makeMessage({ seq: 1, from_uid: '100', to_uid: '200' });
    expect(conversationKeyFromMessage(msg, '100')).toBe('u:200');

    const msg2 = makeMessage({ seq: 2, from_uid: '200', to_uid: '100' });
    expect(conversationKeyFromMessage(msg2, '100')).toBe('u:200');
  });

  it('群消息使用 group_id 生成会话 key', () => {
    const msg = makeMessage({ seq: 1, group_id: '500' });
    expect(conversationKeyFromMessage(msg, '100')).toBe('g:500');
  });
});
