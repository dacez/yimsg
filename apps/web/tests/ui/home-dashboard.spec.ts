import { expect, test } from '@playwright/test';

test.describe('home dashboard', () => {
  test('首页展示 9 宫格，并支持调尺寸、卸载、加载和清空数据', async ({ page }) => {
    await page.goto('/app/home-dashboard.html');

    await expect(page.locator('.home-dashboard__cell')).toHaveCount(9);
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll<HTMLElement>('.home-dashboard__cell-host'))
        .every((host) => Boolean(host.shadowRoot?.querySelector('.auth-card')));
    });

    const firstCell = page.locator('#dashboard-cell-grid-1');
    const firstHost = page.locator('#dashboard-host-grid-1');

    await page.selectOption('#dashboard-size-grid-1', '2x2');
    await expect(firstCell).toHaveAttribute('data-size', '2x2');

    await page.click('#dashboard-unload-grid-1');
    await expect(page.locator('#dashboard-status-grid-1')).toHaveText('已卸载');
    await expect.poll(async () => {
      return page.evaluate(() => document.getElementById('dashboard-host-grid-1')?.shadowRoot?.childNodes.length ?? -1);
    }).toBe(0);

    await page.click('#dashboard-load-grid-1');
    await page.waitForFunction(() => {
      return Boolean(document.getElementById('dashboard-host-grid-1')?.shadowRoot?.querySelector('.auth-card'));
    });

    await page.click('#dashboard-clear-grid-1');
    await expect(page.locator('#dashboard-status-grid-1')).toHaveText('数据已清空');
    await expect.poll(async () => {
      return page.evaluate(() => document.getElementById('dashboard-host-grid-1')?.shadowRoot?.childNodes.length ?? -1);
    }).toBe(0);

    await page.click('#dashboard-load-grid-1');
    await expect(firstHost).toBeVisible();
    await page.waitForFunction(() => {
      return Boolean(document.getElementById('dashboard-host-grid-1')?.shadowRoot?.querySelector('.auth-card'));
    });
  });
});
