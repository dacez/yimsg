import { test, expect } from '@playwright/test';
import { loginSeedUser, seedPrefix } from './helpers';

// 组织通讯录：组织条目出现在通讯录列表（带"组织"徽标），点开进入组织架构浏览器，
// 面包屑逐级下钻，绝对排序（总经理 rank=10 排第一）、一人多岗（Test2 部门排第一）、
// 以及冷缓存成员资料补齐可见。
// 数据来自 test-seed 的 "{prefix}_测试组织"。
test.describe('Org directory', () => {
  test('org entry expands into tag browser with absolute order', async ({ page }) => {
    await loginSeedUser(page, 'Test1');
    const orgName = `${seedPrefix()}_测试组织`;

    // 通讯录好友列表包含组织条目（带组织徽标）。
    await page.click('[data-view="contacts"]');
    const orgRow = page.locator('#friends-tab .contact-item', { hasText: orgName });
    await expect(orgRow).toBeVisible({ timeout: 15_000 });
    await expect(orgRow.locator('.contact-org-badge')).toBeVisible();
    const orgRowLayout = await orgRow.evaluate((row) => {
      const badge = row.querySelector<HTMLElement>('.contact-org-badge')!;
      const name = row.querySelector<HTMLElement>('.contact-name-text')!;
      const rowRect = row.getBoundingClientRect();
      const badgeRect = badge.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      return {
        badgeLeft: badgeRect.left,
        badgeRight: badgeRect.right,
        nameRight: nameRect.right,
        rowRight: rowRect.right,
        rowScrollWidth: row.scrollWidth,
        rowClientWidth: row.clientWidth,
      };
    });
    expect(orgRowLayout.badgeRight).toBeLessThanOrEqual(orgRowLayout.rowRight + 0.5);
    expect(orgRowLayout.nameRight).toBeLessThanOrEqual(orgRowLayout.badgeLeft);
    expect(orgRowLayout.rowScrollWidth).toBeLessThanOrEqual(orgRowLayout.rowClientWidth + 1);

    // 点开 → 组织架构浏览器：根层展示公司领导（rank=10）在测试部门（rank=20）前。
    await orgRow.click();
    const panel = page.locator('#contacts-detail-panel');
    await expect(panel.locator('.org-crumb-current')).toContainText(orgName, { timeout: 10_000 });
    const rootRows = panel.locator('.org-tag-row .contact-name');
    await expect(rootRows.first()).toContainText('公司领导', { timeout: 10_000 });
    await expect(rootRows.nth(1)).toContainText('测试部门');
    await expect(rootRows.nth(2)).toContainText('远端部门');

    // 下钻公司领导：总经理（rank=10）排第一并带职务徽标；Test2 副总沉底。
    // 面包屑当前层名字必须补齐为"公司领导"，不能停留在纯数字 tagId（该 tag 无子 tag，
    // 只有 getTagInfos 把面包屑祖先一起批量取回才会命中缓存）。
    await panel.locator('.org-tag-row', { hasText: '公司领导' }).click();
    await expect(panel.locator('.org-crumb-current')).toContainText('公司领导', { timeout: 10_000 });
    const leaderRows = panel.locator('.org-member-row');
    await expect(leaderRows.first()).toContainText('测试用户1', { timeout: 10_000 });
    await expect(leaderRows.first().locator('.org-member-title')).toContainText('总经理');
    await expect(leaderRows.nth(1)).toContainText('测试用户2');

    // 面包屑回根，再下钻测试部门：一人多岗——Test2 在这里 rank=1 排第一。
    await panel.locator('.org-crumb').first().click();
    await panel.locator('.org-tag-row', { hasText: '测试部门' }).click();
    const deptRows = panel.locator('.org-member-row');
    await expect(deptRows.first()).toContainText('测试用户2', { timeout: 10_000 });
    await expect(deptRows.first().locator('.org-member-title')).toContainText('部门负责人');

    // 再下钻一个成员资料大概率未被左侧联系人列表预热的部门：成员名必须在 display:updated 后补齐，
    // 不能停留在纯数字 UID。
    await panel.locator('.org-crumb').first().click();
    await panel.locator('.org-tag-row', { hasText: '远端部门' }).click();
    const remoteNames = panel.locator('.org-member-row .contact-name');
    await expect(remoteNames).toHaveText([
      /测试用户200.*远端负责人/,
      /测试用户201/,
      /测试用户202/,
    ], { timeout: 10_000 });
    const remoteTexts = await remoteNames.allTextContents();
    expect(remoteTexts.some(text => /^\d+$/.test(text.trim()))).toBe(false);
  });
});
