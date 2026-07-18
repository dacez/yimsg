import { test, expect } from './test-fixtures';
import { loginSeedUser, sendMessage, expectMessage } from './helpers';

const convListScrollTop = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (document.getElementById('conversation-list') as HTMLElement).scrollTop);

// 会话列表有界消息流窗口回归：种子用户 Test1 拥有上百个会话（test-seed 的 dmFanout）。
// 这些用例锁定历史 bug：keyset 游标被当成随机访问 offset，导致
// “永远滚不到底部、老是重复、少了非常多”。
test.describe('Conversation list bounded stream window', () => {
  test.beforeEach(async ({ page }) => {
    await loginSeedUser(page);
    await page.click('[data-view="chat"]');
    await expect(page.locator('#conversation-list .conversation-item').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders a bounded stream window over a tall scroll area', async ({ page }) => {
    // DOM 只保留视窗附近的少量节点，而不是全部会话。
    await expect(async () => {
      const count = await page.locator('#conversation-list .conversation-item').count();
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThanOrEqual(80);
    }).toPass({ timeout: 10_000 });

    const metrics = await page.evaluate(() => {
      const el = document.getElementById('conversation-list') as HTMLElement | null;
      return { scrollHeight: el?.scrollHeight ?? 0, clientHeight: el?.clientHeight ?? 0 };
    });
    // 上百个会话 × 68px：滚动区应远高于视窗。
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight * 3);
  });

  test('scrolls all the way to a stable bottom without phantom rows', async ({ page }) => {
    const read = () =>
      page.evaluate(() => {
        const el = document.getElementById('conversation-list') as HTMLElement;
        return {
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
        };
      });

    // 反复滚到底部并等待增量补页，直到 scrollHeight 稳定（不再增长）。
    // 旧 bug 下 total 是不断变大的估算值，scrollHeight 永远不稳定、底部永远填不满。
    let stableHeight = 0;
    await expect(async () => {
      await page.evaluate(() => {
        const el = document.getElementById('conversation-list') as HTMLElement;
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      const before = (await read()).scrollHeight;
      await page.waitForTimeout(150);
      const after = await read();
      // 已经稳定：底部可真正抵达。
      expect(after.scrollHeight).toBe(before);
      expect(after.scrollTop + after.clientHeight).toBeGreaterThanOrEqual(after.scrollHeight - 4);
      stableHeight = after.scrollHeight;
    }).toPass({ timeout: 20_000 });

    expect(stableHeight).toBeGreaterThan(0);

    // 渲染窗口内不得有重复的会话 key。
    const keys = await page.locator('#conversation-list .conversation-item').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.key || ''),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every conversation is reachable while scrolling (no missing items)', async ({ page }) => {
    const seen = new Set<string>();
    const collectVisibleKeys = async () => {
      const keys = await page
        .locator('#conversation-list .conversation-item')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.key || ''));
      // 单个窗口内不重复。
      expect(new Set(keys).size).toBe(keys.length);
      keys.forEach((k) => k && seen.add(k));
    };

    await collectVisibleKeys();

    const bottomBoundary = page
      .locator('#conversation-list .list-boundary-hint-bottom')
      .filter({ hasText: /没有更多会话|No more conversations/ });

    // 每次触底后等待窗口内容真正换页或出现数据集底部，再收集下一窗口。
    // 不能用固定 sleep：并发运行时查询可能超过 sleep，旧流程会在发出加载后立即把
    // “当前已在底部”误判为遍历完成，只收集到有界窗口上限（80）条。
    let reachedDatasetEnd = false;
    for (let step = 0; step < 12; step++) {
      if (await bottomBoundary.isVisible()) {
        reachedDatasetEnd = true;
        break;
      }

      const beforeKeys = await page
        .locator('#conversation-list .conversation-item')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.key || '').join('|'));
      await page.evaluate(() => {
        const el = document.getElementById('conversation-list') as HTMLElement;
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });

      await expect.poll(async () => {
        if (await bottomBoundary.isVisible()) return 'dataset-end';
        return page
          .locator('#conversation-list .conversation-item')
          .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.key || '').join('|'));
      }, { timeout: 20_000 }).not.toBe(beforeKeys);
      await collectVisibleKeys();
    }

    expect(reachedDatasetEnd || await bottomBoundary.isVisible()).toBe(true);
    // 种子至少有 dmFanout(120) 个会话；旧 bug 下大量会话不可达。
    expect(seen.size).toBeGreaterThanOrEqual(120);
  });

  // 锁定 bug：本端发送消息后（conversations:sent → toTop）列表只重拉首页却没真正置顶，
  // render 的锚点恢复把视口顶在原来那条上，发出的会话被顶出视口、看不到。
  test('sending a message scrolls the list back to top with that conversation selected', async ({ page }) => {
    // 打开顶部第一个会话，记录其 key（发送后它应仍被选中并回到顶部）。
    await page.locator('#conversation-list .conversation-item').first().click();
    await expect(page.locator('#message-input-area')).toBeVisible({ timeout: 5_000 });
    const activeKey = await page
      .locator('#conversation-list .conversation-item.active')
      .getAttribute('data-key');
    expect(activeKey).toBeTruthy();

    // 把会话列表滚到底部（远离顶部），制造“发送后需要置顶”的前置条件。
    await expect(async () => {
      await page.evaluate(() => {
        const el = document.getElementById('conversation-list') as HTMLElement;
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(150);
      const top = await page.evaluate(
        () => (document.getElementById('conversation-list') as HTMLElement).scrollTop,
      );
      expect(top).toBeGreaterThan(50);
    }).toPass({ timeout: 10_000 });

    // 在打开的会话里发送一条消息。
    const text = `top-back ${Date.now()}`;
    await sendMessage(page, text);
    await expectMessage(page, text);

    // 发送后：列表滚回最顶端，且发出的会话是首条并处于选中态。
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (document.getElementById('conversation-list') as HTMLElement).scrollTop,
          ),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(4);

    const topItem = page.locator('#conversation-list .conversation-item').first();
    await expect(topItem).toHaveAttribute('data-key', activeKey!);
    await expect(topItem).toHaveClass(/active/);
  });

  // 锁定 bug：会话列表停在最顶端时，他端来消息（messages:received → force 重拉）只 reset
  // 重拉首页却没把滚动容器归零，render 的锚点恢复把视口顶在原来那条上，新置顶的会话被顶出
  // 视口——表现为「贴顶却要下拉才看得到新会话，同时误亮『有新消息』提示条」。
  test('incoming message auto-refreshes the list to top when already at top', async ({ browser, page }) => {
    // 前置：会话列表停在最顶端。
    await page.evaluate(() => {
      const el = document.getElementById('conversation-list') as HTMLElement;
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => convListScrollTop(page), { timeout: 10_000 }).toBeLessThanOrEqual(4);

    // 另一好友（Test6，会话原本沉在列表底部、未加载进当前窗口）给 Test1 发来新消息。
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page2 = await ctx2.newPage();
    try {
      await loginSeedUser(page2, 'Test6');
      await page2.click('[data-view="chat"]');
      const onlyConv = page2.locator('#conversation-list .conversation-item').first();
      await expect(onlyConv).toBeVisible({ timeout: 10_000 });
      await onlyConv.click();
      await expect(page2.locator('#message-input-area')).toBeVisible({ timeout: 5_000 });
      const text = `auto-top ${Date.now()}`;
      await sendMessage(page2, text);
      await expectMessage(page2, text);

      // Test1 侧：该会话出现在列表里即证明来消息已触发重绘 / 重拉。
      // （Test1 是共享种子用户，并行用例可能并发重排其列表，故只锁定滚动位置与提示条这两个
      //  与本 bug 直接相关、且不受并发重排影响的不变量，不断言具体置顶条目。）
      await expect(
        page.locator('#conversation-list .conversation-item', { hasText: text }),
      ).toHaveCount(1, { timeout: 15_000 });
      // 贴顶背景刷新必须自动滚回最顶端（reset 后归零），而不是被锚点恢复下推（旧 bug 下 scrollTop>4）。
      await expect.poll(() => convListScrollTop(page), { timeout: 10_000 }).toBeLessThanOrEqual(4);
      // 贴顶自动追平，不应点亮「有新消息」提示条。
      await expect(page.locator('#conversation-update-pill')).toBeHidden();
    } finally {
      await ctx2.close();
    }
  });

  // 锁定 bug：会话列表不在顶部时，他端来消息（messages:received）只点亮提示条、列表完全不更新——
  // 收到消息的会话仍在数据窗口内，却看不到新预览/未读。修复后：不重排，但对窗口内受影响会话
  // 定向拉取并就地更新（renderConversationList({ force, keys }) → refreshConversations）。
  test('incoming message updates an in-window conversation in place without reordering when not at top', async ({ browser, page }) => {
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page2 = await ctx2.newPage();
    try {
      // Test6 只有一个会话（与 Test1）。先让它发一条消息，Test1 贴顶 reset 后把该会话带到窗口顶部。
      await loginSeedUser(page2, 'Test6');
      await page2.click('[data-view="chat"]');
      const onlyConv = page2.locator('#conversation-list .conversation-item').first();
      await expect(onlyConv).toBeVisible({ timeout: 10_000 });
      await onlyConv.click();
      await expect(page2.locator('#message-input-area')).toBeVisible({ timeout: 5_000 });

      const first = `inwindow-first ${Date.now()}`;
      await sendMessage(page2, first);
      await expectMessage(page2, first);

      // Test1 侧：该会话进入窗口（携带 first 预览）。
      const firstItem = page.locator('#conversation-list .conversation-item', { hasText: first });
      await expect(firstItem).toHaveCount(1, { timeout: 15_000 });

      // 把列表向下滚动一点，离开顶部但该会话仍在首页窗口内（pageSize=40，滚 100px 仍在首页）。
      await expect(async () => {
        await page.evaluate(() => {
          const el = document.getElementById('conversation-list') as HTMLElement;
          el.scrollTop = 100;
          el.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(120);
        expect(await convListScrollTop(page)).toBeGreaterThan(4);
      }).toPass({ timeout: 10_000 });

      // Test6 再发一条新消息：Test1 不在顶部，应不重排但就地更新该会话的预览。
      const second = `inwindow-second ${Date.now()}`;
      await sendMessage(page2, second);
      await expectMessage(page2, second);

      // 关键断言：窗口内该会话的预览就地更新为新消息（旧实现下列表不动也不更新，看不到 second）。
      await expect(
        page.locator('#conversation-list .conversation-item', { hasText: second }),
      ).toHaveCount(1, { timeout: 15_000 });
      // 不在顶部：列表不重排、不滚回顶部。
      expect(await convListScrollTop(page)).toBeGreaterThan(4);
      // 不在顶部收到消息：点亮「列表有更新」提示条。
      await expect(page.locator('#conversation-update-pill')).toBeVisible();
    } finally {
      await ctx2.close();
    }
  });

  // 锁定 bug：刚进入聊天、初始同步「一堆网络请求」期间会话列表被反复整列表重建
  // （messages:received / session:sync success → force reset → innerHTML 清空重填）。
  // 用户此时点击：mousedown 的行节点在 mouseup 前被销毁，浏览器不再派发 click，
  // 表现为「刚打开点会话没反应，过一会儿才行」。修复：指针按下期间推迟列表重建，
  // 原节点存活到 click 派发之后。
  //
  // 这里用一个确定性的「按下→重建→抬起」时序验证：mousedown 落在某一行后，立刻让另一端
  // 持续发消息触发整列表重建，再 mouseup；修复后该行仍被打开。引擎层的同一不变量另有确定性
  // 单测覆盖（tests/unit/uikit-bounded-stream-window.test.ts：指针按下期间不重建）。
  test('clicking a conversation still opens it while the list is churning from incoming messages', async ({ browser, page }) => {
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page2 = await ctx2.newPage();
    try {
      // 另一好友 Test5 打开与 Test1 的会话，准备发一小段消息制造 Test1 列表重建。
      await loginSeedUser(page2, 'Test5');
      await page2.click('[data-view="chat"]');
      const onlyConv = page2.locator('#conversation-list .conversation-item').first();
      await expect(onlyConv).toBeVisible({ timeout: 10_000 });
      await onlyConv.click();
      await expect(page2.locator('#message-input-area')).toBeVisible({ timeout: 5_000 });

      // Test1 停在列表顶部：他端来消息会触发 force reset 整列表重建。
      await page.evaluate(() => {
        const el = document.getElementById('conversation-list') as HTMLElement;
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
      });
      await expect.poll(() => convListScrollTop(page), { timeout: 10_000 }).toBeLessThanOrEqual(4);

      // Test1：对某一行按下，按下期间触发整列表重建，再抬起。
      const target = page.locator('#conversation-list .conversation-item').first();
      await expect(target).toBeVisible({ timeout: 10_000 });
      const box = await target.boundingBox();
      expect(box).toBeTruthy();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      // 按下期间发几条消息：Test1 会话列表多次整列表重建（未修复时原行节点被销毁、click 被吃掉）。
      for (let i = 0; i < 6; i++) {
        await sendMessage(page2, `churn ${Date.now()}-${i}`);
        await page.waitForTimeout(120);
      }
      await page.mouse.up();

      // 修复后：按下期间重建被推迟，原节点存活，click 正常派发 → 会话被打开。
      await expect(page.locator('#message-input-area')).toBeVisible({ timeout: 8_000 });
    } finally {
      await ctx2.close();
    }
  });
});
