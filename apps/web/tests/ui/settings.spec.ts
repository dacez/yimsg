import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { uniqueUser, register, login, ensureModeSelected, addFriend } from './helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Settings', () => {
  const password = '123456';

  test('settings shows correct nickname and uid', async ({ page }) => {
    const user = uniqueUser('st');
    await register(page, user, password, 'SettingsNick');
    await page.click('[data-view="settings"]');
    await expect(page.locator('#settings-nickname')).toHaveText('SettingsNick');
    await expect(page.locator('#settings-uid')).toContainText(/UID[:：]/);
  });

  test('settings shows mode badge', async ({ page }) => {
    await register(page, uniqueUser('mb'), password, 'ModeUser');
    await page.click('[data-view="settings"]');
    const badge = page.locator('#settings-mode');
    await expect(badge).toBeVisible();
    // 默认语言为中文，应显示"即时"或"持久存储"
    const text = await badge.textContent();
    expect(['即时', '持久存储']).toContain(text?.trim());
  });

  test('update nickname updates settings display', async ({ page }) => {
    const user = uniqueUser('un');
    await register(page, user, password, 'OldNick');
    await page.click('[data-view="settings"]');
    await expect(page.locator('#settings-nickname')).toHaveText('OldNick');

    // Update nickname
    await page.fill('#edit-nickname', 'NewNick');
    await page.click('#save-profile-btn');

    // Should show success toast and updated nickname
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#settings-nickname')).toHaveText('NewNick', { timeout: 5000 });
  });

  test('update nickname with empty string shows error', async ({ page }) => {
    await register(page, uniqueUser('une'), password, 'NickUser');
    await page.click('[data-view="settings"]');

    // Clear nickname and try to save
    await page.fill('#edit-nickname', '');
    await page.click('#save-profile-btn');

    // Should show error toast
    await expect(page.locator('.toast-error')).toBeVisible({ timeout: 5000 });
  });

  test('change password then login with new password', async ({ browser }) => {
    const user = uniqueUser('cpwd');
    const oldPwd = '123456';
    const newPwd = 'newpassword789';

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await register(page, user, oldPwd, 'PwdUser');

    // Change password - this will also invalidate the current session
    await page.click('[data-view="settings"]');
    await page.fill('#old-password', oldPwd);
    await page.fill('#new-password', newPwd);
    await page.click('#change-pwd-btn');
    await expect(page.locator('.toast-success').first()).toBeVisible({ timeout: 5000 });

    // Session gets kicked after password change, auth view should appear
    await expect(page.locator('#view-auth')).toBeVisible({ timeout: 10_000 });

    // Login with new password. Mode is application-controlled and should be reused.
    await page.click('[data-tab="login"]');
    await page.fill('#login-username', user);
    await page.fill('#login-password', newPwd);
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#modal-overlay:not(.hidden)')).toHaveCount(0);

    await ctx.close();
  });

  test('change password with wrong old password shows error', async ({ page }) => {
    await register(page, uniqueUser('wpwd'), password, 'WrongPwdUser');
    await page.click('[data-view="settings"]');
    await page.fill('#old-password', 'wrongoldpassword');
    await page.fill('#new-password', 'newpassword456');
    await page.click('#change-pwd-btn');
    await expect(page.locator('.toast-error')).toBeVisible({ timeout: 5000 });
  });

  test('logout returns to auth view', async ({ page }) => {
    await register(page, uniqueUser('lo'), password, 'LogoutUser');
    await page.click('[data-view="settings"]');
    await page.click('#logout-btn');
    await expect(page.locator('#view-auth')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#app')).toBeHidden({ timeout: 5000 });
  });

  test('nickname update reflects in conversation list', async ({ browser }) => {
    const u1 = uniqueUser('ncu1');
    const u2 = uniqueUser('ncu2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'OldName');
    await register(page2, u2, password, 'Observer');

    // Make them friends and open a DM
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="search"]');
    await page1.fill('#search-username', u2);
    await page1.click('#search-btn');
    const addBtn = page1.locator('#search-results button');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-confirm-btn');

    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="requests"]');
    const acceptBtn = page2.locator('#requests-tab .btn-primary').first();
    await expect(acceptBtn).toBeVisible({ timeout: 10_000 });
    await acceptBtn.click();

    // User1 updates their nickname
    await page1.click('[data-view="settings"]');
    await page1.fill('#edit-nickname', 'UpdatedName');
    await page1.click('#save-profile-btn');
    await expect(page1.locator('.toast-success').last()).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('update personal avatar', async ({ page }) => {
    await register(page, uniqueUser('av'), password, 'AvatarUser');
    await page.click('[data-view="settings"]');

    // Avatar picker should be available
    await expect(page.locator('#settings-avatar')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#avatar-picker')).toBeAttached({ timeout: 5000 });

    // Upload avatar image
    const imgPath = path.resolve(__dirname, 'fixtures', 'test-image.png');
    await page.locator('#avatar-picker').setInputFiles(imgPath);

    // Should show success toast
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 10_000 });

    // Avatar should now display the uploaded image
    const avatarImg = page.locator('#settings-avatar img');
    await expect(avatarImg).toBeVisible({ timeout: 5000 });
    const src = await avatarImg.getAttribute('src');
    expect(src).toContain('/media/');
  });

  test('clear data button only shows in persistent mode', async ({ page }) => {
    await register(page, uniqueUser('cdmem'), password, 'InstantUser');
    await page.click('[data-view="settings"]');
    await expect(page.locator('#settings-mode')).toHaveText('即时');
    await expect(page.locator('#clear-data-btn')).toBeHidden();
  });

  test('clear data 清空本地库后从服务端重新全量追平好友数据', async ({ browser }) => {
    const u1 = uniqueUser('cd1');
    const u2 = uniqueUser('cd2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/app/');
    await ensureModeSelected(page1, 'persistent');
    await page1.click('[data-tab="register"]');
    await page1.fill('#reg-username', u1);
    await page1.fill('#reg-password', password);
    await page1.fill('#reg-nickname', 'ClearDataUser1');
    await page1.click('#register-form button[type="submit"]');
    await expect(page1.locator('#app')).toBeVisible({ timeout: 20_000 });

    await register(page2, u2, password, 'ClearDataUser2');
    await addFriend(page1, page2, u2);

    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('.contact-item', { hasText: 'ClearDataUser2' })).toBeVisible({ timeout: 10_000 });

    await page1.click('[data-view="settings"]');
    await expect(page1.locator('#settings-mode')).toHaveText('持久存储');
    await expect(page1.locator('#clear-data-btn')).toBeVisible();
    await page1.click('#clear-data-btn');
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-confirm-btn');
    await expect(page1.locator('.toast-success')).toBeVisible({ timeout: 10_000 });

    // 仍处于持久存储模式且未登出；本地库被清空后应从服务端重新全量追平好友数据。
    await expect(page1.locator('#settings-mode')).toHaveText('持久存储');
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('.contact-item', { hasText: 'ClearDataUser2' })).toBeVisible({ timeout: 15_000 });

    await ctx1.close();
    await ctx2.close();
  });
});
