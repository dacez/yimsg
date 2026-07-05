/**
 * 多端同步测试 — 同一用户在两个浏览器上下文中登录（模拟两台设备），
 * 验证消息、红点、通讯录变更在两端之间的实时同步。
 *
 * 注：持久存储模式在 headless Chromium 中不支持持久存储后端，因此仅测试 memory + memory 模式。
 */
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { uniqueUser, register, login, addFriend, sendMessage, expectMessage, openDMFromContacts, openConversation, getMessageTexts } from './helpers';

test.describe('Multi-Device Sync', () => {
  const password = '123456';

  /**
   * Helper: login the same user on two separate browser contexts.
   * Returns [deviceA, deviceB] pages.
   */
  async function loginOnTwoDevices(
    browser: import('@playwright/test').Browser,
    username: string,
    pwd: string,
  ): Promise<[Page, Page, BrowserContext, BrowserContext]> {
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await login(pageA, username, pwd);
    await login(pageB, username, pwd);
    return [pageA, pageB, ctxA, ctxB];
  }

  test('message from third party appears on both devices', async ({ browser }) => {
    const userA = uniqueUser('md_a');
    const userB = uniqueUser('md_b');

    // Register both users in separate contexts
    const ctxReg = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageReg = await ctxReg.newPage();
    await register(pageReg, userA, password, 'DeviceUser');
    await ctxReg.close();

    const ctxSender = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageSender = await ctxSender.newPage();
    await register(pageSender, userB, password, 'Sender');

    // Make them friends (from sender's side, DeviceUser accepts)
    const ctxAccept = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageAccept = await ctxAccept.newPage();
    await login(pageAccept, userA, password);
    await addFriend(pageSender, pageAccept, userA);
    await ctxAccept.close();

    // DeviceUser logs in on two devices
    const [deviceA, deviceB, ctxA, ctxB] = await loginOnTwoDevices(browser, userA, password);

    // Both devices open chat view
    await deviceA.click('[data-view="chat"]');
    await deviceB.click('[data-view="chat"]');

    // Sender sends a message to DeviceUser
    await openDMFromContacts(pageSender, 'DeviceUser');
    await sendMessage(pageSender, 'hello multi-device');

    // Both devices should see the new conversation appear
    const convA = deviceA.locator('#conversation-list .conversation-item', { hasText: 'Sender' });
    const convB = deviceB.locator('#conversation-list .conversation-item', { hasText: 'Sender' });
    await expect(convA).toBeVisible({ timeout: 10_000 });
    await expect(convB).toBeVisible({ timeout: 10_000 });

    // Device A opens the conversation and sees the message
    await convA.click();
    await expectMessage(deviceA, 'hello multi-device', 20_000);

    // Device B also opens and sees the same message
    await convB.click();
    await expectMessage(deviceB, 'hello multi-device', 20_000);

    await ctxA.close();
    await ctxB.close();
    await ctxSender.close();
  });

  test('message sent on device A appears on device B', async ({ browser }) => {
    const user1 = uniqueUser('ms_u1');
    const user2 = uniqueUser('ms_u2');

    // Register both users
    const ctxU1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxU2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageU1 = await ctxU1.newPage();
    const pageU2 = await ctxU2.newPage();
    await register(pageU1, user1, password, 'SyncSender');
    await register(pageU2, user2, password, 'SyncFriend');
    await addFriend(pageU1, pageU2, user2);
    await ctxU1.close();

    // User1 logs in on two devices
    const [deviceA, deviceB, ctxA, ctxB] = await loginOnTwoDevices(browser, user1, password);

    // Device A opens DM with user2 and sends a message
    await deviceA.click('[data-view="chat"]');
    await deviceB.click('[data-view="chat"]');

    await openDMFromContacts(deviceA, 'SyncFriend');
    await sendMessage(deviceA, 'sent from device A');
    await expectMessage(deviceA, 'sent from device A');

    // Device B should see the conversation appear with the sent message
    const convB = deviceB.locator('#conversation-list .conversation-item', { hasText: 'SyncFriend' });
    await expect(convB).toBeVisible({ timeout: 10_000 });
    await convB.click();
    await expectMessage(deviceB, 'sent from device A', 10_000);

    // Device B sends a reply
    await sendMessage(deviceB, 'reply from device B');
    await expectMessage(deviceB, 'reply from device B');

    // Device A should see the reply
    await expectMessage(deviceA, 'reply from device B', 10_000);

    await ctxA.close();
    await ctxB.close();
    await ctxU2.close();
  });

  test('clear_unread on device A clears unread badge on device B', async ({ browser }) => {
    const user1 = uniqueUser('mr_u1');
    const user2 = uniqueUser('mr_u2');

    // Register user1 and user2
    const ctxU1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxU2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageU1 = await ctxU1.newPage();
    const pageU2 = await ctxU2.newPage();
    await register(pageU1, user1, password, 'Reader');
    await register(pageU2, user2, password, 'MsgSender');
    await addFriend(pageU1, pageU2, user2);
    await ctxU1.close();

    // User1 logs in on two devices
    const [deviceA, deviceB, ctxA, ctxB] = await loginOnTwoDevices(browser, user1, password);

    // Both go to chat view
    await deviceA.click('[data-view="chat"]');
    await deviceB.click('[data-view="chat"]');

    // User2 sends a message to user1
    await openDMFromContacts(pageU2, 'Reader');
    await sendMessage(pageU2, 'unread test msg');

    // Both devices should see the conversation with unread badge
    const convA = deviceA.locator('#conversation-list .conversation-item', { hasText: 'MsgSender' });
    const convB = deviceB.locator('#conversation-list .conversation-item', { hasText: 'MsgSender' });
    await expect(convA).toBeVisible({ timeout: 10_000 });
    await expect(convB).toBeVisible({ timeout: 10_000 });

    // Both should show unread badge
    await expect(convA.locator('.unread-badge')).toBeVisible({ timeout: 5000 });
    await expect(convB.locator('.unread-badge')).toBeVisible({ timeout: 5000 });

    // Device A opens the conversation (triggers clear_unread)
    await convA.click();
    await expectMessage(deviceA, 'unread test msg', 5000);

    // Device A's badge should be cleared
    await expect(convA.locator('.unread-badge')).toBeHidden({ timeout: 5000 });

    // Device B's badge should also be cleared via conversations:clearunread notification
    await expect(convB.locator('.unread-badge')).toBeHidden({ timeout: 10_000 });

    await ctxA.close();
    await ctxB.close();
    await ctxU2.close();
  });

  test('staying in conversation auto-clears unread for new messages', async ({ browser }) => {
    const user1 = uniqueUser('ac_u1');
    const user2 = uniqueUser('ac_u2');

    const ctxU1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxU2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageU1 = await ctxU1.newPage();
    const pageU2 = await ctxU2.newPage();
    await register(pageU1, user1, password, 'StayUser');
    await register(pageU2, user2, password, 'AutoSender');
    await addFriend(pageU1, pageU2, user2);
    await ctxU1.close();

    // User1 logs in and opens the DM with user2
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const deviceA = await ctxA.newPage();
    await login(deviceA, user1, password);
    await deviceA.click('[data-view="chat"]');

    // User2 sends first message
    await openDMFromContacts(pageU2, 'StayUser');
    await sendMessage(pageU2, 'first msg');

    // User1 opens the conversation
    const conv = deviceA.locator('#conversation-list .conversation-item', { hasText: 'AutoSender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await conv.click();
    await expectMessage(deviceA, 'first msg', 10_000);

    // While user1 stays in the conversation, user2 sends more messages
    await sendMessage(pageU2, 'second msg while viewing');
    await expectMessage(deviceA, 'second msg while viewing', 10_000);

    // The conversation should NOT have an unread badge (user is viewing it)
    await expect(conv.locator('.unread-badge')).toBeHidden({ timeout: 5000 });

    // Chat nav should also not show unread dot
    const chatNav = deviceA.locator('.nav-item[data-view="chat"]');
    await expect(chatNav.locator('.nav-badge')).toBeHidden({ timeout: 3000 });

    await ctxA.close();
    await ctxU2.close();
  });

  test('accept friend on device A syncs to device B contacts', async ({ browser }) => {
    const user1 = uniqueUser('cs_u1');
    const requester = uniqueUser('cs_req');

    // Register both users
    const ctxReq = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageReq = await ctxReq.newPage();
    await register(pageReq, requester, password, 'FriendRequester');

    const ctxReg = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageReg = await ctxReg.newPage();
    await register(pageReg, user1, password, 'ContactSync');
    await ctxReg.close();

    // Requester sends friend request to user1
    await pageReq.click('[data-view="contacts"]');
    await pageReq.click('[data-ctab="search"]');
    await pageReq.fill('#search-username', user1);
    await pageReq.click('#search-btn');
    const addBtn = pageReq.locator('#search-results button');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await expect(pageReq.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await pageReq.click('#modal-confirm-btn');

    // User1 logs in on two devices
    const [deviceA, deviceB, ctxA, ctxB] = await loginOnTwoDevices(browser, user1, password);

    // Device A: go to contacts → requests, accept the friend request
    await deviceA.click('[data-view="contacts"]');
    await deviceA.click('[data-ctab="requests"]');
    const acceptBtn = deviceA.locator('#requests-tab .btn-primary').first();
    await expect(acceptBtn).toBeVisible({ timeout: 10_000 });
    await acceptBtn.click();

    // Device A: should see the friend in friends list
    await deviceA.click('[data-ctab="friends"]');
    await expect(deviceA.locator('#friends-tab')).toContainText('FriendRequester', { timeout: 5000 });

    // Device B: should also see the friend appear (via contacts:updated notification → sync)
    await deviceB.click('[data-view="contacts"]');
    await deviceB.click('[data-ctab="friends"]');
    await expect(deviceB.locator('#friends-tab')).toContainText('FriendRequester', { timeout: 15_000 });

    await ctxA.close();
    await ctxB.close();
    await ctxReq.close();
  });

  test('chat nav badge syncs across devices when unread cleared', async ({ browser }) => {
    const user1 = uniqueUser('nb_u1');
    const user2 = uniqueUser('nb_u2');

    const ctxU2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageU2 = await ctxU2.newPage();
    await register(pageU2, user2, password, 'BadgeSender');

    const ctxReg = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageReg = await ctxReg.newPage();
    await register(pageReg, user1, password, 'BadgeUser');
    await addFriend(pageReg, pageU2, user2);
    await ctxReg.close();

    // User1 on two devices
    const [deviceA, deviceB, ctxA, ctxB] = await loginOnTwoDevices(browser, user1, password);

    // Device B goes to settings (not chat) so badge is visible on nav
    await deviceB.click('[data-view="settings"]');

    // User2 sends message
    await openDMFromContacts(pageU2, 'BadgeUser');
    await sendMessage(pageU2, 'badge sync test');

    // Device B should see chat nav badge (red dot)
    const chatNavB = deviceB.locator('.nav-item[data-view="chat"]');
    await expect(chatNavB.locator('.nav-badge')).toBeVisible({ timeout: 10_000 });

    // Device A opens chat and reads the message
    await deviceA.click('[data-view="chat"]');
    const convA = deviceA.locator('#conversation-list .conversation-item', { hasText: 'BadgeSender' });
    await expect(convA).toBeVisible({ timeout: 10_000 });
    await convA.click();
    await expectMessage(deviceA, 'badge sync test', 5000);

    // Device B's chat nav badge should disappear (conversations:clearunread synced)
    await expect(chatNavB.locator('.nav-badge')).toBeHidden({ timeout: 10_000 });

    await ctxA.close();
    await ctxB.close();
    await ctxU2.close();
  });
});
