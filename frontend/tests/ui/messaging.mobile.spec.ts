import { test, expect, devices } from '@playwright/test';
import { uniqueUser, register, addFriend, openDMFromContacts, sendMessage } from './helpers';

// 使用 iPhone 13 的设备尺寸与 pointer: coarse，验证移动端布局与长按撤回路径。
test.describe('Mobile layout & recall', () => {
  const password = '123456';
  const iphone = devices['iPhone 13'];

  test('mobile layout applies data-layout=mobile and long-press opens recall menu', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u1 = uniqueUser('mob1');
    const u2 = uniqueUser('mob2');

    await register(page1, u1, password, 'MobileSender');
    await register(page2, u2, password, 'MobileReceiver');

    // 确认启动后 body 上有 data-layout 属性（自动检测 → mobile）
    const layout = await page1.evaluate(() => document.body.dataset.layout);
    expect(layout).toBe('mobile');

    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'MobileReceiver');

    // 发送一条消息
    await page1.fill('#msg-input', 'mobile hello');
    await page1.click('#msg-send');
    await expect(page1.locator('#message-list', { hasText: 'mobile hello' })).toBeVisible();

    // 在触屏 viewport 下，动作触发按钮应直接可见（opacity:1）
    const trigger = page1.locator('.message-row.self .message-actions-trigger').last();
    await expect(trigger).toBeVisible();
    await expect(page1.locator('body')).toHaveAttribute('data-layout', 'mobile');
    await expect.poll(async () => Number(await trigger.evaluate((el) => getComputedStyle(el).opacity)), {
      message: 'mobile message action trigger should become visible after layout styles settle',
      timeout: 3000,
    }).toBeGreaterThan(0.9);

    // 点击 ⋯ 按钮（相当于手机用户的替代入口）应能弹出含"撤回"的菜单
    await trigger.click();
    await expect(page1.locator('.message-action-menu [data-action="recall"]')).toBeVisible({ timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('mobile chat view hides conversation list when conversation is opened', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u1 = uniqueUser('mobx1');
    const u2 = uniqueUser('mobx2');

    await register(page1, u1, password, 'MobXA');
    await register(page2, u2, password, 'MobXB');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'MobXB');

    // 打开会话后，左侧会话列表应不可见
    await expect(page1.locator('#left-panel')).toBeHidden();
    await expect(page1.locator('#center-panel')).toBeVisible();

    // 点击 header 左上角返回区域（前 56px）应回到会话列表
    const header = page1.locator('#chat-header');
    await header.click({ position: { x: 10, y: 20 } });
    await expect(page1.locator('#left-panel')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  test('mobile 会话列表保留选中会话时不会自动清未读，只有真正进入聊天面板才清除', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u1 = uniqueUser('mobur1');
    const u2 = uniqueUser('mobur2');

    await register(page1, u1, password, 'MobileUnreadReader');
    await register(page2, u2, password, 'MobileUnreadSender');
    await addFriend(page1, page2, u2);

    await openDMFromContacts(page1, 'MobileUnreadSender');

    const header = page1.locator('#chat-header');
    await header.click({ position: { x: 10, y: 20 } });
    await expect(page1.locator('#left-panel')).toBeVisible();
    await expect(page1.locator('#center-panel')).toBeHidden();

    await openDMFromContacts(page2, 'MobileUnreadReader');
    await sendMessage(page2, 'mobile unread should stay');

    const conv = page1.locator('#conversation-list .conversation-item', { hasText: 'MobileUnreadSender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await expect(conv.locator('.unread-badge')).toBeVisible({ timeout: 10_000 });
    await expect(page1.locator('.nav-item[data-view="chat"] .nav-badge')).toBeVisible({ timeout: 10_000 });

    await page1.click('[data-view="settings"]');
    await page1.click('[data-view="chat"]');

    await expect(page1.locator('#left-panel')).toBeVisible();
    await expect(page1.locator('#center-panel')).toBeHidden();
    await expect(conv.locator('.unread-badge')).toBeVisible({ timeout: 5_000 });
    await expect(page1.locator('.nav-item[data-view="chat"] .nav-badge')).toBeVisible({ timeout: 5_000 });

    await conv.click();
    await expect(page1.locator('#center-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page1.locator('#message-list', { hasText: 'mobile unread should stay' })).toBeVisible({ timeout: 10_000 });
    await expect(page1.locator('.nav-item[data-view="chat"] .nav-badge')).toBeHidden({ timeout: 10_000 });

    await header.click({ position: { x: 10, y: 20 } });
    await expect(page1.locator('#left-panel')).toBeVisible({ timeout: 5_000 });
    await expect(conv.locator('.unread-badge')).toBeHidden({ timeout: 5_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('desktop viewport keeps three-column layout (data-layout=desktop)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const u = uniqueUser('desk');
    await register(page, u, password, 'DeskUser');
    const layout = await page.evaluate(() => document.body.dataset.layout);
    expect(layout).toBe('desktop');
    await ctx.close();
  });
});
