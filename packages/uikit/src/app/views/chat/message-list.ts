import type { Message } from '@yimsg/sdk';
import {
  MSG_TYPE_FILE,
  MSG_TYPE_FORWARD,
  MSG_TYPE_IMAGE,
  MSG_TYPE_MARKDOWN,
  MSG_TYPE_QUOTE,
  MSG_TYPE_SYSTEM,
} from '@yimsg/sdk';
import {
  displayUserName,
  formatFileSize,
  formatTime,
} from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from '../../app-instance';
import { canAutoClearUnreadCurrentConversation } from './helpers';
import { showMessageActionMenu } from './action-menu';
import {
  currentConversation,
  formatForwardBlockText,
} from './helpers';
import { updateSelectionBar } from './selection';
import { setSafeHtml, setTrustedAnchorHref, setTrustedImageSrc, safeHtml } from '../../safe-dom';
import { getOrCreateBoundedStreamWindow, BoundedStreamWindow } from '../../bounded-stream-window';
import {
  appendNewerMessagesToPage,
  markMessagesHasNewer,
  messageBackwardCursor,
  messageForwardCursor,
  prependOlderMessagesToPage,
  removeMessageFromPage,
  setInitialMessagePage,
} from './message-page';

const messageListViews = new WeakMap<AppInstance, BoundedStreamWindow<Message>>();
const BOTTOM_SETTLE_FRAME_COUNT = 4;
// 距底部 50px 以内视为"贴底"。
const NEAR_BOTTOM_THRESHOLD_PX = 50;
const NEW_MESSAGE_PILL_ID = 'new-message-pill';

export function isNearBottom(list: HTMLElement): boolean {
  return list.scrollTop + list.clientHeight >= list.scrollHeight - NEAR_BOTTOM_THRESHOLD_PX;
}

// 消息数据窗口本身有界（message-page.ts，≤150 条），因此不做窗口切片，
// 全量渲染交给浏览器布局：滚动零重建，行高永远是真实值，无需估算或实测。
function getMessageListView(app: AppInstance): BoundedStreamWindow<Message> {
  return getOrCreateBoundedStreamWindow(messageListViews, app, () => new BoundedStreamWindow<Message>({
    scrollElement: app.$('message-list'),
  }));
}

function scheduleFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => callback());
    return;
  }
  callback();
}

export function renderMessages(app: AppInstance) {
  const myUid = app.client.getSessionSnapshot().currentUid;

  let lastSender: string | null = null;
  const activeConversation = currentConversation(app);
  const isGroup = activeConversation?.kind === 'group';

  const senderUids = new Set<string>();
  for (const msg of app.chatState.currentMessages) {
    const fromUid = msg.senderId || '0';
    if (fromUid !== myUid && fromUid !== '0') senderUids.add(fromUid);
  }
  const senderMap = app.client.getUserInfos([...senderUids]);

  getMessageListView(app).render({
    items: app.chatState.currentMessages,
    hasMoreBefore: app.chatState.messagePageHasOlder,
    hasMoreAfter: app.chatState.messagePageHasNewer,
    loadingBefore: app.chatState.loadingMoreMessages,
    loadingAfter: app.chatState.loadingNewerMessages,
    loadingText: app.t('common.loading'),
    topBoundaryText: app.t('chat.reachedEarliest'),
    bottomBoundaryText: app.t('chat.reachedLatest'),
    loadBefore: () => { void loadOlderMessages(app); },
    loadAfter: () => { void loadNewerMessages(app); },
    keyOf: (msg) => msg.messageId || String(msg.seq),
    renderItem: (msg) => {
      const fromUid = msg.senderId || '0';
      const isSelf = fromUid === myUid;
      const isSystem = msg.messageType === MSG_TYPE_SYSTEM;

      if (isSystem) {
        const div = app.dom.ownerDocument.createElement('div');
        div.className = 'message-system';
        div.dataset.msgId = msg.messageId;
        div.textContent = app.client.describeMessage(msg).text;
        lastSender = null;
        return [div];
      }

      const elements: HTMLElement[] = [];
      if (isGroup && !isSelf && fromUid !== lastSender) {
        const sender = senderMap.get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
        const label = app.dom.ownerDocument.createElement('div');
        label.className = 'message-sender';
        label.textContent = displayUserName(sender, fromUid);
        elements.push(label);
      }
      lastSender = fromUid;

      const row = app.dom.ownerDocument.createElement('div');
      row.className = 'message-row' + (isSelf ? ' self' : '');
      row.dataset.seq = String(msg.seq);
      row.dataset.msgId = msg.messageId;
      const sender = senderMap.get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
      const fromName = isSelf ? app.t('chat.selfName') : displayUserName(sender, fromUid);

      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showMessageActionMenu(app, row, msg, fromName, event.clientX, event.clientY);
      });

      if (!isSelf) {
        const avatarDiv = app.dom.ownerDocument.createElement('div');
        avatarDiv.className = 'avatar avatar-sm';
        avatarDiv.innerHTML = app.avatarInnerHtml({ avatar: sender.avatarUrl, nickname: fromName });
        row.appendChild(avatarDiv);
      }

      if (app.chatState.messageSelectionMode) {
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

      if (!app.chatState.messageSelectionMode) {
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
    },
  });

  syncNewMessagePill(app);
}

