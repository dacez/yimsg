import { test, expect, type Page } from '../support/test-fixtures';
import { addFriend, expectMessage, openDMFromContacts, sendMessage, uniqueUser } from './helpers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 跨域嵌入端到端回归。
 *
 * 目标形态：客户把 yimsg 部署到自己的一台服务器，任意第三方站点给出这个网址就能
 * 嵌入 UIKit。这里的宿主页由 global-setup 拉起的独立静态服务器提供（localhost），
 * yimsg 服务端跑在 127.0.0.1——两者是不同 origin，浏览器会真正走跨域检查。
 */

function thirdPartyOrigin(): string {
  const origin = process.env.THIRD_PARTY_HOST_ORIGIN;
  if (!origin) throw new Error('缺少 THIRD_PARTY_HOST_ORIGIN，global-setup 未拉起第三方宿主服务器');
  return origin;
}

/** 收集控制台与页面错误，用于断言全程没有跨域 / 混合内容问题。 */
function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  return problems;
}

/** 在跨域宿主页的 widget 内完成注册并进入应用视图。 */
async function registerInWidget(page: Page, username: string, nickname: string): Promise<void> {
  await page.locator('.tab[data-tab="register"]').click();
  await page.locator('#reg-username').fill(username);
  await page.locator('#reg-password').fill('123456');
  await page.locator('#reg-nickname').fill(nickname);
  await page.locator('#register-form button[type="submit"]').click();
  await expect(page.locator('#conversation-list')).toBeVisible({ timeout: 20_000 });
}

test.describe('跨域嵌入', () => {
  test('IIFE bundle 跨域加载后暴露全局 YimsgUIKit 并建出 shadow root', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto(`${thirdPartyOrigin()}/iife.html`);

    // 全局对象来自跨域的普通 script 标签：宿主页无需改造成 module script，
    // 这是「给个网址就能嵌」的最短接入形态。
    await expect
      .poll(() => page.evaluate(() => (window as never as { __yimsgGlobalReady?: boolean }).__yimsgGlobalReady))
      .toBe(true);

    const hasShadow = await page.evaluate(() => Boolean(document.getElementById('chat-host')?.shadowRoot));
    expect(hasShadow).toBe(true);
    await expect(page.locator('#login-form')).toBeVisible({ timeout: 15_000 });

    expect(problems.filter((p) => /CORS|Mixed Content|blocked/i.test(p))).toEqual([]);
  });

  test('IIFE 宿主页同样能完成跨域注册登录', async ({ page }) => {
    await page.goto(`${thirdPartyOrigin()}/iife.html`);
    await registerInWidget(page, uniqueUser('xiife'), 'CrossOriginIife');

    const widgetErrors = await page.evaluate(() => (window as never as { __yimsgErrors?: string[] }).__yimsgErrors ?? []);
    expect(widgetErrors).toEqual([]);
  });

  test('ESM bundle 跨域 import 成功并建出 shadow root', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto(`${thirdPartyOrigin()}/esm.html`);

    // module script 的跨域 import 走 CORS 模式请求，服务端必须回 Access-Control-Allow-Origin，
    // 否则这里会直接失败——这一条就是整个跨域嵌入链路的入口断言。
    await expect.poll(() => page.evaluate(() => (window as never as { __yimsgEsmLoaded?: boolean }).__yimsgEsmLoaded))
      .toBe(true);
    const esmError = await page.evaluate(() => (window as never as { __yimsgEsmError?: string }).__yimsgEsmError);
    expect(esmError).toBeUndefined();

    const hasShadow = await page.evaluate(() => Boolean(document.getElementById('chat-host')?.shadowRoot));
    expect(hasShadow).toBe(true);
    await expect(page.locator('#login-form')).toBeVisible({ timeout: 15_000 });

    expect(problems.filter((p) => /CORS|Mixed Content|blocked/i.test(p))).toEqual([]);
  });

  test('跨域宿主页可以注册登录并建立 WebSocket 会话', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto(`${thirdPartyOrigin()}/esm.html`);

    await registerInWidget(page, uniqueUser('xorigin'), 'CrossOriginUser');

    // widget 内部没有通过 onError 上报任何问题。
    const widgetErrors = await page.evaluate(() => (window as never as { __yimsgErrors?: string[] }).__yimsgErrors ?? []);
    expect(widgetErrors).toEqual([]);
    expect(problems.filter((p) => /CORS|Mixed Content/i.test(p))).toEqual([]);
  });

  test('跨域上传图片成功，且媒体地址指向服务端并真实加载', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto(`${thirdPartyOrigin()}/esm.html`);
    await registerInWidget(page, uniqueUser('xupload'), 'CrossOriginUploader');

    // 头像上传是最短的一条「带 Authorization 的跨域上传 + 媒体展示」链路。
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator('#settings-avatar')).toBeVisible({ timeout: 10_000 });
    await page.locator('#avatar-picker').setInputFiles(path.resolve(__dirname, 'fixtures', 'test-image.png'));
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 20_000 });

    const avatarImg = page.locator('#settings-avatar img');
    await expect(avatarImg).toBeVisible({ timeout: 10_000 });

    // 关键断言：媒体地址被解析成服务端 origin 的绝对地址，而不是宿主站点的相对路径。
    const src = await avatarImg.getAttribute('src');
    const serverOrigin = process.env.PLAYWRIGHT_BASE_URL!;
    expect(src).toContain(serverOrigin);
    expect(src).toContain('/media/');

    // 并且真的加载出来了（跨域被拦时 naturalWidth 为 0）。
    await expect.poll(async () => avatarImg.evaluate((img: HTMLImageElement) => img.naturalWidth), {
      timeout: 15_000,
    }).toBeGreaterThan(0);

    expect(problems.filter((p) => /CORS|Mixed Content/i.test(p))).toEqual([]);
  });

  test('两个跨域宿主页之间可以互发消息', async ({ browser }) => {
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const user1 = uniqueUser('xmsg1');
    const user2 = uniqueUser('xmsg2');

    await page1.goto(`${thirdPartyOrigin()}/esm.html`);
    await page2.goto(`${thirdPartyOrigin()}/esm.html`);
    await registerInWidget(page1, user1, 'CrossOriginA');
    await registerInWidget(page2, user2, 'CrossOriginB');

    // 加好友、开会话、发消息全部复用主应用同一套流程：widget 在 shadow DOM 里，
    // Playwright 的选择器能穿透，跨域宿主页与同源页面共用同一组断言。
    await addFriend(page1, page2, user2);
    await openDMFromContacts(page1, 'CrossOriginB');
    await sendMessage(page1, '跨域你好');

    await page2.click('[data-view="chat"]');
    const conversation = page2.locator('#conversation-list .conversation-item', { hasText: 'CrossOriginA' });
    await expect(conversation).toBeVisible({ timeout: 20_000 });
    await conversation.click();
    await expectMessage(page2, '跨域你好', 20_000);

    await ctx1.close();
    await ctx2.close();
  });
});
