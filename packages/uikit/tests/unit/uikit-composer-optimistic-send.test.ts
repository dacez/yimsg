import { describe, expect, it, vi } from 'vitest';
import { MSG_TYPE_IMAGE, MSG_TYPE_TEXT } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import { appendLiveMessageToPage } from '../../src/app/views/chat/message-page';
import { sendMessage, uploadAndSend } from '../../src/app/views/chat/composer';

/** 手动可控的 Promise：测试用它精确摆放"网络往返尚未完成"这一时刻。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * appendLiveMessageToPage / removeMessageFromPage 现在只是 app.chatState.messageList
 * 的薄封装（见 message-page.ts），本测试只关心 composer.ts 的乐观发送编排本身
 * （占位消息插入 / 替换 / 撤回），不需要真正的 BoundedList 与滚动容器，
 * 这里用一个只操作 currentMessages 数组的最小假实现顶替真实窗口。
 */
function createFakeMessageList(chatState: { currentMessages: { messageId: string }[] }) {
  return {
    upsertLocal(message: { messageId: string }): void {
      const idx = chatState.currentMessages.findIndex((m) => m.messageId === message.messageId);
      if (idx >= 0) chatState.currentMessages[idx] = message;
      else chatState.currentMessages.push(message);
    },
    removeLocal(id: string): boolean {
      const idx = chatState.currentMessages.findIndex((m) => m.messageId === id);
      if (idx < 0) return false;
      chatState.currentMessages.splice(idx, 1);
      return true;
    },
  };
}

function createApp(sendText: (...args: unknown[]) => Promise<unknown>) {
  const renderMessages = vi.fn();
  const scrollToBottom = vi.fn();
  const showToast = vi.fn();
  const input = { value: '好积极了', disabled: false };

  const chatState = {
    currentConvKey: 'u:2',
    currentMessages: [] as { messageId: string }[],
    composerMentions: new Map<string, string>(),
    composerMentionAll: false,
    composerMarkdownMode: false,
    composerQuote: null,
    pendingMessageIds: new Set<string>(),
    selectedMessageIds: new Set<string>(),
  };
  const app = {
    chatState: { ...chatState, messageList: createFakeMessageList(chatState) },
    client: {
      describeConversation: () => ({ target: { toUid: '2' }, kind: 'dm', id: '2' }),
      validateTextMessage: () => {},
      getSessionSnapshot: () => ({ currentUid: '1' }),
      sendText,
    },
    views: { chat: { renderMessages, scrollToBottom } },
    showToast,
    t: (key: string) => key,
    $: (id: string) => (id === 'msg-input' ? input : ({} as unknown)),
  };

  return { app: app as unknown as AppInstance, input, showToast };
}

function createUploadApp(client: {
  uploadFile: (...args: unknown[]) => Promise<{ mediaId: string; size: number }>;
  sendImage?: (...args: unknown[]) => Promise<unknown>;
  sendFile?: (...args: unknown[]) => Promise<unknown>;
}) {
  const renderMessages = vi.fn();
  const scrollToBottom = vi.fn();
  const showToast = vi.fn();

  const chatState = {
    currentConvKey: 'u:2',
    currentMessages: [] as { messageId: string }[],
    pendingMessageIds: new Set<string>(),
    selectedMessageIds: new Set<string>(),
  };
  const app = {
    chatState: { ...chatState, messageList: createFakeMessageList(chatState) },
    client: {
      describeConversation: () => ({ target: { toUid: '2' }, kind: 'dm', id: '2' }),
      getSessionSnapshot: () => ({ currentUid: '1' }),
      ...client,
    },
    views: { chat: { renderMessages, scrollToBottom } },
    showToast,
    t: (key: string) => key,
    $: () => ({ disabled: false }),
  };

  return { app: app as unknown as AppInstance, showToast };
}

