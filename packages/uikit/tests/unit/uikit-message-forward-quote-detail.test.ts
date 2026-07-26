import { describe, expect, it, vi } from 'vitest';
import { MSG_TYPE_FORWARD, MSG_TYPE_QUOTE, MSG_TYPE_TEXT } from '@yimsg/sdk';
import type { ConversationTarget, Message, MessageContentDescriptor } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import { createMessageWindow, setInitialMessagePage, type MessagePageResultLike } from '../../src/app/views/chat/message-page';
import { renderMessages } from '../../src/app/views/chat/message-list';

// 回归的 bug：转发消息气泡文案是"转发 N 条（点击查看）"、引用消息气泡本该能点开查看原文，
// 但两者点击都没有绑定任何跳转/展开逻辑——转发块压根没有点击事件，引用块的点击只是在原地
// 重复展示同一句预览摘要，从未真正打开新窗口查看内容。这里搭一套最小可运行的假 DOM，驱动
// message-list.ts 的真实渲染 + message-detail.ts 的真实弹窗逻辑，验证点击后确实按 msg_id
// 拉取完整原文并在弹窗中展示。

interface FakeNode {
  id: string;
  textContent: string;
  dataset: Record<string, string>;
  children: FakeNode[];
  parentElement: FakeNode | null;
  ownerDocument: { createElement(tag?: string): FakeNode } | null;
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
    textContent: '',
    dataset: {} as Record<string, string>,
    children: [] as FakeNode[],
    parentElement: null as FakeNode | null,
    ownerDocument: null as { createElement(tag?: string): FakeNode } | null,
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
  node.ownerDocument = { createElement: () => createFakeElement() };
  return node;
}

