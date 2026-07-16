import { test, expect } from '@playwright/test';
import { uniqueUser, register, login, sendMessage, addFriend, openDMFromContacts, openConversation, expectMessage, getMessageTexts, loginSeedUser, seedPrefix, ensureModeSelected } from './helpers';

test.describe('Chat', () => {
  let user1: string, user2: string;
  const password = '123456';

  async function openCurrentConversationDetail(page: import('@playwright/test').Page) {
    await page.click('#toggle-detail');
    await expect(page.locator('#detail-panel .detail-header')).toBeVisible({ timeout: 10_000 });
  }

  test.beforeEach(async () => {
    user1 = uniqueUser('c1');
    user2 = uniqueUser('c2');
  });

  test('two users can chat', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, user1, password, 'User1');
    await register(page2, user2, password, 'User2');
    await addFriend(page1, page2, user2);

    // User1 opens DM via contacts → Chat button
    await openDMFromContacts(page1, 'User2');
    await sendMessage(page1, 'hello from user1');
    await expectMessage(page1, 'hello from user1');

    // User2 should see the conversation appear and the message
    await page2.click('[data-view="chat"]');
    const conv2 = page2.locator('#conversation-list .conversation-item', { hasText: 'User1' });
    await expect(conv2).toBeVisible({ timeout: 10_000 });
    await conv2.click();
    await expectMessage(page2, 'hello from user1', 10_000);

    // User2 replies
    await sendMessage(page2, 'reply from user2');
    await expectMessage(page2, 'reply from user2');

    // User1 should see the reply
    await expectMessage(page1, 'reply from user2', 10_000);

    await ctx1.close();
    await ctx2.close();
  });

  test('messages display in correct order', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, user1, password, 'User1');
    await register(page2, user2, password, 'User2');
    await addFriend(page1, page2, user2);

    // User1 opens DM and sends multiple messages
    await openDMFromContacts(page1, 'User2');
    await sendMessage(page1, 'msg-1');
    await expectMessage(page1, 'msg-1');
    await sendMessage(page1, 'msg-2');
    await expectMessage(page1, 'msg-2');
    await sendMessage(page1, 'msg-3');
    await expectMessage(page1, 'msg-3');

    // Verify order: msg-1 before msg-2 before msg-3
    const texts = await getMessageTexts(page1);
    const idx1 = texts.findIndex(t => t.includes('msg-1'));
    const idx2 = texts.findIndex(t => t.includes('msg-2'));
    const idx3 = texts.findIndex(t => t.includes('msg-3'));
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);

    await ctx1.close();
    await ctx2.close();
  });

  test('app ignores any pre-existing URL hash and always lands on empty chat view', async ({ page }) => {
    // 应用不做 URL 深链恢复：即使地址栏带着一个陈旧/无效的会话 hash，登录后也必须
    // 固定落在空的会话列表视图，而不是尝试按 hash 打开一个可能已不存在的会话。
    await page.goto('/app/#/chat/g/1');
    await ensureModeSelected(page, 'instant');
    await page.fill('#login-username', `${seedPrefix()}_Test1`);
    await page.fill('#login-password', 'test123');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('#message-input-area')).toHaveClass(/hidden/);
    await expect(page.locator('#chat-empty')).not.toHaveClass(/hidden/);
    await expect(page.locator('#conversation-list .conversation-item.active')).toHaveCount(0);
  });

  test('blocked user shows status in detail panel', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, user1, password, 'BlockedUser1');
    await register(page2, user2, password, 'BlockedUser2');
    await addFriend(page1, page2, user2);
    await openDMFromContacts(page1, 'BlockedUser2');
    await openCurrentConversationDetail(page1);

    const blockBtn = page1.locator('#detail-user-block-btn');
    await expect(blockBtn).toHaveText('屏蔽用户');
    await blockBtn.click();

    await expect(page1.locator('#detail-panel')).toContainText('已屏蔽');
    await expect(page1.locator('#detail-user-block-btn')).toHaveText('取消屏蔽');
    await expect(page1.locator('#msg-input')).toBeEnabled();
    await expect(page1.locator('#msg-input')).toHaveAttribute('placeholder', '输入消息...');
    await expect(page1.locator('#msg-send')).toBeEnabled();

    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('.contact-item', { hasText: 'BlockedUser2' })).not.toContainText('已屏蔽');

    await ctx1.close();
    await ctx2.close();
  });

  test('mutelist status appears in detail panel', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, user1, password, 'MuteUser1');
    await register(page2, user2, password, 'MuteUser2');
    await addFriend(page1, page2, user2);
    await openDMFromContacts(page1, 'MuteUser2');
    await openCurrentConversationDetail(page1);

    const muteBtn = page1.locator('#detail-user-mutelist-btn');
    await expect(muteBtn).toHaveText('开启免打扰');
    await muteBtn.click();

    await expect(page1.locator('#detail-panel')).toContainText('免打扰已开启');
    await expect(page1.locator('#detail-user-mutelist-btn')).toHaveText('关闭免打扰');
    await expect(page1.locator('#conversation-list .conversation-item', { hasText: 'MuteUser2' })).not.toContainText('免打扰');

    await ctx1.close();
    await ctx2.close();
  });
});

