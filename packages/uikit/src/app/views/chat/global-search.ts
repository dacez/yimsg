import type { Contact, LocalConversation, Message } from '@yimsg/sdk';
import { displayGroupName, displayUserName, formatTime } from '@yimsg/sdk';
import type { AppInstance } from '../../app-instance';
import { contactFriendUid, contactGroupId } from '../contacts';
import { openConversation, openConversationShellForJump } from './conversation-list';
import { jumpToMessageInConversation } from './message-search';

const SEARCH_DEBOUNCE_MS = 300;
const CONTACT_RESULT_LIMIT = 8;
const MESSAGE_RESULT_LIMIT = 20;

/**
 * 全局聊天搜索：会话列表顶部入口，类似微信「搜索」——同时查通讯录（好友/收藏群）
 * 和跨全部会话的消息（search_messages 不传 target），结果分两组展示。
 * 只是一次性列表，不做分页；不复用 message-search.ts 的单会话搜索面板（那个限定当前会话）。
 */
export function setupGlobalChatSearch(app: AppInstance): void {
  let requestId = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const input = () => app.$('global-search-input') as HTMLInputElement;
  const cancelBtn = () => app.$('global-search-cancel');
  const resultsPanel = () => app.$('global-search-results');
  const listEl = () => app.$('conversation-list');

  function showResultsPanel(): void {
    resultsPanel().classList.remove('hidden');
    listEl().classList.add('hidden');
  }

  function hideResultsPanel(): void {
    resultsPanel().classList.add('hidden');
    listEl().classList.remove('hidden');
    resultsPanel().innerHTML = '';
  }

  function closeSearch(): void {
    requestId++;
    input().value = '';
    cancelBtn().classList.add('hidden');
    hideResultsPanel();
  }

  function sectionTitle(text: string): HTMLElement {
    const el = app.dom.ownerDocument.createElement('div');
    el.className = 'global-search-section-title';
    el.textContent = text;
    return el;
  }

  function resultRow(opts: {
    name: string;
    avatarUrl: string;
    preview?: string;
    time?: string;
    onClick: () => void;
  }): HTMLElement {
    const div = app.dom.ownerDocument.createElement('div');
    div.className = 'conversation-item';
    const previewHtml = opts.preview
      ? `<span class="conversation-preview">${app.escapeHtml(opts.preview)}</span>`
      : '';
    const timeHtml = opts.time ? `<span class="conversation-time">${app.escapeHtml(opts.time)}</span>` : '';
    div.innerHTML = `
      <div class="avatar-wrapper">
        <div class="avatar avatar-md">${app.avatarInnerHtml({ avatar: opts.avatarUrl, nickname: opts.name })}</div>
      </div>
      <div class="conversation-info">
        <div class="conversation-top">
          <div class="conversation-name-row"><span class="conversation-name">${app.escapeHtml(opts.name)}</span></div>
          ${timeHtml}
        </div>
        ${previewHtml}
      </div>
    `;
    div.addEventListener('click', () => {
      closeSearch();
      opts.onClick();
    });
    return div;
  }

  // DM 消息的会话展示名取对端（发送方是我则取 recipientId，否则取 senderId）。
  function dmPeerUid(app: AppInstance, message: Message): string {
    const myUid = app.client.getSessionSnapshot().currentUid;
    return message.senderId === myUid ? message.recipientId : message.senderId;
  }

  async function runSearch(rawKeyword: string): Promise<void> {
    const keyword = rawKeyword.trim();
    const myRequestId = ++requestId;
    if (!keyword) {
      hideResultsPanel();
      return;
    }
    showResultsPanel();
    resultsPanel().innerHTML = `<div class="empty-state">${app.escapeHtml(app.t('common.loading'))}</div>`;

    let contacts: Contact[] = [];
    let messages: Message[] = [];
    try {
      const [contactsPage, messagesPage] = await Promise.all([
        app.client.searchContacts({ keyword, limit: CONTACT_RESULT_LIMIT }),
        app.client.searchMessages({ keyword, limit: MESSAGE_RESULT_LIMIT }),
      ]);
      // 组织类通讯录条目不是会话目标，全局搜索只关心可以直接开聊的好友/收藏群。
      contacts = contactsPage.contacts.filter((c) => contactFriendUid(c) !== '0' || contactGroupId(c) !== '0');
      messages = [...messagesPage.messages].sort((a, b) => b.seq - a.seq);
    } catch (_) {
      if (myRequestId !== requestId) return;
      resultsPanel().innerHTML = `<div class="empty-state">${app.escapeHtml(app.t('chat.searchFailed'))}</div>`;
      return;
    }
    if (myRequestId !== requestId) return;

    if (contacts.length === 0 && messages.length === 0) {
      resultsPanel().innerHTML = `<div class="empty-state">${app.escapeHtml(app.t('chat.searchNoResults'))}</div>`;
      return;
    }

    const friendUids = contacts.filter((c) => contactGroupId(c) === '0').map(contactFriendUid);
    const contactGroupIds = contacts.filter((c) => contactGroupId(c) !== '0').map(contactGroupId);
    const msgUserIds = messages.filter((m) => !m.groupId || m.groupId === '0').map((m) => dmPeerUid(app, m));
    const msgGroupIds = messages.filter((m) => m.groupId && m.groupId !== '0').map((m) => m.groupId);

    const userDisplayMap = app.client.getUserInfos([...friendUids, ...msgUserIds]);
    const groupDisplayMap = app.client.getGroupInfos([...contactGroupIds, ...msgGroupIds]);

    const frag = app.dom.ownerDocument.createDocumentFragment();

    if (contacts.length > 0) {
      frag.appendChild(sectionTitle(app.t('chat.searchSectionContacts')));
      for (const contact of contacts) {
        const isGroup = contactGroupId(contact) !== '0';
        let name: string;
        let avatarUrl: string;
        if (isGroup) {
          const g = groupDisplayMap.get(contactGroupId(contact)) || { name: '', avatarUrl: '', remarkName: '' };
          name = displayGroupName(g, app.t('chat.group'));
          avatarUrl = g.avatarUrl || '';
        } else {
          const uid = contactFriendUid(contact);
          const u = userDisplayMap.get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
          name = displayUserName(u, uid);
          avatarUrl = u.avatarUrl || '';
        }
        frag.appendChild(resultRow({
          name,
          avatarUrl,
          onClick: () => {
            const conv: LocalConversation = isGroup
              ? { groupId: contactGroupId(contact), friendUid: '0', lastSeq: 0, lastMessage: null }
              : { groupId: '0', friendUid: contactFriendUid(contact), lastSeq: 0, lastMessage: null };
            void openConversation(app, conv);
          },
        }));
      }
    }

    if (messages.length > 0) {
      frag.appendChild(sectionTitle(app.t('chat.searchSectionMessages')));
      for (const message of messages) {
        const isGroup = Boolean(message.groupId && message.groupId !== '0');
        let convName: string;
        let avatarUrl: string;
        if (isGroup) {
          const g = groupDisplayMap.get(message.groupId) || { name: '', avatarUrl: '', remarkName: '' };
          convName = displayGroupName(g, app.t('chat.group'));
          avatarUrl = g.avatarUrl || '';
        } else {
          const peer = dmPeerUid(app, message);
          const u = userDisplayMap.get(peer) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
          convName = displayUserName(u, peer);
          avatarUrl = u.avatarUrl || '';
        }
        frag.appendChild(resultRow({
          name: convName,
          avatarUrl,
          preview: app.client.describeMessage(message).text,
          time: formatTime(message.sentAt),
          onClick: () => void openConversationAndJumpToMessage(app, message),
        }));
      }
    }

    resultsPanel().innerHTML = '';
    resultsPanel().appendChild(frag);
  }

  input().addEventListener('input', () => {
    cancelBtn().classList.toggle('hidden', !input().value);
    if (debounce) clearTimeout(debounce);
    const value = input().value;
    debounce = setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
  });
  input().addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    closeSearch();
  });
  cancelBtn().addEventListener('click', () => closeSearch());

  app.registerDisposer(() => {
    if (debounce) clearTimeout(debounce);
  });
}