function findByClass(node: FakeNode, cls: string): FakeNode | null {
  if (node.className.split(' ').includes(cls)) return node;
  for (const child of node.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return null;
}

function findAllByClass(node: FakeNode, cls: string): FakeNode[] {
  const result: FakeNode[] = [];
  if (node.className.split(' ').includes(cls)) result.push(node);
  for (const child of node.children) result.push(...findAllByClass(child, cls));
  return result;
}

function textMessage(seq: number, messageId: string, text: string): Message {
  return {
    seq,
    messageId,
    senderId: '2',
    recipientId: '1',
    groupId: '0',
    messageType: MSG_TYPE_TEXT,
    body: { text: { text } },
    sentAt: seq,
  } as Message;
}

function forwardMessage(seq: number, msgIds: string[], title: string): Message {
  return {
    seq,
    messageId: `m-${seq}`,
    senderId: '1',
    recipientId: '2',
    groupId: '0',
    messageType: MSG_TYPE_FORWARD,
    body: { forward: { msg_ids: msgIds, title } },
    sentAt: seq,
  } as Message;
}

function quoteMessage(seq: number, quoteMsgId: string, preview: string, replyText: string): Message {
  return {
    seq,
    messageId: `m-${seq}`,
    senderId: '1',
    recipientId: '2',
    groupId: '0',
    messageType: MSG_TYPE_QUOTE,
    body: { quote: { quote_msg_id: quoteMsgId, quote_preview: preview, text: { text: replyText } } },
    sentAt: seq,
  } as Message;
}

// 最小化的 describeMessage 假实现：只覆盖本文件用到的三种消息类型，字段形状与真实的
// describeMessageContent（packages/sdk/src/internal/message-descriptor.ts）保持一致。
function fakeDescribeMessage(msg: Message): MessageContentDescriptor {
  const body = msg.body as { forward?: { msg_ids: string[]; title?: string }; quote?: { quote_msg_id: string; quote_preview?: string; text?: { text: string } }; text?: { text: string } };
  const base = { html: null, image: null, file: null, recall: null, mention: null };
  if (body.forward) {
    return {
      ...base,
      text: body.forward.title || '',
      bodyKind: MSG_TYPE_FORWARD,
      quote: null,
      forward: { messageIds: [...body.forward.msg_ids], title: body.forward.title || '' },
    } as MessageContentDescriptor;
  }
  if (body.quote) {
    return {
      ...base,
      text: body.quote.text?.text || '',
      bodyKind: MSG_TYPE_QUOTE,
      quote: { messageId: body.quote.quote_msg_id, preview: body.quote.quote_preview || '', text: body.quote.text?.text || '' },
      forward: null,
    } as MessageContentDescriptor;
  }
  return { ...base, text: body.text?.text || '', bodyKind: msg.messageType, quote: null, forward: null } as MessageContentDescriptor;
}

function pageResult(messages: Message[]): MessagePageResultLike {
  return {
    messages,
    page: {
      startCursor: messages.length ? `s-${messages[0].seq}` : '',
      endCursor: messages.length ? `e-${messages[messages.length - 1].seq}` : '',
      hasMoreBackward: false,
      hasMoreForward: false,
    },
  };
}

function createTestApp(messages: Message[]) {
  const root = createFakeElement();
  const messageList = createFakeElement();
  messageList.clientHeight = 500;
  messageList.scrollHeight = 500;
  root.appendChild(messageList);
  const modalOverlay = createFakeElement();
  modalOverlay.classList.add('hidden');
  const modalContent = createFakeElement();
  root.appendChild(modalOverlay);
  root.appendChild(modalContent);

  const elements = new Map<string, FakeNode>([
    ['message-list', messageList],
    ['modal-overlay', modalOverlay],
    ['modal-content', modalContent],
  ]);

  const getMessagesByIds = vi.fn(async (): Promise<Message[]> => []);

  const app = {
    $: (id: string) => elements.get(id) as unknown as HTMLElement,
    closeModal: () => { modalOverlay.classList.add('hidden'); },
    dom: {
      root: { querySelector: () => null },
      ownerDocument: {
        createElement: () => createFakeElement() as unknown as HTMLElement,
        body: { dataset: {} },
        defaultView: undefined,
      },
      layoutHost: { dataset: {} },
      getElementById: (id: string) => elements.get(id) as unknown as HTMLElement | null ?? null,
    },
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${vars.n}` : key),
    client: {
      getSessionSnapshot: () => ({ currentUid: '1' }),
      getUserInfos: () => new Map(),
      describeMessage: (msg: Message) => fakeDescribeMessage(msg),
      describeConversation: () => ({
        key: 'u:2',
        kind: 'direct' as const,
        id: '2',
        target: { toUid: '2' } as ConversationTarget,
      }),
      getMessagesByIds,
    },
    chatState: {
      currentConvKey: 'u:2',
      messageWindow: createMessageWindow(5),
      currentMessages: [] as Message[],
      messageListStickToBottom: true,
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
    },
  } as unknown as AppInstance;

  setInitialMessagePage(app, pageResult(messages));
  renderMessages(app);

  return { app, messageList, modalOverlay, modalContent, getMessagesByIds };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('转发消息点击查看', () => {
  it('点击"转发 N 条（点击查看）"块：按 msg_ids 拉取被转发消息全文并在弹窗逐条展示，已删除的条目用占位文案兜底', async () => {
    const forward = forwardMessage(1, ['a', 'b'], '转发标题');
    const { modalOverlay, modalContent, getMessagesByIds, messageList } = createTestApp([forward]);
    expect(modalOverlay.classList.contains('hidden')).toBe(true);

    getMessagesByIds.mockResolvedValueOnce([textMessage(100, 'a', 'hello a')]); // 'b' 已被删除，服务端不返回

    const block = findByClass(messageList, 'message-forward-block');
    expect(block).not.toBeNull();
    block!.dispatch('click');

    expect(getMessagesByIds).toHaveBeenCalledWith(['a', 'b']);
    await flushMicrotasks();

    expect(modalOverlay.classList.contains('hidden')).toBe(false);
    expect(modalContent.className).toContain('modal-content-wide');
    expect(findByClass(modalContent, 'modal-title')!.textContent).toBe('转发标题');

    const items = findAllByClass(modalContent, 'message-detail-item');
    expect(items).toHaveLength(2);
    expect(findByClass(items[0], 'message-bubble')!.textContent).toBe('hello a');
    expect(items[1].textContent).toBe('chat.forwardMessageNotFound');

    // 关闭按钮：还原弹窗宽度，并把 overlay 重新隐藏。
    const closeBtn = findByClass(modalContent, 'btn-secondary');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.textContent).toBe('common.close');
    closeBtn!.dispatch('click');
    expect(modalOverlay.classList.contains('hidden')).toBe(true);
    expect(modalContent.className).not.toContain('modal-content-wide');
  });
});

describe('引用消息点击查看', () => {
  it('点击引用预览块：按 quote_msg_id 拉取被引用原始消息全文并展示', async () => {
    const quote = quoteMessage(1, 'q1', '预览摘要', '这是回复');
    const { modalOverlay, modalContent, getMessagesByIds, messageList } = createTestApp([quote]);

    getMessagesByIds.mockResolvedValueOnce([textMessage(200, 'q1', '被引用的完整原文')]);

    const block = findByClass(messageList, 'message-quote-block');
    expect(block).not.toBeNull();
    block!.dispatch('click');

    expect(getMessagesByIds).toHaveBeenCalledWith(['q1']);
    await flushMicrotasks();

    expect(modalOverlay.classList.contains('hidden')).toBe(false);
    expect(modalContent.className).not.toContain('modal-content-wide');
    expect(findByClass(modalContent, 'modal-title')!.textContent).toBe('chat.quoteDetailTitle');

    const items = findAllByClass(modalContent, 'message-detail-item');
    expect(items).toHaveLength(1);
    expect(findByClass(items[0], 'message-bubble')!.textContent).toBe('被引用的完整原文');
  });

  it('被引用的原始消息已不存在时，退回展示引用预览摘要', async () => {
    const quote = quoteMessage(1, 'q1', '预览摘要', '这是回复');
    const { modalContent, getMessagesByIds, messageList } = createTestApp([quote]);

    getMessagesByIds.mockResolvedValueOnce([]);

    const block = findByClass(messageList, 'message-quote-block');
    block!.dispatch('click');
    await flushMicrotasks();

    const items = findAllByClass(modalContent, 'message-detail-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('chat.quoteMessageNotFound');
    expect(items[1].textContent).toBe('预览摘要');
  });
});
