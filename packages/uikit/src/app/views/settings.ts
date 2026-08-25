import type { AppInstance } from '../app-instance';
import { describeError } from '../error-i18n';
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
      app.showToast(app.t('settings.failed') + describeError(app, e), 'error');
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
      app.showToast(app.t('settings.failed') + describeError(app, e), 'error');
    }
  }

  async function logout() {
    app.storage.clearStoredToken();
    await app.client.logout();
    app.emitLogout();
    app.views.auth?.showAuthView();
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
      app.showToast(app.t('settings.failed') + describeError(app, e), 'error');
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

    (app.$('edit-nickname') as HTMLInputElement).value = ud.nickname || '';

    const avatarHtml = app.avatarInnerHtml({
      avatar: ud.avatarUrl,
      nickname: ud.nickname || app.t('chat.unknown'),
    });
    app.$('settings-avatar').innerHTML = avatarHtml;

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
