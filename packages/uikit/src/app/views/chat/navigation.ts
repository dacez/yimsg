import type { LocalConversation } from '@yimsg/sdk';
import type { AppInstance } from '../../app-instance';
import { closeGlobalChatSearch } from './global-search';
import { resumeOpenConversation } from './message-list';

export function startDMFromContact(app: AppInstance, uid: string) {
  switchView(app, 'chat');
  const conv: LocalConversation = { groupId: '0', friendUid: uid, lastSeq: 0, lastMessage: null };
  void app.views.chat?.openConversation(conv);
}

// 显示范围收窄（chat-only / contacts-only）时没有底部导航，用户不能切到其它视图。
const FORCED_VIEW_BY_MODE: Partial<Record<AppInstance['runtime']['viewMode'] & string, string>> = {
  'chat-only': 'chat',
  'contacts-only': 'contacts',
};

export function switchView(app: AppInstance, requestedName: string) {
  const forced = app.runtime.viewMode ? FORCED_VIEW_BY_MODE[app.runtime.viewMode] : undefined;
  const name = forced ?? requestedName;
  app.dom.querySelectorAll<HTMLElement>('#main-content > .view').forEach((view) => view.classList.add('hidden'));
  app.$('view-' + name).classList.remove('hidden');
  app.dom.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
  app.dom.querySelector(`.nav-item[data-view="${name}"]`)?.classList.add('active');

  // 聊天视图重新可见：把隐藏期间攒下的变化交回消息列表决策，贴底就追平并清未读。
  // 这里不自己判断未读数——chatState.currentConversation 是打开会话那一刻的快照，
  // 它的 unreadCount 此后永不更新，用它决定"现在要不要清未读"必然看运气：打开时有
  // 红点的会话每次切回来都白清一次，打开时没红点的会话则永远清不掉。
  if (name === 'chat') resumeOpenConversation(app);
  if (name === 'contacts') app.chatState.loadContactsFn?.();
  if (name === 'settings') app.chatState.renderSettingsFn?.();
  if (name !== 'chat') closeGlobalChatSearch(app);
}
