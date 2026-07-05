import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { uniqueUser, register, addFriend, sendMessage, expectMessage, openConversation, loginSeedUser, seedPrefix } from './helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Group Chat', () => {
  const password = '123456';

  test('create group with one friend', async ({ browser }) => {
    const owner = uniqueUser('go');
    const member = uniqueUser('gm');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'GroupOwner');
    await register(page2, member, password, 'GroupMember');
    await addFriend(page1, page2, member);

    // Create a group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');

    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Fill group name
    await page1.fill('#group-name-input', 'TestGroup1');

    // Select GroupMember
    const memberCheckbox = page1.locator('.member-select-item', { hasText: 'GroupMember' }).locator('input[type="checkbox"]');
    await expect(memberCheckbox).toBeVisible({ timeout: 5000 });
    await memberCheckbox.check();

    await page1.click('#modal-create');

    // Navigate to chat view then check group appears in conversation list
    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'TestGroup1' });
    await expect(groupConv).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('create group requires at least one member', async ({ browser }) => {
    const owner = uniqueUser('gnm');
    const friend = uniqueUser('gnmf');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'NoMemberOwner');
    await register(page2, friend, password, 'Friend');
    await addFriend(page1, page2, friend);

    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');

    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page1.fill('#group-name-input', 'EmptyGroup');
    // Don't select any member
    await page1.click('#modal-create');

    // Should show error toast (no member selected)
    await expect(page1.locator('.toast-error')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('create group requires a name', async ({ browser }) => {
    const owner = uniqueUser('gnn');
    const friend = uniqueUser('gnnf');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'NoNameOwner');
    await register(page2, friend, password, 'FriendForGroup');
    await addFriend(page1, page2, friend);

    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');

    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Don't fill group name
    const memberCheckbox = page1.locator('.member-select-item', { hasText: 'FriendForGroup' }).locator('input[type="checkbox"]');
    await expect(memberCheckbox).toBeVisible({ timeout: 5000 });
    await memberCheckbox.check();
    await page1.click('#modal-create');

    // Should show error toast (no name)
    await expect(page1.locator('.toast-error')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('group message received by all members', async ({ browser }) => {
    const owner = uniqueUser('gmo');
    const member = uniqueUser('gmm');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'GOwner');
    await register(page2, member, password, 'GMember');
    await addFriend(page1, page2, member);

    // Create group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'GroupChat1');
    const memberCb = page1.locator('.member-select-item', { hasText: 'GMember' }).locator('input[type="checkbox"]');
    await expect(memberCb).toBeVisible({ timeout: 5000 });
    await memberCb.check();
    await page1.click('#modal-create');

    // Owner sends a message in the group
    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'GroupChat1' });
    await expect(groupConv).toBeVisible({ timeout: 5000 });
    await groupConv.click();
    await sendMessage(page1, 'hello group!');
    await expectMessage(page1, 'hello group!');

    // Member should receive the message
    await page2.click('[data-view="chat"]');
    const memberGroupConv = page2.locator('#conversation-list .conversation-item', { hasText: 'GroupChat1' });
    await expect(memberGroupConv).toBeVisible({ timeout: 15_000 });
    await memberGroupConv.click();
    await expectMessage(page2, 'hello group!', 10_000);

    await ctx1.close();
    await ctx2.close();
  });

  test('group members shown in detail panel', async ({ browser }) => {
    const owner = uniqueUser('gd1');
    const friend = uniqueUser('gd2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'DetailOwner');
    await register(page2, friend, password, 'DetailMember');
    await addFriend(page1, page2, friend);

    // Create group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'DetailGroup');
    const cb = page1.locator('.member-select-item', { hasText: 'DetailMember' }).locator('input[type="checkbox"]');
    await expect(cb).toBeVisible({ timeout: 5000 });
    await cb.check();
    await page1.click('#modal-create');

    // Open group and toggle detail panel
    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'DetailGroup' });
    await expect(groupConv).toBeVisible({ timeout: 5000 });
    await groupConv.click();
    await page1.click('#toggle-detail');

    // Detail panel should show group info and members
    const rightPanel = page1.locator('#right-panel');
    await expect(rightPanel).not.toHaveClass(/collapsed/, { timeout: 5000 });
    await expect(rightPanel.locator('#members-list')).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('member can also send group messages', async ({ browser }) => {
    const owner = uniqueUser('msg_o');
    const mem = uniqueUser('msg_m');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'MsgOwner');
    await register(page2, mem, password, 'MsgMem');
    await addFriend(page1, page2, mem);

    // Create group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'BothSendGroup');
    const cb = page1.locator('.member-select-item', { hasText: 'MsgMem' }).locator('input[type="checkbox"]');
    await expect(cb).toBeVisible({ timeout: 5000 });
    await cb.check();
    await page1.click('#modal-create');

    // Owner sends message
    await page1.click('[data-view="chat"]');
    const ownerGroupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'BothSendGroup' });
    await expect(ownerGroupConv).toBeVisible({ timeout: 5000 });
    await ownerGroupConv.click();
    await sendMessage(page1, 'owner says hi');
    await expectMessage(page1, 'owner says hi');

    // Member opens and replies
    await page2.click('[data-view="chat"]');
    const memGroupConv = page2.locator('#conversation-list .conversation-item', { hasText: 'BothSendGroup' });
    await expect(memGroupConv).toBeVisible({ timeout: 15_000 });
    await memGroupConv.click();
    await expectMessage(page2, 'owner says hi', 10_000);
    await sendMessage(page2, 'member replies');
    await expectMessage(page2, 'member replies');

    // Owner should receive the reply
    await expectMessage(page1, 'member replies', 10_000);

    await ctx1.close();
    await ctx2.close();
  });

  test('update group avatar as owner', async ({ browser }) => {
    const owner = uniqueUser('ga_o');
    const member = uniqueUser('ga_m');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, owner, password, 'AvatarOwner');
    await register(page2, member, password, 'AvatarMember');
    await addFriend(page1, page2, member);

    // Create group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'AvatarGroup');
    const cb = page1.locator('.member-select-item', { hasText: 'AvatarMember' }).locator('input[type="checkbox"]');
    await expect(cb).toBeVisible({ timeout: 5000 });
    await cb.check();
    await page1.click('#modal-create');

    // Open group and toggle detail panel
    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'AvatarGroup' });
    await expect(groupConv).toBeVisible({ timeout: 5000 });
    await groupConv.click();
    await page1.click('#toggle-detail');

    const rightPanel = page1.locator('#right-panel');
    await expect(rightPanel).not.toHaveClass(/collapsed/, { timeout: 5000 });

    // Owner should see clickable avatar with file picker
    await expect(page1.locator('#group-avatar-display')).toBeVisible({ timeout: 5000 });
    await expect(page1.locator('#group-avatar-picker')).toBeAttached({ timeout: 5000 });

    // Upload group avatar
    const imgPath = path.resolve(__dirname, 'fixtures', 'test-image.png');
    await page1.locator('#group-avatar-picker').setInputFiles(imgPath);

    // Should show success toast
    await expect(page1.locator('.toast-success')).toBeVisible({ timeout: 10_000 });

    // Avatar should now show an img tag (uploaded image)
    const avatarImg = page1.locator('#group-avatar-display img');
    await expect(avatarImg).toBeVisible({ timeout: 5000 });
    const src = await avatarImg.getAttribute('src');
    expect(src).toContain('/media/');

    await ctx1.close();
    await ctx2.close();
  });
});

