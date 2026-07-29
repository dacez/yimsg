import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { detectLocale } from '../../src/i18n';
import {
  applyThemeVarsToElement,
  clearThemeVarsFromElement,
  resolveTheme,
} from '../../src/theme';

/**
 * uikit 纯逻辑模块（i18n、theme）的单元测试。
 *
 * 这些模块不依赖 DOM，可以直接在 vitest 中验证。
 */

describe('uikit i18n', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('defaults to zh-CN when navigator is missing', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectLocale()).toBe('zh-CN');
  });

  it('detects en for en-US navigator', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(detectLocale()).toBe('en');
  });

  it('detects zh-CN for zh-TW navigator too (broad zh match)', () => {
    vi.stubGlobal('navigator', { language: 'zh-TW' });
    expect(detectLocale()).toBe('zh-CN');
  });

});

describe('uikit theme', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark'), addEventListener: () => undefined, removeEventListener: () => undefined }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves light preset to light tokens', () => {
    const t = resolveTheme('light');
    expect(t.preset).toBe('light');
    expect(t.tokens.background).toBe('#ffffff');
  });

  it('resolves dark preset to dark tokens', () => {
    const t = resolveTheme('dark');
    expect(t.preset).toBe('dark');
    expect(t.tokens.background).toBe('#1e1f22');
  });

  it('auto follows prefers-color-scheme (dark when matchMedia says dark)', () => {
    const t = resolveTheme('auto');
    expect(t.preset).toBe('auto');
    expect(t.tokens.background).toBe('#1e1f22');
  });

  it('custom tokens override preset defaults', () => {
    const t = resolveTheme({ preset: 'light', primary: '#ff0000', radius: '16px' });
    expect(t.tokens.primary).toBe('#ff0000');
    expect(t.tokens.radius).toBe('16px');
    expect(t.tokens.background).toBe('#ffffff'); // preset fallback
  });

  it('applyThemeVarsToElement only writes theme vars', () => {
    const values = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => {
          values.set(name, value);
        },
        removeProperty: (name: string) => {
          values.delete(name);
        },
        getPropertyValue: (name: string) => values.get(name) ?? '',
      },
    } as unknown as HTMLElement;

    values.set('height', '400px');
    applyThemeVarsToElement(element, resolveTheme('dark'));

    expect(values.get('--mc-bg')).toBe('#1e1f22');
    expect(values.get('--mc-primary')).toBe('#5b9bff');
    expect(values.get('height')).toBe('400px');
  });

  it('clearThemeVarsFromElement preserves unrelated inline styles', () => {
    const values = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => {
          values.set(name, value);
        },
        removeProperty: (name: string) => {
          values.delete(name);
        },
        getPropertyValue: (name: string) => values.get(name) ?? '',
      },
    } as unknown as HTMLElement;

    values.set('height', '400px');
    applyThemeVarsToElement(element, resolveTheme('light'));
    clearThemeVarsFromElement(element);

    expect(values.get('--mc-bg')).toBeUndefined();
    expect(values.get('--mc-primary')).toBeUndefined();
    expect(values.get('height')).toBe('400px');
  });
});
