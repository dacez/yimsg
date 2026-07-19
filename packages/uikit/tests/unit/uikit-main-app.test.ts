import { describe, expect, it, vi, beforeEach } from 'vitest';
import { startApp } from '../../src/app/main-app';

/**
 * startApp 的连接事件 / 有界列表 wiring 测试：不驱动真实 DOM（项目未引入 jsdom），
 * 只验证 main-app.ts 里"绑定了什么、按什么条件调用了什么"这层胶水逻辑本身。
 * 各视图工厂（createChatView 等）整体 mock 成纯 vi.fn 桩，行为细节由各自模块的测试覆盖。
 */

vi.mock('../../src/app/views/auth', () => ({
  createAuthView: vi.fn(() => ({
    setupAuth: vi.fn(),
    authenticate: vi.fn(async () => undefined),
    ensureInitialModeSelection: vi.fn(async () => undefined),
    showAuthView: vi.fn(),
    showAppView: vi.fn(),
    handleSessionKicked: vi.fn(),
  })),
}));

vi.mock('../../src/app/views/chat', () => ({
  createChatView: vi.fn(() => ({
    setupChat: vi.fn(),
    renderConversationList: vi.fn(),
    refreshConversations: vi.fn(async () => undefined),
    removeMessage: vi.fn(),
    renderMessages: vi.fn(),
    scrollToBottom: vi.fn(),
    openConversation: vi.fn(async () => undefined),
    refreshDetailPanel: vi.fn(),
    rerenderCurrentDetailPanel: vi.fn(),
    refreshOpenConversation: vi.fn(async () => undefined),
    refreshChatHeader: vi.fn(),
    applyConversationGuards: vi.fn(),
    registerViewCallbacks: vi.fn(),
    startDMFromContact: vi.fn(),
    switchView: vi.fn(),
    getCurrentConvKey: vi.fn(() => null),
  })),
}));

vi.mock('../../src/app/views/contacts', () => ({
  createContactsView: vi.fn(() => ({
    setupContacts: vi.fn(),
    loadContacts: vi.fn(async () => undefined),
    refreshContactsDisplay: vi.fn(),
    updateContactBadges: vi.fn(),
    refreshOrgPanel: vi.fn(),
  })),
}));

vi.mock('../../src/app/views/settings', () => ({
  createSettingsView: vi.fn(() => ({
    setupSettings: vi.fn(),
    renderSettings: vi.fn(),
  })),
}));

vi.mock('../../src/app/views/session-preferences', () => ({
  createSessionPreferencesView: vi.fn(() => ({
    isUserBlocked: vi.fn(async () => false),
    isMuted: vi.fn(async () => false),
  })),
}));

vi.mock('../../src/app/layout', () => ({
  watchLayoutChangesForApp: vi.fn(() => () => undefined),
}));

type Listener = (event: unknown) => void;

/** 极简 client 事件总线：只需要支持 main-app.ts 用到的 on/off/emit。 */
function createFakeClient(snapshot: { currentUid: string | null; isSessionInitialized: boolean; isAuthenticated: boolean }) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: vi.fn((event: string, handler: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: Listener) => {
      listeners.get(event)?.delete(handler);
    }),
    emit(event: string, payload?: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    getSessionSnapshot: vi.fn(() => snapshot),
    getContactCount: vi.fn(async () => 0),
  };
}

function createFakeApp(client: ReturnType<typeof createFakeClient>) {
  const boundedLists = new Map<string, { id: string; invalidate: () => void | Promise<void> }>();
  const element = () => ({
    addEventListener: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
    dataset: {},
  });

  const app = {
    client,
    runtime: { embedded: false, instanceId: 'main-app-test', hooks: {} },
    storage: {
      getStoredToken: vi.fn(() => null as string | null),
      getStoredMode: vi.fn(() => 'instant'),
    },
    views: {} as Record<string, unknown>,
    dom: { querySelectorAll: vi.fn(() => []) },
    $: vi.fn(() => element()),
    t: vi.fn((key: string) => key),
    applyStaticTranslations: vi.fn(),
    registerDisposer: vi.fn(),
    showStatus: vi.fn(),
    hideStatus: vi.fn(),
    showToast: vi.fn(),
    emitReady: vi.fn(),
    emitMessages: vi.fn(),
    emitAppError: vi.fn(),
    registerBoundedList: vi.fn((controller: { id: string; invalidate: () => void | Promise<void> }) => {
      boundedLists.set(controller.id, controller);
      return () => boundedLists.delete(controller.id);
    }),
    invalidateBoundedLists: vi.fn(() => {
      for (const controller of boundedLists.values()) void controller.invalidate();
    }),
  };

  return app as unknown as Parameters<typeof startApp>[0] & { views: Record<string, any> };
}

describe('startApp connection/bounded-list wiring', () => {
  let client: ReturnType<typeof createFakeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createFakeClient({ currentUid: null, isSessionInitialized: false, isAuthenticated: false });
  });

  it('registers a bounded list controller per list, reusing the existing notification-style refresh actions', async () => {
    const app = createFakeApp(client);
    startApp(app);

    app.invalidateBoundedLists();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.views.chat.renderConversationList).toHaveBeenCalledWith({ force: true });
    expect(app.views.chat.refreshOpenConversation).toHaveBeenCalledOnce();
    expect(app.views.contacts.loadContacts).toHaveBeenCalledWith({ background: true });
  });

  it('does not invalidate bounded lists on the very first connection (no prior disconnect)', () => {
    client = createFakeClient({ currentUid: null, isSessionInitialized: true, isAuthenticated: false });
    const app = createFakeApp(client);
    startApp(app);

    client.emit('connection:connected');

    expect(app.invalidateBoundedLists).not.toHaveBeenCalled();
    expect(app.hideStatus).toHaveBeenCalledOnce();
  });

  it('invalidates bounded lists after a reconnect once the session was already initialized', () => {
    client = createFakeClient({ currentUid: null, isSessionInitialized: true, isAuthenticated: false });
    const app = createFakeApp(client);
    startApp(app);

    client.emit('connection:disconnected');
    expect(app.showStatus).toHaveBeenCalledWith('status.reconnecting', 'reconnecting');

    client.emit('connection:connected');

    expect(app.invalidateBoundedLists).toHaveBeenCalledOnce();
  });

  it('treats connection:reconnecting the same as a disconnect for the next connected event', () => {
    client = createFakeClient({ currentUid: null, isSessionInitialized: true, isAuthenticated: false });
    const app = createFakeApp(client);
    startApp(app);

    client.emit('connection:reconnecting');
    client.emit('connection:connected');

    expect(app.invalidateBoundedLists).toHaveBeenCalledOnce();
  });

  it('does not invalidate bounded lists when the session was never initialized (still on the login flow)', () => {
    client = createFakeClient({ currentUid: null, isSessionInitialized: false, isAuthenticated: false });
    const app = createFakeApp(client);
    startApp(app);

    client.emit('connection:disconnected');
    client.emit('connection:connected');

    expect(app.invalidateBoundedLists).not.toHaveBeenCalled();
  });

  it('a second reconnect only invalidates once per disconnect/connect cycle', () => {
    client = createFakeClient({ currentUid: null, isSessionInitialized: true, isAuthenticated: false });
    const app = createFakeApp(client);
    startApp(app);

    client.emit('connection:disconnected');
    client.emit('connection:connected');
    client.emit('connection:connected');

    expect(app.invalidateBoundedLists).toHaveBeenCalledOnce();
  });
});