/** 关闭全局搜索面板并清空输入/结果；离开聊天视图或打开某个会话后调用，避免结果跨场景残留。 */
export function closeGlobalChatSearch(app: AppInstance): void {
  const input = app.$('global-search-input') as HTMLInputElement;
  input.value = '';
  app.$('global-search-cancel').classList.add('hidden');
  app.$('global-search-results').classList.add('hidden');
  app.$('global-search-results').innerHTML = '';
  app.$('conversation-list').classList.remove('hidden');
}

// 点开全局搜索的消息结果：先切到消息所属会话（如果不是当前会话），再以该消息为锚点
// 加载消息窗口并滚动高亮，复用 message-search.ts 单会话搜索面板同一套跳转逻辑。
// 注意：切会话只做骨架初始化（openConversationShellForJump），不经过 openConversation
// 拉最新页那一步——否则会先渲染出最新页、马上又被锚点页覆盖重渲，且 openConversation
// 的 scrollToBottom 多帧动画会和随后的锚点滚动/高亮竞态，导致命中会话内非最后一条消息时
// 跳转/高亮被最新页的滚动结果覆盖，看起来像没跳转到指定消息。
async function openConversationAndJumpToMessage(app: AppInstance, message: Message): Promise<void> {
  const descriptor = app.client.describeMessageConversation(message);
  if (app.chatState.currentConvKey !== descriptor.key) {
    const conv: LocalConversation = descriptor.kind === 'group'
      ? { groupId: descriptor.id, friendUid: '0', lastSeq: 0, lastMessage: null }
      : { groupId: '0', friendUid: descriptor.id, lastSeq: 0, lastMessage: null };
    openConversationShellForJump(app, conv);
  }
  await jumpToMessageInConversation(app, descriptor.target, message.messageId);
}
