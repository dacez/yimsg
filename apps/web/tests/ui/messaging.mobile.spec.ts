import { test, expect, devices } from './test-fixtures';
import { uniqueUser, register, addFriend, openDMFromContacts, sendMessage, expectMessage } from './helpers';

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

    // 触屏设备下消息输入框字号必须 >= 16px，否则 iOS Safari 聚焦时会自动放大整页且不会自动缩回
    await expect(page1.locator('#msg-input')).toHaveCSS('font-size', '16px');

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

    // 按钮不应被消息行的 flex 布局压扁：宽高应保持接近相等的正圆
    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    }

    // 点击 ⋯ 按钮（相当于手机用户的替代入口）应能弹出含"撤回"的菜单
    await trigger.click();
    await expect(page1.locator('.message-action-menu [data-action="recall"]')).toBeVisible({ timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('桌面鼠标环境下手动选择手机布局，消息操作按钮无需悬停即可见且不被压扁', async ({ browser }) => {
    // 复现真实场景：非触屏设备（真实鼠标，hover:hover / pointer:fine），
    // 用户在启动页手动把布局偏好切成"手机"，此时不应依赖 hover 才显示操作按钮。
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u1 = uniqueUser('mobd1');
    const u2 = uniqueUser('mobd2');

    await register(page1, u1, password, 'MobileDesktopA', 'mobile');
    await register(page2, u2, password, 'MobileDesktopB');

    await expect(page1.locator('body')).toHaveAttribute('data-layout', 'mobile');

    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'MobileDesktopB');

    await page1.fill('#msg-input', 'desktop-mouse mobile layout');
    await page1.click('#msg-send');
    await expect(page1.locator('#message-list', { hasText: 'desktop-mouse mobile layout' })).toBeVisible();

    const trigger = page1.locator('.message-row.self .message-actions-trigger').last();
    // 关键：鼠标停在别处（不 hover 这一行），按钮也必须可见
    await page1.mouse.move(10, 10);
    await expect.poll(async () => Number(await trigger.evaluate((el) => getComputedStyle(el).opacity)), {
      message: 'manually-selected mobile layout should keep the trigger visible without hover',
      timeout: 3000,
    }).toBeGreaterThan(0.9);

    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    }

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

    // 点击顶栏返回按钮应回到会话列表
    await page1.locator('#chat-back-btn').click();
    await expect(page1.locator('#left-panel')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });

  // 回归用例：移动端从聊天页点返回只会隐藏聊天面板、不会清空 currentConvKey（详见
  // messaging.mobile.spec.ts 上面 "mobile chat view hides conversation list" 那条用例）。
  // 因此全局搜索命中"刚刚返回前正在看的那个会话"内的消息时，若跳转逻辑只在
  // currentConvKey 变化时才重新展示聊天面板，就会误判"已经是当前会话"而跳过展示，
  // 移动端点击搜索结果后仍停留在会话列表——这正是用户报告的 bug（搜中间的消息不跳转，
  // 搜最后一条消息才正常，实为"是否恰好在此之前手动重新进过该会话"的巧合）。
  test('mobile 从聊天页返回会话列表后，全局搜索命中同一会话内的消息也要正确跳转到聊天面板', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u1 = uniqueUser('mobj1');
    const u2 = uniqueUser('mobj2');

    await register(page1, u1, password, 'MobJumpSearcher');
    await register(page2, u2, password, 'MobJumpFriend');
    await addFriend(page1, page2, u2);

    await openDMFromContacts(page1, 'MobJumpFriend');
    for (let i = 1; i <= 9; i++) {
      await sendMessage(page1, `mobjump message ${i}`);
    }
    await expectMessage(page1, 'mobjump message 9');

    // 点击顶栏返回按钮回到会话列表：只隐藏聊天面板，currentConvKey 不清空。
    await page1.locator('#chat-back-btn').click();
    await expect(page1.locator('#left-panel')).toBeVisible();
    await expect(page1.locator('#center-panel')).toBeHidden();

    // 全局搜索命中会话中间（非最后一条）的消息，点击应正确切到聊天面板并高亮定位。
    await page1.fill('#global-search-input', 'mobjump message 3');
    const messageResult = page1.locator('#global-search-results .conversation-item', { hasText: 'mobjump message 3' });
    await expect(messageResult).toBeVisible({ timeout: 10_000 });
    await messageResult.click();

    await expect(page1.locator('#center-panel')).toBeVisible({ timeout: 5_000 });
    await expect(page1.locator('#left-panel')).toBeHidden({ timeout: 5_000 });
    const highlighted = page1.locator('.message-row.msg-highlight');
    await expect(highlighted).toBeVisible({ timeout: 5_000 });
    await expect(highlighted.locator('.message-bubble')).toContainText('mobjump message 3');

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

    const backBtn = page1.locator('#chat-back-btn');
    await backBtn.click();
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

    await backBtn.click();
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

  test('conversation list plus button opens a menu with create-group and add-friend', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ...iphone, ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const u1 = uniqueUser('plus1');
    const u2 = uniqueUser('plus2');
    await register(page1, u1, password, 'PlusOwner');
    await register(page2, u2, password, 'PlusFriend');
    await addFriend(page1, page2, u2);

    // addFriend 结束后停留在通讯录视图，加号按钮属于会话列表视图，需先切回去
    await page1.click('[data-view="chat"]');

    // 点击左上角加号弹出下拉菜单（创建群聊 + 添加好友）
    await page1.click('#chat-list-start-btn');
    await expect(page1.locator('.plus-menu [data-action="create-group"]')).toBeVisible();
    await expect(page1.locator('.plus-menu [data-action="add-friend"]')).toBeVisible();

    // 点击菜单外部应关闭菜单，不触发任何菜单项动作
    await page1.click('#conversation-list');
    await expect(page1.locator('.plus-menu')).toHaveCount(0);

    // 点击"创建群聊"直接弹出建群 Modal
    await page1.click('#chat-list-start-btn');
    await page1.click('.plus-menu [data-action="create-group"]');
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-cancel');

    // 点击"添加好友"跳到通讯录搜索 Tab
    await page1.click('#chat-list-start-btn');
    await page1.click('.plus-menu [data-action="add-friend"]');
    await expect(page1.locator('#search-tab')).not.toHaveClass(/hidden/);

    await ctx1.close();
    await ctx2.close();
  });
});
