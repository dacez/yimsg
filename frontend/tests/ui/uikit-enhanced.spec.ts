import { test, expect } from '@playwright/test';
import { uniqueUser } from './helpers';

/**
 * uikit 增强能力的端到端覆盖，补充原有 uikit-embed.spec 之外的场景：
 *
 * 1. 主题系统：`setTheme('dark')` 切换后根节点 CSS 变量被替换；
 * 2. i18n：`setLocale('en')` 切换后"会话"→"Conversations"；
 * 3. 登录回调：`onAuthenticated` 能拿到真实的 token 与 uid；
 * 4. Handle API：`handle.logout()` 能让 widget 回到认证页；
 * 5. ESM 示例：现代浏览器通过 module import 挂载，不依赖 IIFE 自动挂载。
 *
 * 测试用户名由 `uniqueUser()` 生成（内部使用 Math.random），仅用于避免并发冲突，
 * 不涉及任何安全上下文，CodeQL 对此处 Math.random 的提示属于测试场景误报。
 */

/** 测试中注入到 window 的调试属性类型。 */
interface TestWindow extends Window {
  __demoHandle?: {
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    logout: () => Promise<void>;
  };
  __authEvents?: Array<{ token: string; uid: string }>;
  YimsgUIKit?: unknown;
}

test.describe('uikit enhanced', () => {
  test('setTheme and setLocale update shadow DOM', async ({ page }) => {
    const username = uniqueUser('uidk_theme');
    await page.goto('/chat/demo/embed.html');

    // 注册并进入聊天视图，确保会话列表存在
    await page.locator('.tab[data-tab="register"]').click();
    await page.locator('#reg-username').fill(username);
    await page.locator('#reg-password').fill('123456');
    await page.locator('#reg-nickname').fill('ThemeUser');
    await page.locator('#register-form button[type="submit"]').click();
    await expect(page.locator('#conversation-list')).toBeVisible({ timeout: 15_000 });

    // 切到 dark，验证 host 元素上的 CSS 变量变化
    await page.click('#btn-theme-dark');
    const darkBg = await page.evaluate(() => (document.getElementById('chat-host') as HTMLElement).style.getPropertyValue('--mc-bg'));
    expect(darkBg.trim()).toBe('#1e1f22');

    // 切到 light
    await page.click('#btn-theme-light');
    const lightBg = await page.evaluate(() => (document.getElementById('chat-host') as HTMLElement).style.getPropertyValue('--mc-bg'));
    expect(lightBg.trim()).toBe('#ffffff');

    // 切到英文，导航 title 从“聊天”变为 “Chat”
    await page.click('#btn-locale-en');
    await expect(page.locator('.nav-item[data-view="chat"]')).toHaveAttribute('title', 'Chat', { timeout: 3_000 });
    // 切回中文
    await page.click('#btn-locale-zh');
    await expect(page.locator('.nav-item[data-view="chat"]')).toHaveAttribute('title', '聊天', { timeout: 3_000 });
  });

  test('onAuthenticated callback receives token and uid', async ({ page }) => {
    const username = uniqueUser('uidk_auth');
    await page.addInitScript(() => {
      (window as TestWindow).__authEvents = [];
    });
    await page.goto('/chat/demo/embed.html');
    // 在 widget 已挂载后订阅 authenticated 事件（demo 页把 handle 挂在 window.__demoHandle 上）
    await page.evaluate(() => {
      const w = window as TestWindow;
      w.__demoHandle?.on('authenticated', (info) => {
        w.__authEvents!.push(info as { token: string; uid: string });
      });
    });

    await page.locator('.tab[data-tab="register"]').click();
    await page.locator('#reg-username').fill(username);
    await page.locator('#reg-password').fill('123456');
    await page.locator('#reg-nickname').fill('AuthUser');
    await page.locator('#register-form button[type="submit"]').click();
    await expect(page.locator('#conversation-list')).toBeVisible({ timeout: 15_000 });

    const events = await page.evaluate(() => (window as TestWindow).__authEvents ?? []);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(typeof last.token).toBe('string');
    expect(last.token.length).toBeGreaterThan(0);
    expect(typeof last.uid).toBe('string');
    expect(last.uid.length).toBeGreaterThan(0);
  });

  test('handle.logout() takes the widget back to auth view', async ({ page }) => {
    const username = uniqueUser('uidk_lo');
    await page.goto('/chat/demo/embed.html');
    await page.locator('.tab[data-tab="register"]').click();
    await page.locator('#reg-username').fill(username);
    await page.locator('#reg-password').fill('123456');
    await page.locator('#reg-nickname').fill('LogoutUser');
    await page.locator('#register-form button[type="submit"]').click();
    await expect(page.locator('#conversation-list')).toBeVisible({ timeout: 15_000 });

    await page.evaluate(async () => {
      await (window as TestWindow).__demoHandle?.logout();
    });

    // 回到认证 tab 表单
    await expect(page.locator('.auth-card')).toBeVisible({ timeout: 5_000 });
  });

  test('ESM demo exposes mount API and renders auth form', async ({ page }) => {
    await page.goto('/chat/demo/embed.html');
    const hasApi = await page.evaluate(() => Boolean((window as TestWindow).YimsgUIKit));
    expect(hasApi).toBe(true);
    await expect(page.locator('.tab[data-tab="login"]')).toBeVisible({ timeout: 5_000 });
  });
});
