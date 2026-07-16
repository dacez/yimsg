import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Translator, detectLocale } from '../../src/i18n';
import {
  applyThemeVarsToElement,
  clearThemeVarsFromElement,
  resolveTheme,
  themeToInlineVars,
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

  it('translator returns different text per locale', () => {
    const zh = new Translator('zh-CN');
    const en = new Translator('en');
    expect(zh.t('send')).toBe('发送');
    expect(en.t('send')).toBe('Send');
  });

  it('overrides take precedence over builtin messages', () => {
    const tr = new Translator('en', { send: 'GO' });
    expect(tr.t('send')).toBe('GO');
    expect(tr.t('logout')).toBe('Sign out'); // 未覆盖的仍回退默认
  });

  it('setLocale switches the active language', () => {
    const tr = new Translator('zh-CN');
    expect(tr.t('logout')).toBe('退出');
    tr.setLocale('en');
    expect(tr.t('logout')).toBe('Sign out');
    expect(tr.getLocale()).toBe('en');
  });

  it('unknown keys fall back to the key itself', () => {
    const tr = new Translator('en');
    // 故意传一个不在 Messages 里的 key，验证回退逻辑；这里用 keyof 宽松断言以避免 ts-expect-error。
    const t = tr as unknown as { t: (k: string) => string };
    expect(t.t('does.not.exist')).toBe('does.not.exist');
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

  it('themeToInlineVars emits all --mc-* variables', () => {
    const css = themeToInlineVars(resolveTheme('light'));
    expect(css).toContain('--mc-primary:#2e7df6');
    expect(css).toContain('--mc-bg:#ffffff');
    expect(css).toContain('--mc-font-family:');
    expect(css).toContain('--mc-radius:10px');
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
