import { Page, expect } from '@playwright/test';

/** Generate a unique username for test isolation */
export function uniqueUser(prefix = 'u') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Register a new user and land on the app (instant mode).
 * `layout` 可选：在启动模态框上顺带手动选择布局偏好（auto/desktop/mobile），
 * 用于覆盖“桌面鼠标环境下手动选择手机布局”这类场景，不传则保持自动检测。
 */
export async function register(
  page: Page,
  username: string,
  password: string,
  nickname: string,
  layout?: 'auto' | 'desktop' | 'mobile',
) {
  await page.goto('/app/');
  await ensureModeSelected(page, 'instant', layout);
  await page.click('[data-tab="register"]');
  await page.fill('#reg-username', username);
  await page.fill('#reg-password', password);
  await page.fill('#reg-nickname', nickname);
  await page.click('#register-form button[type="submit"]');
  await waitForAppReady(page);
}

/** Login with existing credentials */
export async function login(page: Page, username: string, password: string) {
  await page.goto('/app/');
  await ensureModeSelected(page, 'instant');
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type="submit"]');
  await waitForAppReady(page);
}

async function waitForAppReady(page: Page) {
  await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#navbar')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#view-chat')).toBeVisible({ timeout: 20_000 });
}

/** Select instant or 持久存储 mode when the startup modal is visible; 可选顺带手动选择布局偏好 */
export async function ensureModeSelected(
  page: Page,
  mode: 'instant' | 'persistent',
  layout?: 'auto' | 'desktop' | 'mobile',
) {
  const modal = page.locator('#modal-overlay:not(.hidden)');
  try {
    await page.locator('#mode-opt-instant').waitFor({ state: 'visible', timeout: 1000 });
  } catch (_) {
    if (await modal.count() === 0) return;
  }
  await expect(modal).toBeVisible({ timeout: 5000 });
  if (layout) {
    await page.click(`.layout-option[data-layout="${layout}"]`);
  }
  await page.click(mode === 'instant' ? '#mode-opt-instant' : '#mode-opt-persistent');
  await expect(modal).toHaveCount(0);
}

/** Send a text message in the currently open conversation */
export async function sendMessage(page: Page, text: string) {
  await page.fill('#msg-input', text);
  await page.click('#msg-send');
}

/**
 * Add a friend: user1 sends request, user2 accepts.
 * After accepting, user1 clicks "Chat" on user2 from friends list to open DM.
 */
export async function addFriend(page1: Page, page2: Page, username2: string) {
  const requestSentToast = page1.locator('#toast-container .toast', {
    hasText: /好友请求已发送|Friend request sent/,
  });
  // 同一页面可能连续添加多个好友；必须等上一笔成功提示退场，才能把后续 toast
  // 明确归属于本次写入。
  await expect(requestSentToast).toHaveCount(0, { timeout: 6_000 });

  // User1: contacts → search → add
  await page1.click('[data-view="contacts"]');
  await page1.click('[data-ctab="search"]');
  await page1.fill('#search-username', username2);
  await page1.click('#search-btn');
  const targetResult = page1.locator('#search-results .search-result', { hasText: `@${username2}` });
  await expect(targetResult).toBeVisible({ timeout: 5_000 });
  const addBtn = targetResult.locator('#add-friend-btn');
  await addBtn.click();
  const remarkModal = page1.locator('#modal-overlay:not(.hidden)');
  if (await remarkModal.isVisible({ timeout: 1000 }).catch(() => false)) {
    await page1.click('#modal-confirm-btn');
  }
  // 先确认发送接口已经提交成功，再让接收方追平，避免把“按钮已点击”误当成请求已落库。
  await expect(requestSentToast).toBeVisible({ timeout: 10_000 });

  // User2: contacts → requests → accept. 通知只提示数据变化；每轮切出再切回通讯录，
  // 主动触发 loadContacts 拉取服务端已提交的数据，不能只反复点击当前 requests tab。
  const acceptBtn = page2.locator('#requests-tab .btn-primary').first();
  await expect(async () => {
    await page2.click('[data-view="chat"]');
    await page2.click('[data-view="contacts"]');
    await page2.click('[data-ctab="requests"]');
    await expect(acceptBtn).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const friendAddedToast = page2.locator('#toast-container .toast', {
    hasText: /已添加好友|Friend added/,
  });
  await expect(friendAddedToast).toHaveCount(0, { timeout: 6_000 });
  await acceptBtn.click();
  await expect(friendAddedToast).toBeVisible({ timeout: 10_000 });
  await expect(acceptBtn).toHaveCount(0, { timeout: 10_000 });
}

export async function setContactRemark(page: Page, currentName: string, remark: string) {
  await page.click('[data-view="contacts"]');
  await page.click('[data-ctab="friends"]');
  const item = page.locator('.contact-item', { hasText: currentName });
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  const remarkBtn = page.locator('#contacts-detail-panel [data-action="remark"]');
  await expect(remarkBtn).toBeVisible({ timeout: 5000 });
  await remarkBtn.click();
  await page.fill('#modal-text-input', remark);
  await page.click('#modal-confirm-btn');
}

/** Open DM with a friend via contacts → friends → detail panel's Chat button */
export async function openDMFromContacts(page: Page, friendNickname: string) {
  await page.click('[data-view="contacts"]');
  await page.click('[data-ctab="friends"]');
  const item = page.locator('.contact-item', { hasText: friendNickname });
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  const detailPanel = page.locator('#contacts-detail-panel');
  // 上一个联系人的详情按钮可能仍短暂可见；必须先等目标详情标题完成切换。
  await expect(detailPanel.locator('.detail-name')).toHaveText(friendNickname, { timeout: 10_000 });
  const chatBtn = detailPanel.locator('[data-action="chat"]');
  await expect(chatBtn).toBeVisible({ timeout: 10_000 });
  await chatBtn.click();
  // Should switch to chat view with the conversation open
  await expect(page.locator('#message-input-area')).toBeVisible({ timeout: 5000 });
}

/** Click a conversation by its display name */
export async function openConversation(page: Page, name: string) {
  await page.click('[data-view="chat"]');
  const conv = page.locator('#conversation-list .conversation-item', { hasText: name });
  await expect(conv).toBeVisible({ timeout: 5000 });
  await conv.click();
}

/** Wait for the message list to contain a specific text */
export async function expectMessage(page: Page, text: string, timeout = 5000) {
  await expect(page.locator('#message-list', { hasText: text })).toBeVisible({ timeout });
}

/** Get all visible message texts (bubble content) */
export async function getMessageTexts(page: Page): Promise<string[]> {
  return page.locator('.message-bubble').allTextContents();
}

/** Get the test-seed prefix from env (set by global-setup) */
export function seedPrefix(): string {
  const p = process.env.TEST_SEED_PREFIX;
  if (!p) throw new Error('TEST_SEED_PREFIX not set — run test-seed first');
  return p;
}

/** Login as a test-seed user (e.g. {prefix}_Test1/test123) and select instant mode */
export async function loginSeedUser(page: Page, username = 'Test1', password = 'test123') {
  const fullUsername = `${seedPrefix()}_${username}`;
  await page.goto('/app/');
  await ensureModeSelected(page, 'instant');
  await page.fill('#login-username', fullUsername);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type="submit"]');
  await waitForAppReady(page);
}