// 新消息提示条只表示实时通知带来的新消息，不复用 messagePageHasNewer 的分页含义。
// messagePageHasNewer 也可能只是上翻历史后尾部页被窗口裁剪，不能因此误提示"有新消息"。
// 点击跳到最新一页；pending 归零（重拉最新页、切换会话）后自动隐藏。
function ensureNewMessagePill(app: AppInstance): HTMLElement {
  const existing = app.dom.getElementById(NEW_MESSAGE_PILL_ID);
  if (existing) return existing;
  const pill = app.dom.ownerDocument.createElement('button');
  pill.id = NEW_MESSAGE_PILL_ID;
  pill.type = 'button';
  pill.className = 'new-message-pill hidden';
  pill.addEventListener('click', () => {
    void reloadLatestMessagePage(app);
  });
  app.$('message-list').parentElement?.appendChild(pill);
  return pill;
}

export function syncNewMessagePill(app: AppInstance): void {
  const pill = ensureNewMessagePill(app);
  const count = app.chatState.pendingNewMessageCount;
  pill.textContent = count > 0 ? app.t('chat.newMessagesCount', { n: count }) : app.t('chat.jumpToLatest');
  pill.classList.toggle('hidden', !app.chatState.messagePageHasNewer || count <= 0);
}

function mediaUrl(kind: 'image' | 'file', mediaId: string): string {
  return `/media/${kind}/${mediaId}`;
}

