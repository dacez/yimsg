import type { AppInstance } from '../app-instance';
import { describeError } from '../error-i18n';
import type { LayoutChoice } from '../session-storage';
import { persistAndApplyLayoutForApp } from '../layout';
import { needsInitialLayoutSelection } from '../startup-mode';
import { initAfterAuth } from '../main-app';

type AuthSuccess = {
  token: string;
  uid: string;
};

export function createAuthView(app: AppInstance) {
  let sessionKickCleanup: Promise<void> | null = null;

  async function login(username: string, password: string) {
    // session:kicked 会异步清理旧 transport。登录页已经显示时清理可能仍未结束；
    // 若直接登录，旧 logout 会在新连接建立后把它断开，表现为偶发“连接失败”。
    if (sessionKickCleanup) await sessionKickCleanup;
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
    await initAfterAuth(app);
    emitAuthenticated(result);
  }

  function showLayoutSelectionModal(): Promise<LayoutChoice> {
    return new Promise((resolve) => {
      const overlay = app.$('modal-overlay');
      const content = app.dom.querySelector<HTMLElement>('.modal-content') || overlay;
      content.classList.add('layout-select-modal');

      const currentLayout = app.storage.getStoredLayout();

      content.innerHTML = `
        <div class="layout-select">
          <h2 class="modal-title">${app.t('auth.chooseLayout')}</h2>
          <div class="layout-select-section">
            <div class="layout-select-label">${app.t('auth.chooseLayout')}</div>
            <div class="layout-options" role="radiogroup" aria-label="${app.t('auth.chooseLayout')}">
              <button type="button" class="layout-option${currentLayout === 'auto' ? ' active' : ''}" data-layout="auto" role="radio" aria-checked="${currentLayout === 'auto'}">${app.t('auth.layoutAuto')}</button>
              <button type="button" class="layout-option${currentLayout === 'desktop' ? ' active' : ''}" data-layout="desktop" role="radio" aria-checked="${currentLayout === 'desktop'}">${app.t('auth.layoutDesktop')}</button>
              <button type="button" class="layout-option${currentLayout === 'mobile' ? ' active' : ''}" data-layout="mobile" role="radio" aria-checked="${currentLayout === 'mobile'}">${app.t('auth.layoutMobile')}</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-block" id="layout-confirm-btn">${app.t('auth.layoutConfirm')}</button>
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

      app.$('layout-confirm-btn').addEventListener('click', () => {
        content.classList.remove('layout-select-modal');
        delete overlay.dataset.preventClose;
        app.closeModal();
        resolve(selectedLayout);
      });
    });
  }

  async function promptLayoutSelection() {
    persistAndApplyLayoutForApp(app, await showLayoutSelectionModal());
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
        await ensureInitialLayoutSelection();
      }
    }
  }

  async function ensureInitialLayoutSelection() {
    if (!needsInitialLayoutSelection(app.storage.getStoredToken())) return;
    showAuthView();
    await promptLayoutSelection();
  }

  function handleSessionKicked() {
    app.storage.clearStoredToken();
    if (!sessionKickCleanup) {
      const cleanup = app.client.logout().finally(() => {
        if (sessionKickCleanup === cleanup) sessionKickCleanup = null;
      });
      sessionKickCleanup = cleanup;
    }
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
        errEl.textContent = describeError(app, err);
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
        errEl.textContent = describeError(app, err);
      }
    });
  }

  return {
    setupAuth,
    authenticate,
    ensureInitialLayoutSelection,
    showAuthView,
    showAppView,
    handleSessionKicked,
  };
}
