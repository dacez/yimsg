/**
 * UIKit 对外语言与文案覆盖契约。
 *
 * 实际运行时翻译表与查找逻辑位于 app/i18n.ts 和 app/app-instance.ts；
 * 本文件只保留公开类型与 locale 自动判定，避免维护第二套翻译表。
 */

export type LocaleCode = 'zh-CN' | 'en';

/** 嵌入包允许覆盖的基础文案 key。 */
export interface Messages {
  'brand': string;
  'auth.login': string;
  'auth.register': string;
  'auth.username': string;
  'auth.password': string;
  'auth.nickname': string;
  'auth.submit.login': string;
  'auth.submit.register': string;
  'auth.emptyCreds': string;
  'auth.emptyNick': string;
  'auth.failed': string;
  'auth.loginFailed': string;
  'auth.autoLoginFailed': string;
  'auth.initFailed': string;
  'auth.kicked': string;
  'list.header': string;
  'list.empty': string;
  'logout': string;
  'back': string;
  'chat.empty': string;
  'chat.pick': string;
  'composer.placeholder': string;
  'send': string;
  'recall': string;
  'recall.confirm': string;
  'recalled': string;
  'sendFailed': string;
  'connecting': string;
  'reconnecting': string;
  'disconnected': string;
  'group': string;
  'imageAttach': string;
  'imageSending': string;
  'imageFailed': string;
  'imageLabel': string;
  'unreadBadge': string;
}

export type LocaleOption = LocaleCode | 'auto';

/** 根据 navigator.language 推断地区；在非浏览器环境回退 zh-CN。 */
export function detectLocale(): LocaleCode {
  if (typeof navigator === 'undefined') return 'zh-CN';
  const lang = (navigator.language || 'zh-CN').toLowerCase();
  if (lang.startsWith('zh')) return 'zh-CN';
  return 'en';
}
