import type { Message } from '@yimsg/sdk';
import {
  MSG_TYPE_FILE,
  MSG_TYPE_FORWARD,
  MSG_TYPE_IMAGE,
  MSG_TYPE_MARKDOWN,
  MSG_TYPE_QUOTE,
  MSG_TYPE_RECALL,
  MSG_TYPE_SYSTEM,
} from '@yimsg/sdk';
import {
  displayUserName,
  formatFileSize,
  formatTime,
} from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance, MessageQuery } from '../../app-instance';
import { canAutoClearUnreadCurrentConversation } from './helpers';
import { showMessageActionMenu } from './action-menu';
import { showForwardDetailModal, showQuoteDetailModal } from './message-detail';
import {
  currentConversation,
  formatForwardBlockText,
  recallPlaceholderText,
} from './helpers';
import { updateSelectionBar } from './selection';
import { setSafeHtml, setTrustedAnchorHref, setTrustedImageSrc, safeHtml } from '../../safe-dom';
import { createBoundedList, serverPageSource, type BoundedList, type RenderItemContext } from '../../bounded-list';
import { messageKey, sortUniqueBySeq, syncCurrentMessages } from './message-page';

const BOTTOM_SETTLE_FRAME_COUNT = 4;
// 距底部 50px 以内视为"贴底"。
const NEAR_BOTTOM_THRESHOLD_PX = 50;

export function isNearBottom(list: HTMLElement): boolean {
  return list.scrollTop + list.clientHeight >= list.scrollHeight - NEAR_BOTTOM_THRESHOLD_PX;
}

function scheduleFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => callback());
    return;
  }
  callback();
}

/**
 * 惰性创建当前会话消息列表 BoundedList 实例；同一个实例伴随 AppInstance 全程复用，
 * 切换会话时用 reset({ query }) 换到新目标，而不是重新构造（避免反复挂卸载滚动监听、
 * 反复创建 / 销毁提示条）。source 的 query.aroundMsgId 承载搜索跳转的锚点加载，
 * 不传时是普通"拉最新一页"。
 */
export function getMessageList(app: AppInstance): BoundedList<Message, MessageQuery> {
  if (app.chatState.messageList) return app.chatState.messageList;

  let windowItems: readonly Message[] = [];
  let senderMap: ReturnType<typeof app.client.getUserInfos> = new Map();

  const list = createBoundedList<Message, MessageQuery>({
    id: 'open-conversation-messages',
    scrollElement: app.$('message-list'),
    pageSize: APP_CONFIG.chat.messagePageSize,
    maxPages: APP_CONFIG.chat.messagePageMaxPages,
    register: (controller) => app.registerBoundedList(controller),
    isActive: () => Boolean(app.chatState.currentConvKey) && !app.$('view-chat').classList.contains('hidden'),
    initialQuery: {},
    source: serverPageSource<Awaited<ReturnType<typeof app.client.getMessages>>, Message, MessageQuery>(
      ({ cursor, backward, limit, query }) => {
        const conv = app.chatState.currentConversation;
        const target = conv ? app.client.describeConversation(conv).target : { toUid: '0' };
        if (cursor === undefined && query?.aroundMsgId) {
          return app.client.getMessages({ target, around: query.aroundMsgId, limit });
        }
        // reset() 固定以 cursor=undefined、backward=false 发起首页请求；但本列表
        // freshEdge='tail'，无游标时必须取"最新一页"，对应 getMessages 的
        // backward=true（从尾部往前取 limit 条），而不是字面透传的 backward=false
        // （那会从最早消息开始，取到最旧一页）。
        if (cursor === undefined) {
          return app.client.getMessages({ target, backward: true, limit });
        }
        return app.client.getMessages({ target, cursor, backward, limit });
      },
      (page) => ({
        items: page.messages,
        startCursor: page.page.startCursor,
        endCursor: page.page.endCursor,
        hasMoreBackward: page.page.hasMoreBackward,
        hasMoreForward: page.page.hasMoreForward,
      }),
    ),
    normalize: sortUniqueBySeq,
    identityOf: messageKey,
    freshEdge: 'tail',
    renderItem: (msg, ctx) => {
      if (ctx.index === 0) {
        const myUid = app.client.getSessionSnapshot().currentUid;
        const senderUids = new Set<string>();
        for (const m of windowItems) {
          const fromUid = m.senderId || '0';
          if (fromUid !== myUid && fromUid !== '0') senderUids.add(fromUid);
        }
        senderMap = app.client.getUserInfos([...senderUids]);
      }
      return renderMessageRow(app, msg, ctx, senderMap);
    },
    text: {
      loading: () => app.t('common.loading'),
      backwardBoundary: () => app.t('chat.reachedEarliest'),
      forwardBoundary: () => app.t('chat.reachedLatest'),
      updatePill: () => app.t('chat.jumpToLatest'),
      retry: () => app.t('common.retry'),
    },
    onItemsChanged: (items) => {
      windowItems = items;
      syncCurrentMessages(app, items);
      if (app.chatState.messageSelectionMode) updateSelectionBar(app);
    },
    onError: (_error, phase) => {
      if (phase === 'reset') app.showToast(app.t('chat.failedToLoadMessages'), 'error');
      else console.warn(`[yimsg/uikit] message list ${phase} failed:`, _error);
    },
  });

  app.chatState.messageList = list;
  app.registerDisposer(() => list.dispose());
  return list;
}

