import { test, expect } from '../support/test-fixtures';
import { ensureStartupPrefs, uniqueUser, register } from './helpers';

test.describe('Auth', () => {
  test('首次访问只需确认布局偏好，不再选择存储模式', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('#layout-confirm-btn')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.layout-option[data-layout="auto"]')).toBeVisible();
    // 浏览器端只有内存模式，存储模式选项已随浏览器端 SQLite 一并退役。
    await expect(page.locator('#mode-opt-instant')).toHaveCount(0);
    await expect(page.locator('#mode-opt-persistent')).toHaveCount(0);

    await ensureStartupPrefs(page);
    await expect(page.locator('#login-form')).toBeVisible();
  });

  test('register and see app', async ({ page }) => {
    const user = uniqueUser('reg');
    await register(page, user, '123456', 'TestNick');
    // Should see the app with settings showing the nickname
    await page.click('[data-view="settings"]');
    await expect(page.locator('#settings-nickname')).toHaveText('TestNick');
  });

  test('register with duplicate username shows error', async ({ browser }) => {
    const user = uniqueUser('dup');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    await register(page1, user, '123456', 'First');

    // New context (clean state) to try registering same username
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page2 = await ctx2.newPage();
    await page2.goto('/app/');
    await ensureStartupPrefs(page2);
    await page2.click('[data-tab="register"]');
    await page2.fill('#reg-username', user);
    await page2.fill('#reg-password', '123456');
    await page2.fill('#reg-nickname', 'Second');
    await page2.click('#register-form button[type="submit"]');
    await expect(page2.locator('#auth-error')).not.toBeEmpty({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('login with wrong password shows error', async ({ page }) => {
    await page.goto('/app/');
    await ensureStartupPrefs(page);
    await page.fill('#login-username', 'nonexistent_user_xyz');
    await page.fill('#login-password', 'wrongpass');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#auth-error')).not.toBeEmpty({ timeout: 5000 });
  });
});
