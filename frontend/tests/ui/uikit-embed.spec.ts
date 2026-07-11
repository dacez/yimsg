import { test, expect } from '@playwright/test';
import type { MountHandle } from '../../src/uikit';
import { uniqueUser } from './helpers';

/**
 * uikit 嵌入式 IM 组件的端到端回归：
 * 1. 宿主页面加载 IIFE bundle 后能得到全局 YimsgUIKit；
 * 2. `mount()` 在容器上创建 Shadow DOM，widget 内容被封装在 shadow root 内；
 * 3. 在 widget 内完成注册并进入聊天视图；
 * 4. `unmount()` 完成后 shadow root 内容被清空。
 *
 * Playwright 默认能穿透 open Shadow DOM，可直接用 CSS 选择器定位内部元素。
 */
test.describe('uikit embed', () => {
  test('mount → register → reach chat view → unmount works inside Shadow DOM', async ({ page }) => {
    const username = uniqueUser('uikit');
    await page.goto('/demo/embed.html');

    // widget 容器存在且带有 shadow root
    const hasShadow = await page.evaluate(() => {
      const el = document.getElementById('chat-host');
      return Boolean(el && el.shadowRoot);
    });
    expect(hasShadow).toBe(true);

    // 切到注册 tab；Playwright 会自动穿透 open shadow root。
    await page.locator('.tab[data-tab="register"]').click();
    await page.locator('#reg-username').fill(username);
    await page.locator('#reg-password').fill('123456');
    await page.locator('#reg-nickname').fill('UISDKUser');
    await page.locator('#register-form button[type="submit"]').click();

    // 进入应用视图：会话列表可见 → 证明已完成 login + startSession
    await expect(page.locator('#conversation-list')).toBeVisible({ timeout: 15_000 });

    // unmount：shadow root 中所有节点应被清空
    await page.click('#btn-unmount');
    const shadowChildCount = await page.evaluate(() => {
      const el = document.getElementById('chat-host');
      return el?.shadowRoot ? el.shadowRoot.childNodes.length : 0;
    });
    expect(shadowChildCount).toBe(0);
  });

  test('host body styles stay isolated from widget (Shadow DOM scoping)', async ({ page }) => {
    await page.goto('/demo/embed.html');
    // 宿主 body 背景来自 demo HTML 自身 CSS (#f5f6fa)，widget 内 .mc-root 用的是 #ffffff。
    // 若 Shadow DOM 未隔离，会出现颜色污染。
    const hostBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(hostBg).toMatch(/rgb\(\s*245\s*,\s*246\s*,\s*250\s*\)/);
  });

  test('mount accepts mode option and widget bundle exposes UIKitMode-aware API', async ({ page }) => {
    // 通过运行时加载 IIFE，然后动态构造一个隔离容器调用 mount({ mode: 'memory' })。
    // 目标：验证 `mode` 参数不会让 mount() 报错、widget 能正常渲染认证页。
    await page.goto('/demo/embed.html');

    const result = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'mode-test-host';
      host.style.height = '400px';
      document.body.appendChild(host);
      const w = window as unknown as { YimsgUIKit: { mount: (el: HTMLElement, opts: Record<string, unknown>) => { unmount: () => void; shadowRoot: ShadowRoot } } };
      const handle = w.YimsgUIKit.mount(host, {
        wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
        mode: 'memory',
      });
      const hasAuthCard = !!handle.shadowRoot.querySelector('.auth-card');
      handle.unmount();
      host.remove();
      return { hasAuthCard };
    });

    expect(result.hasAuthCard).toBe(true);
  });

  test('viewMode: chat-only hides bottom navbar and host hash changes never affect the widget', async ({ page }) => {
    // 页面上已有 #chat-host 默认 widget，用独立 hostId 隔离，避免全局选择器命中两个 shadow root。
    const username = uniqueUser('chatonly');
    await page.goto('/demo/embed.html');

    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'chat-only-host';
      host.style.width = '760px';
      host.style.height = '480px';
      document.body.appendChild(host);
      const w = window as unknown as {
        __chatOnlyHandle?: MountHandle;
        YimsgUIKit: { mount: (el: HTMLElement, opts: Record<string, unknown>) => MountHandle };
      };
      w.__chatOnlyHandle = w.YimsgUIKit.mount(host, {
        wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
        viewMode: 'chat-only',
      });
    });

    await page.waitForFunction(() => Boolean(document.getElementById('chat-only-host')?.shadowRoot?.querySelector('.auth-card')));

    const submit = async (selector: string, value?: string) => {
      await page.evaluate(({ selector, value }) => {
        const root = document.getElementById('chat-only-host')?.shadowRoot;
        const el = root?.querySelector<HTMLInputElement>(selector);
        if (!el) throw new Error(`missing ${selector} in chat-only-host`);
        if (value === undefined) el.click();
        else {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, { selector, value });
    };

    await submit('.tab[data-tab="register"]');
    await submit('#reg-username', username);
    await submit('#reg-password', '123456');
    await submit('#reg-nickname', 'ChatOnlyUser');
    await submit('#register-form button[type="submit"]');

    await page.waitForFunction(() => Boolean(document.getElementById('chat-only-host')?.shadowRoot?.querySelector('#conversation-list')), undefined, { timeout: 15_000 });

    const readyState = await page.evaluate(() => {
      const root = document.getElementById('chat-only-host')?.shadowRoot;
      const navbar = root?.querySelector<HTMLElement>('#navbar');
      return {
        navbarDisplay: navbar ? getComputedStyle(navbar).display : null,
        viewMode: root?.querySelector<HTMLElement>('.mc-app-shell')?.getAttribute('data-view-mode'),
      };
    });
    expect(readyState.navbarDisplay).toBe('none');
    expect(readyState.viewMode).toBe('chat-only');

    // widget 不使用/不监听 URL hash：改宿主页面 hash 对 widget 当前视图必须完全没有影响。
    await page.evaluate(() => { location.hash = '#/contacts'; });
    await page.waitForTimeout(200);
    const routedState = await page.evaluate(() => {
      const root = document.getElementById('chat-only-host')?.shadowRoot;
      return {
        chatHidden: root?.querySelector('#view-chat')?.classList.contains('hidden') ?? true,
        contactsHidden: root?.querySelector('#view-contacts')?.classList.contains('hidden') ?? true,
      };
    });
    expect(routedState.chatHidden).toBe(false);
    expect(routedState.contactsHidden).toBe(true);

    await page.evaluate(() => {
      const w = window as unknown as { __chatOnlyHandle?: MountHandle };
      w.__chatOnlyHandle?.unmount();
      delete w.__chatOnlyHandle;
      document.getElementById('chat-only-host')?.remove();
      location.hash = '';
    });
  });

  test('explicit mobile layout preserves host inline styles after unmount', async ({ page }) => {
    await page.goto('/demo/embed.html');

    const result = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'layout-style-host';
      host.style.width = '420px';
      host.style.height = '400px';
      host.style.border = '3px solid rgb(255, 0, 0)';
      document.body.appendChild(host);

      const w = window as unknown as {
        YimsgUIKit: {
          mount: (el: HTMLElement, opts: Record<string, unknown>) => MountHandle;
        };
      };

      const handle = w.YimsgUIKit.mount(host, {
        wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
        layout: 'mobile',
      });
      handle.setTheme('dark');

      const mobile = handle.shadowRoot.querySelector('.mc-app-shell')?.getAttribute('data-layout') === 'mobile';
      handle.unmount();

      const inlineStyle = host.getAttribute('style');
      host.remove();

      return { mobile, inlineStyle };
    });

    expect(result.mobile).toBe(true);
    expect(result.inlineStyle).toContain('width: 420px;');
    expect(result.inlineStyle).toContain('height: 400px;');
    expect(result.inlineStyle).toContain('border: 3px solid rgb(255, 0, 0);');
    expect(result.inlineStyle).not.toContain('--mc-bg');
  });

  test('auto layout reacts to host resize and keeps auth card usable', async ({ page }) => {
    await page.goto('/demo/embed.html');

    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'auto-layout-host';
      host.style.width = '760px';
      host.style.height = '380px';
      host.style.marginTop = '16px';
      document.body.appendChild(host);

      const w = window as unknown as {
        __autoLayoutHandle?: MountHandle;
        YimsgUIKit: {
          mount: (el: HTMLElement, opts: Record<string, unknown>) => MountHandle;
        };
      };

      w.__autoLayoutHandle?.unmount();
      w.__autoLayoutHandle = w.YimsgUIKit.mount(host, {
        wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
        layout: 'auto',
        locale: 'zh-CN',
      });
    });

    await page.waitForFunction(() => {
      return document.getElementById('auto-layout-host')?.shadowRoot?.querySelector('.mc-app-shell')?.getAttribute('data-layout') === 'desktop';
    });

    await page.evaluate(() => {
      const host = document.getElementById('auto-layout-host') as HTMLElement | null;
      if (host) host.style.width = '420px';
    });

    await page.waitForFunction(() => {
      return document.getElementById('auto-layout-host')?.shadowRoot?.querySelector('.mc-app-shell')?.getAttribute('data-layout') === 'mobile';
    });

    const narrowState = await page.evaluate(() => {
      const tolerance = 4;
      const host = document.getElementById('auto-layout-host');
      const root = host?.shadowRoot;
      const card = root?.querySelector<HTMLElement>('.auth-card');
      const hostRect = host?.getBoundingClientRect();
      const cardRect = card?.getBoundingClientRect();

      return {
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

    expect(narrowState.cardFits).toBe(true);

    await page.evaluate(() => {
      const host = document.getElementById('auto-layout-host') as HTMLElement | null;
      if (host) host.style.width = '760px';
    });

    await page.waitForFunction(() => {
      return document.getElementById('auto-layout-host')?.shadowRoot?.querySelector('.mc-app-shell')?.getAttribute('data-layout') === 'desktop';
    });

    await page.evaluate(() => {
      const w = window as unknown as { __autoLayoutHandle?: MountHandle };
      w.__autoLayoutHandle?.unmount();
      delete w.__autoLayoutHandle;
      document.getElementById('auto-layout-host')?.remove();
    });
  });

  test('host too small shows guard message until container becomes large enough', async ({ page }) => {
    await page.goto('/demo/embed.html');

    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'too-small-host';
      host.style.width = '300px';
      host.style.height = '340px';
      host.style.marginTop = '16px';
      document.body.appendChild(host);

      const w = window as unknown as {
        __tooSmallHandle?: MountHandle;
        YimsgUIKit: {
          mount: (el: HTMLElement, opts: Record<string, unknown>) => MountHandle;
        };
      };

      w.__tooSmallHandle?.unmount();
      w.__tooSmallHandle = w.YimsgUIKit.mount(host, {
        wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
        layout: 'auto',
        locale: 'zh-CN',
      });
    });

    await page.waitForFunction(() => {
      return document.getElementById('too-small-host')?.shadowRoot?.querySelector('.mc-app-shell')?.getAttribute('data-size-state') === 'too-small';
    });

    const guardState = await page.evaluate(() => {
      const root = document.getElementById('too-small-host')?.shadowRoot;
      const title = root?.querySelector<HTMLElement>('.mc-size-guard-title')?.textContent ?? '';
      const body = root?.querySelector<HTMLElement>('.mc-size-guard-body')?.textContent ?? '';
      const authDisplay = root?.querySelector<HTMLElement>('#view-auth')
        ? getComputedStyle(root.querySelector<HTMLElement>('#view-auth')!).display
        : '';

      return { title, body, authDisplay };
    });

    expect(guardState.title).toContain('容器太小');
    expect(guardState.body).toContain('320 x 360 px');
    expect(guardState.authDisplay).toBe('none');

    await page.evaluate(() => {
      const host = document.getElementById('too-small-host') as HTMLElement | null;
      if (!host) return;
      host.style.width = '420px';
      host.style.height = '400px';
    });

    await page.waitForFunction(() => {
      return document.getElementById('too-small-host')?.shadowRoot?.querySelector('.mc-app-shell')?.getAttribute('data-size-state') === 'ready';
    });

    const recovered = await page.evaluate(() => {
      const root = document.getElementById('too-small-host')?.shadowRoot;
      const authCard = root?.querySelector<HTMLElement>('.auth-card');
      return {
        authVisible: Boolean(authCard && getComputedStyle(authCard).display !== 'none'),
      };
    });

    expect(recovered.authVisible).toBe(true);

    await page.evaluate(() => {
      const w = window as unknown as { __tooSmallHandle?: MountHandle };
      w.__tooSmallHandle?.unmount();
      delete w.__tooSmallHandle;
      document.getElementById('too-small-host')?.remove();
    });
  });
});
