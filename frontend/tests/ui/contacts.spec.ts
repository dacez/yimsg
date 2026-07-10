import { test, expect } from '@playwright/test';
import { uniqueUser, register, login, addFriend, openDMFromContacts, getMessageTexts, loginSeedUser } from './helpers';

test.describe('Contacts', () => {
  const password = '123456';

  test('search user not found shows empty state', async ({ page }) => {
    await register(page, uniqueUser('srch'), password, 'Searcher');
    await page.click('[data-view="contacts"]');
    await page.click('[data-ctab="search"]');
    await page.fill('#search-username', 'definitely_nonexistent_xyz_abc');
    await page.click('#search-btn');
    await expect(page.locator('#search-results')).toContainText(/not found|用户不存在/, { timeout: 5000 });
  });

  test('search user and send friend request', async ({ browser }) => {
    const u1 = uniqueUser('s1');
    const u2 = uniqueUser('s2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Sender');
    await register(page2, u2, password, 'Receiver');

    // Search for u2 from u1's account
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="search"]');
    await page1.fill('#search-username', u2);
    await page1.click('#search-btn');
    // Should show the user profile
    await expect(page1.locator('#search-results')).toContainText('Receiver', { timeout: 5000 });
    // Add button should be visible
    const addBtn = page1.locator('#search-results button');
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-confirm-btn');

    // Receiver should see the contacts nav red dot（不再显示精确数字，只点亮红点）
    await expect(page2.locator('.nav-item[data-view="contacts"] .nav-badge')).toBeVisible({ timeout: 10_000 });
    // 请求列表里能看到发起者
    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="requests"]');
    await expect(page2.locator('#requests-tab')).toContainText('Sender', { timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  // 回归用例：申请方自己在「请求」tab 不应该出现接受/拒绝按钮，避免误以为能对自己发出的
  // 请求做处理；申请方自己的红点也不应该被点亮，只有接收方待处理时才点亮。
  test('requester sees own request as non-actionable and gets no red dot', async ({ browser }) => {
    const u1 = uniqueUser('so1');
    const u2 = uniqueUser('so2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Requester');
    await register(page2, u2, password, 'Recipient');

    // u1 发起请求
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="search"]');
    await page1.fill('#search-username', u2);
    await page1.click('#search-btn');
    const addBtn = page1.locator('#search-results button');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-confirm-btn');

    // u1（申请方）自己的请求 tab：能看到 Recipient，但不应该有接受/拒绝按钮，也不应该点亮红点。
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="requests"]');
    await expect(page1.locator('#requests-tab')).toContainText('Recipient', { timeout: 10_000 });
    await expect(page1.locator('#requests-tab .btn-primary')).toHaveCount(0);
    await expect(page1.locator('#requests-tab .btn-danger')).toHaveCount(0);
    await expect(page1.locator('.nav-item[data-view="contacts"] .nav-badge')).toHaveCount(0);
    await expect(page1.locator('[data-ctab="requests"] .nav-badge')).toHaveCount(0);

    // u2（接收方）应该能看到可操作的接受/拒绝按钮，并且两处红点都应该点亮。
    await expect(page2.locator('.nav-item[data-view="contacts"] .nav-badge')).toBeVisible({ timeout: 10_000 });
    await page2.click('[data-view="contacts"]');
    await expect(page2.locator('[data-ctab="requests"] .nav-badge')).toBeVisible({ timeout: 10_000 });
    await page2.click('[data-ctab="requests"]');
    await expect(page2.locator('#requests-tab .btn-primary')).toBeVisible({ timeout: 10_000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('accept friend request - both see each other in friends list', async ({ browser }) => {
    const u1 = uniqueUser('af1');
    const u2 = uniqueUser('af2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Friend1');
    await register(page2, u2, password, 'Friend2');
    await addFriend(page1, page2, u2);

    // Both should see each other in friends list
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('#friends-tab')).toContainText('Friend2', { timeout: 5000 });

    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="friends"]');
    await expect(page2.locator('#friends-tab')).toContainText('Friend1', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('reject friend request', async ({ browser }) => {
    const u1 = uniqueUser('rj1');
    const u2 = uniqueUser('rj2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Requester');
    await register(page2, u2, password, 'Rejecter');

    // u1 sends request to u2
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="search"]');
    await page1.fill('#search-username', u2);
    await page1.click('#search-btn');
    const addBtn = page1.locator('#search-results button');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await expect(page1.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });
    await page1.click('#modal-confirm-btn');

    // u2 rejects
    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="requests"]');
    const rejectBtn = page2.locator('#requests-tab .btn-danger').first();
    await expect(rejectBtn).toBeVisible({ timeout: 10_000 });
    await rejectBtn.click();

    // Requests tab should clear
    await expect(page2.locator('#requests-tab')).toContainText(/No pending requests|暂无待处理请求/, { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('delete friend removes from friends list', async ({ browser }) => {
    const u1 = uniqueUser('del1');
    const u2 = uniqueUser('del2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'Deleter');
    await register(page2, u2, password, 'Deleted');
    await addFriend(page1, page2, u2);

    // Verify friends
    await page1.click('[data-view="contacts"]');
    await page1.click('[data-ctab="friends"]');
    await expect(page1.locator('#friends-tab')).toContainText('Deleted', { timeout: 5000 });

    // Mock the confirm dialog to return true
    page1.on('dialog', dialog => dialog.accept());

    // Select the contact then delete via detail panel
    await page1.locator('.contact-item', { hasText: 'Deleted' }).click();
    const deleteBtn = page1.locator('#contacts-detail-panel [data-action="delete"]');
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();

    // Friends list should no longer contain Deleted
    await expect(page1.locator('#friends-tab')).not.toContainText('Deleted', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('friend chat button opens DM', async ({ browser }) => {
    const u1 = uniqueUser('dm1');
    const u2 = uniqueUser('dm2');
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(page1, u1, password, 'DMUser1');
    await register(page2, u2, password, 'DMUser2');
    await addFriend(page1, page2, u2);

    // Click Chat button on DMUser2 in friends list
    await openDMFromContacts(page1, 'DMUser2');

    // Should be in chat view with message input visible
    await expect(page1.locator('#message-input-area')).toBeVisible({ timeout: 5000 });
    // Chat title should show DMUser2
    await expect(page1.locator('#chat-title')).toContainText('DMUser2', { timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('seed data friends first page loaded and sorted', async ({ page }) => {
    await loginSeedUser(page);

    await page.click('[data-view="contacts"]');
    await page.click('[data-ctab="friends"]');

    // Wait for friends to load
    await expect(page.locator('#friends-tab .contact-item').first()).toBeVisible({ timeout: 10_000 });

    // Bounded stream window should render a bounded slice, not the whole contact set.
    await expect(async () => {
      const count = await page.locator('#friends-tab .contact-item').count();
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThanOrEqual(40);
    }).toPass({ timeout: 10_000 });

    // Verify visible range is sorted by cache_name.
    const items = page.locator('#friends-tab .contact-item');
    const names = await items.locator('.contact-name').allTextContents();
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);

    // Verify no duplicates
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('contacts left panel can be resized by mouse', async ({ page }) => {
    await loginSeedUser(page);

    await page.click('[data-view="contacts"]');
    const left = page.locator('.contacts-left');
    const detail = page.locator('#contacts-detail-panel');
    const resizer = page.locator('#contacts-resizer');
    await expect(left).toBeVisible({ timeout: 10_000 });
    await expect(resizer).toBeVisible();

    const before = await left.boundingBox();
    const handle = await resizer.boundingBox();
    expect(before).not.toBeNull();
    expect(handle).not.toBeNull();

    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + handle!.width / 2 + 96, handle!.y + handle!.height / 2);
    await page.mouse.up();

    await expect(async () => {
      const after = await left.boundingBox();
      const detailBox = await detail.boundingBox();
      expect(after).not.toBeNull();
      expect(detailBox).not.toBeNull();
      expect(after!.width).toBeGreaterThan(before!.width + 60);
      expect(detailBox!.width).toBeGreaterThan(300);
    }).toPass({ timeout: 5_000 });
  });

  test('friends list does not keep a loading hint pinned at the top after load', async ({ page }) => {
    await loginSeedUser(page);

    await page.click('[data-view="contacts"]');
    await page.click('[data-ctab="friends"]');

    // 首页加载完成后应有真实联系人。
    await expect(page.locator('#friends-tab .contact-item').first()).toBeVisible({ timeout: 10_000 });

    // 加载完成后顶部不应残留「加载中」提示条（旧 bug：渲染早于清除 loading 标志，顶部永久定格加载中）。
    await expect(page.locator('#friends-tab .list-boundary-hint-top')).toHaveCount(0);
  });

  test('pending requests light up contacts nav red dot', async ({ browser }) => {
    const host = uniqueUser('badge_host');
    const req1 = uniqueUser('badge_r1');
    const req2 = uniqueUser('badge_r2');

    const ctxHost = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });

    const pageHost = await ctxHost.newPage();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await register(pageHost, host, password, 'HostUser');
    await register(page1, req1, password, 'Req1');
    await register(page2, req2, password, 'Req2');

    // Both req1 and req2 send friend requests to host
    for (const [page, target] of [[page1, host], [page2, host]] as const) {
      await page.click('[data-view="contacts"]');
      await page.click('[data-ctab="search"]');
      await page.fill('#search-username', target);
      await page.click('#search-btn');
      const btn = page.locator('#search-results button');
      await expect(btn).toBeVisible({ timeout: 5000 });
      await btn.click();
      const overlay = page.locator('#modal-overlay:not(.hidden)');
      if (await overlay.isVisible({ timeout: 1000 }).catch(() => false)) {
        await page.click('#modal-confirm-btn');
      }
    }

    // Host should see the contacts nav red dot（去掉精确数字，改为红点提示）
    await pageHost.click('[data-view="contacts"]');
    await expect(pageHost.locator('.nav-item[data-view="contacts"] .nav-badge')).toBeVisible({ timeout: 15_000 });
    // 请求列表里能看到两位发起者
    await pageHost.click('[data-ctab="requests"]');
    await expect(pageHost.locator('#requests-tab')).toContainText('Req1', { timeout: 15_000 });
    await expect(pageHost.locator('#requests-tab')).toContainText('Req2', { timeout: 15_000 });

    await ctxHost.close();
    await ctx1.close();
    await ctx2.close();
  });

  test('contacts scroll pagination loads more friends', async ({ page }) => {
    await loginSeedUser(page);

    await page.click('[data-view="contacts"]');
    await page.click('[data-ctab="friends"]');

    // Wait for initial bounded stream window to load.
    await expect(page.locator('#friends-tab .contact-item').first()).toBeVisible({ timeout: 10_000 });

    // Should initially render a bounded stream window.
    await expect(async () => {
      const count = await page.locator('#friends-tab .contact-item').count();
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThanOrEqual(40);
    }).toPass({ timeout: 10_000 });

    const boundedMetrics = await page.evaluate(() => {
      const el = document.querySelector('.contacts-content') as HTMLElement | null;
      return { scrollHeight: el?.scrollHeight ?? 0, clientHeight: el?.clientHeight ?? 0 };
    });
    expect(boundedMetrics.scrollHeight).toBeLessThan(10_000);
    expect(boundedMetrics.scrollHeight).toBeGreaterThan(boundedMetrics.clientHeight);

    // Scroll the contacts content area to the bottom to trigger pagination
    await page.evaluate(() => {
      const el = document.querySelector('.contacts-content');
      if (el) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      }
    });

    // After scrolling, DOM remains bounded and the range moves.
    await expect(async () => {
      const count = await page.locator('#friends-tab .contact-item').count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(80);
      const scrollTop = await page.evaluate(() => (document.querySelector('.contacts-content') as HTMLElement | null)?.scrollTop ?? 0);
      expect(scrollTop).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });

    // Verify visible range is sorted and unique.
    // 显示信息（昵称）异步加载，未命中缓存时 contact-name 会先回退为纯数字 uid，
    // 此时与服务端按 sort_key（昵称）排序的 DOM 顺序短暂不一致。轮询等到可见行
    // 全部加载出真实昵称（不再有纯数字回退）后再校验排序，消除竞态。
    await expect(async () => {
      const names = await page.locator('#friends-tab .contact-item .contact-name').allTextContents();
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((n) => !/^\d+$/.test(n.trim()))).toBe(true);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    }).toPass({ timeout: 10_000 });
  });

  test('remark after pagination reorders contacts without duplicates', async ({ page }) => {
    await loginSeedUser(page);

    await page.click('[data-view="contacts"]');
    await page.click('[data-ctab="friends"]');
    await expect(page.locator('#friends-tab .contact-item').first()).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      const el = document.querySelector('.contacts-content');
      if (el) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      }
    });

    await expect(async () => {
      const count = await page.locator('#friends-tab .contact-item').count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(80);
    }).toPass({ timeout: 10_000 });

    // 滚动到底会触发分页加载并整体重渲染联系人列表，点击可能落在即将被卸载的节点上而被吞掉；
    // 用重试点击直到备注弹窗真正打开，避免重渲染竞态导致的偶发失败。
    const overlay = page.locator('#modal-overlay:not(.hidden)');
    await expect(async () => {
      if (!(await overlay.isVisible())) {
        await page.locator('#friends-tab .contact-item').last().click();
        await page.locator('#contacts-detail-panel [data-action="remark"]').click();
      }
      await expect(overlay).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.fill('#modal-text-input', '000_Remark_A');
    await page.click('#modal-confirm-btn');

    await expect(page.locator('#friends-tab .contact-item').first()).toContainText('000_Remark_A', { timeout: 10_000 });

    const names = await page.locator('#friends-tab .contact-item .contact-name').allTextContents();
    expect(names.length).toBeLessThanOrEqual(80);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });
});
