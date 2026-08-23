import type { AppInstance } from './app-instance';
import { CONTACT_PENDING_INCOMING } from '@yimsg/sdk';
import { describeError } from './error-i18n';
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
  // 组织被删除或本人被移出时通讯录组织行会消失，已经打开的组织详情必须跟着收起。
  void app.views.contacts?.closeOrgPanelIfEntryGone();

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

  // 会话列表 / 当前会话消息列表 / 通讯录好友与请求列表都已经是 BoundedList 实例，
  // 构造时通过 register 参数自行登记到 app 的注册表（见各自 views/*.ts 的
  // createBoundedList 调用），重连广播 invalidateBoundedLists() 时天然覆盖到它们，
  // 不再需要在这里手工注册。

  app.dom.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => app.views.chat?.switchView(item.dataset.view!));
  });

  const openContactsSearchTab = () => {
    app.dom.querySelector<HTMLElement>('.tab[data-ctab="search"]')?.click();
  };
  let closePlusMenu: (() => void) | null = null;
  app.$('chat-list-start-btn').addEventListener('click', () => {
    if (closePlusMenu) {
      closePlusMenu();
      return;
    }

    const menu = app.dom.ownerDocument.createElement('div');
    menu.className = 'attach-menu plus-menu';
    menu.innerHTML = `
      <button class="attach-menu-item" data-action="create-group">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        ${app.t('contacts.createGroup')}
      </button>
      <button class="attach-menu-item" data-action="add-friend">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>
        ${app.t('contacts.addWithRemark')}
      </button>
    `;
    app.$('chat-list-topbar').appendChild(menu);

    let outsideHandler: ((event: Event) => void) | null = null;
    closePlusMenu = () => {
      menu.remove();
      closePlusMenu = null;
      if (outsideHandler) app.dom.ownerDocument.removeEventListener('click', outsideHandler);
    };
    menu.querySelector('[data-action="create-group"]')?.addEventListener('click', () => {
      closePlusMenu?.();
      void app.views.contacts?.showCreateGroupModal();
    });
    menu.querySelector('[data-action="add-friend"]')?.addEventListener('click', () => {
      closePlusMenu?.();
      app.views.chat?.switchView('contacts');
      openContactsSearchTab();
    });

    setTimeout(() => {
      outsideHandler = (event: Event) => {
        if (!menu.contains(event.target as Node) && (event.target as HTMLElement).id !== 'chat-list-start-btn') {
          closePlusMenu?.();
        }
      };
      app.dom.ownerDocument.addEventListener('click', outsideHandler);
    }, 0);
  });
  app.$('contacts-add-btn').addEventListener('click', openContactsSearchTab);

  app.$('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && !app.$('modal-overlay').dataset.preventClose) app.closeModal();
  });

  const bindClient = <K extends keyof import('@yimsg/sdk').ClientEvents>(event: K, handler: import('@yimsg/sdk').ClientEvents[K]) => {
    app.client.on(event, handler);
    app.registerDisposer(() => app.client.off(event, handler));
  };

  // 断线期间（disconnected 或重试到阈值的 reconnecting）都点亮全局提示条；
  // 重连成功（connected）后若此前确实断过线，且会话已初始化过，则广播有界列表 invalidate，
  // 让会话列表/当前会话消息/联系人列表各自追平——效果等价于收到一次新会话/新消息/新联系人通知。
  let disconnectedSinceLastConnect = false;

  bindClient('connection:connected', () => {
    app.hideStatus();
    const token = app.storage.getStoredToken();
    if (token && app.client.getSessionSnapshot().currentUid) void app.views.auth?.authenticate(token);
    if (disconnectedSinceLastConnect && app.client.getSessionSnapshot().isSessionInitialized) {
      app.invalidateBoundedLists();
    }
    disconnectedSinceLastConnect = false;
  });

  bindClient('connection:disconnected', () => {
    disconnectedSinceLastConnect = true;
    app.showStatus(app.t('status.reconnecting'), 'reconnecting');
  });

  bindClient('connection:reconnecting', () => {
    disconnectedSinceLastConnect = true;
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
      app.showToast(event.error ? describeError(app, event.error) : app.t('status.syncFailed'), 'error');
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
  bindClient('conversations:sent', (event) => {
    app.views.chat?.renderConversationList({ toTop: true, keys: event.keys });
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