describe('composer 乐观发送', () => {
  it('发送发起后立即插入发送中占位消息，resolve 后按临时 id 换成真实消息', async () => {
    const { promise, resolve } = deferred<{ message: unknown; messageId: string; seq: number }>();
    const { app, input } = createApp(() => promise);

    const sendCall = sendMessage(app);

    // 网络请求尚未 resolve：占位消息已经同步插入，输入框已清空。
    expect(input.value).toBe('');
    expect(app.chatState.currentMessages).toHaveLength(1);
    const placeholder = app.chatState.currentMessages[0] as { messageId: string; body: unknown };
    expect(app.chatState.pendingMessageIds.has(placeholder.messageId)).toBe(true);
    expect((placeholder.body as { text: { text: string } }).text.text).toBe('好积极了');

    const realMessage = {
      seq: 42,
      messageId: 'real-msg-id',
      senderId: '1',
      recipientId: '2',
      groupId: '0',
      messageType: MSG_TYPE_TEXT,
      body: { text: { text: '好积极了' } },
      sentAt: Date.now(),
    };
    resolve({ seq: 42, messageId: 'real-msg-id', message: realMessage });
    await sendCall;

    expect(app.chatState.currentMessages).toHaveLength(1);
    expect(app.chatState.currentMessages[0].messageId).toBe('real-msg-id');
    expect(app.chatState.pendingMessageIds.size).toBe(0);
  });

  it('多选中的占位消息落地后把选中状态迁移到真实消息 id', async () => {
    const { promise, resolve } = deferred<{ message: unknown; messageId: string; seq: number }>();
    const { app } = createApp(() => promise);
    const existingMessage = {
      seq: 1,
      messageId: 'existing-selected-msg-id',
      senderId: '2',
      recipientId: '1',
      groupId: '0',
      messageType: MSG_TYPE_TEXT,
      body: { text: { text: '先前消息' } },
      sentAt: 1,
    };
    appendLiveMessageToPage(app, existingMessage);
    app.chatState.selectedMessageIds.add(existingMessage.messageId);

    const sendCall = sendMessage(app);
    const placeholder = app.chatState.currentMessages.find(
      (message) => (message as { messageId: string }).messageId.startsWith('~pending-'),
    ) as { messageId: string };
    app.chatState.selectedMessageIds.add(placeholder.messageId);

    const realMessage = {
      seq: 43,
      messageId: 'real-selected-msg-id',
      senderId: '1',
      recipientId: '2',
      groupId: '0',
      messageType: MSG_TYPE_TEXT,
      body: { text: { text: '好积极了' } },
      sentAt: Date.now(),
    };
    resolve({ seq: 43, messageId: realMessage.messageId, message: realMessage });
    await sendCall;

    expect(app.chatState.selectedMessageIds.has(placeholder.messageId)).toBe(false);
    expect(app.chatState.selectedMessageIds).toEqual(new Set([existingMessage.messageId, realMessage.messageId]));
  });

  it('发送失败时把占位消息撤回并提示报错', async () => {
    const { promise, reject } = deferred<{ message: unknown }>();
    const { app, showToast } = createApp(() => promise);

    const sendCall = sendMessage(app);
    expect(app.chatState.currentMessages).toHaveLength(1);
    const placeholder = app.chatState.currentMessages[0] as { messageId: string };
    app.chatState.selectedMessageIds.add(placeholder.messageId);

    reject(new Error('网络异常'));
    await sendCall;

    expect(app.chatState.currentMessages).toHaveLength(0);
    expect(app.chatState.pendingMessageIds.size).toBe(0);
    expect(app.chatState.selectedMessageIds.size).toBe(0);
    expect(showToast).toHaveBeenCalledOnce();
  });

  it('上传图片时立即用本地 blob 预览占位，上传+发送落地后换成真实消息并释放预览', async () => {
    const uploadResult = deferred<{ mediaId: string; size: number }>();
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const { app } = createUploadApp({
      uploadFile: () => uploadResult.promise,
      sendImage: async (_target: unknown, input: { mediaId: string; size: number; mime: string }) => ({
        seq: 10,
        messageId: 'real-img-id',
        message: {
          seq: 10,
          messageId: 'real-img-id',
          senderId: '1',
          recipientId: '2',
          groupId: '0',
          messageType: MSG_TYPE_IMAGE,
          body: { image: { media_id: input.mediaId, size: input.size, width: 0, height: 0, mime: input.mime, caption: '' } },
          sentAt: Date.now(),
        },
      }),
    });

    const file = new File(['fake-image-bytes'], 'pic.png', { type: 'image/png' });
    const sendCall = uploadAndSend(app, file, 'image');

    // 上传尚未完成：占位消息已经用本地 blob: 预览地址插入，标记为发送中。
    expect(app.chatState.currentMessages).toHaveLength(1);
    const placeholder = app.chatState.currentMessages[0] as { messageId: string; body: { image: { media_id: string } } };
    expect(app.chatState.pendingMessageIds.has(placeholder.messageId)).toBe(true);
    expect(placeholder.body.image.media_id.startsWith('blob:')).toBe(true);

    uploadResult.resolve({ mediaId: 'server-media-1', size: file.size });
    await sendCall;

    expect(app.chatState.currentMessages).toHaveLength(1);
    expect(app.chatState.currentMessages[0].messageId).toBe('real-img-id');
    expect(app.chatState.pendingMessageIds.size).toBe(0);
    expect(revokeSpy).toHaveBeenCalled();
  });

  it('上传文件失败时把占位消息撤回并提示报错', async () => {
    const uploadResult = deferred<{ mediaId: string; size: number }>();
    const { app, showToast } = createUploadApp({
      uploadFile: () => uploadResult.promise,
      sendFile: vi.fn(),
    });

    const file = new File(['fake-file-bytes'], 'doc.pdf', { type: 'application/pdf' });
    const sendCall = uploadAndSend(app, file, 'file');
    expect(app.chatState.currentMessages).toHaveLength(1);

    uploadResult.reject(new Error('上传超时'));
    await sendCall;

    expect(app.chatState.currentMessages).toHaveLength(0);
    expect(app.chatState.pendingMessageIds.size).toBe(0);
    expect(showToast).toHaveBeenCalledOnce();
  });
});
