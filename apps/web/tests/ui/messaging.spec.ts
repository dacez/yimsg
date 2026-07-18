import { test, expect } from './test-fixtures';
import path from 'path';
import { fileURLToPath } from 'url';
import { uniqueUser, register, addFriend, sendMessage, expectMessage, openDMFromContacts, openConversation, getMessageTexts } from './helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Messaging', () => {
  const password = '123456';

  test('send message with Enter key', async ({ browser }) => {
    const u1 = uniqueUser('enter1');
    const u2 = uniqueUser('enter2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'EnterSender');
    await register(page2, u2, password, 'EnterReceiver');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'EnterReceiver');

    // Type and press Enter
    await page1.fill('#msg-input', 'sent with enter key');
    await page1.keyboard.press('Enter');

    await expectMessage(page1, 'sent with enter key');

    await ctx1.close();
    await ctx2.close();
  });

  test('Shift+Enter does not send message', async ({ browser }) => {
    const u1 = uniqueUser('she1');
    const u2 = uniqueUser('she2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ShiftUser');
    await register(page2, u2, password, 'ShiftFriend');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'ShiftFriend');

    // Type and press Shift+Enter - should not send
    await page1.fill('#msg-input', 'this should not send');
    await page1.keyboard.press('Shift+Enter');

    // Input should still have content (not sent)
    const inputValue = await page1.locator('#msg-input').inputValue();
    expect(inputValue).toContain('this should not send');

    // Message list should not contain this text
    const texts = await getMessageTexts(page1);
    expect(texts.some(t => t.includes('this should not send'))).toBeFalsy();

    await ctx1.close();
    await ctx2.close();
  });

  test('empty message is not sent', async ({ browser }) => {
    const u1 = uniqueUser('empty1');
    const u2 = uniqueUser('empty2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'EmptyMsg1');
    await register(page2, u2, password, 'EmptyMsg2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'EmptyMsg2');

    const initialCount = (await getMessageTexts(page1)).length;
    await page1.click('#msg-send');
    const afterCount = (await getMessageTexts(page1)).length;
    expect(afterCount).toBe(initialCount);

    await ctx1.close();
    await ctx2.close();
  });

  test('emoji picker inserts emoji into input and can be sent', async ({ browser }) => {
    const u1 = uniqueUser('emoji1');
    const u2 = uniqueUser('emoji2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'EmojiSender');
    await register(page2, u2, password, 'EmojiReceiver');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'EmojiReceiver');

    await page1.click('#msg-emoji');
    const picker = page1.locator('.emoji-picker');
    await expect(picker).toBeVisible({ timeout: 5000 });

    // Switch to the "gestures" category and pick the thumbs-up emoji
    await page1.click('.emoji-picker-tab[data-category="gestures"]');
    await page1.locator('.emoji-picker-item', { hasText: '👍' }).click();

    const inputValue = await page1.locator('#msg-input').inputValue();
    expect(inputValue).toContain('👍');

    // Picking an emoji should not close the picker (allows multiple picks)
    await expect(picker).toBeVisible();

    // Clicking outside should close the picker
    await page1.click('#message-list');
    await expect(picker).toHaveCount(0);

    await page1.click('#msg-send');
    await expectMessage(page1, '👍');

    await ctx1.close();
    await ctx2.close();
  });

  test('message input clears after sending', async ({ browser }) => {
    const u1 = uniqueUser('clr1');
    const u2 = uniqueUser('clr2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ClearUser');
    await register(page2, u2, password, 'ClearFriend');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'ClearFriend');

    await sendMessage(page1, 'test message for clear');
    // Input should be empty after sending
    const inputValue = await page1.locator('#msg-input').inputValue();
    expect(inputValue).toBe('');

    await ctx1.close();
    await ctx2.close();
  });

  test('sender can recall message and UI updates in current chat', async ({ browser }) => {
    const u1 = uniqueUser('recall1');
    const u2 = uniqueUser('recall2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'RecallUser1');
    await register(page2, u2, password, 'RecallUser2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'RecallUser2');

    await sendMessage(page1, '需要撤回的消息');
    await expectMessage(page1, '需要撤回的消息');

    const selfRow = page1.locator('.message-row.self').last();
    await selfRow.hover();
    await selfRow.locator('.message-actions-trigger').click();
    await page1.locator('.message-action-item').getByText('撤回').click();

    await expect(page1.locator('.message-bubble').last()).toContainText('你撤回了一条消息', { timeout: 10_000 });
    await expect(page1.locator('#conversation-list .conversation-item', { hasText: 'RecallUser2' })).toContainText('你撤回了一条消息');

    await page2.click('[data-view="chat"]');
    const conv = page2.locator('#conversation-list .conversation-item', { hasText: 'RecallUser1' });
    await expect(conv).toContainText('对方撤回了一条消息', { timeout: 10_000 });
    await conv.click();
    await expect(page2.locator('.message-bubble').last()).toContainText('对方撤回了一条消息');

    await ctx1.close();
    await ctx2.close();
  });

  test('expired recall time limit hides recall action', async ({ browser }) => {
    const u1 = uniqueUser('recall_expire1');
    const u2 = uniqueUser('recall_expire2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'RecallExpireUser1');
    await register(page2, u2, password, 'RecallExpireUser2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'RecallExpireUser2');

    await sendMessage(page1, '超过时限的消息');
    await expectMessage(page1, '超过时限的消息');
    await page1.waitForTimeout(4_000);

    const selfRow = page1.locator('.message-row.self').last();
    await selfRow.hover();
    await selfRow.locator('.message-actions-trigger').click();

    await expect(page1.locator('.message-action-item', { hasText: '撤回' })).toHaveCount(0);
    await expect(page1.locator('.message-action-item', { hasText: '引用' })).toHaveCount(1);

    await ctx1.close();
    await ctx2.close();
  });

  test('quote message uses QuoteBody and renders quote block', async ({ browser }) => {
    const u1 = uniqueUser('quote1');
    const u2 = uniqueUser('quote2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'QuoteUser1');
    await register(page2, u2, password, 'QuoteUser2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'QuoteUser2');

    await sendMessage(page1, 'origin message');
    await expectMessage(page1, 'origin message');

    await page1.locator('.message-row').first().hover();
    await page1.locator('.message-actions-trigger').first().click();
    await page1.locator('.message-action-item').getByText('引用').click();
    await expect(page1.locator('#msg-quote-bar')).not.toHaveClass(/hidden/);
    await sendMessage(page1, 'reply with quote');

    await expect(page1.locator('.message-quote-block').last()).toContainText('origin message');
    await expectMessage(page1, 'reply with quote');

    // 点击引用块应内联展开详细信息，而不是弹窗
    await page1.locator('.message-quote-block').last().click();
    await expect(page1.locator('.quote-detail').last()).toBeVisible();
    await expect(page1.locator('.quote-detail').last()).toContainText('origin message');
    // 再次点击应收起
    await page1.locator('.message-quote-block').last().click();
    await expect(page1.locator('.quote-detail')).toHaveCount(0);

    await ctx1.close();
    await ctx2.close();
  });

  test('forward message uses ForwardBody and renders forward block', async ({ browser }) => {
    const u1 = uniqueUser('forward1');
    const u2 = uniqueUser('forward2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ForwardUser1');
    await register(page2, u2, password, 'ForwardUser2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'ForwardUser2');

    await sendMessage(page1, 'origin for forward');
    await expectMessage(page1, 'origin for forward');

    await page1.locator('.message-row').first().hover();
    await page1.locator('.message-actions-trigger').first().click();
    await page1.locator('.message-action-item').getByText('转发').click();

    await expect(page1.locator('#forward-conversation-list')).toBeVisible();
    await page1.locator('#forward-comment-input').fill('来自转发');
    await page1.locator('#forward-confirm-btn').click();

    await expect(page1.locator('.message-forward-block').last()).toContainText('转发 1 条');
    await expectMessage(page1, '来自转发');

    await ctx1.close();
    await ctx2.close();
  });

  test('multi-select forward sends merged forward block', async ({ browser }) => {
    const u1 = uniqueUser('mforward1');
    const u2 = uniqueUser('mforward2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'MultiForwardUser1');
    await register(page2, u2, password, 'MultiForwardUser2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'MultiForwardUser2');

    await sendMessage(page1, 'forward item 1');
    await sendMessage(page1, 'forward item 2');
    await expectMessage(page1, 'forward item 2');

    await page1.locator('.message-row').first().hover();
    await page1.locator('.message-actions-trigger').first().click();
    await page1.locator('.message-action-item').getByText('多选').click();

    await expect(page1.locator('#msg-selection-bar')).toBeVisible();
    await expect(page1.locator('#msg-selection-count')).toContainText('已选择 1 条消息');

    const checkboxes = page1.locator('.message-select-checkbox');
    await checkboxes.nth(1).check();
    await expect(page1.locator('#msg-selection-count')).toContainText('已选择 2 条消息');

    await page1.locator('#msg-selection-forward').click();
    await page1.locator('#forward-comment-input').fill('合并转发附言');
    await page1.locator('#forward-confirm-btn').click();

    await expect(page1.locator('.message-forward-block').last()).toContainText('转发 2 条');
    await expectMessage(page1, '合并转发附言');

    await ctx1.close();
    await ctx2.close();
  });

  test('multi-select forward summarizes message count and title', async ({ browser }) => {
    const u1 = uniqueUser('fpreview1');
    const u2 = uniqueUser('fpreview2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ForwardPreviewUser1');
    await register(page2, u2, password, 'ForwardPreviewUser2');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'ForwardPreviewUser2');

    for (let i = 1; i <= 6; i++) {
      await sendMessage(page1, `preview item ${i}`);
    }
    await expectMessage(page1, 'preview item 6');

    await page1.locator('.message-row').first().hover();
    await page1.locator('.message-actions-trigger').first().click();
    await page1.locator('.message-action-item').getByText('多选').click();

    const checkboxes = page1.locator('.message-select-checkbox');
    await expect(checkboxes).toHaveCount(6);
    for (let i = 1; i < 6; i++) {
      await checkboxes.nth(i).check();
    }
    await expect(page1.locator('#msg-selection-count')).toContainText('已选择 6 条消息');

    await page1.locator('#msg-selection-forward').click();
    await page1.locator('#forward-comment-input').fill('预览条数验证');
    await page1.locator('#forward-confirm-btn').click();

    // 新转发模型只携带 msg_ids 与标题：气泡展示条数摘要与标题，不再上传/预览明细。
    const forwardBlock = page1.locator('.message-forward-block').last();
    await expect(forwardBlock).toContainText('转发 6 条');
    await expectMessage(page1, '预览条数验证');

    await ctx1.close();
    await ctx2.close();
  });

  test('multiple conversations tracked independently', async ({ browser }) => {
    const u1 = uniqueUser('mc1');
    const u2 = uniqueUser('mc2');
    const u3 = uniqueUser('mc3');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx3 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    await register(page1, u1, password, 'Multi1');
    await register(page2, u2, password, 'Multi2');
    await register(page3, u3, password, 'Multi3');

    await addFriend(page1, page2, u2);
    await addFriend(page1, page3, u3);

    // Send to user2
    await openDMFromContacts(page1, 'Multi2');
    await sendMessage(page1, 'message to user2');
    await expectMessage(page1, 'message to user2');

    // Send to user3
    await openDMFromContacts(page1, 'Multi3');
    await sendMessage(page1, 'message to user3');
    await expectMessage(page1, 'message to user3');

    // Switch back to user2 conv - should NOT show user3's message
    await openConversation(page1, 'Multi2');
    await expectMessage(page1, 'message to user2', 10_000);
    const texts = await getMessageTexts(page1);
    expect(texts.some(t => t.includes('message to user3'))).toBeFalsy();

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });

  test('conversation preview shows last message', async ({ browser }) => {
    const u1 = uniqueUser('prev1');
    const u2 = uniqueUser('prev2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Prev1');
    await register(page2, u2, password, 'Prev2');
    await addFriend(page1, page2, u2);

    await openDMFromContacts(page1, 'Prev2');
    await sendMessage(page1, 'first message');
    await expectMessage(page1, 'first message');
    await sendMessage(page1, 'last message preview');
    await expectMessage(page1, 'last message preview');

    // Go to conversation list
    await page1.click('[data-view="chat"]');
    const conv = page1.locator('#conversation-list .conversation-item', { hasText: 'Prev2' });
    await expect(conv.locator('.conversation-preview')).toContainText('last message preview', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('detail panel shows user info for DM', async ({ browser }) => {
    const u1 = uniqueUser('dp1');
    const u2 = uniqueUser('dp2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'DetailUser1');
    await register(page2, u2, password, 'DetailUser2');
    await addFriend(page1, page2, u2);

    await openDMFromContacts(page1, 'DetailUser2');
    await page1.click('#toggle-detail');

    // Right panel should open
    const rightPanel = page1.locator('#right-panel');
    await expect(rightPanel).not.toHaveClass(/collapsed/, { timeout: 5000 });
    await expect(rightPanel).toContainText('DetailUser2', { timeout: 5000 });

    // Toggle again to close
    await page1.click('#toggle-detail');
    await expect(rightPanel).toHaveClass(/collapsed/, { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('conversation is sorted by most recent message', async ({ browser }) => {
    const u1 = uniqueUser('sort1');
    const u2 = uniqueUser('sort2');
    const u3 = uniqueUser('sort3');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx3 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    await register(page1, u1, password, 'SortUser1');
    await register(page2, u2, password, 'SortUser2');
    await register(page3, u3, password, 'SortUser3');

    await addFriend(page1, page2, u2);
    await addFriend(page1, page3, u3);

    // Message SortUser2 first
    await openDMFromContacts(page1, 'SortUser2');
    await sendMessage(page1, 'message to 2');
    await expectMessage(page1, 'message to 2');

    // Then message SortUser3
    await openDMFromContacts(page1, 'SortUser3');
    await sendMessage(page1, 'message to 3');
    await expectMessage(page1, 'message to 3');

    // Conversation list should show SortUser3 first (most recent)
    await page1.click('[data-view="chat"]');
    const convItems = page1.locator('#conversation-list .conversation-item');
    await expect(convItems.first()).toContainText('SortUser3', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });

  test('send image message', async ({ browser }) => {
    const u1 = uniqueUser('img1');
    const u2 = uniqueUser('img2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'ImgSender');
    await register(page2, u2, password, 'ImgReceiver');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'ImgReceiver');

    // Set image file on the hidden file picker and trigger change
    const imgPath = path.resolve(__dirname, 'fixtures', 'test-image.png');
    await page1.locator('#file-picker-image').setInputFiles(imgPath);

    // Should display the image in message list
    const img = page1.locator('#message-list .message-image');
    await expect(img).toBeVisible({ timeout: 10_000 });
    // Image src should be a valid upload URL
    const src = await img.getAttribute('src');
    expect(src).toContain('/media/');

    // Receiver should also see the image
    await page2.click('[data-view="chat"]');
    const conv = page2.locator('#conversation-list .conversation-item', { hasText: 'ImgSender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await conv.click();
    await expect(page2.locator('#message-list .message-image')).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('send file message', async ({ browser }) => {
    const u1 = uniqueUser('file1');
    const u2 = uniqueUser('file2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'FileSender');
    await register(page2, u2, password, 'FileReceiver');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'FileReceiver');

    // Set file on the hidden file picker
    const filePath = path.resolve(__dirname, 'fixtures', 'test-file.txt');
    await page1.locator('#file-picker-file').setInputFiles(filePath);

    // Should display the file in message list
    const fileMsg = page1.locator('#message-list .message-file');
    await expect(fileMsg).toBeVisible({ timeout: 10_000 });
    // File name should be shown
    await expect(fileMsg.locator('.message-file-name')).toContainText('test-file.txt');
    await expect(fileMsg).toHaveAttribute('download', 'test-file.txt');

    const downloadPromise = page1.waitForEvent('download');
    await fileMsg.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('test-file.txt');

    // Receiver should also see the file
    await page2.click('[data-view="chat"]');
    const conv = page2.locator('#conversation-list .conversation-item', { hasText: 'FileSender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await conv.click();
    const receivedFileMsg = page2.locator('#message-list .message-file');
    await expect(receivedFileMsg).toBeVisible({ timeout: 10_000 });
    await expect(receivedFileMsg).toHaveAttribute('download', 'test-file.txt');

    await ctx1.close();
    await ctx2.close();
  });

  // 上翻阅读中收到新消息：不强制滚底，点亮新消息提示条；点击提示条跳到最新一页并滚到底部。
  test('new message pill shows when scrolled up and jumps to latest on click', async ({ browser }) => {
    const u1 = uniqueUser('pill1');
    const u2 = uniqueUser('pill2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'PillSender');
    await register(page2, u2, password, 'PillReader');
    await addFriend(page1, page2, u2);
    await openDMFromContacts(page1, 'PillReader');

    // 填充足够多的消息使接收方消息列表可滚动。
    for (let i = 1; i <= 15; i++) {
      await sendMessage(page1, `pill filler message ${i}`);
      await expectMessage(page1, `pill filler message ${i}`);
    }

    await openConversation(page2, 'PillSender');
    await expectMessage(page2, 'pill filler message 15');
    // 等 scrollToBottom 的多帧稳定链结束，否则后续上翻会被 settle 帧钉回底部。
    await page2.waitForTimeout(600);

    // 接收方上翻到顶部（远离底部），并确认位置稳定。
    await page2.evaluate(() => {
      const list = document.querySelector('#message-list') as HTMLElement;
      list.scrollTop = 0;
    });
    await page2.waitForTimeout(300);
    const settledTop = await page2.evaluate(() => (document.querySelector('#message-list') as HTMLElement).scrollTop);
    expect(settledTop).toBeLessThan(100);

    await sendMessage(page1, 'pill trigger message');

    // 提示条出现，且阅读位置未被拽到底部。
    const pill = page2.locator('#new-message-pill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    const distanceFromBottom = await page2.evaluate(() => {
      const list = document.querySelector('#message-list') as HTMLElement;
      return list.scrollHeight - list.scrollTop - list.clientHeight;
    });
    expect(distanceFromBottom).toBeGreaterThan(50);

    // 点击提示条：加载最新一页、滚到底部、提示条隐藏。
    await pill.click();
    await expectMessage(page2, 'pill trigger message');
    await expect(pill).toBeHidden({ timeout: 5000 });
    await expect.poll(async () => page2.evaluate(() => {
      const list = document.querySelector('#message-list') as HTMLElement;
      return list.scrollHeight - list.scrollTop - list.clientHeight;
    }), { timeout: 5000 }).toBeLessThanOrEqual(180);

    await ctx1.close();
    await ctx2.close();
  });
});
