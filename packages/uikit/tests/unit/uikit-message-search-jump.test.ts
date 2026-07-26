import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MSG_TYPE_TEXT } from '@yimsg/sdk';
import type { ConversationDescriptor, ConversationTarget, Message } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import { createMessageWindow } from '../../src/app/views/chat/message-page';
import { jumpToMessageInConversation } from '../../src/app/views/chat/message-search';
import { openConversationAndJumpToMessage } from '../../src/app/views/chat/global-search';
import { openConversationShellForJump } from '../../src/app/views/chat/conversation-list';

// jumpToMessageInConversation 内部 renderMessages 会做完整 DOM 渲染（虚拟窗口、消息气泡等），
// 这里只关心"是否正确加载了锚点页 + 是否展示了聊天面板"这两件事，把渲染整体 mock 成空操作，
// 避免为一个跳转单测搭一整套消息列表 DOM。
vi.mock('../../src/app/views/chat/message-list', () => ({
  renderMessages: vi.fn(),
}));

vi.mock('../../src/app/views/chat/conversation-list', async () => {
  const actual = await vi.importActual<typeof import('../../src/app/views/chat/conversation-list')>(
    '../../src/app/views/chat/conversation-list',
  );
  return {
    ...actual,
    openConversation: vi.fn(),
    openConversationShellForJump: vi.fn(),
  };
});

function makeClassListElement() {
  const classes = new Set<string>();
  return {
    classList: {
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
      contains: (cls: string) => classes.has(cls),
      toggle: (cls: string, force?: boolean) => {
        const next = force ?? !classes.has(cls);
        if (next) classes.add(cls); else classes.delete(cls);
      },
    },
    hasClass: (cls: string) => classes.has(cls),
  };
}

function message(seq: number, messageId: string): Message {
  return {
    seq,
    messageId,
    senderId: '1',
    recipientId: '2',
    groupId: '0',
    messageType: MSG_TYPE_TEXT,
    body: {} as Message['body'],
    sentAt: seq,
  } as Message;
}

function createApp() {
  const viewChat = makeClassListElement();
  const elements = new Map<string, ReturnType<typeof makeClassListElement>>([['view-chat', viewChat]]);

  const getMessages = vi.fn(async () => ({
    messages: [],
    page: { startCursor: '', endCursor: '', hasMoreBackward: true, hasMoreForward: true },
  }));

  const app = {
    $: (id: string) => elements.get(id),
    dom: { querySelector: () => null },
    showToast: vi.fn(),
    client: { getMessages },
    chatState: {
      currentConvKey: null as string | null,
      messageWindow: createMessageWindow(3),
      currentMessages: [],
      loadingMoreMessages: false,
      loadingNewerMessages: false,
      messagePageHasOlder: false,
      messagePageHasNewer: false,
      messagePageRequestId: 0,
      pendingNewMessageCount: 0,
      selectedMessageIds: new Set<string>(),
      expandedQuoteMessageIds: new Set<string>(),
      highlightMessageId: null as string | null,
    },
  } as unknown as AppInstance;

  return { app, viewChat, getMessages };
}

describe('jumpToMessageInConversation（消息锚点跳转）', () => {
  it('跳转前移动端聊天面板尚未展示（如刚从聊天页返回会话列表）时，也要补上 mobile-showing-chat', async () => {
    const { app, viewChat, getMessages } = createApp();
    expect(viewChat.hasClass('mobile-showing-chat')).toBe(false);

    const target: ConversationTarget = { toUid: '2' };
    await jumpToMessageInConversation(app, target, 'm-3');

    expect(viewChat.hasClass('mobile-showing-chat')).toBe(true);
    expect(getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ target, around: 'm-3' }),
    );
  });

  it('聊天面板已展示时保持展示（幂等，桌面端无副作用）', async () => {
    const { app, viewChat } = createApp();
    viewChat.classList.add('mobile-showing-chat');

    await jumpToMessageInConversation(app, { toUid: '2' }, 'm-9');

    expect(viewChat.hasClass('mobile-showing-chat')).toBe(true);
  });
});

describe('全局搜索命中消息后的跳转决策（global-search.ts）', () => {
  beforeEach(() => {
    vi.mocked(openConversationShellForJump).mockClear();
  });

  it('命中消息属于当前会话（移动端返回后 currentConvKey 未清空）时跳过 shell 初始化，仍要展示聊天面板', async () => {
    const { app, viewChat } = createApp();

    const descriptor: ConversationDescriptor = { key: 'u:2', kind: 'direct', id: '2', target: { toUid: '2' } };
    app.chatState.currentConvKey = descriptor.key;
    (app as unknown as { client: Record<string, unknown> }).client.describeMessageConversation = vi.fn(() => descriptor);

    // 模拟：mobile-showing-chat 已在返回会话列表时被移除，但 currentConvKey 仍是这个会话。
    expect(viewChat.hasClass('mobile-showing-chat')).toBe(false);

    await openConversationAndJumpToMessage(app, message(3, 'm-3'));

    expect(openConversationShellForJump).not.toHaveBeenCalled();
    expect(viewChat.hasClass('mobile-showing-chat')).toBe(true);
  });

  it('命中消息属于其它会话时正常走 shell 初始化', async () => {
    const { app } = createApp();

    const descriptor: ConversationDescriptor = { key: 'u:2', kind: 'direct', id: '2', target: { toUid: '2' } };
    app.chatState.currentConvKey = 'u:3';
    (app as unknown as { client: Record<string, unknown> }).client.describeMessageConversation = vi.fn(() => descriptor);

    await openConversationAndJumpToMessage(app, message(3, 'm-3'));

    expect(openConversationShellForJump).toHaveBeenCalledTimes(1);
  });
});
