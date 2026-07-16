import type { AppInstance } from './app-instance';
import { isNearBottom } from './views/chat/message-list';

// 不做 URL 深链恢复：每次进入 ready 状态都固定落在会话列表（chat）视图，
// 不读取、也不依赖任何外部（宿主页面）URL 状态。
export function renderReadyState(app: AppInstance): void {
  app.views.auth?.showAppView();
  app.views.chat?.switchView('chat');
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
  app.views.chat?.refreshChatHeader();
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