function fillMessageBubble(app: AppInstance, bubble: HTMLElement, msg: Message) {
  const details = app.client.describeMessage(msg);

  if (msg.messageType === MSG_TYPE_IMAGE) {
    const mediaId = details.image?.media_id || '';
    const img = app.dom.ownerDocument.createElement('img');
    img.className = 'message-image';
    img.alt = details.image?.caption || app.t('chat.previewImage');
    if (!mediaId || !setTrustedImageSrc(img, mediaUrl('image', mediaId))) {
      bubble.textContent = details.image?.caption || app.t('chat.previewImage');
      return;
    }
    img.addEventListener('click', () => {
      if (typeof window !== 'undefined') window.open(img.src, '_blank', 'noopener,noreferrer');
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
    const forwardBlock = app.dom.ownerDocument.createElement('div');
    forwardBlock.className = 'message-forward-block';
    forwardBlock.textContent = formatForwardBlockText(app, details.forward.messageIds.length);
    bubble.appendChild(forwardBlock);
    if (details.forward.title) {
      const title = app.dom.ownerDocument.createElement('div');
      title.className = 'message-forward-title';
      title.textContent = details.forward.title;
      bubble.appendChild(title);
    }
    return;
  }

  if (msg.messageType === MSG_TYPE_QUOTE && details.quote) {
    const quote = details.quote;
    const quoteBlock = app.dom.ownerDocument.createElement('div');
    quoteBlock.className = 'message-quote-block';
    quoteBlock.textContent = quote.preview;
    quoteBlock.style.cursor = 'pointer';
    quoteBlock.addEventListener('click', () => {
      if (app.chatState.expandedQuoteMessageIds.has(msg.messageId)) {
        app.chatState.expandedQuoteMessageIds.delete(msg.messageId);
      } else {
        app.chatState.expandedQuoteMessageIds.add(msg.messageId);
      }
      renderMessages(app);
    });
    if (app.chatState.expandedQuoteMessageIds.has(msg.messageId)) {
      const detail = app.dom.ownerDocument.createElement('div');
      detail.className = 'quote-detail';
      detail.textContent = quote.preview;
      quoteBlock.appendChild(detail);
    }
    bubble.appendChild(quoteBlock);
    const reply = app.dom.ownerDocument.createElement('div');
    reply.textContent = quote.text;
    bubble.appendChild(reply);
    return;
  }

  // RECALL 占位与普通文本/系统消息均直接展示 describeMessage 文本。
  bubble.textContent = details.text;
}

// 内容（特别是图片）可能在渲染后的若干帧内才完成排版，多帧重设 scrollTop 才能真正到底；
// 更晚到达的图片由 setup.ts 的 load 捕获监听兜底（贴底时继续贴底）。
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

// 翻页在头 / 尾插入并可能在另一端裁剪，重渲染后画面不应跳动：锚点保持由引擎统一负责
// （renderMessages 传入 keyOf，引擎据此保持视口顶部第一条可见消息的偏移不变）。
export async function loadOlderMessages(app: AppInstance) {
  if (app.chatState.loadingMoreMessages || !app.chatState.messagePageHasOlder || !app.chatState.currentConvKey || app.chatState.currentMessages.length === 0) return;
  app.chatState.loadingMoreMessages = true;

  const target = app.client.describeConversation(app.chatState.currentConvKey).target;

  try {
    // 续翻向前用窗口首页的不透明 start_cursor；空页时 prepend 会把 hasOlder 置 false，
    // 重渲染立即显示"已到最早"边界提示。
    const result = await app.client.getMessages({ target, cursor: messageBackwardCursor(app), backward: true, limit: APP_CONFIG.chat.messagePageSize });
    prependOlderMessagesToPage(app, result);
    renderMessages(app);
    if (app.chatState.messageSelectionMode) updateSelectionBar(app);
  } catch (e) {
    console.warn('loadOlderMessages failed:', e);
  } finally {
    app.chatState.loadingMoreMessages = false;
  }
}

export async function loadNewerMessages(app: AppInstance) {
  if (app.chatState.loadingNewerMessages || !app.chatState.messagePageHasNewer || !app.chatState.currentConvKey || app.chatState.currentMessages.length === 0) return;
  app.chatState.loadingNewerMessages = true;

  const target = app.client.describeConversation(app.chatState.currentConvKey).target;

  try {
    // 续翻向后用窗口尾页的不透明 end_cursor；空页时 append 会把 hasNewer 置 false，
    // 重渲染立即隐藏提示条并刷新"已到最新"边界提示。
    const result = await app.client.getMessages({ target, cursor: messageForwardCursor(app), limit: APP_CONFIG.chat.messagePageSize });
    appendNewerMessagesToPage(app, result);
    renderMessages(app);
    if (app.chatState.messageSelectionMode) updateSelectionBar(app);
  } catch (e) {
    console.warn('loadNewerMessages failed:', e);
  } finally {
    app.chatState.loadingNewerMessages = false;
  }
}

// reloadLatestMessagePage 重新拉取打开中会话的最新一页并滚到底部。
// 供"贴底时收到重绘信号"和"点击新消息提示条"两条路径复用。
async function reloadLatestMessagePage(app: AppInstance): Promise<void> {
  const convKey = app.chatState.currentConvKey;
  if (!convKey) return;
  const target = app.client.describeConversation(convKey).target;
  const requestId = app.chatState.messagePageRequestId;
  try {
    const result = await app.client.getMessages({ target, backward: true, limit: APP_CONFIG.chat.messagePageSize });
    if (app.chatState.messagePageRequestId !== requestId || app.chatState.currentConvKey !== convKey) return;
    setInitialMessagePage(app, result);
    app.chatState.pendingNewMessageCount = 0;
    renderMessages(app);
    scrollToBottom(app);

    if (canAutoClearUnreadCurrentConversation(app)) {
      app.client.clearUnread(target).catch(() => {});
    }
  } catch (e) {
    console.warn('reload latest message page failed:', e);
  }
}

// removeMessage 收到 messages:deleted 信号时就地从消息窗口删除该消息（命中才重渲染），不重拉。
export function removeMessage(app: AppInstance, messageId: string): void {
  if (removeMessageFromPage(app, messageId)) renderMessages(app);
}

// refreshOpenConversation 收到 messages:received 重绘信号时刷新打开中的会话。
// 不消费通知 payload：通过 get_messages 重读，新消息/撤回/删除都按服务端最新状态统一反映。
// 只有用户贴底时才重拉最新一页并滚到底部；上翻阅读中只点亮新消息提示条，
// 交给滚动触底的 loadNewerMessages 或提示条点击跳转，避免打断浏览。
export async function refreshOpenConversation(app: AppInstance): Promise<void> {
  if (!app.chatState.currentConvKey) return;
  if (app.$('view-chat').classList.contains('hidden')) return;
  if (app.chatState.messagePageHasNewer) {
    app.chatState.pendingNewMessageCount += 1;
    syncNewMessagePill(app);
    return;
  }
  if (!isNearBottom(app.$('message-list')) && app.chatState.currentMessages.length > 0) {
    // 会话尾部之后出现了新内容：标记 hasNewer，让触底加载能追平，并点亮提示条。
    app.chatState.pendingNewMessageCount += 1;
    markMessagesHasNewer(app);
    syncNewMessagePill(app);
    return;
  }
  await reloadLatestMessagePage(app);
}
