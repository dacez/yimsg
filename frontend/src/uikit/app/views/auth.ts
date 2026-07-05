import type { AppInstance } from '../app-instance';
import type { LayoutChoice } from '../session-storage';
import { persistAndApplyLayoutForApp } from '../layout';
import { needsInitialModeSelection, resolveModeAfterAuth, shouldResetPersistentStorage } from '../startup-mode';
import { startSessionByMode } from '../../mode';
import { initAfterAuth } from '../main-app';

type ModeChoice = {
  mode: 'memory' | 'persistent';
  clearPersistentData: boolean;
  layout: LayoutChoice;
};

type AuthSuccess = {
  token: string;
  uid: string;
};

export function createAuthView(app: AppInstance) {
  let resetAllPersistentDataOnNextSession = false;

  async function login(username: string, password: string) {
    const result = await app.client.login(username, password);
    await finalizeAuthSuccess(result);
  }

  async function register(username: string, password: string, nickname: string) {
    await app.client.register(username, password, nickname);
    await login(username, password);
  }

  function emitAuthenticated(result: AuthSuccess) {
    app.emitAuthenticated({
      token: result.token,
      uid: result.uid,
      event: { snapshot: app.client.getSessionSnapshot(), uid: result.uid },
    });
  }

  async function finalizeAuthSuccess(result: AuthSuccess, persistedToken = result.token) {
    app.storage.setStoredToken(persistedToken);
    await initSelectedModeAfterAuth();
    emitAuthenticated(result);
  }

  async function initSelectedModeAfterAuth() {
    if (app.runtime.embedded) {
      const requestedMode = app.runtime.requestedMode ?? 'memory';
      await initAfterAuth(app, {
        requestedMode,
        startSession: () => startSessionByMode(app.client, {
          mode: requestedMode,
          instanceId: app.runtime.instanceId,
        }, (error, context) => {
          app.emitAppError(error, context);
        }),
      });
      return;
    }

    const savedMode = app.storage.getStoredMode();
    await initMode(resolveModeAfterAuth(savedMode));
  }

  async function initMode(mode: 'memory' | 'persistent') {
    const snapshot = app.client.getSessionSnapshot();
    const shouldResetStoredPersistentData = shouldResetPersistentStorage(mode, app.storage.getStoredPersistentUid(), snapshot.currentUid);
    const shouldResetPersistentData = resetAllPersistentDataOnNextSession || shouldResetStoredPersistentData;
    const resetLocalData = mode === 'persistent' && shouldResetPersistentData
      ? 'all'
      : 'none';
    const sessionStart = {
      result: null as Awaited<ReturnType<typeof app.client.startSession>> | null,
    };

    app.storage.setStoredMode(mode);
    await initAfterAuth(app, {
      requestedMode: mode,
      startSession: async () => {
        sessionStart.result = await app.client.startSession({
          storage: mode === 'persistent' ? 'persistent' : 'memory',
          resetLocalData,
          instanceId: app.runtime.instanceId,
        });
      },
    });

    const startResult = sessionStart.result;
    if (startResult?.degraded) {
      app.storage.setStoredMode('memory');
      app.storage.clearStoredPersistentUid();
      app.emitAppError(new Error('持久化会话不可用，已降级为 memory 模式'), 'mode:persistent-fallback');
    } else {
      app.storage.setStoredMode(mode);
    }

    if (startResult?.resetLocalDataError) {
      app.storage.clearStoredPersistentUid();
      app.emitAppError(startResult.resetLocalDataError, 'mode:reset-local-data');
    }
    if (resetAllPersistentDataOnNextSession && startResult?.resetLocalData === 'all') {
      resetAllPersistentDataOnNextSession = false;
      if (!startResult?.resetLocalDataError) {
        app.showToast(app.t('auth.persistentDataCleared'), 'success');
      }
    }

    const nextSnapshot = app.client.getSessionSnapshot();
    if (startResult?.mode === 'persistent' && nextSnapshot.currentUid) {
      app.storage.setStoredPersistentUid(nextSnapshot.currentUid);
    }
  }

  function showModeSelectionModal(includeResetOption: boolean): Promise<ModeChoice> {
    return new Promise((resolve) => {
      const overlay = app.$('modal-overlay');
      const content = app.dom.querySelector<HTMLElement>('.modal-content') || overlay;
      content.classList.add('mode-select-modal');

      const persistentClass = 'mode-option mode-option-recommended';
      const persistentResetClass = 'mode-option';
      const resetOptionHtml = includeResetOption ? `
            <div class="${persistentResetClass}" id="mode-opt-persistent-reset">
              <div class="mode-option-title">${app.t('auth.persistentResetTitle')}</div>
              <div class="mode-option-desc">${app.t('auth.persistentResetDesc')}</div>
            </div>
      ` : '';

      const currentLayout = app.storage.getStoredLayout();

      content.innerHTML = `
        <div class="mode-select">
          <h2 class="modal-title">${app.t('auth.chooseMode')}</h2>
          <div class="mode-options">
            <div class="mode-option" id="mode-opt-memory">
              <div class="mode-option-title">${app.t('auth.liteTitle')}</div>
              <div class="mode-option-desc">${app.t('auth.liteDesc')}</div>
            </div>
            <div class="${persistentClass}" id="mode-opt-persistent">
              <div class="mode-option-title">${app.t('auth.persistentTitle')}</div>
              <div class="mode-option-desc">${app.t('auth.persistentDesc')}</div>
            </div>
            ${resetOptionHtml}
          </div>
          <div class="layout-select-section">
            <div class="layout-select-label">${app.t('auth.chooseLayout')}</div>
            <div class="layout-options" role="radiogroup" aria-label="${app.t('auth.chooseLayout')}">
              <button type="button" class="layout-option${currentLayout === 'auto' ? ' active' : ''}" data-layout="auto" role="radio" aria-checked="${currentLayout === 'auto'}">${app.t('auth.layoutAuto')}</button>
              <button type="button" class="layout-option${currentLayout === 'desktop' ? ' active' : ''}" data-layout="desktop" role="radio" aria-checked="${currentLayout === 'desktop'}">${app.t('auth.layoutDesktop')}</button>
              <button type="button" class="layout-option${currentLayout === 'mobile' ? ' active' : ''}" data-layout="mobile" role="radio" aria-checked="${currentLayout === 'mobile'}">${app.t('auth.layoutMobile')}</button>
            </div>
          </div>
        </div>
      `;
      overlay.dataset.preventClose = '1';
      overlay.classList.remove('hidden');

      let selectedLayout: LayoutChoice = currentLayout;
      content.querySelectorAll<HTMLButtonElement>('.layout-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedLayout = (btn.dataset.layout as LayoutChoice) || 'auto';
          content.querySelectorAll<HTMLButtonElement>('.layout-option').forEach((b) => {
            const active = b === btn;
            b.classList.toggle('active', active);
            b.setAttribute('aria-checked', active ? 'true' : 'false');
          });
        });
      });

      const finish = (choice: Omit<ModeChoice, 'layout'>) => {
        content.classList.remove('mode-select-modal');
        delete overlay.dataset.preventClose;
        app.closeModal();
        resolve({ ...choice, layout: selectedLayout });
      };

      app.$('mode-opt-memory').addEventListener('click', () => finish({ mode: 'memory', clearPersistentData: false }));
      app.$('mode-opt-persistent').addEventListener('click', () => finish({ mode: 'persistent', clearPersistentData: false }));
      if (includeResetOption) {
        app.$('mode-opt-persistent-reset').addEventListener('click', () => finish({ mode: 'persistent', clearPersistentData: true }));
      }
    });
  }

  async function promptModeSelection(options: {
    includeResetOption: boolean;
    initAfterSelection: boolean;
  }) {
    const choice = await showModeSelectionModal(options.includeResetOption);
    app.storage.setStoredMode(choice.mode);
    persistAndApplyLayoutForApp(app, choice.layout);

    if (choice.clearPersistentData) {
      resetAllPersistentDataOnNextSession = true;
      app.storage.clearStoredPersistentUid();
    }

    if (options.initAfterSelection) {
      await initMode(choice.mode);
    }
  }

  function showAuthView() {
    app.dom.querySelectorAll<HTMLElement>('.auth-card .tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === 'login');
    });
    app.$('login-form').classList.remove('hidden');
    app.$('register-form').classList.add('hidden');
    app.$('view-auth').classList.remove('hidden');
    app.$('app').classList.add('hidden');
  }

  function showAppView() {
    app.$('view-auth').classList.add('hidden');
    app.$('app').classList.remove('hidden');
  }

  async function authenticate(token: string) {
    try {
      const result = await app.client.authenticate(token);
      await finalizeAuthSuccess(result, token);
    } catch (_) {
      app.storage.clearStoredToken();
      await app.client.logout();
      showAuthView();
      app.emitAppError(new Error(app.t('auth.sessionExpired')), 'authenticate');
      if (!app.runtime.embedded) {
        await ensureInitialModeSelection();
      }
    }
  }

  async function ensureInitialModeSelection() {
    if (!needsInitialModeSelection(app.storage.getStoredToken())) return;
    showAuthView();
    await promptModeSelection({ includeResetOption: true, initAfterSelection: false });
  }

  function handleSessionKicked() {
    app.storage.clearStoredToken();
    void app.client.logout();
    showAuthView();
    app.emitLogout();
    app.showToast(app.t('auth.sessionExpired'), 'error');
  }

  function setupAuth() {
    app.dom.querySelectorAll<HTMLElement>('.auth-card .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        app.dom.querySelectorAll('.auth-card .tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isLogin = tab.dataset.tab === 'login';
        app.$('login-form').classList.toggle('hidden', !isLogin);
        app.$('register-form').classList.toggle('hidden', isLogin);
      });
    });

    app.$('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (app.dom.getElementById('login-username') as HTMLInputElement).value.trim();
      const password = (app.dom.getElementById('login-password') as HTMLInputElement).value;
      const errEl = app.$('auth-error');
      errEl.textContent = '';
      try {
        await login(username, password);
      } catch (err: unknown) {
        errEl.textContent = (err as Error).message;
      }
    });

    app.$('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (app.dom.getElementById('reg-username') as HTMLInputElement).value.trim();
      const password = (app.dom.getElementById('reg-password') as HTMLInputElement).value;
      const nickname = (app.dom.getElementById('reg-nickname') as HTMLInputElement).value.trim();
      const errEl = app.$('auth-error');
      errEl.textContent = '';
      try {
        await register(username, password, nickname);
      } catch (err: unknown) {
        errEl.textContent = (err as Error).message;
      }
    });
  }

  return {
    setupAuth,
    authenticate,
    ensureInitialModeSelection,
    showAuthView,
    showAppView,
    handleSessionKicked,
  };
}
