import type { LocalConversation } from '../../sdk';
import type { AppInstance } from './app-instance';
import { getCurrentRoute, parseRoute } from './router';
import { isNearBottom } from './views/chat/message-list';

function findConversationByRoute(target: { toUid?: string; groupId?: string }): LocalConversation | null {
  if (target.toUid) {
    return { groupId: '0', friendUid: target.toUid, lastSeq: 0, lastMessage: null };
  }
  if (target.groupId) {
    return { groupId: target.groupId, friendUid: '0', lastSeq: 0, lastMessage: null };
  }
  return null;
}

export function applyRoute(app: AppInstance, route: ReturnType<typeof parseRoute>): void {
  app.views.chat?.switchView(route.view, { updateRoute: false });
  if (!route.conversation || route.view !== 'chat') return;
  const conversation = findConversationByRoute({
    toUid: 'toUid' in route.conversation ? route.conversation.toUid : undefined,
    groupId: 'groupId' in route.conversation ? route.conversation.groupId : undefined,
  });
  if (!conversation) return;
  void app.views.chat?.openConversation(conversation);
}

export function renderReadyState(app: AppInstance): void {
  app.views.auth?.showAppView();
  applyRoute(app, getCurrentRoute());
  app.views.chat?.renderConversationList();
  app.views.settings?.renderSettings();
}

type DetailRefreshMode = 'refresh' | 'rerender' | 'skip';
type ViewRefreshMode = 'always' | 'visible' | 'skip';

interface RefreshVisibleViewsOptions {
  readonly detail?: DetailRefreshMode;
  readonly settings?: ViewRefreshMode;
  readonly contacts?: ViewRefreshMode;
}

function shouldRefreshView(app: AppInstance, viewId: 'view-settings' | 'view-contacts', mode: ViewRefreshMode): boolean {
  if (mode === 'always') return true;
  if (mode === 'skip') return false;
  return !app.$(viewId).classList.contains('hidden');
}

export function refreshVisibleViews(app: AppInstance, options: RefreshVisibleViewsOptions = {}): void {
  app.views.chat?.renderConversationList();
  // 重绘消息列表只在用户贴底时保持贴底；上翻阅读中（如 display:updated 触发的刷新）
  // 保留当前阅读位置，不得把视口拽到底部。
  const wasNearBottom = isNearBottom(app.$('message-list'));
  app.views.chat?.renderMessages();
  if (wasNearBottom) app.views.chat?.scrollToBottom();

  if (options.detail === 'refresh') app.views.chat?.refreshDetailPanel();
  if (options.detail === 'rerender') app.views.chat?.rerenderCurrentDetailPanel();

  if (shouldRefreshView(app, 'view-settings', options.settings ?? 'skip')) {
    app.views.settings?.renderSettings();
  }
  if (shouldRefreshView(app, 'view-contacts', options.contacts ?? 'skip')) {
    app.views.contacts?.refreshContactsDisplay();
  }

  app.views.chat?.applyConversationGuards();
}
