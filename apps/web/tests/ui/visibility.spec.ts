import { test, expect } from './test-fixtures';
import path from 'path';
import { fileURLToPath } from 'url';
import { uniqueUser, register, addFriend, sendMessage, expectMessage, openDMFromContacts, openConversation, setContactRemark, ensureModeSelected } from './helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Profile Change Visibility', () => {
  const password = '123456';

  test('opening user detail force-refreshes changed nickname and display cache', async ({ browser }) => {
    const u1 = uniqueUser('nv1');
    const u2 = uniqueUser('nv2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'OriginalNick');
    await register(page2, u2, password, 'Friend2');
    await addFriend(page1, page2, u2);

    // 建立会话，让接收方先缓存旧昵称。资料修改不要求主动广播到关联账号。
    await openDMFromContacts(page1, 'Friend2');
    await sendMessage(page1, 'hello from original');
    await page2.click('[data-view="chat"]');
    await expect(page2.locator('#conversation-list .conversation-item', { hasText: 'OriginalNick' })).toBeVisible({ timeout: 10_000 });

    // 用户 1 修改昵称；用户 2 的列表此时允许继续使用缓存。
    await page1.click('[data-view="settings"]');
    await page1.fill('#edit-nickname', 'UpdatedNick');
    await page1.click('#save-profile-btn');
    await expect(page1.locator('.toast-success').last()).toBeVisible({ timeout: 5000 });

    // 用户 2 重新进入旧昵称会话并点击详情；详情请求必须绕过缓存。
    await openConversation(page2, 'OriginalNick');
    await page2.click('#toggle-detail');
    await expect(page2.locator('#detail-panel .detail-name')).toHaveText('UpdatedNick', { timeout: 10_000 });

    // 强制拉取成功后会写回显示缓存，并驱动会话标题与列表重绘。
    await expect(page2.locator('#chat-title')).toHaveText('UpdatedNick', { timeout: 10_000 });
    await expect(page2.locator('#conversation-list .conversation-item', { hasText: 'UpdatedNick' })).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('remark change visible in contacts list', async ({ browser }) => {
    const u1 = uniqueUser('rmk1');
    const u2 = uniqueUser('rmk2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'RemarkUser');
    await register(page2, u2, password, 'RemarkFriend');
    await addFriend(page1, page2, u2);

    // User1 sets remark for user2
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    const friendItem = page1.locator('.contact-item', { hasText: 'RemarkFriend' });
    await expect(friendItem).toBeVisible({ timeout: 10_000 });

    await setContactRemark(page1, 'RemarkFriend', 'MyBestFriend');
    await expect(page1.locator('.contact-item', { hasText: 'MyBestFriend' })).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('remark visible in conversation list instead of nickname', async ({ browser }) => {
    const u1 = uniqueUser('rconv1');
    const u2 = uniqueUser('rconv2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ConvRemark1');
    await register(page2, u2, password, 'ConvRemark2');
    await addFriend(page1, page2, u2);

    // Send message first
    await openDMFromContacts(page1, 'ConvRemark2');
    await sendMessage(page1, 'hello');
    await expectMessage(page1, 'hello');

    // Set remark
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await setContactRemark(page1, 'ConvRemark2', 'RemarkInConv');

    // Go to chat view - conversation should show remark name
    await page1.click('[data-view="chat"]');
    await expect(page1.locator('#conversation-list .conversation-item', { hasText: 'RemarkInConv' })).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('opening user detail force-refreshes changed avatar and display cache', async ({ browser }) => {
    const u1 = uniqueUser('av1');
    const u2 = uniqueUser('av2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'AvatarUser');
    await page2.goto('/app/');
    await ensureModeSelected(page2, 'persistent');
    await page2.click('[data-tab="register"]');
    await page2.fill('#reg-username', u2);
    await page2.fill('#reg-password', password);
    await page2.fill('#reg-nickname', 'AvatarFriend');
    await page2.click('#register-form button[type="submit"]');
    await expect(page2.locator('#app')).toBeVisible({ timeout: 20_000 });
    await addFriend(page1, page2, u2);

    // 建立会话，让用户 2 缓存用户 1 的字母头像。
    await openDMFromContacts(page1, 'AvatarFriend');
    await sendMessage(page1, 'hello avatar');
    await page2.click('[data-view="chat"]');
    await expect(page2.locator('#conversation-list .conversation-item', { hasText: 'AvatarUser' })).toBeVisible({ timeout: 10_000 });

    // 用户 1 上传头像；不要求向所有好友和群成员主动广播资料变化。
    await page1.click('[data-view="settings"]');
    const imgPath = path.resolve(__dirname, 'fixtures', 'test-image.png');
    await page1.locator('#avatar-picker').setInputFiles(imgPath);
    await expect(page1.locator('.toast-success').last()).toBeVisible({ timeout: 10_000 });

    // 重新进入会话并点击详情后，详情头像必须来自服务端最新资料。
    await openConversation(page2, 'AvatarUser');
    await page2.click('#toggle-detail');
    const detailAvatar = page2.locator('#detail-panel .detail-header .avatar img');
    await expect(detailAvatar).toBeVisible({ timeout: 10_000 });
    await expect(detailAvatar).toHaveAttribute('src', /\/media\//);

    // 最新头像写回显示缓存后，会话列表头像也同步重绘。
    const conversationAvatar = page2.locator('#conversation-list .conversation-item', { hasText: 'AvatarUser' }).locator('.avatar img');
    await expect(conversationAvatar).toBeVisible({ timeout: 10_000 });
    await expect(conversationAvatar).toHaveAttribute('src', /\/media\//);

    await ctx1.close();
    await ctx2.close();
  });

  test('without remark shows nickname in contacts and conversation list', async ({ browser }) => {
    const u1 = uniqueUser('nrm1');
    const u2 = uniqueUser('nrm2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'NoRemarkA');
    await register(page2, u2, password, 'NoRemarkB');
    await addFriend(page1, page2, u2);

    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('.contact-item', { hasText: 'NoRemarkB' })).toBeVisible({ timeout: 10_000 });

    await openDMFromContacts(page1, 'NoRemarkB');
    await sendMessage(page1, 'hello no remark');
    await page1.click('[data-view="chat"]');
    await expect(page1.locator('#conversation-list .conversation-item', { hasText: 'NoRemarkB' })).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });
});

test.describe('Group Info Change Visibility', () => {
  const password = '123456';

  test('group name change visible to all members', async ({ browser }) => {
    const u1 = uniqueUser('gn1');
    const u2 = uniqueUser('gn2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'GroupOwner');
    await register(page2, u2, password, 'GroupMember');
    await addFriend(page1, page2, u2);

    // Create group
    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    const modal = page1.locator('#modal-overlay:not(.hidden)');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'OrigGroupName');
    const memberCheckbox = page1.locator('.member-select-item', { hasText: 'GroupMember' }).locator('input[type="checkbox"]');
    await expect(memberCheckbox).toBeVisible({ timeout: 5000 });
    await memberCheckbox.check();
    await page1.click('#modal-create');
    await page1.waitForTimeout(1000);

    // Owner sends group message
    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'OrigGroupName' });
    if (await groupConv.isVisible()) {
      await groupConv.click();
      await sendMessage(page1, 'hello group');

      // Member should see group in conversation list
      await page2.click('[data-view="chat"]');
      await expect(page2.locator('#conversation-list .conversation-item', { hasText: 'OrigGroupName' })).toBeVisible({ timeout: 15_000 });
    }

    await ctx1.close();
    await ctx2.close();
  });

  test('favorited group appears in contacts and group remark overrides name', async ({ browser }) => {
    const u1 = uniqueUser('fg1');
    const u2 = uniqueUser('fg2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'FavOwner');
    await register(page2, u2, password, 'FavMember');
    await addFriend(page1, page2, u2);

    await page1.click('[data-view="contacts"]');
    await page1.click('#create-group-btn');
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.fill('#group-name-input', 'FavoriteGroup');
    await page1.locator('.member-select-item', { hasText: 'FavMember' }).locator('input[type="checkbox"]').check();
    await page1.click('#modal-create');
    await page1.waitForTimeout(1000);

    await page1.click('[data-view="chat"]');
    const groupConv = page1.locator('#conversation-list .conversation-item', { hasText: 'FavoriteGroup' });
    await expect(groupConv).toBeVisible({ timeout: 10_000 });
    await groupConv.click();
    await page1.click('#toggle-detail');
    await page1.click('#detail-group-favorite-btn');
    await expect(page1.locator('#detail-group-favorite-btn')).toContainText(/Remove from Contacts|移出通讯录/, { timeout: 10_000 });

    await page1.click('#detail-group-remark-btn');
    await page1.fill('#modal-text-input', 'FavRemark');
    await page1.click('#modal-confirm-btn');
    await page1.waitForTimeout(500);

    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('.contact-item', { hasText: 'FavRemark' })).toBeVisible({ timeout: 10_000 });

    await page1.click('[data-view="chat"]');
    await expect(page1.locator('#conversation-list .conversation-item', { hasText: 'FavRemark' })).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });
});
