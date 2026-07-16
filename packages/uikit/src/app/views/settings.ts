import type { AppInstance } from '../app-instance';
import { refreshVisibleViews } from '../view-refresh';

export function createSettingsView(app: AppInstance) {
  async function saveProfile() {
    const nickname = (app.$('edit-nickname') as HTMLInputElement).value.trim();
    if (!nickname) { app.showToast(app.t('settings.nicknameRequired'), 'error'); return; }
    try {
      const uid = app.client.getSessionSnapshot().currentUid;
      const ud = app.client.getUserInfos([uid]).get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
      await app.client.updateUserInfo({ nickname, avatarUrl: ud.avatarUrl });
      renderSettings();
      app.showToast(app.t('settings.profileUpdated'), 'success');
    } catch (e) {
      app.showToast(app.t('settings.failed') + (e as Error).message, 'error');
    }
  }

  async function changePassword() {
    const oldPwd = (app.$('old-password') as HTMLInputElement).value;
    const newPwd = (app.$('new-password') as HTMLInputElement).value;
    if (!oldPwd || !newPwd) { app.showToast(app.t('settings.fillBothFields'), 'error'); return; }
    try {
      await app.client.updatePassword(oldPwd, newPwd);
      app.showToast(app.t('settings.passwordChanged'), 'success');
    } catch (e) {
      app.showToast(app.t('settings.failed') + (e as Error).message, 'error');
    }
  }

  async function logout() {
    app.storage.clearStoredToken();
    await app.client.logout();
    app.emitLogout();
    app.views.auth?.showAuthView();
  }

  /** 清除本地持久化数据：重新以 resetLocalData='current-user' 启动当前实例的持久化会话，删库后从服务端全量重新追平。 */
  async function clearData() {
    const confirmed = await app.showConfirmModal({
      title: app.t('settings.clearDataConfirmTitle'),
      desc: app.t('settings.clearDataConfirmDesc'),
      confirmText: app.t('settings.clearData'),
      cancelText: app.t('group.cancel'),
      danger: true,
    });
    if (!confirmed) return;

    try {
      const result = await app.client.startSession({
        storage: 'persistent',
        resetLocalData: 'current-user',
        instanceId: app.runtime.instanceId,
      });
      if (result.resetLocalDataError) throw result.resetLocalDataError;

      if (result.degraded) {
        app.storage.setStoredMode('instant');
        app.storage.clearStoredPersistentUid();
        app.emitAppError(new Error('持久化会话不可用，已降级为 instant 模式'), 'mode:persistent-fallback');
      } else {
        const uid = app.client.getSessionSnapshot().currentUid;
        if (uid) app.storage.setStoredPersistentUid(uid);
      }

      app.views.chat?.renderConversationList({ force: true });
      if (!app.$('view-contacts').classList.contains('hidden')) {
        void app.views.contacts?.loadContacts();
      }
      renderSettings();
      app.showToast(app.t('settings.clearDataSuccess'), 'success');
    } catch (e) {
      app.showToast(app.t('settings.clearDataFailed') + (e as Error).message, 'error');
    }
  }

  async function uploadAvatar(file: File) {
    try {
      const data = await app.client.uploadFile(file, 'avatar');
      const uid = app.client.getSessionSnapshot().currentUid;
      const ud = app.client.getUserInfos([uid]).get(uid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
      await app.client.updateUserInfo({ nickname: ud.nickname, avatarUrl: data.url });
      renderSettings();
      app.showToast(app.t('settings.avatarUpdated'), 'success');
    } catch (e) {
      app.showToast(app.t('settings.failed') + (e as Error).message, 'error');
    }
  }

  function applyLocale(locale: 'zh' | 'en') {
    app.setLang(locale);
    refreshVisibleViews(app, {
      detail: 'rerender',
      settings: 'always',
    });
  }

  function setupSettings() {
    app.$('save-profile-btn').addEventListener('click', saveProfile);
    app.$('change-pwd-btn').addEventListener('click', changePassword);
    app.$('clear-data-btn').addEventListener('click', () => void clearData());
    app.$('logout-btn').addEventListener('click', logout);

    app.$('settings-avatar').addEventListener('click', () => {
      (app.$('avatar-picker') as HTMLInputElement).click();
    });
    app.$('avatar-picker').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files?.[0]) { void uploadAvatar(input.files[0]); input.value = ''; }
    });

    app.$('lang-zh-btn').addEventListener('click', () => applyLocale('zh'));
    app.$('lang-en-btn').addEventListener('click', () => applyLocale('en'));
  }

  function renderSettings() {
    const snapshot = app.client.getSessionSnapshot();
    const myUid = snapshot.currentUid;
    const ud = app.client.getUserInfos([myUid]).get(myUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    app.$('settings-nickname').textContent = ud.nickname || app.t('chat.unknown');
    app.$('settings-uid').textContent = app.t('settings.uid') + myUid;

    const modeEl = app.$('settings-mode');
    const isInstant = snapshot.mode === 'instant';
    modeEl.textContent = isInstant ? 'Instant' : '持久存储';
    modeEl.className = 'mode-badge ' + (isInstant ? 'mode-badge-instant' : 'mode-badge-persistent');
    app.$('settings-storage-card').classList.toggle('hidden', isInstant);

    (app.$('edit-nickname') as HTMLInputElement).value = ud.nickname || '';

    app.$('settings-avatar').innerHTML = app.avatarInnerHtml({
      avatar: ud.avatarUrl,
      nickname: ud.nickname || app.t('chat.unknown'),
    });

    const lang = app.getLang();
    const langZhBtn = app.$('lang-zh-btn');
    const langEnBtn = app.$('lang-en-btn');
    langZhBtn.classList.toggle('btn-primary', lang === 'zh');
    langZhBtn.classList.toggle('btn-secondary', lang !== 'zh');
    langEnBtn.classList.toggle('btn-primary', lang === 'en');
    langEnBtn.classList.toggle('btn-secondary', lang !== 'en');
  }

  return {
    setupSettings,
    renderSettings,
  };
}