function renderMessageRow(
  app: AppInstance,
  msg: Message,
  ctx: RenderItemContext<Message>,
  senderMap: ReturnType<typeof app.client.getUserInfos>,
): HTMLElement[] {
  const myUid = app.client.getSessionSnapshot().currentUid;
  const activeConversation = currentConversation(app);
  const isGroup = activeConversation?.kind === 'group';
  const fromUid = msg.senderId || '0';
  const isSelf = fromUid === myUid;
  const isSystem = msg.messageType === MSG_TYPE_SYSTEM;

  if (isSystem) {
    const div = app.dom.ownerDocument.createElement('div');
    div.className = 'message-system'
      + (msg.messageId && msg.messageId === app.chatState.highlightMessageId ? ' msg-highlight' : '');
    div.dataset.msgId = msg.messageId;
    div.textContent = app.client.describeMessage(msg).text;
    return [div];
  }

  // 同一发送者不重复显示名字：上一条是系统消息时（发送者语境被打断）也要重新显示。
  const previous = ctx.previous;
  const previousSenderId = previous && previous.messageType !== MSG_TYPE_SYSTEM ? (previous.senderId || '0') : null;

  const elements: HTMLElement[] = [];
  if (isGroup && !isSelf && fromUid !== previousSenderId) {
    const sender = senderMap.get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    const label = app.dom.ownerDocument.createElement('div');
    label.className = 'message-sender';
    label.textContent = displayUserName(sender, fromUid);
    elements.push(label);
  }

  const row = app.dom.ownerDocument.createElement('div');
  const isPending = app.chatState.pendingMessageIds.has(msg.messageId);
  row.className = 'message-row' + (isSelf ? ' self' : '')
    + (isPending ? ' message-pending' : '')
    + (msg.messageId && msg.messageId === app.chatState.highlightMessageId ? ' msg-highlight' : '');
  row.dataset.seq = String(msg.seq);
  row.dataset.msgId = msg.messageId;
  row.setAttribute('aria-busy', isPending ? 'true' : 'false');
  const sender = senderMap.get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
  const fromName = isSelf ? app.t('chat.selfName') : displayUserName(sender, fromUid);

  if (!isPending) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showMessageActionMenu(app, row, msg, fromName, event.clientX, event.clientY);
    });
  }

  if (!isSelf) {
    const avatarDiv = app.dom.ownerDocument.createElement('div');
    avatarDiv.className = 'avatar avatar-sm';
    avatarDiv.innerHTML = app.avatarInnerHtml({ avatar: sender.avatarUrl, nickname: fromName });
    row.appendChild(avatarDiv);
  }

  if (app.chatState.messageSelectionMode && !isPending) {
    const checkbox = app.dom.ownerDocument.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'message-select-checkbox';
    checkbox.checked = app.chatState.selectedMessageIds.has(msg.messageId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) app.chatState.selectedMessageIds.add(msg.messageId);
      else app.chatState.selectedMessageIds.delete(msg.messageId);
      updateSelectionBar(app);
    });
    row.appendChild(checkbox);
  }

  const bubble = app.dom.ownerDocument.createElement('div');
  bubble.className = 'message-bubble';
  fillMessageBubble(app, bubble, msg);
  row.appendChild(bubble);

  if (isSelf && isPending) {
    const status = app.dom.ownerDocument.createElement('div');
    status.className = 'message-status message-status-sending';
    status.title = app.t('chat.sending');
    row.appendChild(status);
  }

  if (!app.chatState.messageSelectionMode && !isPending) {
    const actionsBtn = app.dom.ownerDocument.createElement('button');
    actionsBtn.className = 'message-actions-trigger';
    actionsBtn.type = 'button';
    actionsBtn.textContent = '⋯';
    actionsBtn.setAttribute('aria-label', app.t('chat.messageActionsAria'));
    actionsBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      showMessageActionMenu(app, actionsBtn, msg, fromName);
    });
    row.appendChild(actionsBtn);

    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let longPressFired = false;
    const startPress = () => {
      longPressFired = false;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        longPressFired = true;
        showMessageActionMenu(app, actionsBtn, msg, fromName);
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          try { navigator.vibrate(30); } catch { /* ignore */ }
        }
      }, 500);
    };
    const cancelPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    row.addEventListener('touchstart', () => {
      startPress();
    }, { passive: true });
    row.addEventListener('touchend', (event) => {
      if (longPressFired) {
        event.preventDefault();
      }
      cancelPress();
    });
    row.addEventListener('touchmove', cancelPress, { passive: true });
    row.addEventListener('touchcancel', cancelPress);

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const me = event as MouseEvent;
      showMessageActionMenu(app, actionsBtn, msg, fromName, me.clientX, me.clientY);
    });
  }

  const time = app.dom.ownerDocument.createElement('div');
  time.className = 'message-time';
  time.textContent = formatTime(msg.sentAt);
  row.appendChild(time);

  elements.push(row);
  return elements;
}

