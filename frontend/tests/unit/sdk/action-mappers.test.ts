import { describe, it, expect } from 'vitest';
import {
  assertValidStatus,
  contactCountRequest,
  getContactsRequest,
  getMessagesRequest,
  groupMembersRequest,
  mapGetBlocklistResponse,
  mapGetContactsResponse,
  mapGetGroupMembersResponse,
  mapGetMutelistResponse,
  mapMessagesResponse,
  mapSyncContactsResponse,
  recallMessageRequest,
  sendMessageRequest,
  targetParams,
} from '../../../src/sdk/internal/action-mappers';
import { CONTACT_FRIEND, MSG_TYPE_RECALL, MSG_TYPE_TEXT } from '../../../src/constants';

// action-mappers.ts 是出方向 action 的无状态业务工具集中地。底层 Type+codec+transport 由
// actions.gen.ts 负责（见 actions-gen.test.ts），这里只覆盖整形 / 校验 / 归一化逻辑。

describe('action-mappers：target / 分页 / 校验', () => {
  it('targetParams 区分单聊与群', () => {
    expect(targetParams({ toUid: '200' })).toEqual({ target: { uid: '200' } });
    expect(targetParams({ groupId: '500' } as never)).toEqual({ target: { group_id: '500' } });
  });

  it('assertValidStatus 校验非法值与必填', () => {
    expect(assertValidStatus(CONTACT_FRIEND, [CONTACT_FRIEND])).toBe(CONTACT_FRIEND);
    expect(assertValidStatus(undefined, [CONTACT_FRIEND])).toBeUndefined();
    expect(() => assertValidStatus(undefined, [CONTACT_FRIEND], true)).toThrow();
    expect(() => assertValidStatus(999, [CONTACT_FRIEND])).toThrow();
  });
});

describe('action-mappers：请求整形', () => {
  it('sendMessageRequest 生成 msg_id 并映射 target', () => {
    const req = sendMessageRequest({ toUid: '200' }, { text: 'hi' } as never, MSG_TYPE_TEXT);
    expect(req.target?.uid).toBe('200');
    expect(req.msg_type).toBe(MSG_TYPE_TEXT);
    // msg_id 为 UUIDv7 base64url，固定 22 字符，由 SDK 唯一生成点产出。
    expect(req.msg_id).toHaveLength(22);
  });

  it('recallMessageRequest 走 RECALL 类型并携带 recall body', () => {
    const req = recallMessageRequest({ toUid: '200' }, 'm1');
    expect(req.msg_type).toBe(MSG_TYPE_RECALL);
    expect(req.body?.recall?.msg_id).toBe('m1');
  });

  it('getContactsRequest 组装 targets、校验状态、构造 page 游标', () => {
    const req = getContactsRequest({
      friend_uids: ['1', '2'],
      group_id: '500',
      status: CONTACT_FRIEND,
      page: { cursor: 'C', limit: 3 },
    });
    expect(req.targets).toHaveLength(3);
    expect(req.targets[0].group_id).toBe('500');
    expect(req.targets[1].uid).toBe('1');
    expect(req.targets[2].uid).toBe('2');
    expect(req.status).toBe(CONTACT_FRIEND);
    expect(req.page?.cursor).toBe('C');
    expect(req.page?.limit).toBe('3');
  });

  it('contactCountRequest 必填状态非法时抛错', () => {
    expect(() => contactCountRequest(0)).toThrow();
  });

  it('getMessagesRequest msg_ids 与 page 互斥抛错', () => {
    expect(() => getMessagesRequest({ msg_ids: ['a'], page: { limit: 1 } })).toThrow();
  });

  it('groupMembersRequest 钳制 limit 至上限 500', () => {
    expect(groupMembersRequest('700', { page: { limit: 99999 } }).page?.limit).toBe('500');
  });
});

describe('action-mappers：响应映射', () => {
  it('mapMessagesResponse 归一化数字字段', () => {
    const msgs = mapMessagesResponse({
      messages: [
        {
          uid: '0',
          seq: '9',
          msg_id: 'm9',
          from_uid: '100',
          to_uid: '200',
          group_id: '0',
          msg_type: String(MSG_TYPE_TEXT),
          send_time: '123',
          status: '0',
        },
      ],
    } as never);
    expect(msgs[0].seq).toBe(9);
    expect(msgs[0].msg_type).toBe(MSG_TYPE_TEXT);
  });

  it('mapGetContactsResponse 透传 page 游标', () => {
    const r = mapGetContactsResponse(
      { contacts: [], page: { start_cursor: 'S', end_cursor: 'E', has_more_forward: true } } as never,
    );
    expect(r.page.hasMoreForward).toBe(true);
    expect(r.page.endCursor).toBe('E');
  });

  it('mapGetBlocklistResponse / mapGetMutelistResponse 回传 page 游标', () => {
    expect(
      mapGetBlocklistResponse({ users: [], page: { end_cursor: 'E5' } } as never).page.endCursor,
    ).toBe('E5');
    expect(
      mapGetMutelistResponse({ mutes: [], page: { start_cursor: 'S7' } } as never).page.startCursor,
    ).toBe('S7');
  });

  it('mapGetGroupMembersResponse 取 page.total 作为总数', () => {
    expect(mapGetGroupMembersResponse({ members: [], page: { total: '4' } } as never).total).toBe(4);
  });

  it('mapSyncContactsResponse 透传 error 与 has_more / cursor_seq', () => {
    const r = mapSyncContactsResponse({ contacts: [], error: 'seq_too_old' } as never);
    expect(r.error).toBe('seq_too_old');
    expect(r.hasMore).toBe(false);
    expect(r.cursorSeq).toBe(0);
    const more = mapSyncContactsResponse({ contacts: [], has_more: true, cursor_seq: '9' } as never);
    expect(more.hasMore).toBe(true);
    expect(more.cursorSeq).toBe(9);
  });
});
