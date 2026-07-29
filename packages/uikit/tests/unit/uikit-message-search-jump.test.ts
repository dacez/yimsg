import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MSG_TYPE_TEXT } from '@yimsg/sdk';
import type { ConversationDescriptor, ConversationTarget, LocalConversation, Message } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import { jumpToMessageInConversation } from '../../src/app/views/chat/message-search';
import { openConversationAndJumpToMessage } from '../../src/app/views/chat/global-search';
import { openConversationShellForJump } from '../../src/app/views/chat/conversation-list';

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

/** 供 BoundedList 内部渲染用的最小假元素：本文件不关心真实渲染内容，只关心加载参数。 */
function makeFakeElement(): any {
  const el: any = {
    children: [] as unknown[],
    className: '',
    textContent: '',
    appendChild: (child: unknown) => { el.children.push(child); return child; },
    setAttribute: () => {},
    removeAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: () => { el.children.length = 0; },
  });
  el.ownerDocument = { createElement: () => makeFakeElement() };
  return el;
}

/** 供 BoundedList 挂监听用的最小假滚动容器：本文件不关心真实渲染，只关心加载参数。 */
function makeScrollElement() {
  const listeners = new Map<string, Array<() => void>>();
  const el = makeFakeElement();
  el.scrollTop = 0;
  el.scrollHeight = 0;
  el.clientHeight = 0;
  el.addEventListener = (type: string, handler: () => void) => {
    const handlers = listeners.get(type) ?? [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };
  el.ownerDocument = { createElement: () => makeFakeElement(), defaultView: undefined };
  return el;
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
  const messageListEl = makeScrollElement();
  const elements = new Map<string, unknown>([
    ['view-chat', viewChat],
    ['message-list', messageListEl],
  ]);

  const getMessages = vi.fn(async () => ({
    messages: [],
    page: { startCursor: '', endCursor: '', hasMoreBackward: true, hasMoreForward: true, total: -1 },
  }));

  const conversation: LocalConversation = { groupId: '0', friendUid: '2', lastSeq: 0, lastMessage: null };
  const descriptor: ConversationDescriptor = { key: 'u:2', kind: 'direct', id: '2', target: { toUid: '2' } };

  const app = {
    $: (id: string) => elements.get(id),
    dom: { querySelector: () => null },
    showToast: vi.fn(),
    t: (key: string) => key,
    registerBoundedList: () => () => {},
    registerDisposer: () => {},
    client: {
      getMessages,
      describeConversation: vi.fn(() => descriptor),
    },
    chatState: {
      currentConvKey: null as string | null,
      currentConversation: conversation as LocalConversation | null,
      messageList: null,
      messageGeneration: 0,
      currentMessages: [] as Message[],
      selectedMessageIds: new Set<string>(),
      pendingMessageIds: new Set<string>(),
      highlightMessageId: null as string | null,
    },
  } as unknown as AppInstance;

  return { app, viewChat, getMessages, descriptor };
}

describe('jumpToMessageInConversation（消息锚点跳转）', () => {
  it('跳转前移动端聊天面板尚未展示（如刚从聊天页返回会话列表）时，也要补上 mobile-showing-chat', async () => {
    const { app, viewChat, getMessages, descriptor } = createApp();
    expect(viewChat.hasClass('mobile-showing-chat')).toBe(false);

    const target: ConversationTarget = { toUid: '2' };
    await jumpToMessageInConversation(app, target, 'm-3');

    expect(viewChat.hasClass('mobile-showing-chat')).toBe(true);
    // 消息列表的 source 从 app.chatState.currentConversation 派生目标，
    // 与调用方传入的 target 应该一致（调用方已确保该会话是当前会话）。
    expect(getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ target: descriptor.target, around: 'm-3' }),
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
    const { app, viewChat, descriptor } = createApp();

    app.chatState.currentConvKey = descriptor.key;
    (app as unknown as { client: Record<string, unknown> }).client.describeMessageConversation = vi.fn(() => descriptor);

    // 模拟：mobile-showing-chat 已在返回会话列表时被移除，但 currentConvKey 仍是这个会话。
    expect(viewChat.hasClass('mobile-showing-chat')).toBe(false);

    await openConversationAndJumpToMessage(app, message(3, 'm-3'));

    expect(openConversationShellForJump).not.toHaveBeenCalled();
    expect(viewChat.hasClass('mobile-showing-chat')).toBe(true);
  });

  it('命中消息属于其它会话时正常走 shell 初始化', async () => {
    const { app, descriptor } = createApp();

    app.chatState.currentConvKey = 'u:3';
    (app as unknown as { client: Record<string, unknown> }).client.describeMessageConversation = vi.fn(() => descriptor);

    await openConversationAndJumpToMessage(app, message(3, 'm-3'));

    expect(openConversationShellForJump).toHaveBeenCalledTimes(1);
  });
});
