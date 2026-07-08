import type { LocalConversation } from '../../../../sdk';
import type { AppInstance } from '../../app-instance';
import { canAutoClearUnreadCurrentConversation } from './helpers';
import { pushRoute, type AppViewName } from '../../router';

export function startDMFromContact(app: AppInstance, uid: string) {
  switchView(app, 'chat');
  const conv: LocalConversation = { groupId: '0', friendUid: uid, lastSeq: 0, lastMessage: null };
  void app.views.chat?.openConversation(conv);
}

// 显示范围收窄（chat-only / contacts-only）时没有底部导航，用户不能切到其它视图；
// 同时挡掉宿主页面 hash 路由的误触发。
const FORCED_VIEW_BY_MODE: Partial<Record<AppInstance['runtime']['viewMode'] & string, string>> = {
  'chat-only': 'chat',
  'contacts-only': 'contacts',
};

export function switchView(app: AppInstance, requestedName: string, options: { updateRoute?: boolean } = {}) {
  const forced = app.runtime.viewMode ? FORCED_VIEW_BY_MODE[app.runtime.viewMode] : undefined;
  const name = forced ?? requestedName;
  app.dom.querySelectorAll<HTMLElement>('#main-content > .view').forEach((view) => view.classList.add('hidden'));
  app.$('view-' + name).classList.remove('hidden');
  app.dom.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
  app.dom.querySelector(`.nav-item[data-view="${name}"]`)?.classList.add('active');

  if (name === 'chat' && app.chatState.currentConvKey && canAutoClearUnreadCurrentConversation(app)) {
    const target = app.client.describeConversation(app.chatState.currentConvKey).target;
    if ((app.chatState.currentConversation?.unreadCount || 0) > 0) {
      app.client.clearUnread(target).catch(() => {});
      app.views.chat?.renderConversationList();
    }
  }
  if (name === 'contacts') app.chatState.loadContactsFn?.();
  if (name === 'settings') app.chatState.renderSettingsFn?.();

  if (options.updateRoute !== false && (name === 'chat' || name === 'contacts' || name === 'settings')) {
    const conversation = name === 'chat' && app.chatState.currentConvKey
      ? app.client.describeConversation(app.chatState.currentConvKey).target
      : undefined;
    pushRoute({ view: name as AppViewName, conversation });
  }
}
