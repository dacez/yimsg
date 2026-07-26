import type { ConversationTarget, Message } from '@yimsg/sdk';
import { displayUserName, formatTime } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from '../../app-instance';
import { currentConversation } from './helpers';
import { renderMessages } from './message-list';
import { resetMessagePage, setInitialMessagePage } from './message-page';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_LIMIT = 30;
const HIGHLIGHT_MS = 1500;

// 跳转锚点渲染后，get_messages around 两端 has_more 按设计先乐观置 true（协议文档：
// 客户端滚动到真实边界拿到空页后再收敛），BoundedStreamWindow 的 checkReach 会在锚点
// 窗口不足一屏或贴边时自动触发 loadOlderMessages/loadNewerMessages 续拉一页——而这些续拉
// 完成后都会整份重渲消息列表。如果高亮只是渲染后再用 classList.add 补上去的临时状态，
// 这类紧随跳转发生的自动续拉一重渲就会把 class 冲掉，表现为"跳转命中会话中间的消息时
// 高亮/定位很快消失，只有命中没有更早更新消息的最后一条时才稳定"。因此高亮改为跟 msgId
// 一起写进 chatState、由 message-list.ts 的 renderItem 按此声明式补 class，任何重渲染
// （含上述自动续拉）都会一并带上，不再是渲染之外的旁路副作用。
const highlightTimers = new WeakMap<AppInstance, ReturnType<typeof setTimeout>>();

function setMessageHighlight(app: AppInstance, msgId: string): void {
  const existing = highlightTimers.get(app);
  if (existing) clearTimeout(existing);
  app.chatState.highlightMessageId = msgId;
  const timer = setTimeout(() => {
    highlightTimers.delete(app);
    if (app.chatState.highlightMessageId !== msgId) return;
    app.chatState.highlightMessageId = null;
    renderMessages(app);
  }, HIGHLIGHT_MS);
  highlightTimers.set(app, timer);
}

/**
 * 以某条消息为锚点重新加载消息窗口（get_messages around）并滚动高亮。
 * 调用方需确保 target 对应的会话已经是当前打开的会话——本会话内搜索面板天然满足；
 * 全局搜索（global-search.ts）会先切到目标会话再调用本函数。
 */
export async function jumpToMessageInConversation(app: AppInstance, target: ConversationTarget, msgId: string): Promise<void> {
  const messagePageRequestId = resetMessagePage(app);
  try {
    const page = await app.client.getMessages({
      target,
      around: msgId,
      limit: APP_CONFIG.chat.messagePageSize,
    });
    if (messagePageRequestId !== app.chatState.messagePageRequestId) return;
    setInitialMessagePage(app, page);
    setMessageHighlight(app, msgId);
    renderMessages(app);
    scrollToMessage(app, msgId);
  } catch (_) {
    app.showToast(app.t('chat.failedToLoadMessages'), 'error');
  }
}

/** 关闭消息搜索面板并清空输入/结果；切换会话时调用，避免搜索结果跨会话残留。 */
export function closeMessageSearchPanel(app: AppInstance): void {
  app.$('message-search-panel').classList.add('hidden');
  (app.$('message-search-input') as HTMLInputElement).value = '';
  app.$('message-search-results').innerHTML = '';
}

/** 消息搜索：限定当前打开的会话内搜索，不支持跨会话全局搜索（UI 上只暴露单会话入口）。 */
export function setupMessageSearch(app: AppInstance): void {
  let requestId = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const panel = () => app.$('message-search-panel');
  const input = () => app.$('message-search-input') as HTMLInputElement;
  const resultsEl = () => app.$('message-search-results');

  function closePanel(): void {
    closeMessageSearchPanel(app);
    requestId++;
  }

  function openPanel(): void {
    if (!app.chatState.currentConvKey) return;
    panel().classList.remove('hidden');
    input().focus();
  }

  function renderResults(messages: readonly Message[]): void {
    const container = resultsEl();
    if (messages.length === 0) {
      container.innerHTML = `<div class="empty-state">${app.escapeHtml(app.t('chat.searchNoResults'))}</div>`;
      return;
    }
    const myUid = app.client.getSessionSnapshot().currentUid;
    const senderUids = [...new Set(messages.map((m) => m.senderId).filter((uid) => uid && uid !== '0'))];
    const senderMap = app.client.getUserInfos(senderUids);
    const sorted = [...messages].sort((a, b) => b.seq - a.seq);
    const frag = app.dom.ownerDocument.createDocumentFragment();
    for (const msg of sorted) {
      const fromUid = msg.senderId || '0';
      const isSelf = fromUid === myUid;
      const sender = senderMap.get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
      const senderName = isSelf ? app.t('chat.selfName') : displayUserName(sender, fromUid);
      const preview = app.client.describeMessage(msg).text;
      const div = app.dom.ownerDocument.createElement('div');
      div.className = 'message-search-result';
      div.innerHTML = `
        <div class="message-search-result-header">
          <span class="message-search-result-sender">${app.escapeHtml(senderName)}</span>
          <span class="message-search-result-time">${app.escapeHtml(formatTime(msg.sentAt))}</span>
        </div>
        <div class="message-search-result-preview">${app.escapeHtml(preview)}</div>
      `;
      div.addEventListener('click', () => void jumpToResult(msg.messageId));
      frag.appendChild(div);
    }
    container.innerHTML = '';
    container.appendChild(frag);
  }

  async function runSearch(rawKeyword: string): Promise<void> {
    const keyword = rawKeyword.trim();
    const myRequestId = ++requestId;
    if (!keyword) {
      resultsEl().innerHTML = '';
      return;
    }
    const conversation = currentConversation(app);
    if (!conversation) return;
    resultsEl().innerHTML = `<div class="empty-state">${app.escapeHtml(app.t('common.loading'))}</div>`;
    try {
      const page = await app.client.searchMessages({
        keyword,
        target: conversation.target,
        limit: SEARCH_RESULT_LIMIT,
      });
      if (myRequestId !== requestId) return;
      renderResults(page.messages);
    } catch (_) {
      if (myRequestId !== requestId) return;
      resultsEl().innerHTML = `<div class="empty-state">${app.escapeHtml(app.t('chat.searchFailed'))}</div>`;
    }
  }

  // 点开结果：以该消息为锚点重新加载消息窗口，当前会话内搜索不需要切会话。
  async function jumpToResult(msgId: string): Promise<void> {
    const conversation = currentConversation(app);
    if (!conversation) return;
    closePanel();
    await jumpToMessageInConversation(app, conversation.target, msgId);
  }

  input().addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    const value = input().value;
    debounce = setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
  });
  input().addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Enter') {
      if (debounce) clearTimeout(debounce);
      void runSearch(input().value);
    } else if (key === 'Escape') {
      closePanel();
    }
  });
  app.$('message-search-toggle').addEventListener('click', () => {
    if (panel().classList.contains('hidden')) openPanel();
    else closePanel();
  });
  app.$('message-search-close').addEventListener('click', () => closePanel());

  app.registerDisposer(() => {
    if (debounce) clearTimeout(debounce);
  });
}

// 高亮 class 已由 message-list.ts 按 chatState.highlightMessageId 声明式渲染（见上方
// setMessageHighlight 的注释），这里只负责把目标行滚动到视口内。
function scrollToMessage(app: AppInstance, msgId: string): void {
  const run = () => {
    const row = app.dom.querySelector<HTMLElement>(`[data-msg-id="${msgId.replace(/"/g, '\\"')}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
  };
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(run));
  } else {
    setTimeout(run, 0);
  }
}
