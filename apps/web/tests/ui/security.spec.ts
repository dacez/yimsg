import { test, expect } from './test-fixtures';
import {
  addFriend,
  openDMFromContacts,
  register,
  sendMessage,
  uniqueUser,
} from './helpers';

test.describe('Security rendering', () => {
  test('恶意消息内容按文本展示，不执行事件属性', async ({ browser }) => {
    const password = '123456';
    const sender = uniqueUser('xss1');
    const receiver = uniqueUser('xss2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page2.addInitScript(() => {
      (window as unknown as { __yimsgXss?: boolean }).__yimsgXss = false;
    });

    await register(page1, sender, password, 'Sender');
    await register(page2, receiver, password, 'Receiver');
    await addFriend(page1, page2, receiver);

    await openDMFromContacts(page1, 'Receiver');
    await sendMessage(page1, '<img src=x onerror="window.__yimsgXss=true">');

    await page2.click('[data-view="chat"]');
    const conv = page2.locator('#conversation-list .conversation-item', { hasText: 'Sender' });
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await conv.click();

    await expect(page2.locator('#message-list')).toContainText('<img src=x onerror="window.__yimsgXss=true">', { timeout: 10_000 });
    await expect(page2.locator('#message-list .message-bubble img')).toHaveCount(0);
    await expect.poll(() => page2.evaluate(() => (window as unknown as { __yimsgXss?: boolean }).__yimsgXss)).toBe(false);

    await ctx1.close();
    await ctx2.close();
  });
});
