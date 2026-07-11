import { test, expect, type Page } from '@playwright/test';
import { uniqueUser, seedPrefix } from './helpers';

async function clickShadow(page: Page, hostId: string, selector: string) {
  await page.evaluate(({ hostId, selector }) => {
    const root = document.getElementById(hostId)?.shadowRoot;
    const el = root?.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`missing ${selector} in ${hostId}`);
    el.click();
  }, { hostId, selector });
}

async function fillShadow(page: Page, hostId: string, selector: string, value: string) {
  await page.evaluate(({ hostId, selector, value }) => {
    const root = document.getElementById(hostId)?.shadowRoot;
    const el = root?.querySelector<HTMLInputElement>(selector);
    if (!el) throw new Error(`missing ${selector} in ${hostId}`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { hostId, selector, value });
}

async function waitForShadow(page: Page, hostId: string, selector: string, timeout = 15_000) {
  await page.waitForFunction(({ hostId, selector }) => {
    return Boolean(document.getElementById(hostId)?.shadowRoot?.querySelector(selector));
  }, { hostId, selector }, { timeout });
}

async function waitForAppReady(page: Page, hostId: string, timeout = 15_000) {
  await page.waitForFunction((hostId) => {
    const root = document.getElementById(hostId)?.shadowRoot;
    const app = root?.querySelector<HTMLElement>('#app');
    return Boolean(app && !app.classList.contains('hidden'));
  }, hostId, { timeout });
}

async function textInShadow(page: Page, hostId: string, selector: string) {
  return page.evaluate(({ hostId, selector }) => {
    const el = document.getElementById(hostId)?.shadowRoot?.querySelector<HTMLElement>(selector);
    return el?.textContent?.trim() ?? '';
  }, { hostId, selector });
}

async function registerHost(page: Page, hostId: string, username: string, password: string, nickname: string) {
  await clickShadow(page, hostId, '.tab[data-tab="register"]');
  await fillShadow(page, hostId, '#reg-username', username);
  await fillShadow(page, hostId, '#reg-password', password);
  await fillShadow(page, hostId, '#reg-nickname', nickname);
  await clickShadow(page, hostId, '#register-form button[type="submit"]');
  await waitForAppReady(page, hostId);
}

async function loginHost(page: Page, hostId: string, username: string, password: string) {
  await fillShadow(page, hostId, '#login-username', username);
  await fillShadow(page, hostId, '#login-password', password);
  await clickShadow(page, hostId, '#login-form button[type="submit"]');
  await waitForAppReady(page, hostId);
}

async function switchContactsTab(page: Page, hostId: string, tab: 'friends' | 'requests' | 'search') {
  await clickShadow(page, hostId, `[data-view="contacts"]`);
  await clickShadow(page, hostId, `[data-ctab="${tab}"]`);
}

async function searchAndAddFriend(page: Page, hostId: string, username: string) {
  await switchContactsTab(page, hostId, 'search');
  await fillShadow(page, hostId, '#search-username', username);
  await clickShadow(page, hostId, '#search-btn');
  await waitForShadow(page, hostId, '#add-friend-btn');
  await clickShadow(page, hostId, '#add-friend-btn');
  await waitForShadow(page, hostId, '#modal-confirm-btn');
  await clickShadow(page, hostId, '#modal-confirm-btn');
}

async function acceptFirstRequest(page: Page, hostId: string) {
  await switchContactsTab(page, hostId, 'requests');
  await waitForShadow(page, hostId, '#requests-tab .btn-primary');
  await clickShadow(page, hostId, '#requests-tab .btn-primary');
}

async function openFriendChat(page: Page, hostId: string, name: string) {
  await switchContactsTab(page, hostId, 'friends');
  await page.waitForFunction(({ hostId, name }) => {
    const root = document.getElementById(hostId)?.shadowRoot;
    return Array.from(root?.querySelectorAll<HTMLElement>('.contact-item') ?? []).some((item) => item.textContent?.includes(name));
  }, { hostId, name });
  await page.evaluate(({ hostId, name }) => {
    const root = document.getElementById(hostId)?.shadowRoot;
    const item = Array.from(root?.querySelectorAll<HTMLElement>('.contact-item') ?? []).find((el) => el.textContent?.includes(name));
    if (!item) throw new Error(`contact item missing for ${name} in ${hostId}`);
    item.click();
  }, { hostId, name });
  await waitForShadow(page, hostId, '#contacts-detail-panel [data-action="chat"]');
  await clickShadow(page, hostId, '#contacts-detail-panel [data-action="chat"]');
  await waitForShadow(page, hostId, '#message-input-area:not(.hidden)', 30_000);
}

async function sendShadowMessage(page: Page, hostId: string, text: string) {
  await fillShadow(page, hostId, '#msg-input', text);
  await clickShadow(page, hostId, '#msg-send');
}

test.describe('uikit multi instance', () => {
  test('网格内 widget 会按宿主尺寸自适应，认证卡完整显示', async ({ page }) => {
    await page.goto('/demo/embed-multi.html');

    const hostIds = ['host-u1-persistent', 'host-u1-reset', 'host-u1-memory', 'host-u2-persistent', 'host-u3-persistent', 'host-u4-memory', 'host-u5-persistent', 'host-u5-memory'];
    for (const hostId of hostIds) {
      await page.waitForFunction((id) => Boolean(document.getElementById(id)?.shadowRoot?.querySelector('.auth-card')), hostId);
    }

    const states = await page.evaluate((hostIds) => {
      const tolerance = 4;
      return hostIds.map((hostId) => {
        const host = document.getElementById(hostId);
        const root = host?.shadowRoot;
        const shell = root?.querySelector<HTMLElement>('.mc-app-shell');
        const card = root?.querySelector<HTMLElement>('.auth-card');
        const hostRect = host?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();

        return {
          hostId,
          layout: shell?.dataset.layout ?? '',
          sizeState: shell?.dataset.sizeState ?? '',
          expectedLayout: (hostRect?.width ?? 0) <= 640 ? 'mobile' : 'desktop',
          hostHeight: hostRect?.height ?? 0,
          viewportHeight: window.innerHeight,
          cardFits: Boolean(
            hostRect
            && cardRect
            && cardRect.top >= hostRect.top - tolerance
            && cardRect.bottom <= hostRect.bottom + tolerance
            && cardRect.left >= hostRect.left - tolerance
            && cardRect.right <= hostRect.right + tolerance,
          ),
        };
      });
    }, hostIds);

    for (const state of states) {
      expect(state.layout).toBe(state.expectedLayout);
      expect(state.sizeState).toBe('ready');
      expect(state.cardFits, `${state.hostId} auth card should fit inside host`).toBe(true);
      const maxAllowedHeight = state.expectedLayout === 'mobile' ? 420 : 440;
      expect(state.hostHeight, `${state.hostId} host should stay compact in grid layout`).toBeLessThanOrEqual(maxAllowedHeight + 1);
    }
  });

  test('seed 用户登录后好友长列表不会把格子撑高', async ({ page }) => {
    await page.goto('/demo/embed-multi.html');

    const seededUser = `${seedPrefix()}_Test1`;
    await page.waitForFunction(() => Boolean(document.getElementById('host-u1-persistent')?.shadowRoot?.querySelector('#login-form')));
    await loginHost(page, 'host-u1-persistent', seededUser, 'test123');
    const postLoginLayoutState = await page.evaluate(() => {
      const tolerance = 1;
      const host = document.getElementById('host-u1-persistent');
      const root = host?.shadowRoot;
      const app = root?.querySelector<HTMLElement>('#app');
      const navbar = root?.querySelector<HTMLElement>('#navbar');
      const hostRect = host?.getBoundingClientRect();
      const appRect = app?.getBoundingClientRect();
      const navRect = navbar?.getBoundingClientRect();

      return {
        appFitsHost: Boolean(
          hostRect
          && appRect
          && appRect.top >= hostRect.top - tolerance
          && appRect.bottom <= hostRect.bottom + tolerance,
        ),
        navbarFitsHost: Boolean(
          hostRect
          && navRect
          && navRect.top >= hostRect.top - tolerance
          && navRect.bottom <= hostRect.bottom + tolerance,
        ),
      };
    });
    expect(postLoginLayoutState.appFitsHost).toBe(true);
    expect(postLoginLayoutState.navbarFitsHost).toBe(true);

    const hostHeightBeforeContacts = await page.evaluate(() => {
      return document.getElementById('host-u1-persistent')?.getBoundingClientRect().height ?? 0;
    });
    await switchContactsTab(page, 'host-u1-persistent', 'friends');
    await page.waitForFunction(() => {
      const root = document.getElementById('host-u1-persistent')?.shadowRoot;
      return (root?.querySelectorAll('#friends-tab .contact-item').length ?? 0) > 5;
    });

    const state = await page.evaluate(() => {
      const host = document.getElementById('host-u1-persistent');
      const root = host?.shadowRoot;
      const shell = root?.querySelector<HTMLElement>('.mc-app-shell');
      const hostRect = host?.getBoundingClientRect();

      return {
        layout: shell?.dataset.layout ?? '',
        sizeState: shell?.dataset.sizeState ?? '',
        expectedLayout: (hostRect?.width ?? 0) <= 640 ? 'mobile' : 'desktop',
        hostHeight: hostRect?.height ?? 0,
        viewportHeight: window.innerHeight,
        friendCount: root?.querySelectorAll('#friends-tab .contact-item').length ?? 0,
      };
    });

    expect(state.layout).toBe(state.expectedLayout);
    expect(state.sizeState).toBe('ready');
    const maxAllowedHeight = state.expectedLayout === 'mobile' ? 420 : 440;
    expect(state.hostHeight).toBeLessThanOrEqual(maxAllowedHeight + 1);
    expect(Math.abs(state.hostHeight - hostHeightBeforeContacts)).toBeLessThanOrEqual(1);
    expect(state.friendCount).toBeGreaterThan(5);
  });

  test('8 个格子可独立登录，同账号多模式互不串扰且能同时收消息', async ({ page }) => {
    const password = '123456';
    const user1 = uniqueUser('grid_u1');
    const user2 = uniqueUser('grid_u2');
    const user3 = uniqueUser('grid_u3');
    const user4 = uniqueUser('grid_u4');
    const user5 = uniqueUser('grid_u5');

    await page.goto('/demo/embed-multi.html');

    const hostIds = ['host-u1-persistent', 'host-u1-reset', 'host-u1-memory', 'host-u2-persistent', 'host-u3-persistent', 'host-u4-memory', 'host-u5-persistent', 'host-u5-memory'];
    for (const hostId of hostIds) {
      await page.waitForFunction((id) => Boolean(document.getElementById(id)?.shadowRoot), hostId);
    }

    await registerHost(page, 'host-u1-persistent', user1, password, 'User One');
    await loginHost(page, 'host-u1-reset', user1, password);
    await loginHost(page, 'host-u1-memory', user1, password);
    await registerHost(page, 'host-u2-persistent', user2, password, 'User Two');
    await registerHost(page, 'host-u3-persistent', user3, password, 'User Three');
    await registerHost(page, 'host-u4-memory', user4, password, 'User Four');
    await registerHost(page, 'host-u5-persistent', user5, password, 'User Five');
    await loginHost(page, 'host-u5-memory', user5, password);

    await searchAndAddFriend(page, 'host-u2-persistent', user1);
    await acceptFirstRequest(page, 'host-u1-persistent');
    await page.waitForTimeout(800);

    await openFriendChat(page, 'host-u2-persistent', 'User One');
    await sendShadowMessage(page, 'host-u2-persistent', 'hello multi grid');

    for (const hostId of ['host-u1-persistent', 'host-u1-reset', 'host-u1-memory']) {
      await openFriendChat(page, hostId, 'User Two');
      await page.waitForFunction(({ hostId, text }) => {
        const root = document.getElementById(hostId)?.shadowRoot;
        return Array.from(root?.querySelectorAll<HTMLElement>('.message-bubble') ?? []).some((el) => el.textContent?.includes(text));
      }, { hostId, text: 'hello multi grid' }, { timeout: 15_000 });
    }

    await clickShadow(page, 'host-u1-persistent', '[data-view="settings"]');
    await page.evaluate(() => window.__gridHandles['host-u1-persistent'].setLocale('en'));
    await page.waitForFunction(() => {
      const root = document.getElementById('host-u1-persistent')?.shadowRoot;
      return root?.querySelector('#logout-btn')?.textContent?.includes('Logout');
    });

    expect(await textInShadow(page, 'host-u1-persistent', '#logout-btn')).toBe('Logout');
    await clickShadow(page, 'host-u1-reset', '[data-view="settings"]');
    expect(await textInShadow(page, 'host-u1-reset', '#logout-btn')).toBe('退出登录');

    await page.evaluate(() => window.__gridHandles['host-u1-reset'].unmount());
    await page.waitForFunction(() => window.__gridDemo.shadowChildCount('host-u1-reset') === 0);
    expect(await page.evaluate(() => window.__gridDemo.shadowChildCount('host-u1-reset'))).toBe(0);
    expect(await page.evaluate(() => window.__gridDemo.shadowChildCount('host-u1-persistent') > 0)).toBe(true);
  });
});