/**
 * 消息分页测试 — 使用 seed data 中的账号（中群有 10000 条消息）。
 * 验证：
 * 1. 初始加载的消息按时间 ASC 排列（旧→新）
 * 2. 滚动到顶部触发分页后，旧消息按正确顺序插入
 * 3. 分页前后消息无重复、无乱序
 *
 * 注：持久存储模式分页已在单元测试中覆盖（headless Chromium 不支持持久存储后端）。
 */
test.describe('Message Pagination', () => {
  /** Extract seq numbers from message content (test-seed format: "群消息_TestX_N") */
  function extractSeqNums(texts: string[]): number[] {
    return texts
      .map(t => {
        const m = t.match(/群消息_\w+_(\d+)/);
        return m ? Number(m[1]) : -1;
      })
      .filter(n => n > 0);
  }

  /** Open the 测试群 conversation (test-seed: 4 members, 200 messages) */
  async function openGroupConversation(page: import('@playwright/test').Page) {
    await page.click('[data-view="chat"]');
    const groupName = `${seedPrefix()}_测试群`;
    const conv = page.locator('#conversation-list .conversation-item', { hasText: groupName }).first();
    await expect(conv).toBeVisible({ timeout: 10_000 });
    await conv.click();
    await expect(page.locator('#message-input-area')).toBeVisible({ timeout: 5000 });
    // Wait for initial messages to render
    await expect(page.locator('.message-bubble').first()).toBeVisible({ timeout: 5000 });
  }

  async function scrollToTopAndWaitForOlder(page: import('@playwright/test').Page, initialMinSeq: number) {
    await page.evaluate(() => {
      const list = document.getElementById('message-list');
      if (!list) return;
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
    });
    await expect(async () => {
      await page.evaluate(() => {
        const list = document.getElementById('message-list');
        if (!list) return;
        list.scrollTop = 0;
        list.dispatchEvent(new Event('scroll'));
      });
      const texts = await getMessageTexts(page);
      const nums = extractSeqNums(texts);
      expect(nums.some(n => n < initialMinSeq)).toBe(true);
    }).toPass({ timeout: 10_000 });
  }

  test('initial messages are in ASC order', async ({ page }) => {
    await loginSeedUser(page);
    await openGroupConversation(page);

    const texts = await getMessageTexts(page);
    expect(texts.length).toBeGreaterThan(0);

    const nums = extractSeqNums(texts);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    }
  });

  test('opening conversation lands on latest message', async ({ page }) => {
    await loginSeedUser(page);
    await openGroupConversation(page);

    const latest = `群消息_${seedPrefix()}_Test4_200`;
    await expect(page.locator('.message-bubble', { hasText: latest })).toBeVisible({ timeout: 10_000 });
    // 动态分页窗口不再模拟全局滚动条高度；打开会话只需确保最新消息自然可见。
    await expect(page.locator('.message-bubble', { hasText: latest })).toBeVisible({ timeout: 10_000 });
  });

  test('pagination loads older messages in correct order', async ({ page }) => {
    await loginSeedUser(page);
    await openGroupConversation(page);

    const initialTexts = await getMessageTexts(page);
    const initialNums = extractSeqNums(initialTexts);
    expect(initialNums.length).toBeGreaterThan(0);

    // Scroll to top to trigger pagination, then continue to the expanded older side.
    const initialMin = Math.min(...initialNums);
    await scrollToTopAndWaitForOlder(page, initialMin);

    const afterTexts = await getMessageTexts(page);
    const afterNums = extractSeqNums(afterTexts);

    expect(afterNums.some(n => n < initialMin)).toBe(true);

    // ALL messages must be in strict ASC order
    for (let i = 1; i < afterNums.length; i++) {
      expect(afterNums[i]).toBeGreaterThan(afterNums[i - 1]);
    }

    expect(afterNums[0]).toBeLessThan(initialMin);
  });

  test('message page can return to latest after loading older history', async ({ page }) => {
    await loginSeedUser(page);
    await openGroupConversation(page);

    const latest = `群消息_${seedPrefix()}_Test4_200`;
    await expect(page.locator('.message-bubble', { hasText: latest })).toBeVisible({ timeout: 10_000 });

    for (let round = 0; round < 5; round++) {
      if (!(await page.locator('.message-bubble', { hasText: latest }).isVisible())) break;
      const beforeTexts = await getMessageTexts(page);
      const beforeNums = extractSeqNums(beforeTexts);
      const beforeMin = Math.min(...beforeNums);
      await expect(async () => {
        // 上一页 DOM 已更新时，请求的 finally 可能仍未释放 loading 守卫；
        // 每次轮询都重新触发滚动，避免一次性 scroll 事件恰好落在该窄窗口内而丢失。
        await page.evaluate(() => {
          const list = document.getElementById('message-list');
          if (!list) return;
          list.scrollTop = 0;
          list.dispatchEvent(new Event('scroll'));
        });
        const texts = await getMessageTexts(page);
        const nums = extractSeqNums(texts);
        expect(Math.min(...nums)).toBeLessThan(beforeMin);
      }).toPass({ timeout: 10_000 });
    }

    for (let round = 0; round < 5; round++) {
      if (await page.locator('.message-bubble', { hasText: latest }).isVisible()) break;
      await page.evaluate(() => {
        const list = document.getElementById('message-list');
        if (!list) return;
        list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(100);
    }
    await expect(page.locator('.message-bubble', { hasText: latest })).toBeVisible({ timeout: 10_000 });
  });

  test('loading newer page keeps scroll anchor instead of jumping to latest', async ({ page }) => {
    await loginSeedUser(page);
    await openGroupConversation(page);

    const latest = `群消息_${seedPrefix()}_Test4_200`;
    await expect(page.locator('.message-bubble', { hasText: latest })).toBeVisible({ timeout: 10_000 });

    for (let round = 0; round < 5; round++) {
      if (!(await page.locator('.message-bubble', { hasText: latest }).isVisible())) break;
      const beforeTexts = await getMessageTexts(page);
      const beforeNums = extractSeqNums(beforeTexts);
      const beforeMin = Math.min(...beforeNums);
      await expect(async () => {
        // 与上一个翻页场景相同：重试期间重新派发 scroll，等待 loading 守卫释放。
        await page.evaluate(() => {
          const list = document.getElementById('message-list');
          if (!list) return;
          list.scrollTop = 0;
          list.dispatchEvent(new Event('scroll'));
        });
        const texts = await getMessageTexts(page);
        const nums = extractSeqNums(texts);
        expect(Math.min(...nums)).toBeLessThan(beforeMin);
      }).toPass({ timeout: 10_000 });
    }

    await expect(page.locator('.message-bubble', { hasText: latest })).toBeHidden({ timeout: 5_000 });
    // 上翻历史导致尾部页被有界窗口裁剪时，底部仍有更新页可加载，
    // 但这不是实时新消息，不能误亮"有新消息"提示条。
    await expect(page.locator('#new-message-pill')).toBeHidden({ timeout: 1_000 });

    const beforeMax = Math.max(...extractSeqNums(await getMessageTexts(page)));
    await page.evaluate(() => {
      const list = document.getElementById('message-list');
      if (!list) return;
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll'));
    });
    await expect(async () => {
      const afterNums = extractSeqNums(await getMessageTexts(page));
      expect(Math.max(...afterNums)).toBeGreaterThan(beforeMax);
      const atBottom = await page.evaluate(() => {
        const list = document.getElementById('message-list');
        if (!list) return false;
        return list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
      });
      expect(atBottom).toBe(false);
    }).toPass({ timeout: 10_000 });
    // 较新页可能已经把 latest 放回有界 DOM；视口仍未贴底才是锚点保持的判据。
  });

  test('multiple pagination rounds maintain order with no duplicates', async ({ page }) => {
    await loginSeedUser(page);
    await openGroupConversation(page);

    // Paginate 3 times
    for (let round = 0; round < 3; round++) {
      const beforeNums = extractSeqNums(await getMessageTexts(page));
      const beforeMin = Math.min(...beforeNums);
      await page.evaluate(() => {
        const list = document.getElementById('message-list');
        if (!list) return;
        list.scrollTop = 0;
        list.dispatchEvent(new Event('scroll'));
      });
      try {
        await expect(async () => {
          const nums = extractSeqNums(await getMessageTexts(page));
          expect(Math.min(...nums)).toBeLessThan(beforeMin);
        }).toPass({ timeout: 5000 });
      } catch {
        break; // No more messages to load
      }
    }

    // Final check: ALL messages in ASC order, no duplicates
    const texts = await getMessageTexts(page);
    const nums = extractSeqNums(texts);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    }
    const unique = new Set(nums);
    expect(unique.size).toBe(nums.length);
  });
});
