/**
 * yimsg demo 页面共享的语言检测与文案应用逻辑。
 * 语言判定优先读取官网语言切换器写入的 localStorage['yimsg-lang']（website/index.html
 * 的 `#lang-toggle` 会写入同一个 key），未设置时按 navigator.language 是否以 zh 开头回退判定，
 * 使从官网点进来的访客与直接用中/英文浏览器打开的访客都能看到匹配语言的 demo 页面。
 */

const STORAGE_KEY = 'yimsg-lang';

/** 返回 'zh' 或 'en'。 */
export function detectDemoLang() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (saved === 'zh' || saved === 'en') return saved;
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** demo 语言 -> UIKit mount() 期望的 locale 值。 */
export function demoLocale(lang) {
  return lang === 'en' ? 'en' : 'zh-CN';
}

/**
 * 把 dict 中的文案套用到页面上：
 * - `data-i18n="key"` 元素的 textContent 替换为 dict[key]；
 * - `data-i18n-html="key"` 元素的 innerHTML 替换为 dict[key]（用于含 <code> 的文案）；
 * - dict.pageTitle 存在时同步写入 document.title。
 */
export function applyDemoI18n(lang, dict) {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (dict.pageTitle) document.title = dict.pageTitle;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (dict[key] !== undefined) el.innerHTML = dict[key];
  });
}
