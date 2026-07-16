import { describe, expect, it } from 'vitest';
import { MSG_TYPE_TEXT } from '@yimsg/sdk';
import { STATUS_DELETED } from '@yimsg/sdk/uikit-internal';
import type { Message } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import {
  appendLiveMessageToPage,
  appendNewerMessagesToPage,
  createMessageWindow,
  markMessagesHasNewer,
  messageBackwardCursor,
  messageForwardCursor,
  prependOlderMessagesToPage,
  resetMessagePage,
  setInitialMessagePage,
  type MessagePageResultLike,
} from '../../src/app/views/chat/message-page';

function message(seq: number, status = 0): Message {
  return {
    seq,
    messageId: `m-${seq}`,
    senderId: '1',
    recipientId: '2',
    groupId: '0',
    messageType: MSG_TYPE_TEXT,
    content: `msg-${seq}`,
    sentAt: seq,
    status,
  } as Message;
}

function range(start: number, end: number): Message[] {
  return Array.from({ length: end - start + 1 }, (_, index) => message(start + index));
}

function pageResult(
  messages: Message[],
  opts: { hasMoreBackward?: boolean; hasMoreForward?: boolean } = {},
): MessagePageResultLike {
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

const MAX_PAGES = 3;

function appWithMessages(): AppInstance {
  return {
    chatState: {
      messageWindow: createMessageWindow(MAX_PAGES),
      currentMessages: [],
      loadingMoreMessages: false,
      loadingNewerMessages: false,
      messagePageHasOlder: false,
      messagePageHasNewer: false,
      messagePageRequestId: 0,
      pendingNewMessageCount: 0,
      selectedMessageIds: new Set<string>(),
      expandedQuoteMessageIds: new Set<string>(),
    },
  } as unknown as AppInstance;
}

describe('message page (按页边界游标记账)', () => {
  it('setInitial 同步窗口投影、hasMore 与边界游标', () => {
    const app = appWithMessages();
    setInitialMessagePage(app, pageResult(range(1, 30), { hasMoreBackward: true }));

    expect(app.chatState.currentMessages).toHaveLength(30);
    expect(app.chatState.currentMessages[0].seq).toBe(1);
    expect(app.chatState.messagePageHasOlder).toBe(true);
    expect(app.chatState.messagePageHasNewer).toBe(false);
    expect(messageBackwardCursor(app)).toBe('s-1');
    expect(messageForwardCursor(app)).toBe('e-30');
  });

  it('归一化：同 messageId 去重、删除态剔除、按 seq 升序', () => {
    const app = appWithMessages();
    const dup = message(5);
    setInitialMessagePage(app, pageResult([message(3), message(1), dup, message(1), message(2, STATUS_DELETED)]));
    expect(app.chatState.currentMessages.map((m) => m.seq)).toEqual([1, 3, 5]);
  });

  it('appendForward 超过窗口页数上限时整页裁旧并标记 hasOlder', () => {
    const app = appWithMessages();
    setInitialMessagePage(app, pageResult(range(1, 30), { hasMoreForward: true }));
    appendNewerMessagesToPage(app, pageResult(range(31, 60), { hasMoreForward: true }));
    appendNewerMessagesToPage(app, pageResult(range(61, 90), { hasMoreForward: true }));
    expect(app.chatState.currentMessages).toHaveLength(90);

    // 第 4 页触发整页裁首（MAX_PAGES=3）。
    appendNewerMessagesToPage(app, pageResult(range(91, 120), { hasMoreForward: false }));
    expect(app.chatState.currentMessages).toHaveLength(90);
    expect(app.chatState.currentMessages[0].seq).toBe(31);
    expect(app.chatState.messagePageHasOlder).toBe(true);
    expect(app.chatState.messagePageHasNewer).toBe(false);
    expect(messageForwardCursor(app)).toBe('e-120');
  });

  it('prependBackward 超过上限时整页裁新并标记 hasNewer', () => {
    const app = appWithMessages();
    setInitialMessagePage(app, pageResult(range(91, 120), { hasMoreBackward: true }));
    prependOlderMessagesToPage(app, pageResult(range(61, 90), { hasMoreBackward: true }));
    prependOlderMessagesToPage(app, pageResult(range(31, 60), { hasMoreBackward: true }));
    prependOlderMessagesToPage(app, pageResult(range(1, 30), { hasMoreBackward: false }));

    expect(app.chatState.currentMessages).toHaveLength(90);
    expect(app.chatState.currentMessages[0].seq).toBe(1);
    expect(app.chatState.messagePageHasOlder).toBe(false);
    expect(app.chatState.messagePageHasNewer).toBe(true);
    expect(messageBackwardCursor(app)).toBe('s-1');
  });

  it('appendLive 追加到尾页并保持贴底（hasNewer=false）', () => {
    const app = appWithMessages();
    setInitialMessagePage(app, pageResult(range(1, 30)));
    appendLiveMessageToPage(app, message(31));
    expect(app.chatState.currentMessages[app.chatState.currentMessages.length - 1].seq).toBe(31);
    expect(app.chatState.messagePageHasNewer).toBe(false);
  });

  it('markMessagesHasNewer 标记尾部之后有更新', () => {
    const app = appWithMessages();
    setInitialMessagePage(app, pageResult(range(1, 30)));
    markMessagesHasNewer(app);
    expect(app.chatState.messagePageHasNewer).toBe(true);
  });

  it('reset 清空窗口与状态', () => {
    const app = appWithMessages();
    setInitialMessagePage(app, pageResult(range(1, 30), { hasMoreBackward: true }));
    const requestId = resetMessagePage(app);
    expect(app.chatState.currentMessages).toEqual([]);
    expect(app.chatState.messagePageHasOlder).toBe(false);
    expect(app.chatState.messagePageHasNewer).toBe(false);
    expect(messageBackwardCursor(app)).toBe('');
    expect(requestId).toBe(1);
  });
});