test.describe('Group Member Pagination (seed data)', () => {
  test('大测试群 members pagination via scroll', async ({ page }) => {
    await loginSeedUser(page);

    // Open 大测试群 conversation
    await page.click('[data-view="chat"]');
    const bigGroupName = `${seedPrefix()}_大测试群`;
    const conv = page.locator('#conversation-list .conversation-item', { hasText: bigGroupName });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await conv.click();
    await expect(page.locator('#message-input-area')).toBeVisible({ timeout: 5000 });

    // Open detail panel
    await page.click('#toggle-detail');
    const rightPanel = page.locator('#right-panel');
    await expect(rightPanel).not.toHaveClass(/collapsed/, { timeout: 5000 });
    await expect(page.locator('#members-list .member-item').first()).toBeVisible({ timeout: 10_000 });

    // 有界消息流窗口只渲染当前成员范围，不再 append 全量 DOM。
    await expect(async () => {
      const count = await page.locator('#members-list .member-item').count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(200);
    }).toPass({ timeout: 10_000 });

    // Scroll the member bounded stream window to the bottom to trigger page pagination
    await page.evaluate(() => {
      const el = document.getElementById('members-list');
      if (el) el.scrollTop = el.scrollHeight;
    });

    // After pagination, DOM stays bounded rather than accumulating all 250 members
    await expect(async () => {
      const count = await page.locator('#members-list .member-item').count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(200);
    }).toPass({ timeout: 10_000 });

    // Members count in header should update
    await expect(page.locator('.detail-section h4')).toContainText(/250/);
  });
});
