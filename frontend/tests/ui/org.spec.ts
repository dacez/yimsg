import { test, expect } from '@playwright/test';
import { loginSeedUser, seedPrefix, register, uniqueUser } from './helpers';

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

  // 通讯录左下角"创建组织"入口：create_org 只授予创建者管理员 GRANT 边，不产生通讯录
  // 条目；UI 随后必须调用 add_org_member 把创建者挂为组织根成员，新组织才会出现在
  // 自己的好友列表里，且创建者应能直接进入管理面板（删除组织按钮只有根管理员可见）。
  test('create organization via contacts entry point', async ({ page }) => {
    await register(page, uniqueUser('createorg'), '123456', 'OrgCreator');
    await page.click('[data-view="contacts"]');
    await page.click('#create-org-btn');
    await expect(page.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });

    const orgName = `我的组织_${Date.now()}`;
    await page.fill('#modal-text-input', orgName);
    await page.click('#modal-confirm-btn');

    const orgRow = page.locator('#friends-tab .contact-item', { hasText: orgName });
    await expect(orgRow).toBeVisible({ timeout: 15_000 });
    await expect(orgRow.locator('.contact-org-badge')).toBeVisible();

    await orgRow.click();
    const panel = page.locator('#contacts-detail-panel');
    await expect(panel.locator('.org-crumb-current')).toContainText(orgName, { timeout: 10_000 });
    await panel.locator('#contacts-org-manage').click();
    await expect(page.locator('#modal-content #oa-delete-org')).toBeVisible({ timeout: 10_000 });
  });

  // 通讯录管理弹层新建部门：刚建的 tag 展示名走 getTagInfos 缓存，创建瞬间大概率冷缓存
  // 未命中，先按 tag_id 兜底展示；缓存异步补齐后必须通过 display:updated 把弹层里的
  // 名字换成真实值，不能停留在纯数字 tag_id。曾经这里因为弹层内 showTextInputModal
  // 复用同一个 #modal-overlay/#modal-content、resolve 时也会短暂触发 hidden，导致
  // display:updated 订阅被过早解绑而无法回归此测试要覆盖的场景。
  test('org-admin panel refreshes a newly created department name off cold cache', async ({ page }) => {
    await register(page, uniqueUser('createdept'), '123456', 'DeptCreator');
    await page.click('[data-view="contacts"]');
    await page.click('#create-org-btn');
    await expect(page.locator('#modal-overlay:not(.hidden)')).toBeVisible({ timeout: 5000 });

    const orgName = `部门测试组织_${Date.now()}`;
    await page.fill('#modal-text-input', orgName);
    await page.click('#modal-confirm-btn');

    const orgRow = page.locator('#friends-tab .contact-item', { hasText: orgName });
    await expect(orgRow).toBeVisible({ timeout: 15_000 });
    await orgRow.click();

    const panel = page.locator('#contacts-detail-panel');
    await expect(panel.locator('.org-crumb-current')).toContainText(orgName, { timeout: 10_000 });
    await panel.locator('#contacts-org-manage').click();
    await expect(page.locator('#modal-content #oa-create-tag')).toBeVisible({ timeout: 10_000 });

    const deptName = '财务部';
    await page.click('#oa-create-tag');
    await page.fill('#modal-text-input', deptName);
    await page.click('#modal-confirm-btn');

    const deptRow = page.locator('#modal-content .org-admin-row', { hasText: deptName });
    await expect(deptRow).toBeVisible({ timeout: 10_000 });
    const rowNames = await page.locator('#modal-content .org-admin-row .org-admin-row-name').allTextContents();
    expect(rowNames.some(text => /^\d+$/.test(text.trim()))).toBe(false);

    // 弹层的"关闭"按钮仍要正常工作，确认 display:updated 订阅没有连带破坏正常关闭路径。
    await page.click('#oa-close');
    await expect(page.locator('#modal-overlay:not(.hidden)')).toHaveCount(0);
  });
});
