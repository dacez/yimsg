import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthView } from '../../src/app/views/auth';
import { initAfterAuth } from '../../src/app/main-app';

vi.mock('../../src/app/main-app', () => ({
  initAfterAuth: vi.fn(async (_app, options: { startSession?: () => Promise<void> }) => {
    await options.startSession?.();
  }),
}));

vi.mock('../../src/app/layout', () => ({
  persistAndApplyLayoutForApp: vi.fn(),
}));

vi.mock('../../src/app/startup-mode', () => ({
  needsInitialModeSelection: vi.fn(() => false),
  resolveModeAfterAuth: vi.fn(() => 'instant'),
  shouldResetPersistentStorage: vi.fn(() => false),
}));

vi.mock('../../src/mode', () => ({
  startSessionByMode: vi.fn(async () => undefined),
}));

type EventHandler = (event: { preventDefault(): void }) => void | Promise<void>;

function createElement(initial: Record<string, unknown> = {}) {
  const handlers = new Map<string, EventHandler>();
  return {
    value: '',
    textContent: '',
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    },
    dataset: {},
    addEventListener: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    trigger: async (event: string) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`missing handler: ${event}`);
      await handler({ preventDefault() {} });
    },
    ...initial,
  };
}

function createApp() {
  const elements = new Map<string, ReturnType<typeof createElement>>();
  const getElement = (id: string, initial: Record<string, unknown> = {}) => {
    if (!elements.has(id)) elements.set(id, createElement(initial));
    return elements.get(id)!;
  };

  const loginForm = getElement('login-form');
  const registerForm = getElement('register-form');
  const authError = getElement('auth-error');
  const viewAuth = getElement('view-auth');
  const appRoot = getElement('app');
  const loginUsername = getElement('login-username', { value: 'alice' });
  const loginPassword = getElement('login-password', { value: 'secret' });
  getElement('reg-username');
  getElement('reg-password');
  getElement('reg-nickname');

  const app = {
    client: {
      login: vi.fn(async () => ({ token: 'tok-login', uid: '1001' })),
      register: vi.fn(async () => undefined),
      authenticate: vi.fn(async (_token: string) => ({ token: 'saved-token', uid: '1002' })),
      startSession: vi.fn(async () => ({
        requestedStorage: 'instant',
        actualStorage: 'instant',
        requestedFileSystem: null,
        actualFileSystem: null,
        mode: 'instant',
        degraded: false,
        persistentStorageAvailable: true,
        resetLocalData: 'none',
        resetLocalDataError: null,
      })),
      logout: vi.fn(async () => undefined),
      getSessionSnapshot: vi.fn(() => ({ currentUid: 'snapshot-uid' })),
    },
    storage: {
      setStoredToken: vi.fn(),
      clearStoredToken: vi.fn(),
      getStoredMode: vi.fn(() => 'instant'),
      getStoredPersistentUid: vi.fn(() => null),
      clearStoredPersistentUid: vi.fn(),
      setStoredPersistentUid: vi.fn(),
      setStoredMode: vi.fn(),
      getStoredLayout: vi.fn(() => 'auto'),
    },
    runtime: {
      embedded: false,
      instanceId: 'main',
      hooks: {},
    },
    dom: {
      getElementById: vi.fn((id: string) => elements.get(id) ?? null),
      querySelectorAll: vi.fn(() => []),
    },
    $: vi.fn((id: string) => {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    }),
    t: vi.fn((key: string) => key),
    emitAuthenticated: vi.fn(),
    emitAppError: vi.fn(),
    showToast: vi.fn(),
  };

  return {
    app: app as unknown as Parameters<typeof createAuthView>[0],
    elements: {
      loginForm,
      registerForm,
      authError,
      viewAuth,
      appRoot,
      loginUsername,
      loginPassword,
    },
    mocks: app,
  };
}

describe('uikit auth view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the same post-auth flow for login submit and token authenticate', async () => {
    const ctx = createApp();
    const view = createAuthView(ctx.app);
    view.setupAuth();

    await ctx.elements.loginForm.trigger('submit');
    await view.authenticate('saved-token');

    expect(ctx.mocks.client.login).toHaveBeenCalledWith('alice', 'secret');
    expect(ctx.mocks.client.authenticate).toHaveBeenCalledWith('saved-token');
    expect(ctx.mocks.storage.setStoredToken).toHaveBeenNthCalledWith(1, 'tok-login');
    expect(ctx.mocks.storage.setStoredToken).toHaveBeenNthCalledWith(2, 'saved-token');
    expect(initAfterAuth).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.emitAuthenticated).toHaveBeenNthCalledWith(1, expect.objectContaining({ token: 'tok-login', uid: '1001' }));
    expect(ctx.mocks.emitAuthenticated).toHaveBeenNthCalledWith(2, expect.objectContaining({ token: 'saved-token', uid: '1002' }));
  });
});
