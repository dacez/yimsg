import { test, expect } from './test-fixtures';
import { uniqueUser, register, login, addFriend, sendMessage, expectMessage, openDMFromContacts } from './helpers';

test.describe('Navigation', () => {
  const password = '123456';

  test('navigate between chat, contacts, settings views', async ({ page }) => {
    await register(page, uniqueUser('nav'), password, 'NavUser');

    // Start in chat view (default)
    await expect(page.locator('#view-chat')).not.toHaveClass(/hidden/);

    // Navigate to contacts
    await page.click('[data-view="contacts"]');
    await expect(page.locator('#view-contacts')).not.toHaveClass(/hidden/);
    await expect(page.locator('#view-chat')).toHaveClass(/hidden/);

    // Navigate to settings
    await page.click('[data-view="settings"]');
    await expect(page.locator('#view-settings')).not.toHaveClass(/hidden/);
    await expect(page.locator('#view-contacts')).toHaveClass(/hidden/);

    // Back to chat
    await page.click('[data-view="chat"]');
    await expect(page.locator('#view-chat')).not.toHaveClass(/hidden/);
    await expect(page.locator('#view-settings')).toHaveClass(/hidden/);
  });

  test('active nav item is highlighted on switch', async ({ page }) => {
    await register(page, uniqueUser('navh'), password, 'HighlightUser');

    // Chat should be active by default
    await expect(page.locator('.nav-item[data-view="chat"]')).toHaveClass(/active/);

    // Switch to contacts
    await page.click('[data-view="contacts"]');
    await expect(page.locator('.nav-item[data-view="contacts"]')).toHaveClass(/active/);
    await expect(page.locator('.nav-item[data-view="chat"]')).not.toHaveClass(/active/);

    // Switch to settings
    await page.click('[data-view="settings"]');
    await expect(page.locator('.nav-item[data-view="settings"]')).toHaveClass(/active/);
    await expect(page.locator('.nav-item[data-view="contacts"]')).not.toHaveClass(/active/);
  });

  test('unread badge appears when new message arrives', async ({ browser }) => {
    const u1 = uniqueUser('ubg1');
    const u2 = uniqueUser('ubg2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Sender');
    await register(page2, u2, password, 'Recipient');
    await addFriend(page1, page2, u2);

    // User2 navigates away from chat view
    await page2.click('[data-view="settings"]');

    // User1 sends a message to user2
    await openDMFromContacts(page1, 'Recipient');
    await sendMessage(page1, 'you have a new message');

    // User2 should see a badge on the chat nav item
    const chatNavBadge = page2.locator('.nav-item[data-view="chat"] .nav-badge');
    await expect(chatNavBadge).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('unread count badge on conversation clears when opened', async ({ browser }) => {
    const u1 = uniqueUser('uc1');
    const u2 = uniqueUser('uc2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Sndr');
    await register(page2, u2, password, 'Rcvr');
    await addFriend(page1, page2, u2);

    // User2 navigates away
    await page2.click('[data-view="contacts"]');

    // User1 sends messages
    await openDMFromContacts(page1, 'Rcvr');
    await sendMessage(page1, 'msg1');
    await sendMessage(page1, 'msg2');

    // User2 goes to chat
    await page2.click('[data-view="chat"]');

    // Conversation should show unread badge
    const conv2 = page2.locator('#conversation-list .conversation-item', { hasText: 'Sndr' });
    await expect(conv2).toBeVisible({ timeout: 10_000 });
    const badge = conv2.locator('.unread-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });

    // Open conversation - badge should disappear
    await conv2.click();
    await expect(badge).toBeHidden({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('#status-bar is global: not nested inside any per-view container', async ({ page }) => {
    await register(page, uniqueUser('statusbar'), password, 'StatusBarUser');

    // #status-bar 挂在 #app 顶层（#app-body 之上），不应嵌套在 chat/contacts/settings
    // 任一 .view 容器内——否则切到其它视图时会随该 .view 的 hidden 一起被隐藏。
    const closestView = await page.locator('#status-bar').evaluate((el) => el.closest('.view')?.id ?? null);
    expect(closestView).toBeNull();

    // 切到通讯录 / 设置视图时，#status-bar 元素本身仍然存在于 DOM 中（不随 .view 一起被移除/隐藏）。
    await page.click('[data-view="contacts"]');
    await expect(page.locator('#status-bar')).toBeAttached();
    await page.click('[data-view="settings"]');
    await expect(page.locator('#status-bar')).toBeAttached();
  });

  test('#status-bar stays visible above modal overlay and other floating layers', async ({ page }) => {
    await register(page, uniqueUser('statusbarz'), password, 'StatusBarZUser');

    // #status-bar 默认是普通文档流元素：没有自己的层叠上下文时，modal-overlay 这类
    // fixed 悬浮层（z-index:1000）在绘制顺序上天然晚于它，会把它整个盖住——即"重连
    // 提示在弹窗打开时看不见"。直接摆出 reconnecting 状态 + 打开 modal-overlay，
    // 验证 status-bar 仍然处在最上层（elementFromPoint 命中的是 status-bar 而不是
    // 被 modal-overlay 盖住），不需要真的断线重连也能验证这条 CSS 层叠约束。
    await page.evaluate(() => {
      const bar = document.getElementById('status-bar')!;
      bar.textContent = 'Reconnecting...';
      bar.className = 'status-bar reconnecting';
      document.getElementById('modal-overlay')!.classList.remove('hidden');
    });

    const topElementId = await page.evaluate(() => {
      const rect = document.getElementById('status-bar')!.getBoundingClientRect();
      const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return el?.closest('#status-bar') ? 'status-bar' : el?.closest('#modal-overlay') ? 'modal-overlay' : (el?.id ?? null);
    });
    expect(topElementId).toBe('status-bar');
  });

  test('empty conversation list shows empty state', async ({ page }) => {
    await register(page, uniqueUser('empty'), password, 'EmptyUser');
    await page.click('[data-view="chat"]');
    await expect(page.locator('#conversation-list')).toContainText(/No conversations yet|暂无会话/);
  });

  test('conversation list updates when new message arrives', async ({ browser }) => {
    const u1 = uniqueUser('cl1');
    const u2 = uniqueUser('cl2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ConvSender');
    await register(page2, u2, password, 'ConvReceiver');
    await addFriend(page1, page2, u2);

    // User1 sends a message
    await openDMFromContacts(page1, 'ConvReceiver');
    await sendMessage(page1, 'hello from conv sender');

    // User2 should see conversation appear
    await page2.click('[data-view="chat"]');
    const conv = page2.locator('#conversation-list .conversation-item', { hasText: 'ConvSender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });

    // Conversation preview should show the message
    await expect(conv.locator('.conversation-preview')).toContainText('hello from conv sender', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('contacts badge disappears after accepting all requests', async ({ browser }) => {
    const u1 = uniqueUser('cba1');
    const u2 = uniqueUser('cba2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Adder');
    await register(page2, u2, password, 'AddTarget');

    // u1 sends friend request to u2
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="search"]');
    await page1.fill('#search-username', u2);
    await page1.click('#search-btn');
    const addBtn = page1.locator('#search-results button');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-confirm-btn');

    // u2 should see contacts badge (a .nav-badge child element)
    const contactsNavBadge = page2.locator('.nav-item[data-view="contacts"] .nav-badge');
    await expect(contactsNavBadge).toBeVisible({ timeout: 10_000 });

    // u2 accepts the request
    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="requests"]');
    const acceptBtn = page2.locator('#requests-tab .btn-primary').first();
    await expect(acceptBtn).toBeVisible({ timeout: 10_000 });
    await acceptBtn.click();
    await page2.waitForTimeout(500);

    // Badge should disappear after accepting
    await expect(contactsNavBadge).toBeHidden({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});
