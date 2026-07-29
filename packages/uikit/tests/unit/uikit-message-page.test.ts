import { describe, expect, it } from 'vitest';
import { MSG_TYPE_TEXT } from '@yimsg/sdk';
import { STATUS_DELETED } from '@yimsg/sdk/uikit-internal';
import type { Message } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import {
  appendLiveMessageToPage,
  messageKey,
  removeMessageFromPage,
  resetMessagePage,
  sortUniqueBySeq,
  syncCurrentMessages,
} from '../../src/app/views/chat/message-page';

// message-page.ts 现在只是 chatState 上的一层薄封装：真正的分页记账（游标、hasMore、
// pageSize×maxPages 硬上限、跨页去重）全部收敛进 BoundedList 自身的 PageWindow，
// 由 packages/uikit/tests/unit/bounded-list/page-window.test.ts 覆盖。这里只测试
// message-page.ts 自己仍然承担的三件事：seq 归一化、外部只读投影同步、以及
// upsertLocal/removeLocal 委托。

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

describe('messageKey / sortUniqueBySeq（归一化）', () => {
  it('messageKey 优先取 messageId，缺失时退化为 seq 字符串', () => {
    expect(messageKey(message(5))).toBe('m-5');
    expect(messageKey({ ...message(5), messageId: '' } as Message)).toBe('5');
  });

  it('同 messageId 保留最新状态、删除态剔除、按 seq 升序', () => {
    const dup = message(5);
    const result = sortUniqueBySeq([message(3), message(1), dup, message(1), message(2, STATUS_DELETED)]);
    expect(result.map((m) => m.seq)).toEqual([1, 3, 5]);
  });
});

function appWithMessages(): AppInstance {
  return {
    chatState: {
      highlightMessageId: 'm-1',
      messageGeneration: 0,
      currentMessages: [] as Message[],
      selectedMessageIds: new Set<string>(['m-1', 'm-2']),
      pendingMessageIds: new Set<string>(['m-1']),
      messageList: {
        upsertLocal: () => {},
        removeLocal: () => false,
      },
    },
  } as unknown as AppInstance;
}

describe('resetMessagePage', () => {
  it('清空高亮 / 选中 / 待发送状态并递增世代计数器', () => {
    const app = appWithMessages();
    const generation = resetMessagePage(app);
    expect(generation).toBe(1);
    expect(app.chatState.highlightMessageId).toBeNull();
    expect(app.chatState.selectedMessageIds.size).toBe(0);
    expect(app.chatState.pendingMessageIds.size).toBe(0);
    expect(resetMessagePage(app)).toBe(2);
  });
});

describe('syncCurrentMessages', () => {
  it('同步窗口投影并修剪已经滚出窗口的选中 id', () => {
    const app = appWithMessages();
    syncCurrentMessages(app, [message(2)]);
    expect(app.chatState.currentMessages.map((m) => m.seq)).toEqual([2]);
    // 'm-1' 已经不在最新窗口投影里，应该被修剪；'m-2' 仍然保留。
    expect([...app.chatState.selectedMessageIds]).toEqual(['m-2']);
  });

  it('选中集为空时不做任何多余的遍历（幂等）', () => {
    const app = appWithMessages();
    app.chatState.selectedMessageIds.clear();
    syncCurrentMessages(app, [message(9)]);
    expect(app.chatState.selectedMessageIds.size).toBe(0);
  });
});

describe('appendLiveMessageToPage / removeMessageFromPage', () => {
  it('委托给 chatState.messageList 的 upsertLocal / removeLocal', () => {
    const upserted: Message[] = [];
    let removedId: string | null = null;
    const app = {
      chatState: {
        messageList: {
          upsertLocal: (m: Message) => { upserted.push(m); },
          removeLocal: (id: string) => { removedId = id; return true; },
        },
      },
    } as unknown as AppInstance;

    appendLiveMessageToPage(app, message(7));
    expect(upserted.map((m) => m.seq)).toEqual([7]);

    expect(removeMessageFromPage(app, 'm-7')).toBe(true);
    expect(removedId).toBe('m-7');
  });

  it('messageList 尚未创建时安全地退化为无操作 / 未命中', () => {
    const app = { chatState: { messageList: null } } as unknown as AppInstance;
    expect(() => appendLiveMessageToPage(app, message(1))).not.toThrow();
    expect(removeMessageFromPage(app, 'm-1')).toBe(false);
  });
});
