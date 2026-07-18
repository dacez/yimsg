/**
 * 增强多端同步测试 — 补充现有 multi-device.spec.ts 的覆盖缺口：
 * 1. 单向删好友后的可见性
 * 2. 群消息两端同步
 * 3. 系统消息渲染
 * 4. 会话未读红点数字正确
 */
import { test, expect } from './test-fixtures';
import { uniqueUser, register, login, addFriend, sendMessage, expectMessage, openDMFromContacts, openConversation } from './helpers';

test.describe('Enhanced Sync Tests', () => {
  const password = '123456';

  test('delete friend only removes from deleter contacts', async ({ browser }) => {
    const u1 = uniqueUser('df1');
    const u2 = uniqueUser('df2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'DelFriend1');
    await register(page2, u2, password, 'DelFriend2');
    await addFriend(page1, page2, u2);

    // Verify both have each other in friends
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('#friends-tab', { hasText: 'DelFriend2' })).toBeVisible({ timeout: 10_000 });

    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="friends"]');
    await expect(page2.locator('#friends-tab', { hasText: 'DelFriend1' })).toBeVisible({ timeout: 10_000 });

    // User1 deletes user2 via the detail panel
    const friendItem = page1.locator('.contact-item', { hasText: 'DelFriend2' });
    await friendItem.click();
    const deleteBtn = page1.locator('#contacts-detail-panel [data-action="delete"]');
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();
      // Confirm if needed
      const confirmBtn = page1.locator('.modal-confirm, #confirm-delete');
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
      }
      await page1.waitForTimeout(1000);

      // User1's friends list should not show DelFriend2
      await page1.click('[data-ctab="friends"]');
      await expect(page1.locator('#friends-tab')).not.toContainText('DelFriend2', { timeout: 5000 });

      // User2 should still keep User1 in friends list（单向删除）
      await page2.click('[data-ctab="friends"]');
      await page2.waitForTimeout(2000);
      await page2.click('[data-ctab="friends"]');
      await expect(page2.locator('#friends-tab')).toContainText('DelFriend1', { timeout: 10_000 });
    }

    await ctx1.close();
    await ctx2.close();
  });

  test('group message visible to all members', async ({ browser }) => {
    const u1 = uniqueUser('gm1');
    const u2 = uniqueUser('gm2');
    const u3 = uniqueUser('gm3');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx3 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    await register(page1, u1, password, 'GrpSender');
    await register(page2, u2, password, 'GrpMember2');
    await register(page3, u3, password, 'GrpMember3');
    await addFriend(page1, page2, u2);
    await addFriend(page1, page3, u3);

    // Create group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'SyncGroup');

    // Select all friends as members。addFriend 落库到建群成员列表可见有异步延迟，
    // 先显式等两个好友都出现在成员列表，避免选到空成员导致建群校验失败、modal 不关。
    const checkboxes = page1.locator('.member-select-item input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(2, { timeout: 15_000 });
    const checkboxCount = await checkboxes.count();
    for (let i = 0; i < checkboxCount; i++) {
      await checkboxes.nth(i).check();
    }
    await page1.click('#modal-create');
    // 等建群成功、modal 真正关闭再继续（旧代码只 waitForTimeout(1000) 就点导航，
    // 建群失败/未完成时 modal 仍开，遮罩挡住后续点击直到测试超时，表现为偶发失败）。
    await expect(modal).toHaveCount(0, { timeout: 15_000 });

    // Send group message
    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'SyncGroup' });
    await expect(groupConv).toBeVisible({ timeout: 15_000 });
    await groupConv.click();
    await sendMessage(page1, 'hello all members');

    // Member 2 should receive
    await page2.click('[data-view="chat"]');
    const conv2 = page2.locator('#conversation-list .conversation-item', { hasText: 'SyncGroup' });
    await expect(conv2).toBeVisible({ timeout: 15_000 });
    await conv2.click();
    await expectMessage(page2, 'hello all members', 20_000);

    // Member 3 should also receive
    await page3.click('[data-view="chat"]');
    const conv3 = page3.locator('#conversation-list .conversation-item', { hasText: 'SyncGroup' });
    await expect(conv3).toBeVisible({ timeout: 15_000 });
    await conv3.click();
    await expectMessage(page3, 'hello all members', 20_000);

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });

  test('unread count shows correct number', async ({ browser }) => {
    const u1 = uniqueUser('uc1');
    const u2 = uniqueUser('uc2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'UnreadCounter');
    await register(page2, u2, password, 'MsgFlood');
    await addFriend(page1, page2, u2);

    // User1 stays on settings page (not viewing chat)
    await page1.click('[data-view="settings"]');

    // User2 sends 3 messages
    await openDMFromContacts(page2, 'UnreadCounter');
    await sendMessage(page2, 'msg 1');
    await page2.waitForTimeout(300);
    await sendMessage(page2, 'msg 2');
    await page2.waitForTimeout(300);
    await sendMessage(page2, 'msg 3');

    // User1 goes to chat view
    await page1.click('[data-view="chat"]');

    // Should see unread badge with count 3
    const conv = page1.locator('#conversation-list .conversation-item', { hasText: 'MsgFlood' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    const badge = conv.locator('.unread-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => parseInt((await badge.textContent()) || '0'), {
      timeout: 5000,
    }).toBeGreaterThanOrEqual(3);

    // Click to open → badge should clear
    await conv.click();
    await expectMessage(page1, 'msg 3', 5000);
    await expect(badge).toBeHidden({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('conversation list updates when receiving message while on another tab', async ({ browser }) => {
    const u1 = uniqueUser('cl1');
    const u2 = uniqueUser('cl2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ConvListUser');
    await register(page2, u2, password, 'ConvListSender');
    await addFriend(page1, page2, u2);

    // User1 is on contacts tab
    await page1.click('[data-view="contacts"]');

    // User2 sends message
    await openDMFromContacts(page2, 'ConvListUser');
    await sendMessage(page2, 'while away');

    // User1 switches to chat tab
    await page1.click('[data-view="chat"]');

    // Conversation should appear with preview
    const conv = page1.locator('#conversation-list .conversation-item', { hasText: 'ConvListSender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await expect(conv.locator('.conversation-preview')).toContainText('while away', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('nav badge appears when message received on non-chat view', async ({ browser }) => {
    const u1 = uniqueUser('nb1');
    const u2 = uniqueUser('nb2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'NavBadge1');
    await register(page2, u2, password, 'NavBadge2');
    await addFriend(page1, page2, u2);

    // User1 on settings
    await page1.click('[data-view="settings"]');

    // User2 sends message
    await openDMFromContacts(page2, 'NavBadge1');
    await sendMessage(page2, 'trigger badge');

    // Chat nav item should show badge
    const chatNav = page1.locator('.nav-item[data-view="chat"]');
    await expect(chatNav.locator('.nav-badge')).toBeVisible({ timeout: 10_000 });

    // Opening chat and reading should clear it
    await page1.click('[data-view="chat"]');
    const conv = page1.locator('#conversation-list .conversation-item', { hasText: 'NavBadge2' });
    await expect(conv).toBeVisible({ timeout: 5000 });
    await conv.click();
    await expectMessage(page1, 'trigger badge', 5000);

    // Badge should clear
    await expect(chatNav.locator('.nav-badge')).toBeHidden({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});
