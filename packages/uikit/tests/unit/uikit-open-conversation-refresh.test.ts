// 打开中会话的刷新契约单测：通知不会因为视图隐藏被吞、未读只在"用户确实看到了最新消息"时清。
//
// 这里刻意不用真实 BoundedList：被测的是 message-list.ts 与 navigation.ts 对列表实例的
// 调用契约（何时 invalidate、何时清未读），列表内部的决策树由 bounded-list 自己的单测和
// 组件测试覆盖。

import { describe, expect, it, vi } from 'vitest';
import type { AppInstance } from '../../src/app/app-instance';
import { refreshOpenConversation, resumeOpenConversation } from '../../src/app/views/chat/message-list';
import { switchView } from '../../src/app/views/chat/navigation';

function makeClassListElement() {
  const classes = new Set<string>();
  return {
    classList: {
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
      contains: (cls: string) => classes.has(cls),
    },
  };
}

interface AppOptions {
  /** 聊天视图是否可见。 */
  readonly chatVisible?: boolean;
  /** 消息列表距底像素；<=50 视为贴底。 */
  readonly distanceFromBottom?: number;
  /** 消息列表当前有没有未追平的变化。 */
  readonly stale?: boolean;
  /** 打开会话那一刻快照里的未读数——任何清未读决策都不该依赖它。 */
  readonly snapshotUnread?: number;
}

function createApp(options: AppOptions = {}) {
  const {
    chatVisible = true,
    distanceFromBottom = 0,
    stale = false,
    snapshotUnread = 0,
  } = options;

  const viewChat = makeClassListElement();
  if (!chatVisible) viewChat.classList.add('hidden');
  const viewContacts = makeClassListElement();
  const viewSettings = makeClassListElement();

  const messageListEl = {
    clientHeight: 500,
    scrollHeight: 1000 + distanceFromBottom,
    scrollTop: 500,
  };

  const elements = new Map<string, unknown>([
    ['view-chat', viewChat],
    ['view-contacts', viewContacts],
    ['view-settings', viewSettings],
    ['message-list', messageListEl],
    // 切离聊天视图时会顺带收起全局搜索。
    ['global-search-input', { value: '' }],
    ['global-search-cancel', makeClassListElement()],
    ['global-search-results', { ...makeClassListElement(), innerHTML: '' }],
    ['conversation-list', makeClassListElement()],
  ]);

  const invalidate = vi.fn();
  const clearUnread = vi.fn(async () => {});

  const app = {
    $: (id: string) => elements.get(id),
    dom: {
      querySelectorAll: () => [viewChat, viewContacts, viewSettings],
      querySelector: () => null,
      root: { querySelector: () => null },
      layoutHost: { dataset: {} },
      ownerDocument: {
        body: { dataset: {} },
        defaultView: { matchMedia: () => ({ matches: false }), innerWidth: 1280 },
      },
    },
    runtime: { viewMode: undefined },
    client: {
      describeConversation: () => ({ key: 'u:2', kind: 'direct', id: '2', target: { toUid: '2' } }),
      clearUnread,
    },
    chatState: {
      currentConvKey: 'u:2',
      currentConversation: { groupId: '0', friendUid: '2', lastSeq: 1, lastMessage: null, unreadCount: snapshotUnread },
      messageList: { invalidate, getState: () => ({ stale }) },
      loadContactsFn: vi.fn(),
      renderSettingsFn: vi.fn(),
      messageSelectionMode: false,
    },
    views: {},
  } as unknown as AppInstance;

  return { app, invalidate, clearUnread, viewChat };
}

describe('refreshOpenConversation（收到新消息）', () => {
  it('聊天视图隐藏时照样 invalidate：可见性决定"何时追平"，不决定"要不要知道"', async () => {
    const { app, invalidate } = createApp({ chatVisible: false });
    await refreshOpenConversation(app);
    // 回归 BUG：曾经在这里按视图隐藏早退，通知被整条吞掉——切回聊天视图后新消息不在
    // 列表里，滚动也补不回来（组件的 dirty 从未被置起）。
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('聊天视图隐藏时不清未读：用户没看到，红点必须留着', async () => {
    const { app, clearUnread } = createApp({ chatVisible: false, distanceFromBottom: 0 });
    await refreshOpenConversation(app);
    expect(clearUnread).not.toHaveBeenCalled();
  });

  it('可见且贴底：清未读', async () => {
    const { app, clearUnread } = createApp({ distanceFromBottom: 0 });
    await refreshOpenConversation(app);
    expect(clearUnread).toHaveBeenCalledTimes(1);
  });

  it('可见但上翻阅读中：不清未读', async () => {
    const { app, clearUnread, invalidate } = createApp({ distanceFromBottom: 400 });
    await refreshOpenConversation(app);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(clearUnread).not.toHaveBeenCalled();
  });

  it('没有打开中的会话时什么都不做', async () => {
    const { app, invalidate, clearUnread } = createApp();
    app.chatState.currentConvKey = null;
    await refreshOpenConversation(app);
    expect(invalidate).not.toHaveBeenCalled();
    expect(clearUnread).not.toHaveBeenCalled();
  });
});

describe('resumeOpenConversation（聊天视图重新可见）', () => {
  it('有未追平的变化时重新决策一次', () => {
    const { app, invalidate } = createApp({ stale: true });
    resumeOpenConversation(app);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('没有未追平的变化时不动：不为切一次视图白发一次请求', () => {
    const { app, invalidate } = createApp({ stale: false });
    resumeOpenConversation(app);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('消息列表还没创建时是空操作', () => {
    const { app } = createApp({ stale: true });
    app.chatState.messageList = null;
    expect(() => resumeOpenConversation(app)).not.toThrow();
  });
});

describe('switchView 回到聊天视图', () => {
  it('隐藏期间攒下的变化会被重新决策，不看打开会话那一刻的未读快照', () => {
    // 回归 BUG：曾经用 chatState.currentConversation.unreadCount（打开那一刻的快照，此后
    // 永不更新）判断要不要清未读。快照为 0 的会话——从通讯录发起、或已读完再点一次——
    // 切走再切回来红点永远清不掉。
    const { app, invalidate } = createApp({ chatVisible: false, stale: true, snapshotUnread: 0 });
    switchView(app, 'chat');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('切到其它视图不碰消息列表', () => {
    const { app, invalidate } = createApp({ stale: true });
    switchView(app, 'settings');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
