import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * uikit mount 单元测试。
 *
 * 由于项目未引入 jsdom / happy-dom 环境，DOM 操作相关的渲染细节由 Playwright
 * 覆盖。本文件仅在零依赖下验证导入签名和参数保护逻辑。
 */

describe('uikit public surface', () => {
  beforeEach(() => {
    vi.stubGlobal('HTMLElement', class HTMLElement {});
    vi.stubGlobal('WebSocket', class { constructor() { /* noop */ } });
    vi.stubGlobal('document', {
      querySelector: () => null,
      createElement: () => ({
        textContent: '',
        innerHTML: '',
        classList: { toggle: () => undefined, add: () => undefined, remove: () => undefined },
        appendChild: () => undefined,
        addEventListener: () => undefined,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
        clientWidth: 0,
        dataset: {},
        style: {},
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('index.ts re-exports mount and YimsgClient', async () => {
    const mod = await import('../../src/uikit');
    expect(typeof mod.mount).toBe('function');
    expect(typeof mod.YimsgClient).toBe('function');
  });

  it('build script also includes the uikit bundle', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.build).toContain('build:uikit');
  });

  it('mount throws on non-HTMLElement container', async () => {
    const { mount } = await import('../../src/uikit');
    expect(() => mount(null as unknown as HTMLElement)).toThrow(/需要一个 HTMLElement/);
    expect(() => mount({} as HTMLElement)).toThrow(/需要一个 HTMLElement/);
  });

  it('mount throws a clear error when selector does not match any element', async () => {
    const { mount } = await import('../../src/uikit');
    // 上面 stubGlobal 的 document.querySelector 始终返回 null，正好模拟"找不到"场景
    expect(() => mount('#not-exist')).toThrow(/找不到容器/);
  });

});
