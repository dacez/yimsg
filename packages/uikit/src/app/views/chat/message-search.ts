import type { ConversationTarget, Message } from '@yimsg/sdk';
import { MSG_TYPE_RECALL, displayUserName, formatTime } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from '../../app-instance';
import { currentConversation, recallPlaceholderText } from './helpers';
import { getMessageList, renderMessages } from './message-list';
import { messageKey, resetMessagePage } from './message-page';
import { createBoundedList, sdkPageSource, type BoundedList } from '../../bounded-list';
import { debounce, type Debounced } from '../../utils';

const HIGHLIGHT_MS = 1500;

// 跳转锚点渲染后，get_messages around 两端 has_more 按设计先乐观置 true（协议文档：
// 客户端滚动到真实边界拿到空页后再收敛），BoundedList 的触界检测会在锚点窗口不足一屏
// 或贴边时自动触发续拉一页——而这些续拉完成后都会整份重渲消息列表。如果高亮只是渲染后
// 再用 classList.add 补上去的临时状态，这类紧随跳转发生的自动续拉一重渲就会把 class
// 冲掉，表现为"跳转命中会话中间的消息时高亮/定位很快消失，只有命中没有更早更新消息的
// 最后一条时才稳定"。因此高亮改为跟 msgId 一起写进 chatState、由 message-list.ts 的
// renderItem 按此声明式补 class，任何重渲染（含上述自动续拉）都会一并带上，不再是渲染
// 之外的旁路副作用。
const highlightTimers = new WeakMap<AppInstance, ReturnType<typeof setTimeout>>();

