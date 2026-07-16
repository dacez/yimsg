import { describe, expect, it, vi } from 'vitest';
import { DisplayInfoCache } from '../../../src/state/cache';
import type { DataGateway } from '../../../src/datagateway/interface';
import { PreconditionError, ValidationError } from '../../../src/errors';
import {
  assertNonEmpty,
  normalizeDisplayInfoKeys,
  requireAuthenticated,
} from '../../../src/internal/client-guards';
import {
  updateGroupInfoDisplayCache,
  updateRemarkDisplayCache,
  updateUserInfoDisplayCache,
} from '../../../src/internal/client-cache-updates';
import {
  wrapContactPage,
  wrapConversationPage,
  wrapGroupMemberPage,
  wrapMessagePage,
} from '../../../src/internal/client-pages';

const emptyPage = { startCursor: '', endCursor: '', hasMoreBackward: false, hasMoreForward: false, total: -1 };

function mockDataGateway(): DataGateway {
  return {
    init: vi.fn().mockResolvedValue({ lastMsgSeq: 0, lastContactSeq: 0 }),
    clear: vi.fn(),
    get_conversations: vi.fn().mockResolvedValue({ conversations: [], page: emptyPage }),
    get_unread_count: vi.fn().mockResolvedValue(0),
    get_messages: vi.fn().mockResolvedValue({ messages: [], page: emptyPage }),
    get_contacts: vi.fn().mockResolvedValue({ contacts: [], page: emptyPage }),
    get_contact_count: vi.fn().mockResolvedValue(0),
    get_blocklist: vi.fn().mockResolvedValue({ users: [], page: emptyPage }),
    get_mutelist: vi.fn().mockResolvedValue({ mutes: [], page: emptyPage }),
    get_user_infos: vi.fn().mockResolvedValue([]),
    get_group_infos: vi.fn().mockResolvedValue([]),
    onMessagesReceived: vi.fn(),
    onContactsChanged: vi.fn(),
    onBlocklistChanged: vi.fn(),
    onMutelistChanged: vi.fn(),
    onUnreadCleared: vi.fn(),
    onConversationDeleted: vi.fn(),
    onMessageDeleted: vi.fn(),
    onSessionKicked: vi.fn(),
    onError: vi.fn(),
    onSync: vi.fn(),
    handleNotification: vi.fn(),
  };
}

function makeCache(): DisplayInfoCache {
  return new DisplayInfoCache({ dataGateway: () => mockDataGateway() });
}

describe('client internal guards', () => {
  it('requireAuthenticated 返回 uid/token，未认证时抛前置条件错误', () => {
    const snapshot = {
      currentUid: '100',
      isAuthenticated: true,
      isSessionInitialized: false,
      sessionState: 'authenticated',
      connectionState: 'connected',
      mode: 'instant',
    } as const;

    expect(requireAuthenticated(snapshot, 'tok', 'sendMessage')).toEqual({ uid: '100', token: 'tok' });
    expect(() => requireAuthenticated({ ...snapshot, currentUid: '' }, 'tok', 'sendMessage')).toThrow(PreconditionError);
    expect(() => requireAuthenticated(snapshot, '', 'sendMessage')).toThrow(PreconditionError);
  });

  it('assertNonEmpty 与 normalizeDisplayInfoKeys 集中处理参数 guard', () => {
    expect(() => assertNonEmpty('  ', 'username', 'login')).toThrow(ValidationError);
    expect(normalizeDisplayInfoKeys(['1', '1', '2'], 'getUserInfos', 2)).toEqual(['1', '2']);
    expect(() => normalizeDisplayInfoKeys(['1', '2', '3'], 'getUserInfos', 2)).toThrow(ValidationError);
  });
});

describe('client cache update helpers', () => {
  it('写后缓存更新保留已有显示字段，只覆盖变更字段', () => {
    const cache = makeCache();
    cache.setUserInfos([{ uid: '100', username: 'alice', nickname: 'Alice', avatar: '/a.png', remark: 'old' }]);
    cache.setGroupInfos([{ group_id: '500', name: 'Team', avatar: '/g.png', remark: 'old group' }]);

    updateRemarkDisplayCache(cache, { toUid: '100' }, 'friend');
    updateGroupInfoDisplayCache(cache, '500', { name: 'New Team' });
    updateUserInfoDisplayCache(cache, '100', { avatarUrl: '/new.png' });

    expect(cache.getUserInfos(['100']).get('100')).toEqual({
      username: 'alice',
      nickname: 'Alice',
      avatar: '/new.png',
      remark: 'friend',
    });
    expect(cache.getGroupInfos(['500']).get('500')).toEqual({
      name: 'New Team',
      avatar: '/g.png',
      remark: 'old group',
    });
  });
});

describe('client page wrappers', () => {
  it('分页包装统一映射公开模型并冻结集合', () => {
    const page = { startCursor: 'S', endCursor: 'E', hasMoreBackward: false, hasMoreForward: false, total: 1 };
    const conversations = wrapConversationPage({
      conversations: [{ group_id: '0', friend_uid: '200', last_seq: 9, unread_count: 1 }],
      page,
    });
    const contacts = wrapContactPage({
      contacts: [{ friend_uid: '200', group_id: '0', status: 1, seq: 2 }],
      page,
    });
    const members = wrapGroupMemberPage({
      total: 1,
      members: [{ uid: '200', role: 1, joined_at: 123 }],
      page,
    });
    const messages = wrapMessagePage({
      messages: [{ seq: 1, msg_id: 'm1', from_uid: '100', to_uid: '200', group_id: '0', msg_type: 1, content: 'hi', send_time: 10 }],
      page,
    });

    expect(Object.isFrozen(conversations)).toBe(true);
    expect(Object.isFrozen(conversations.conversations)).toBe(true);
    expect(conversations.conversations[0].friendUid).toBe('200');
    expect(conversations.page.endCursor).toBe('E');
    expect(contacts.contacts[0].friendUid).toBe('200');
    expect(members.members[0].userId).toBe('200');
    expect(messages.messages[0].messageId).toBe('m1');
  });
});