export function renderMessages(app: AppInstance): void {
  app.chatState.messageList?.render();
}

export function mediaUrl(kind: 'image' | 'file', mediaId: string): string {
  return `/media/${kind}/${mediaId}`;
}

export function fillMessageBubble(app: AppInstance, bubble: HTMLElement, msg: Message) {
  const details = app.client.describeMessage(msg);

  if (msg.messageType === MSG_TYPE_IMAGE) {
    const mediaId = details.image?.media_id || '';
    const img = app.dom.ownerDocument.createElement('img');
    img.className = 'message-image';
    img.alt = details.image?.caption || app.t('chat.previewImage');
    // 乐观发送的图片占位消息：media_id 是本条消息自己刚创建的本地 blob: 预览地址（尚无服务端
    // 真实 media_id），不是外部消息内容，直接使用而不经过面向远端内容的 setTrustedImageSrc 白名单。
    const isPendingLocalPreview = app.chatState.pendingMessageIds.has(msg.messageId) && mediaId.startsWith('blob:');
    if (isPendingLocalPreview) {
      img.src = mediaId;
    } else if (!mediaId || !setTrustedImageSrc(img, mediaUrl('image', mediaId))) {
      bubble.textContent = details.image?.caption || app.t('chat.previewImage');
      return;
    }
    img.addEventListener('click', () => {
      if (!isPendingLocalPreview && typeof window !== 'undefined') window.open(img.src, '_blank', 'noopener,noreferrer');
    });
    bubble.appendChild(img);
    return;
  }

  if (msg.messageType === MSG_TYPE_FILE) {
    const file = details.file;
    const anchor = app.dom.ownerDocument.createElement('a');
    anchor.className = 'message-file';
    anchor.target = '_blank';
    if (!file?.media_id || !setTrustedAnchorHref(anchor, mediaUrl('file', file.media_id))) {
      bubble.textContent = file?.name || app.t('chat.file');
      return;
    }
    anchor.download = file.name || app.t('chat.file');
    const icon = app.dom.ownerDocument.createElement('div');
    icon.className = 'message-file-icon';
    setSafeHtml(icon, safeHtml('<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'));
    const info = app.dom.ownerDocument.createElement('div');
    info.className = 'message-file-info';
    const name = app.dom.ownerDocument.createElement('div');
    name.className = 'message-file-name';
    name.textContent = file.name || app.t('chat.file');
    const size = app.dom.ownerDocument.createElement('div');
    size.className = 'message-file-size';
    size.textContent = formatFileSize(Number(file.size) || 0);
    info.append(name, size);
    anchor.append(icon, info);
    bubble.appendChild(anchor);
    return;
  }

  if (msg.messageType === MSG_TYPE_MARKDOWN) {
    const markdown = app.dom.ownerDocument.createElement('div');
    markdown.className = 'message-markdown';
    setSafeHtml(markdown, safeHtml(details.html || ''));
    bubble.appendChild(markdown);
    return;
  }

  if (msg.messageType === MSG_TYPE_FORWARD && details.forward) {
    const forward = details.forward;
    const forwardBlock = app.dom.ownerDocument.createElement('div');
    forwardBlock.className = 'message-forward-block';
    forwardBlock.textContent = formatForwardBlockText(app, forward.messageIds.length);
    forwardBlock.addEventListener('click', () => {
      void showForwardDetailModal(app, forward);
    });
    bubble.appendChild(forwardBlock);
    if (forward.title) {
      const title = app.dom.ownerDocument.createElement('div');
      title.className = 'message-forward-title';
      title.textContent = forward.title;
      bubble.appendChild(title);
    }
    return;
  }

  if (msg.messageType === MSG_TYPE_QUOTE && details.quote) {
    const quote = details.quote;
    const quoteBlock = app.dom.ownerDocument.createElement('div');
    quoteBlock.className = 'message-quote-block';
    quoteBlock.textContent = quote.preview;
    quoteBlock.addEventListener('click', () => {
      void showQuoteDetailModal(app, quote);
    });
    bubble.appendChild(quoteBlock);
    const reply = app.dom.ownerDocument.createElement('div');
    reply.textContent = quote.text;
    bubble.appendChild(reply);
    return;
  }

  if (msg.messageType === MSG_TYPE_RECALL) {
    bubble.textContent = recallPlaceholderText(app, msg);
    return;
  }

  // 普通文本/系统消息直接展示 describeMessage 文本。
  bubble.textContent = details.text;
}

