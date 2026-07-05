import { describe, expect, it } from 'vitest';
import {
  mapContact,
  mapMessage,
  mapBlocklistUser,
  mapMutelistEntry,
  mapUserInfo,
} from '../../../src/sdk/internal/model-mappers';
import { AuthError, ConnectionError, PreconditionError, RequestError, StorageModeError, ValidationError, isYimsgError } from '../../../src/sdk/errors';
import { MSG_TYPE_TEXT } from '../../../src/constants';

describe('SDK 公开模型映射', () => {
  it('将消息映射为 camelCase 的公开模型', () => {
    const message = mapMessage({
      uid: 0,
      seq: 10,
      msg_id: 'msg-10',
      from_uid: '100',
      to_uid: '200',
      group_id: '0',
      msg_type: MSG_TYPE_TEXT,
      content: 'hello',
      send_time: 123456,
    });

    expect(message).toMatchObject({
      seq: 10,
      messageId: 'msg-10',
      senderId: '100',
      recipientId: '200',
      groupId: '0',
      messageType: MSG_TYPE_TEXT,
      sentAt: 123456,
    });
    expect(Object.isFrozen(message)).toBe(true);
  });

  it('将联系人与资料映射为前端友好字段', () => {
    const contact = mapContact({
      friend_uid: '200',
      group_id: '0',
      status: 1,
      seq: 2,
      remark_name: 'Bob',
    });
    const profile = mapUserInfo({
      uid: '200',
      username: 'bob',
      nickname: 'Bob',
      avatar: 'https://example.com/bob.png',
      remark: '同学',
      created_at: 10,
      updated_at: 20,
    });

    expect(contact).toMatchObject({
      friendUid: '200',
      groupId: '0',
      remarkName: 'Bob',
    });
    expect(profile).toMatchObject({
      uid: '200',
      avatarUrl: 'https://example.com/bob.png',
      remarkName: '同学',
      createdAt: 10,
      updatedAt: 20,
    });
    expect(Object.isFrozen(contact)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it('将屏蔽列表与免打扰条目映射为前端友好字段', () => {
    const blockUser = mapBlocklistUser({
      uid: '200',
      status: 1,
      seq: 9,
      created_at: 10,
      updated_at: 20,
    });
    const mutelist = mapMutelistEntry({
      to_uid: '200',
      group_id: '0',
      status: 1,
      seq: 11,
      updated_at: 22,
    });

    expect(blockUser).toMatchObject({
      uid: '200',
      seq: 9,
      createdAt: 10,
      updatedAt: 20,
    });
    expect(mutelist).toMatchObject({
      toUid: '200',
      groupId: '0',
      status: 1,
      seq: 11,
      updatedAt: 22,
    });
    expect(Object.isFrozen(blockUser)).toBe(true);
    expect(Object.isFrozen(mutelist)).toBe(true);
  });

});

describe('SDK 统一错误模型', () => {
  it('公开错误类型都继承 YimsgError', () => {
    const errors = [
      new PreconditionError('AUTH_REQUIRED', '请先登录'),
      new ValidationError('参数错误'),
      new AuthError('认证失败'),
      new ConnectionError('CONNECTION_TIMEOUT', '连接超时'),
      new RequestError('REQUEST_FAILED', '请求失败'),
      new StorageModeError('STORAGE_FAILED', '存储失败'),
    ];

    expect(errors.every(isYimsgError)).toBe(true);
    expect(errors.map(error => error.kind)).toEqual([
      'precondition',
      'validation',
      'auth',
      'connection',
      'request',
      'storage',
    ]);
  });
});