function setMessageHighlight(app: AppInstance, msgId: string): void {
  const existing = highlightTimers.get(app);
  if (existing) clearTimeout(existing);
  app.chatState.highlightMessageId = msgId;
  // 高亮属于条目之外的宿主状态；reset 已经在 setMessageHighlight 之前完成，后续没有
  // 必然发生的数据渲染。必须立即显式重绘一次，不能依赖触界续页“顺便”带上 class。
  renderMessages(app);
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
 *
 * 移动端从聊天页返回会话列表时（点击 chat-header 内的 chat-back-btn），只会移除 view-chat 上的
 * mobile-showing-chat class，不会清空 chatState.currentConvKey（详见 setup.ts）。因此
 * 全局搜索命中"返回前正在看的那个会话"时，global-search.ts 会判定当前会话已是目标会话
 * 而跳过 shell 初始化（其中才会补上 mobile-showing-chat），移动端就会停在会话列表、
 * 看起来像没跳转。这里统一兜底：无论调用方是否需要重建 shell，跳转到具体消息前都先
 * 确保聊天面板可见——桌面端两栏同时展示，这一步是无害的空操作。
 */
export async function jumpToMessageInConversation(app: AppInstance, target: ConversationTarget, msgId: string): Promise<void> {
  void target; // 消息列表的 source 从 app.chatState.currentConversation 派生目标，调用方只需确保该会话已是当前会话。
  app.$('view-chat').classList.add('mobile-showing-chat');
  const generation = resetMessagePage(app);
  await getMessageList(app).reset({ query: { aroundMsgId: msgId } });
  if (generation !== app.chatState.messageGeneration) return;
  setMessageHighlight(app, msgId);
  scrollToMessage(app, msgId);
}

// 结果列表与它的搜索防抖一起存：关面板时必须把待触发的那次一并取消，否则用户打完字
// 立刻切会话，300ms 后旧关键字还会再搜一次，把刚清空的结果又填回来。
interface SearchResultsHandle {
  readonly list: BoundedList<Message, { keyword: string }>;
  readonly search: Debounced<[string]>;
}

const searchResultLists = new WeakMap<AppInstance, SearchResultsHandle>();

/** 关闭消息搜索面板并清空输入/结果；切换会话时调用，避免搜索结果跨会话残留。 */
export function closeMessageSearchPanel(app: AppInstance): void {
  app.$('message-search-panel').classList.add('hidden');
  (app.$('message-search-input') as HTMLInputElement).value = '';
  const handle = searchResultLists.get(app);
  if (!handle) return;
  handle.search.cancel();
  void handle.list.reset({ query: { keyword: '' } });
}

function renderSearchResultRow(app: AppInstance, msg: Message): HTMLElement {
  const myUid = app.client.getSessionSnapshot().currentUid;
  const fromUid = msg.senderId || '0';
  const isSelf = fromUid === myUid;
  const sender = app.client.getUserInfos([fromUid]).get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
  const senderName = isSelf ? app.t('chat.selfName') : displayUserName(sender, fromUid);
  const preview = msg.messageType === MSG_TYPE_RECALL
    ? recallPlaceholderText(app, msg)
    : app.client.describeMessage(msg).text;
  const div = app.dom.ownerDocument.createElement('div');
  div.className = 'message-search-result';
  div.innerHTML = `
    <div class="message-search-result-header">
      <span class="message-search-result-sender">${app.escapeHtml(senderName)}</span>
      <span class="message-search-result-time">${app.escapeHtml(formatTime(msg.sentAt))}</span>
    </div>
    <div class="message-search-result-preview">${app.escapeHtml(preview)}</div>
  `;
  return div;
}

/** 消息搜索：限定当前打开的会话内搜索，不支持跨会话全局搜索（UI 上只暴露单会话入口）。 */
export function setupMessageSearch(app: AppInstance): void {
  const panel = () => app.$('message-search-panel');
  const input = () => app.$('message-search-input') as HTMLInputElement;

  // 点开结果：以该消息为锚点重新加载消息窗口，当前会话内搜索不需要切会话。
  const jumpToResult = async (msgId: string): Promise<void> => {
    const conversation = currentConversation(app);
    if (!conversation) return;
    closePanel();
    await jumpToMessageInConversation(app, conversation.target, msgId);
  };

  // 结果列表是有界滑动窗口：关键字非空时才真正发起 search_messages，双向续翻用服务端
  // 整页边界游标；关键字为空（未搜索 / 已清空）时 initialQuery 与当前 query 相等，
  // isQueryActive() 为 false，emptyFiltered 不生效、也没有配置 empty 文案，面板保持空白。
  const resultsList = createBoundedList<Message, { keyword: string }>({
    id: 'message-search-results',
    scrollElement: app.$('message-search-results'),
    pageSize: APP_CONFIG.list.pageSize,
    maxPages: APP_CONFIG.list.maxPages,
    register: (controller) => app.registerBoundedList(controller),
    initialQuery: { keyword: '' },
    source: sdkPageSource(
      ({ cursor, backward, limit, query }) => {
        if (!query.keyword) {
          return Promise.resolve({
            messages: [] as readonly Message[],
            page: { startCursor: '', endCursor: '', hasMoreBackward: false, hasMoreForward: false, total: 0 },
          });
        }
        const conversation = currentConversation(app);
        const target = conversation?.target ?? { toUid: '0' };
        return app.client.searchMessages({ keyword: query.keyword, target, cursor, backward, limit });
      },
      (page) => page.messages,
    ),
    identityOf: messageKey,
    order: 'desc',
    renderItem: (msg) => [renderSearchResultRow(app, msg)],
    text: {
      // 关键字为空时（未搜索 / 已清空）不给空态文案，面板保持空白。
      empty: () => input().value.trim() ? app.t('chat.searchNoResults') : '',
      loading: () => app.t('common.loading'),
      error: () => app.t('chat.searchFailed'),
    },
    onActivate: (msg) => void jumpToResult(msg.messageId),
    onError: (error) => console.warn('[yimsg/uikit] message search failed:', error),
  });
  void resultsList.reset();

  // 搜索结果里的发送者昵称首次渲染时可能还没入缓存，异步补齐后靠 display:updated 重绘。
  const onDisplayUpdated = (): void => resultsList.render();
  app.client.on('display:updated', onDisplayUpdated);
  app.registerDisposer(() => app.client.off('display:updated', onDisplayUpdated));

  function closePanel(): void {
    closeMessageSearchPanel(app);
  }

  function openPanel(): void {
    if (!app.chatState.currentConvKey) return;
    panel().classList.remove('hidden');
    input().focus();
  }

  // 防抖只服务于「边打字边搜」；清空关键字与回车都是明确的意图，用 flush 立刻生效。
  const search = debounce((keyword: string) => void resultsList.reset({ query: { keyword } }));
  searchResultLists.set(app, { list: resultsList, search });
  app.registerDisposer(() => { search.cancel(); resultsList.dispose(); });
  input().addEventListener('input', () => {
    const keyword = input().value.trim();
    if (keyword) search(keyword);
    else search.flush('');
  });
  input().addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Enter') {
      search.flush(input().value.trim());
    } else if (key === 'Escape') {
      closePanel();
    }
  });
  app.$('message-search-toggle').addEventListener('click', () => {
    if (panel().classList.contains('hidden')) openPanel();
    else closePanel();
  });
  app.$('message-search-close').addEventListener('click', () => closePanel());
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