// 内容（特别是图片）可能在渲染后的若干帧内才完成排版，多帧重设 scrollTop 才能真正到底；
// BoundedList 自身在 freshEdge='tail' 且贴底时会在图片等异步增高内容 load 完成后自动摁回底部
// （§4.6），这里只需要在"本端发送 / 转发成功"这类不经过 reset 的场景显式滚一次。
export function scrollToBottom(app: AppInstance) {
  const list = app.$('message-list');
  let remainingFrames = BOTTOM_SETTLE_FRAME_COUNT;
  const settle = () => {
    list.scrollTop = list.scrollHeight;
    remainingFrames--;
    if (remainingFrames > 0) scheduleFrame(settle);
  };
  settle();
}

// removeMessage 收到 messages:deleted 信号时就地从消息窗口删除该消息，不重拉。
export function removeMessage(app: AppInstance, messageId: string): void {
  app.chatState.messageList?.removeLocal(messageId);
}

// refreshOpenConversation 收到 messages:received 重绘信号时刷新打开中的会话。
// 不消费通知 payload：BoundedList 的 invalidate 决策树统一处理"贴底直接追平"还是
// "点亮提示条"，替代原来手写的贴边判断与 pendingNewMessageCount 记账。
export async function refreshOpenConversation(app: AppInstance): Promise<void> {
  if (!app.chatState.currentConvKey) return;
  if (app.$('view-chat').classList.contains('hidden')) return;
  app.chatState.messageList?.invalidate();

  if (canAutoClearUnreadCurrentConversation(app) && isNearBottom(app.$('message-list'))) {
    const target = currentConversation(app)?.target;
    if (target) app.client.clearUnread(target).catch(() => {});
  }
}
