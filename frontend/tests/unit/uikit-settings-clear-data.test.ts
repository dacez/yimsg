/**
 * uikit 设置页「清除数据」按钮单元测试。
 *
 * 覆盖 `views/settings.ts` 的 clearData 分支：
 * - persistent 模式下展示按钮，instant 模式下隐藏；
 * - 取消确认弹窗不触发 startSession；
 * - 确认后以 resetLocalData='current-user' 重新初始化持久化会话，成功后刷新 UI 并 toast；
 * - resetLocalDataError / degraded 两种失败路径的处理。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsView } from '../../src/uikit/app/views/settings';

type EventHandler = (event: MouseEvent) => void | Promise<void>;

function createElement(initial: Record<string, unknown> = {}) {
  const handlers = new Map<string, EventHandler>();
  const classes = new Set<string>();
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    classList: {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: (name: string) => classes.has(name),
    },
    addEventListener: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    trigger: async (event: string) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`missing handler: ${event}`);
      await handler({} as MouseEvent);
    },
    ...initial,
  };
}

function startSessionResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requestedStorage: 'persistent',
    actualStorage: 'persistent',
    requestedFileSystem: 'opfs',
    actualFileSystem: 'opfs',
    mode: 'persistent',
    degraded: false,
    persistentStorageAvailable: true,
    resetLocalData: 'current-user',
    resetLocalDataError: null,
    ...overrides,
  };
}

function createApp(options: { mode: 'instant' | 'persistent'; confirmed?: boolean } = { mode: 'persistent', confirmed: true }) {
  const elements = new Map<string, ReturnType<typeof createElement>>();
  const getElement = (id: string, initial: Record<string, unknown> = {}) => {
    if (!elements.has(id)) elements.set(id, createElement(initial));
    return elements.get(id)!;
  };

  for (const id of [
    'settings-nickname', 'settings-uid', 'settings-mode', 'settings-storage-card',
    'edit-nickname', 'settings-avatar', 'lang-zh-btn', 'lang-en-btn',
    'save-profile-btn', 'change-pwd-btn', 'clear-data-btn', 'logout-btn', 'avatar-picker',
  ]) getElement(id);
  getElement('view-contacts', { classList: { contains: () => true, add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } });

  const startSession = vi.fn(async () => startSessionResult());

  const app = {
    client: {
      getSessionSnapshot: vi.fn(() => ({ currentUid: '1001', mode: options.mode })),
      getUserInfos: vi.fn(() => new Map([['1001', { nickname: 'Alice', avatarUrl: '', remarkName: '', username: 'alice' }]])),
      startSession,
    },
    storage: {
      setStoredMode: vi.fn(),
      clearStoredPersistentUid: vi.fn(),
      setStoredPersistentUid: vi.fn(),
    },
    runtime: { instanceId: 'default' },
    views: {
      chat: { renderConversationList: vi.fn() },
      contacts: { loadContacts: vi.fn(async () => undefined) },
    },
    $: vi.fn((id: string) => {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    }),
    t: vi.fn((key: string) => key),
    getLang: vi.fn(() => 'zh'),
    avatarInnerHtml: vi.fn(() => ''),
    showToast: vi.fn(),
    emitAppError: vi.fn(),
    showConfirmModal: vi.fn(async () => options.confirmed ?? true),
  };

  return { app: app as unknown as Parameters<typeof createSettingsView>[0], elements, mocks: app };
}

describe('uikit settings 清除数据', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persistent 模式下展示「清除数据」卡片，instant 模式下隐藏', () => {
    const persistentCtx = createApp({ mode: 'persistent' });
    createSettingsView(persistentCtx.app).renderSettings();
    expect(persistentCtx.elements.get('settings-storage-card')!.classList.contains('hidden')).toBe(false);

    const instantCtx = createApp({ mode: 'instant' });
    createSettingsView(instantCtx.app).renderSettings();
    expect(instantCtx.elements.get('settings-storage-card')!.classList.contains('hidden')).toBe(true);
  });

  it('取消确认弹窗不会调用 startSession', async () => {
    const ctx = createApp({ mode: 'persistent', confirmed: false });
    const view = createSettingsView(ctx.app);
    view.setupSettings();

    await ctx.elements.get('clear-data-btn')!.trigger('click');

    expect(ctx.mocks.showConfirmModal).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.client.startSession).not.toHaveBeenCalled();
  });

  it('确认后以 resetLocalData=current-user 重新初始化持久化会话，成功后刷新会话列表并 toast', async () => {
    const ctx = createApp({ mode: 'persistent', confirmed: true });
    const view = createSettingsView(ctx.app);
    view.setupSettings();

    await ctx.elements.get('clear-data-btn')!.trigger('click');

    expect(ctx.mocks.client.startSession).toHaveBeenCalledWith({
      storage: 'persistent',
      resetLocalData: 'current-user',
      instanceId: 'default',
    });
    expect(ctx.mocks.views.chat.renderConversationList).toHaveBeenCalledWith({ force: true });
    expect(ctx.mocks.storage.setStoredPersistentUid).toHaveBeenCalledWith('1001');
    expect(ctx.mocks.showToast).toHaveBeenCalledWith('settings.clearDataSuccess', 'success');
  });

  it('resetLocalDataError：不崩溃，toast 失败信息', async () => {
    const ctx = createApp({ mode: 'persistent', confirmed: true });
    ctx.mocks.client.startSession.mockResolvedValueOnce(
      startSessionResult({ resetLocalDataError: new Error('cleanup failed') }),
    );
    const view = createSettingsView(ctx.app);
    view.setupSettings();

    await ctx.elements.get('clear-data-btn')!.trigger('click');

    expect(ctx.mocks.showToast).toHaveBeenCalledWith('settings.clearDataFailedcleanup failed', 'error');
    expect(ctx.mocks.views.chat.renderConversationList).not.toHaveBeenCalled();
  });

  it('降级为 instant：更新本地存储模式并上报 mode:persistent-fallback', async () => {
    const ctx = createApp({ mode: 'persistent', confirmed: true });
    ctx.mocks.client.startSession.mockResolvedValueOnce(
      startSessionResult({ degraded: true, actualStorage: 'instant', mode: 'instant' }),
    );
    const view = createSettingsView(ctx.app);
    view.setupSettings();

    await ctx.elements.get('clear-data-btn')!.trigger('click');

    expect(ctx.mocks.storage.setStoredMode).toHaveBeenCalledWith('instant');
    expect(ctx.mocks.storage.clearStoredPersistentUid).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.emitAppError).toHaveBeenCalledWith(expect.any(Error), 'mode:persistent-fallback');
    expect(ctx.mocks.showToast).toHaveBeenCalledWith('settings.clearDataSuccess', 'success');
  });
});
