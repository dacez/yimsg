import { describe, expect, it, vi } from 'vitest';
import { MSG_TYPE_SYSTEM } from '@yimsg/sdk';
import type { ConversationTarget, Message } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import { createMessageWindow, setInitialMessagePage, type MessagePageResultLike } from '../../src/app/views/chat/message-page';
import {
  isNearBottom,
  refreshOpenConversation,
  renderMessages,
} from '../../src/app/views/chat/message-list';

// 本文件回归的 bug：上翻阅读中收到新消息会点亮"新消息"提示条，点击提示条能正确追平并隐藏，
// 但用户不点击、自己把消息列表滑到底部时，提示条曾经不会消失——根因是标记"有新消息"时只
// 点亮了提示条，没有让 BoundedStreamWindow 拿到最新的 hasMoreAfter 快照，滚动到底也就
// 触发不了任何追平动作。这里搭一套最小可运行的假 DOM，驱动 message-list.ts 的真实渲染/
// 追平逻辑（不 mock renderMessages），从而在单测里也能验证提示条的显示/隐藏是否符合预期。

interface FakeNode {
  id: string;
  type: string;
  textContent: string;
  dataset: Record<string, string>;
  children: FakeNode[];
  parentElement: FakeNode | null;
  ownerDocument: { createElement(): FakeNode } | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  classList: {
    contains(cls: string): boolean;
    add(cls: string): void;
    remove(cls: string): void;
    toggle(cls: string, force?: boolean): void;
  };
  listeners: Map<string, Array<() => void>>;
  className: string;
  appendChild(child: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, handler: () => void): void;
  dispatch(type: string): void;
}

function createFakeElement(): FakeNode {
  let classes = new Set<string>();
  let html = '';
  const attributes = new Map<string, string>();
  const node = {
    id: '',
    type: '',
    textContent: '',
    dataset: {} as Record<string, string>,
    children: [] as FakeNode[],
    parentElement: null as FakeNode | null,
    ownerDocument: null as { createElement(): FakeNode } | null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    listeners: new Map<string, Array<() => void>>(),
    classList: {
      contains: (cls: string) => classes.has(cls),
      add: (cls: string) => { classes.add(cls); },
      remove: (cls: string) => { classes.delete(cls); },
      toggle: (cls: string, force?: boolean) => {
        const next = force ?? !classes.has(cls);
        if (next) classes.add(cls); else classes.delete(cls);
      },
    },
    appendChild(child: FakeNode) {
      node.children.push(child);
      child.parentElement = node;
      return child;
    },
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    getAttribute(name: string) { return attributes.get(name) ?? null; },
    addEventListener(type: string, handler: () => void) {
      const handlers = node.listeners.get(type) ?? [];
      handlers.push(handler);
      node.listeners.set(type, handlers);
    },
    dispatch(type: string) {
      for (const handler of node.listeners.get(type) ?? []) handler();
    },
  } as unknown as FakeNode;
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (value: string) => { classes = new Set(String(value).split(' ').filter(Boolean)); },
  });
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set: (value: string) => { html = value; if (value === '') node.children.length = 0; },
  });
  // applyRender 用 (scrollElement/contentElement).ownerDocument.createElement 造边界提示节点。
  node.ownerDocument = { createElement: () => createFakeElement() };
  return node;
}

function findById(node: FakeNode, id: string): FakeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function systemMessage(seq: number): Message {
  return {
    seq,
    messageId: `m-${seq}`,
    senderId: '0',
    recipientId: '2',
    groupId: '0',
    messageType: MSG_TYPE_SYSTEM,
    body: {} as Message['body'],
    sentAt: seq,
  } as Message;
}

function pageResult(messages: Message[], opts: { hasMoreBackward?: boolean; hasMoreForward?: boolean } = {}): MessagePageResultLike {
  return {
    messages,
    page: {
      startCursor: messages.length ? `s-${messages[0].seq}` : '',
      endCursor: messages.length ? `e-${messages[messages.length - 1].seq}` : '',
      hasMoreBackward: opts.hasMoreBackward ?? false,
      hasMoreForward: opts.hasMoreForward ?? false,
    },
  };
}

