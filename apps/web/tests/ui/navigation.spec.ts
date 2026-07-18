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
