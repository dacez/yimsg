import type { AppInstance } from './app-instance';
import { CONTACT_PENDING_INCOMING } from '../../constants';
import { watchLayoutChangesForApp } from './layout';
import { createAuthView } from './views/auth';
import { createChatView } from './views/chat';
import { createContactsView } from './views/contacts';
import { createSettingsView } from './views/settings';
import { createSessionPreferencesView } from './views/session-preferences';
import {
  refreshVisibleViews,
  renderReadyState,
} from './view-refresh';

export async function initAfterAuth(app: AppInstance, options: {
  requestedMode?: 'instant' | 'persistent';
  startSession?: () => Promise<void>;
} = {}) {
  const mode = app.storage.getStoredMode();
  const effectiveMode = options.requestedMode ?? mode;
  if (!effectiveMode && !options.startSession) {
    throw new Error('mode is required before initAfterAuth');
  }

  try {
    if (options.startSession) await options.startSession();
    else await app.client.startSession({
      storage: effectiveMode === 'persistent' ? 'persistent' : 'instant',
      instanceId: app.runtime.instanceId,
    });
  } catch (error) {
    app.hideStatus();
    throw error;
  }

  void app.client.getContactCount(CONTACT_PENDING_INCOMING).then(n => app.views.contacts?.updateContactBadges(n));
  renderReadyState(app);
}

function handleMessagesReceived(app: AppInstance, keys: ReadonlyArray<string>) {
  // messages:received 是重绘信号：重绘会话列表，并重新拉取打开中会话的最新一页（不消费 payload）。
  // 贴顶时整列表 reset 重排；不在顶部时不重排，但对仍在数据窗口内的受影响会话（keys）定向刷新。
  app.views.chat?.renderConversationList({ force: true, keys });
  void app.views.chat?.refreshOpenConversation();
}

function handleContactsChanged(app: AppInstance) {
  void app.client.getContactCount(CONTACT_PENDING_INCOMING).then(n => app.views.contacts?.updateContactBadges(n));

  if (!app.$('view-contacts').classList.contains('hidden')) {
    // 背景刷新：用户不在列表顶部时不打断浏览（loadContacts 内部判定并推迟）。
    void app.views.contacts?.loadContacts({ background: true });
  }
}

function refreshPreferenceDrivenUi(app: AppInstance) {
  app.views.chat?.renderConversationList();
  app.views.chat?.applyConversationGuards();
  app.views.chat?.rerenderCurrentDetailPanel();
  if (!app.$('view-contacts').classList.contains('hidden')) {
    app.views.contacts?.refreshContactsDisplay();
  }
}