function createTestApp() {
  const root = createFakeElement();
  const messageListParent = createFakeElement();
  const messageList = createFakeElement();
  messageList.clientHeight = 500;
  messageList.scrollHeight = 2000;
  messageList.scrollTop = 0;
  root.appendChild(messageListParent);
  messageListParent.appendChild(messageList);

  const viewChat = createFakeElement();

  const elements = new Map<string, FakeNode>([
    ['message-list', messageList],
    ['view-chat', viewChat],
  ]);

  const getMessages = vi.fn(async (): Promise<{ messages: Message[]; page: { startCursor: string; endCursor: string; hasMoreBackward: boolean; hasMoreForward: boolean } }> => ({
    messages: [systemMessage(100)],
    page: { startCursor: 's-100', endCursor: 'e-100', hasMoreBackward: true, hasMoreForward: false },
  }));
  const clearUnread = vi.fn(async () => {});

  const app = {
    $: (id: string) => elements.get(id) as unknown as HTMLElement,
    dom: {
      root: { querySelector: () => null },
      ownerDocument: {
        createElement: () => createFakeElement() as unknown as HTMLElement,
        body: { dataset: {} },
        defaultView: undefined,
      },
      layoutHost: { dataset: {} },
      getElementById: (id: string) => findById(root, id) as unknown as HTMLElement | null,
    },
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${vars.n}` : key),
    client: {
      getSessionSnapshot: () => ({ currentUid: '1' }),
      getUserInfos: () => new Map(),
      describeMessage: (msg: Message) => ({ text: msg.messageId }),
      describeConversation: () => ({
        key: 'u:2',
        kind: 'direct' as const,
        id: '2',
        target: { toUid: '2' } as ConversationTarget,
      }),
      getMessages,
      clearUnread,
    },
    chatState: {
      currentConvKey: 'u:2',
      messageWindow: createMessageWindow(5),
      currentMessages: [] as Message[],
      loadingMoreMessages: false,
      loadingNewerMessages: false,
      messagePageHasOlder: false,
      messagePageHasNewer: false,
      messagePageRequestId: 0,
      pendingNewMessageCount: 0,
      highlightMessageId: null,
      messageSelectionMode: false,
      selectedMessageIds: new Set<string>(),
      pendingMessageIds: new Set<string>(),
      expandedQuoteMessageIds: new Set<string>(),
    },
  } as unknown as AppInstance;

  // 通过真实的 setInitialMessagePage 灌入窗口，而不是直接手写 currentMessages：
  // markMessagesHasNewer 等函数会用窗口投影覆盖 currentMessages，直接手写会在
  // 第一次 syncFromWindow 时被空窗口悄悄冲掉。
  setInitialMessagePage(app, pageResult([systemMessage(1)]));

  return { app, messageList, getMessages, clearUnread };
}

function pill(app: AppInstance) {
  return app.dom.getElementById('new-message-pill') as unknown as FakeNode | null;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('message-list 新消息提示条（贴底追平）', () => {
  it('上翻阅读中收到新消息：点亮提示条，并让底部触界状态跟着刷新（不再是"已到最新"的旧快照）', () => {
    const { app, messageList } = createTestApp();
    renderMessages(app); // 先建立一次真实渲染，注册 onScroll 监听。
    expect(isNearBottom(messageList as unknown as HTMLElement)).toBe(false);

    void refreshOpenConversation(app);

    expect(app.chatState.pendingNewMessageCount).toBe(1);
    expect(app.chatState.messagePageHasNewer).toBe(true);
    const p = pill(app);
    expect(p).not.toBeNull();
    expect(p!.classList.contains('hidden')).toBe(false);

    // hasMoreAfter 已经是 true：底部不应该再渲染"已到最新"边界提示。
    const lastChild = messageList.children[messageList.children.length - 1];
    expect(lastChild.textContent).not.toBe('chat.reachedLatest');
  });

  it('提示条亮起后，用户不点击、自己把列表滑到底部：提示条必须消失', async () => {
    const { app, messageList, getMessages } = createTestApp();
    renderMessages(app);
    void refreshOpenConversation(app);
    expect(pill(app)!.classList.contains('hidden')).toBe(false);

    // 模拟"直接上滑拉最新消息"：滚动到底部并派发 scroll 事件，不点击提示条。
    messageList.scrollTop = messageList.scrollHeight;
    messageList.dispatch('scroll');
    await flushMicrotasks();

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(app.chatState.pendingNewMessageCount).toBe(0);
    expect(app.chatState.messagePageHasNewer).toBe(false);
    expect(pill(app)!.classList.contains('hidden')).toBe(true);
  });

  it('没有待追平的新消息时，滑到底部不应该触发多余的追平请求', async () => {
    const { app, messageList, getMessages } = createTestApp();
    renderMessages(app);
    expect(app.chatState.pendingNewMessageCount).toBe(0);

    messageList.scrollTop = messageList.scrollHeight;
    messageList.dispatch('scroll');
    await flushMicrotasks();

    expect(getMessages).not.toHaveBeenCalled();
  });

  it('追平请求进行中时重复触发（连续滚动）不会并发发起第二次请求', async () => {
    const { app, messageList, getMessages } = createTestApp();
    let resolveFetch: (() => void) | null = null;
    getMessages.mockImplementation(() => new Promise((resolve) => {
      resolveFetch = () => resolve({
        messages: [systemMessage(100)],
        page: { startCursor: 's-100', endCursor: 'e-100', hasMoreBackward: true, hasMoreForward: false },
      });
    }));

    renderMessages(app);
    void refreshOpenConversation(app);
    expect(pill(app)!.classList.contains('hidden')).toBe(false);

    messageList.scrollTop = messageList.scrollHeight;
    messageList.dispatch('scroll');
    await flushMicrotasks();
    // 请求尚未返回时再次滚动，不应叠加发起第二次请求。
    messageList.dispatch('scroll');
    await flushMicrotasks();

    expect(getMessages).toHaveBeenCalledTimes(1);

    resolveFetch!();
    await flushMicrotasks();
    expect(app.chatState.pendingNewMessageCount).toBe(0);
    expect(pill(app)!.classList.contains('hidden')).toBe(true);
  });
});
