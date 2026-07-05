/**
 * uikit 主题系统：提供基于 CSS 变量的可定制配色/圆角/字体。
 *
 * - 内置 `light`（默认）与 `dark` 两套主题；
 * - 宿主可通过 `theme: 'light' | 'dark' | 'auto' | CustomTheme` 来切换；
 * - `auto` 会跟随 `prefers-color-scheme`（若可用）实时切换；
 * - 也可以传入部分覆盖（`CustomTheme` 仅包含需要改的变量），未覆盖的回退到基线。
 *
 * 所有变量以 `--mc-*` 前缀，定义在 Shadow DOM 根节点上，不会泄漏到宿主页面。
 */

export type ThemePreset = 'light' | 'dark' | 'auto';

/** 颜色等主题变量；全部可选，未指定则用 preset 默认值。 */
export interface ThemeTokens {
  /** 主色（按钮、链接等）。 */
  primary?: string;
  /** 主色悬浮态。 */
  primaryHover?: string;
  /** 主色浅色底（激活会话、tab 激活等）。 */
  primaryMuted?: string;
  /** 根节点背景色。 */
  background?: string;
  /** 消息列表背景色。 */
  listBackground?: string;
  /** 卡片 / 面板背景色。 */
  surface?: string;
  /** 次要背景（自己发出的消息气泡）。 */
  bubbleSelf?: string;
  /** 对方消息气泡背景色。 */
  bubbleOther?: string;
  /** 主文案色。 */
  text?: string;
  /** 次要文案色（预览、placeholder）。 */
  textMuted?: string;
  /** 边框 / 分割线色。 */
  border?: string;
  /** 错误 / 告警色。 */
  danger?: string;
  /** 断线等系统提示 banner 背景。 */
  statusBg?: string;
  /** 断线等系统提示 banner 文案。 */
  statusText?: string;
  /** 未读小红点背景色。 */
  unread?: string;
  /** 字体栈。 */
  fontFamily?: string;
  /** 基础字号。 */
  fontSize?: string;
  /** 面板圆角。 */
  radius?: string;
  /** 气泡圆角。 */
  bubbleRadius?: string;
}

export type ThemeOption = ThemePreset | ({ preset?: ThemePreset } & ThemeTokens);

const LIGHT: Required<ThemeTokens> = {
  primary: '#2e7df6',
  primaryHover: '#1f6ae0',
  primaryMuted: '#eaf2fe',
  background: '#ffffff',
  listBackground: '#f3f5f8',
  surface: '#ffffff',
  bubbleSelf: '#d7ebff',
  bubbleOther: '#ffffff',
  text: '#1c1e21',
  textMuted: '#7c828c',
  border: '#e8eaee',
  danger: '#f04a4a',
  statusBg: '#fff3e0',
  statusText: '#e65100',
  unread: '#f04a4a',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif',
  fontSize: '14px',
  radius: '10px',
  bubbleRadius: '18px',
};

const DARK: Required<ThemeTokens> = {
  primary: '#5b9bff',
  primaryHover: '#7aafff',
  primaryMuted: 'rgba(91,155,255,.18)',
  background: '#1e1f22',
  listBackground: '#181a1d',
  surface: '#23262b',
  bubbleSelf: '#2f5fb0',
  bubbleOther: '#2c3038',
  text: '#eceff1',
  textMuted: '#90a4ae',
  border: '#373a40',
  danger: '#ef5350',
  statusBg: '#3e2723',
  statusText: '#ffcc80',
  unread: '#ef5350',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif',
  fontSize: '14px',
  radius: '10px',
  bubbleRadius: '18px',
};

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolvePreset(preset: ThemePreset): Required<ThemeTokens> {
  if (preset === 'dark') return DARK;
  if (preset === 'light') return LIGHT;
  return prefersDark() ? DARK : LIGHT;
}

interface ResolvedTheme {
  readonly preset: ThemePreset;
  readonly tokens: Required<ThemeTokens>;
}

const THEME_VAR_ENTRIES = [
  ['--mc-primary', 'primary'],
  ['--mc-primary-hover', 'primaryHover'],
  ['--mc-primary-muted', 'primaryMuted'],
  ['--mc-bg', 'background'],
  ['--mc-list-bg', 'listBackground'],
  ['--mc-surface', 'surface'],
  ['--mc-bubble-self', 'bubbleSelf'],
  ['--mc-bubble-other', 'bubbleOther'],
  ['--mc-text', 'text'],
  ['--mc-text-muted', 'textMuted'],
  ['--mc-border', 'border'],
  ['--mc-danger', 'danger'],
  ['--mc-status-bg', 'statusBg'],
  ['--mc-status-text', 'statusText'],
  ['--mc-unread', 'unread'],
  ['--mc-font-family', 'fontFamily'],
  ['--mc-font-size', 'fontSize'],
  ['--mc-radius', 'radius'],
  ['--mc-bubble-radius', 'bubbleRadius'],
] as const satisfies ReadonlyArray<readonly [string, keyof ThemeTokens]>;

/** 把用户输入解析为确定的主题 token。 */
export function resolveTheme(option: ThemeOption | undefined): ResolvedTheme {
  if (!option) return { preset: 'auto', tokens: resolvePreset('auto') };
  if (typeof option === 'string') return { preset: option, tokens: resolvePreset(option) };
  const preset = option.preset ?? 'auto';
  return { preset, tokens: { ...resolvePreset(preset), ...filterUndefined(option) } };
}

/** 以内联 CSS `--mc-*` 变量字符串输出，供 style 属性使用。 */
export function themeToInlineVars(theme: ResolvedTheme): string {
  return THEME_VAR_ENTRIES.map(([cssVar, tokenKey]) => `${cssVar}:${theme.tokens[tokenKey]}`).join(';');
}

export function applyThemeVarsToElement(element: Pick<HTMLElement, 'style'>, theme: ResolvedTheme): void {
  for (const [cssVar, tokenKey] of THEME_VAR_ENTRIES) {
    element.style.setProperty(cssVar, theme.tokens[tokenKey] ?? '');
  }
}

export function clearThemeVarsFromElement(element: Pick<HTMLElement, 'style'>): void {
  for (const [cssVar] of THEME_VAR_ENTRIES) {
    element.style.removeProperty(cssVar);
  }
}

/** 当 preset === 'auto' 时监听系统主题变更，调用回调重新解析。 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => { /* noop */ };
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange();
  // 兼容不支持 EventTarget API 的老 matchMedia 实现（iOS Safari < 14、早期 Chromium）。
  // 新代码应走 addEventListener 分支；保留 addListener 分支仅作为防御性回退。
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  mq.addListener?.(handler);
  return () => mq.removeListener?.(handler);
}

function filterUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined && k !== ('preset' as keyof T)) {
      out[k] = obj[k];
    }
  }
  return out;
}