export function startApp(app: AppInstance): () => void {
  app.applyStaticTranslations();
  app.registerDisposer(watchLayoutChangesForApp(app));

  app.views.auth = createAuthView(app);
  app.views.chat = createChatView(app);
  app.views.contacts = createContactsView(app);
  app.views.settings = createSettingsView(app);
  app.views.sessionPreferences = createSessionPreferencesView(app);

  app.views.auth.setupAuth();
  app.views.chat.setupChat();
  app.views.contacts.setupContacts();
  app.views.settings.setupSettings();
  app.views.chat.registerViewCallbacks(
    () => { void app.views.contacts?.loadContacts(); },
    () => app.views.settings?.renderSettings(),
  );

  app.dom.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => app.views.chat?.switchView(item.dataset.view!));
  });

  app.$('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && !app.$('modal-overlay').dataset.preventClose) app.closeModal();
  });

  const bindClient = <K extends keyof import('../../sdk').ClientEvents>(event: K, handler: import('../../sdk').ClientEvents[K]) => {
    app.client.on(event, handler);
    app.registerDisposer(() => app.client.off(event, handler));
  };

  bindClient('connection:connected', () => {
    app.hideStatus();
    const token = app.storage.getStoredToken();
    if (token && app.client.getSessionSnapshot().currentUid) void app.views.auth?.authenticate(token);
  });

  bindClient('connection:disconnected', () => {
    app.showStatus(app.t('status.reconnecting'), 'reconnecting');
  });

  const activeSyncDomains = new Set<string>();
  bindClient('session:sync', (event) => {
    if (event.status === 'started' || event.status === 'reset') {
      activeSyncDomains.add(event.domain);
      app.showStatus(app.t('status.syncing'), 'syncing');
      return;
    }
    activeSyncDomains.delete(event.domain);
    if (event.status === 'failed') {
      app.showToast(event.error?.message || '同步失败', 'error');
    }
    if (event.status === 'success' && (event.domain === 'messages' || event.domain === 'conversations')) {
      app.views.chat?.renderConversationList({ force: true });
    }
    if (event.status === 'success' && event.domain === 'contacts') {
      handleContactsChanged(app);
    }
    if (activeSyncDomains.size === 0) app.hideStatus();
  });
  bindClient('error', (event) => {
    app.emitAppError(event.error, event.context);
  });

  bindClient('messages:received', (event) => {
    // event.messages 仅承载 onMessages 内容（角标/响铃）；重绘由 handleMessagesReceived 重新拉取。
    // event.conversationKeys 是受影响会话 key：不在顶部时据此定向刷新窗口内会话。
    if (event.messages.length > 0) app.emitMessages(event.messages);
    handleMessagesReceived(app, event.conversationKeys);
  });
  bindClient('contacts:updated', () => handleContactsChanged(app));
  bindClient('blocklist:updated', () => refreshPreferenceDrivenUi(app));
  bindClient('mutelist:updated', () => refreshPreferenceDrivenUi(app));
  // 组织架构变更：刷新打开中的组织架构面板；通讯录条目本身走 contacts:updated。
  bindClient('org:updated', (event) => app.views.contacts?.refreshOrgPanel(event.orgIds));
  bindClient('session:kicked', () => app.views.auth?.handleSessionKicked());

  // 清未读 / 删除：对在数据窗口内的会话定向拉取当前状态并更新窗口（删除态则移除），不整列表重拉。
  bindClient('conversations:clearunread', (event) => {
    void app.views.chat?.refreshConversations([...event.keys]);
  });
  bindClient('conversations:delete', (event) => {
    void app.views.chat?.refreshConversations([...event.keys]);
  });
  // 本端发送消息：让该会话移动到顶部（重拉首页+滚回顶部），不点亮提示条。
  bindClient('conversations:sent', () => {
    app.views.chat?.renderConversationList({ toTop: true });
  });

  bindClient('messages:deleted', (event) => {
    // 删除消息：消息窗口就地删除，并定向刷新该会话预览。
    app.views.chat?.removeMessage(event.messageId);
    if (event.key) void app.views.chat?.refreshConversations([event.key]);
  });

  bindClient('display:updated', () => {
    refreshVisibleViews(app, {
      detail: 'refresh',
      settings: 'visible',
      contacts: 'visible',
    });
  });

  app.emitReady();

  void (async () => {
    const snapshot = app.client.getSessionSnapshot();
    if (snapshot.isAuthenticated && snapshot.isSessionInitialized) {
      void app.client.getContactCount(CONTACT_PENDING_INCOMING).then(n => app.views.contacts?.updateContactBadges(n));
      renderReadyState(app);
      return;
    }

    let token = app.storage.getStoredToken() ?? app.runtime.initialToken ?? undefined;
    if (!token && app.runtime.getInitialToken) {
      try {
        const resolved = await app.runtime.getInitialToken();
        if (resolved) token = resolved;
      } catch (error) {
        app.emitAppError(error as Error, 'getToken');
      }
    }

    if (token) {
      void app.views.auth?.authenticate(token);
      return;
    }

    if (app.runtime.embedded) {
      app.views.auth?.showAuthView();
      return;
    }

    void app.views.auth?.ensureInitialModeSelection();
  })();

  return () => {
    app.dispose();
  };
}
