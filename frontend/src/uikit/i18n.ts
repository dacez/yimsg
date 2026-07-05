/**
 * uikit 的内置文案与语言切换。
 *
 * 设计原则：
 * - 所有文案通过 key 查询，避免在视图中硬编码字符串；
 * - 默认支持 `zh-CN`、`en`；宿主可通过 `messages` 覆盖任何 key；
 * - `locale` 为 `auto` 时根据 `navigator.language` 推导；
 * - 未知 key 回退到 key 自身，保证渲染不报错。
 */

export type LocaleCode = 'zh-CN' | 'en';

/** 文案 key 列表，新增 UI 文案时必须在此登记。 */
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

const ZH: Messages = {
  'brand': 'yimsg',
  'auth.login': '登录',
  'auth.register': '注册',
  'auth.username': '用户名',
  'auth.password': '密码',
  'auth.nickname': '昵称',
  'auth.submit.login': '登录',
  'auth.submit.register': '注册',
  'auth.emptyCreds': '用户名和密码不能为空',
  'auth.emptyNick': '昵称不能为空',
  'auth.failed': '登录失败',
  'auth.loginFailed': '登录失败：',
  'auth.autoLoginFailed': '自动登录失败：',
  'auth.initFailed': '初始化会话失败：',
  'auth.kicked': '会话已失效，请重新登录',
  'list.header': '会话',
  'list.empty': '暂无会话',
  'logout': '退出',
  'back': '← 返回',
  'chat.empty': '选择一个会话',
  'chat.pick': '选择一个会话',
  'composer.placeholder': '输入消息，Enter 发送',
  'send': '发送',
  'recall': '撤回',
  'recall.confirm': '撤回这条消息？',
  'recalled': '[消息已撤回]',
  'sendFailed': '发送失败',
  'connecting': '正在连接…',
  'reconnecting': '连接已断开，正在重连…',
  'disconnected': '连接已断开',
  'group': '群聊',
  'imageAttach': '图片',
  'imageSending': '[图片发送中]',
  'imageFailed': '[图片发送失败]',
  'imageLabel': '[图片]',
  'unreadBadge': '未读',
};

const EN: Messages = {
  'brand': 'yimsg',
  'auth.login': 'Sign in',
  'auth.register': 'Sign up',
  'auth.username': 'Username',
  'auth.password': 'Password',
  'auth.nickname': 'Nickname',
  'auth.submit.login': 'Sign in',
  'auth.submit.register': 'Create account',
  'auth.emptyCreds': 'Username and password are required',
  'auth.emptyNick': 'Nickname is required',
  'auth.failed': 'Sign-in failed',
  'auth.loginFailed': 'Sign-in failed: ',
  'auth.autoLoginFailed': 'Auto sign-in failed: ',
  'auth.initFailed': 'Session init failed: ',
  'auth.kicked': 'Session expired, please sign in again',
  'list.header': 'Conversations',
  'list.empty': 'No conversations yet',
  'logout': 'Sign out',
  'back': '← Back',
  'chat.empty': 'Pick a conversation',
  'chat.pick': 'Pick a conversation',
  'composer.placeholder': 'Type a message, press Enter to send',
  'send': 'Send',
  'recall': 'Recall',
  'recall.confirm': 'Recall this message?',
  'recalled': '[message recalled]',
  'sendFailed': 'Send failed',
  'connecting': 'Connecting…',
  'reconnecting': 'Connection lost, reconnecting…',
  'disconnected': 'Disconnected',
  'group': 'Group',
  'imageAttach': 'Image',
  'imageSending': '[sending image]',
  'imageFailed': '[image send failed]',
  'imageLabel': '[image]',
  'unreadBadge': 'unread',
};

const BUILTIN: Record<LocaleCode, Messages> = {
  'zh-CN': ZH,
  'en': EN,
};

export type LocaleOption = LocaleCode | 'auto';

/** 根据 navigator.language 推断地区；在非浏览器环境回退 zh-CN。 */
export function detectLocale(): LocaleCode {
  if (typeof navigator === 'undefined') return 'zh-CN';
  const lang = (navigator.language || 'zh-CN').toLowerCase();
  if (lang.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export class Translator {
  private table: Messages;
  private locale: LocaleCode;

  constructor(option: LocaleOption = 'auto', overrides?: Partial<Messages>) {
    this.locale = option === 'auto' ? detectLocale() : option;
    this.table = { ...BUILTIN[this.locale], ...(overrides ?? {}) };
  }

  setLocale(option: LocaleOption, overrides?: Partial<Messages>): void {
    this.locale = option === 'auto' ? detectLocale() : option;
    this.table = { ...BUILTIN[this.locale], ...(overrides ?? {}) };
  }

  getLocale(): LocaleCode {
    return this.locale;
  }

  t(key: keyof Messages): string {
    return this.table[key] ?? String(key);
  }
}
