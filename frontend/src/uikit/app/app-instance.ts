import {
  YimsgClient,
  type AuthenticatedEvent,
  type ConversationDescriptor,
  type ConversationTarget,
  type Contact,
  type LocalConversation,
  type Message,
  type MsgType,
} from '../../sdk';
import type { LocaleOption, Messages } from '../i18n';
import type { UIKitMode, UIKitViewMode, WidgetEvents } from '../options';
import type { LayoutChoice } from './session-storage';
import { detectLocale } from '../i18n';
import { translations, type Lang } from './i18n';
import { APP_CONFIG } from '../../app-config';
import { BoundedPageWindow } from './bounded-page-window';
import { conversationIdentity, contactIdentity } from './list-identity';
import { createMessageWindow } from './views/chat/message-page';
import { escapeHtml, normalizeTrustedResourceUrl } from './safe-dom';
import {
  StorageScope,
  createBrowserStorage,
  createSeededStorage,
  type StorageAdapter,
} from './storage-base';

function resolveAppLang(option: LocaleOption | undefined): Lang {
  if (!option || option === 'auto') return detectLocale() === 'en' ? 'en' : 'zh';
  return option === 'en' ? 'en' : 'zh';
}

interface AppRuntimeHooks {
  readonly onReady?: (client: YimsgClient) => void;
  readonly onAuthenticated?: WidgetEvents['authenticated'];
  readonly onLogout?: WidgetEvents['logout'];
  readonly onMessages?: WidgetEvents['messages'];
  readonly onConversationOpen?: WidgetEvents['conversation:open'];
  readonly onError?: WidgetEvents['error'];
}

interface AppRuntimeContext {
  readonly embedded: boolean;
  readonly requestedMode?: UIKitMode;
  readonly viewMode?: UIKitViewMode;
  readonly initialToken?: string;
  readonly getInitialToken?: () => string | null | undefined | Promise<string | null | undefined>;
  readonly initialLayout?: LayoutChoice;
  readonly instanceId: string;
  readonly hooks: AppRuntimeHooks;
}

interface ChatState {
  currentConvKey: string | null;
  currentConversation: LocalConversation | null;
  /** 会话列表有界滑动窗口：按页边界游标记账，双向翻页。 */
  conversationWindow: BoundedPageWindow<LocalConversation>;
  /** 背景刷新被推迟（用户不在列表顶部）时点亮"列表有更新"提示。 */
  conversationListStale: boolean;
  conversationTotalUnreadCount: number;
  conversationPageLoaded: boolean;
  conversationPageLoading: boolean;
  conversationPageRequestId: number;
  /** 消息有界滑动窗口；currentMessages 是它 flatten 后的同步投影。 */
  messageWindow: BoundedPageWindow<Message>;
  currentMessages: Message[];
  loadingMoreMessages: boolean;
  loadingNewerMessages: boolean;
  messagePageHasOlder: boolean;
  messagePageHasNewer: boolean;
  messagePageRequestId: number;
  pendingNewMessageCount: number;
  composerQuote: {
    msgId: string;
    fromUid: string;
    fromName: string;
    msgType: MsgType;
    preview: string;
    target: ConversationTarget | null;
  } | null;
  messageActionMenu: HTMLDivElement | null;
  messageSelectionMode: boolean;
  selectedMessageIds: Set<string>;
  expandedQuoteMessageIds: Set<string>;
  loadContactsFn: (() => void) | null;
  renderSettingsFn: (() => void) | null;
  detailRequestId: number;
  detailOpen: boolean;
  forwardSelectionHandler: (() => Promise<void> | void) | null;
}

interface ContactsViewState {
  /** 好友列表有界滑动窗口：按页边界游标记账，双向翻页。 */
  friendWindow: BoundedPageWindow<Contact>;
  friendPageLoaded: boolean;
  friendPageLoading: boolean;
  friendPageRequestId: number;
  contactsLoading: boolean;
  /** 好友请求列表有界滑动窗口：只装待我处理的请求（PENDING_INCOMING），驱动接受/拒绝与红点。 */
  requestWindow: BoundedPageWindow<Contact>;
  requestPageLoaded: boolean;
  requestPageLoading: boolean;
  requestPageRequestId: number;
  /** 我发出的待处理请求（PENDING_OUTGOING）：仅信息展示，不可操作，reset 时整批重拉，不做滚动分页。 */
  outgoingRequests: readonly Contact[];
  outgoingRequestsLoaded: boolean;
}

interface AppViews {
  auth: {
    setupAuth(): void;
    authenticate(token: string): Promise<void>;
    ensureInitialModeSelection(): Promise<void>;
    showAuthView(): void;
    showAppView(): void;
    handleSessionKicked(): void;
  };
  chat: {
    setupChat(): void;
    renderConversationList(options?: { force?: boolean; toTop?: boolean; keys?: ReadonlyArray<string> }): void;
    refreshConversations(keys: string[]): Promise<void>;
    removeMessage(messageId: string): void;
    renderMessages(): void;
    scrollToBottom(): void;
    openConversation(target: unknown): Promise<void>;
    refreshDetailPanel(): void;
    rerenderCurrentDetailPanel(): void;
    refreshOpenConversation(): Promise<void>;
    refreshChatHeader(): void;
    applyConversationGuards(): void;
    registerViewCallbacks(loadContacts: () => void, renderSettings: () => void): void;
    startDMFromContact(uid: string): void;
    switchView(name: string): void;
    getCurrentConvKey(): string | null;
  };
  contacts: {
    setupContacts(): void;
    loadContacts(options?: { background?: boolean }): Promise<void>;
    refreshContactsDisplay(): void;
    updateContactBadges(pendingCount: number): void;
    refreshOrgPanel(orgIds: ReadonlyArray<string>): void;
  };
  settings: {
    setupSettings(): void;
    renderSettings(): void;
  };
  sessionPreferences: {
    isUserBlocked(uid: string): Promise<boolean>;
    isMuted(target: ConversationTarget | { toUid?: string; groupId?: string }): Promise<boolean>;
  };
}

export class AppStorageScope extends StorageScope {}

export class AppDomScope {
  constructor(
    public readonly root: Document | ShadowRoot,
    public readonly ownerDocument: Document,
    public readonly layoutHost: HTMLElement,
    public readonly floatingRoot: HTMLElement,
    public readonly langHost: HTMLElement,
    public readonly viewportHost: HTMLElement,
  ) {}

  getElementById<T extends HTMLElement = HTMLElement>(id: string): T | null {
    if ('getElementById' in this.root && typeof this.root.getElementById === 'function') {
      return this.root.getElementById(id) as T | null;
    }
    return this.root.querySelector<T>(`#${id}`);
  }

  querySelector<T extends Element = Element>(selector: string): T | null {
    return this.root.querySelector<T>(selector);
  }

  querySelectorAll<T extends Element = Element>(selector: string): T[] {
    return Array.from(this.root.querySelectorAll<T>(selector));
  }
}

interface AppInstanceOptions {
  readonly client?: YimsgClient;
  readonly storageAdapter?: StorageAdapter;
  readonly dom: AppDomScope;
  readonly runtime: AppRuntimeContext;
  readonly locale?: LocaleOption;
  readonly messages?: Partial<Messages>;
}

export class AppInstance {
  readonly client: YimsgClient;
  readonly ownsClient: boolean;
  readonly dom: AppDomScope;
  readonly runtime: AppRuntimeContext;
  readonly storage: AppStorageScope;
  readonly chatState: ChatState = {
    currentConvKey: null,
    currentConversation: null,
    conversationWindow: new BoundedPageWindow<LocalConversation>(
      APP_CONFIG.list.maxPages,
      undefined,
      conversationIdentity,
    ),
    conversationListStale: false,
    conversationTotalUnreadCount: 0,
    conversationPageLoaded: false,
    conversationPageLoading: false,
    conversationPageRequestId: 0,
    messageWindow: createMessageWindow(APP_CONFIG.chat.messagePageMaxPages),
    currentMessages: [],
    loadingMoreMessages: false,
    loadingNewerMessages: false,
    messagePageHasOlder: false,
    messagePageHasNewer: false,
    messagePageRequestId: 0,
    pendingNewMessageCount: 0,
    composerQuote: null,
    messageActionMenu: null,
    messageSelectionMode: false,
    selectedMessageIds: new Set<string>(),
    expandedQuoteMessageIds: new Set<string>(),
    loadContactsFn: null,
    renderSettingsFn: null,
    detailRequestId: 0,
    detailOpen: false,
    forwardSelectionHandler: null,
  };
  readonly contactsState: ContactsViewState = {
    friendWindow: new BoundedPageWindow<Contact>(APP_CONFIG.list.maxPages, undefined, contactIdentity),
    friendPageLoaded: false,
    friendPageLoading: false,
    friendPageRequestId: 0,
    contactsLoading: false,
    requestWindow: new BoundedPageWindow<Contact>(APP_CONFIG.list.maxPages, undefined, contactIdentity),
    requestPageLoaded: false,
    requestPageLoading: false,
    requestPageRequestId: 0,
    outgoingRequests: [],
    outgoingRequestsLoaded: false,
  };
  readonly views: Partial<AppViews> = {};
  private readonly disposers: Array<() => void> = [];
  private lang: Lang;
  private overrides: Partial<Record<string, string>>;

  constructor(options: AppInstanceOptions) {
    this.ownsClient = !options.client;
    this.client = options.client ?? new YimsgClient();
    this.dom = options.dom;
    this.runtime = options.runtime;
    this.storage = new AppStorageScope(options.storageAdapter ?? createBrowserStorage());
    this.lang = options.locale === undefined
      ? this.storage.getStoredLang()
      : resolveAppLang(options.locale);
    this.overrides = options.messages as Partial<Record<string, string>> ?? {};
    this.storage.setStoredLang(this.lang);
    this.dom.langHost.lang = this.lang === 'zh' ? 'zh-CN' : 'en';
  }

  registerDisposer(disposer: () => void): void {
    this.disposers.push(disposer);
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) {
      dispose();
    }
  }

  $(id: string): HTMLElement {
    const el = this.dom.getElementById(id);
    if (!el) throw new Error(`[yimsg/uikit] element not found: #${id}`);
    return el;
  }

  escapeHtml(str: string | undefined | null): string {
    return escapeHtml(str);
  }

  showToast(text: string, type?: string): void {
    const container = this.$('toast-container');
    const toast = this.dom.ownerDocument.createElement('div');
    toast.className = 'toast toast-' + (type || '');
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  showStatus(text: string, cls: string): void {
    const bar = this.$('status-bar');
    bar.textContent = text;
    bar.className = 'status-bar ' + cls;
  }

  hideStatus(): void {
    this.$('status-bar').className = 'status-bar hidden';
  }

  closeModal(): void {
    this.$('modal-overlay').classList.add('hidden');
  }

  async showTextInputModal(options: {
    title: string;
    label?: string;
    placeholder?: string;
    initialValue?: string;
    confirmText: string;
    cancelText: string;
    multiline?: boolean;
    readOnly?: boolean;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = this.$('modal-content');
      const fieldHtml = options.multiline
        ? `<textarea class="input modal-textarea" id="modal-text-input" placeholder="${this.escapeHtml(options.placeholder || '')}" ${options.readOnly ? 'readonly' : ''}>${this.escapeHtml(options.initialValue || '')}</textarea>`
        : `<input class="input" type="text" id="modal-text-input" placeholder="${this.escapeHtml(options.placeholder || '')}" value="${this.escapeHtml(options.initialValue || '')}" ${options.readOnly ? 'readonly' : ''}>`;
      modal.innerHTML = `
        <div class="modal-title">${this.escapeHtml(options.title)}</div>
        ${options.label ? `<div class="form-group"><label>${this.escapeHtml(options.label)}</label>` : '<div class="form-group">'}
          ${fieldHtml}
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modal-cancel-btn">${this.escapeHtml(options.cancelText)}</button>
          <button class="btn btn-primary" id="modal-confirm-btn">${this.escapeHtml(options.confirmText)}</button>
        </div>
      `;
      this.$('modal-overlay').classList.remove('hidden');
      const input = this.$('modal-text-input') as HTMLInputElement | HTMLTextAreaElement;
      input.focus();
      input.select();

      const finish = (value: string | null) => {
        this.closeModal();
        resolve(value);
      };

      this.$('modal-cancel-btn').addEventListener('click', () => finish(null));
      this.$('modal-confirm-btn').addEventListener('click', () => finish(input.value.trim()));
      input.addEventListener('keydown', (e) => {
        if (options.multiline) return;
        if ((e as KeyboardEvent).key === 'Enter') finish(input.value.trim());
      });
    });
  }

  async showConfirmModal(options: {
    title: string;
    desc?: string;
    confirmText: string;
    cancelText: string;
    danger?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = this.$('modal-content');
      modal.innerHTML = `
        <div class="modal-title">${this.escapeHtml(options.title)}</div>
        ${options.desc ? `<p class="modal-desc">${this.escapeHtml(options.desc)}</p>` : ''}
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modal-cancel-btn">${this.escapeHtml(options.cancelText)}</button>
          <button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" id="modal-confirm-btn">${this.escapeHtml(options.confirmText)}</button>
        </div>
      `;
      this.$('modal-overlay').classList.remove('hidden');

      const finish = (value: boolean) => {
        this.closeModal();
        resolve(value);
      };

      this.$('modal-cancel-btn').addEventListener('click', () => finish(false));
      this.$('modal-confirm-btn').addEventListener('click', () => finish(true));
    });
  }

  avatarInnerHtml(display: { avatar?: string; nickname: string }): string {
    const avatar = normalizeTrustedResourceUrl(display.avatar);
    if (avatar) {
      return `<img src="${this.escapeHtml(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover">`;
    }
    return this.escapeHtml((display.nickname || '?')[0]);
  }

  setNavBadge(selector: string, visible: boolean): void {
    const nav = this.dom.querySelector<HTMLElement>(selector);
    if (!nav) return;
    nav.querySelector('.nav-badge')?.remove();
    if (visible) {
      const dot = this.dom.ownerDocument.createElement('span');
      dot.className = 'nav-badge';
      nav.appendChild(dot);
    }
  }

  appendFloatingElement(element: HTMLElement): void {
    this.dom.floatingRoot.appendChild(element);
  }

  getLang(): Lang {
    return this.lang;
  }

  setLang(lang: Lang, overrides?: Partial<Messages>): void {
    this.lang = lang;
    this.overrides = overrides as Partial<Record<string, string>> ?? {};
    this.storage.setStoredLang(lang);
    this.dom.langHost.lang = lang === 'zh' ? 'zh-CN' : 'en';
    this.applyStaticTranslations();
  }

  t(key: string, vars?: Record<string, string | number>): string {
    const dict = translations[this.lang] as Record<string, string>;
    let text = this.overrides[key] ?? dict[key] ?? (translations.en as Record<string, string>)[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  }

  applyStaticTranslations(): void {
    const loginTab = this.dom.querySelector<HTMLElement>('.tab[data-tab="login"]');
    if (loginTab) loginTab.textContent = this.t('auth.login');
    const registerTab = this.dom.querySelector<HTMLElement>('.tab[data-tab="register"]');
    if (registerTab) registerTab.textContent = this.t('auth.register');

    const loginUsername = this.dom.getElementById<HTMLInputElement>('login-username');
    if (loginUsername) loginUsername.placeholder = this.t('auth.username');
    const loginPassword = this.dom.getElementById<HTMLInputElement>('login-password');
    if (loginPassword) loginPassword.placeholder = this.t('auth.password');
    const loginSubmit = this.dom.querySelector<HTMLElement>('#login-form button[type="submit"]');
    if (loginSubmit) loginSubmit.textContent = this.t('auth.login');

    const regUsername = this.dom.getElementById<HTMLInputElement>('reg-username');
    if (regUsername) regUsername.placeholder = this.t('auth.username');
    const regPassword = this.dom.getElementById<HTMLInputElement>('reg-password');
    if (regPassword) regPassword.placeholder = this.t('auth.password');
    const regNickname = this.dom.getElementById<HTMLInputElement>('reg-nickname');
    if (regNickname) regNickname.placeholder = this.t('auth.nickname');
    const regSubmit = this.dom.querySelector<HTMLElement>('#register-form button[type="submit"]');
    if (regSubmit) regSubmit.textContent = this.t('auth.register');

    const navChat = this.dom.querySelector<HTMLElement>('.nav-item[data-view="chat"]');
    if (navChat) navChat.title = this.t('nav.chat');
    const navContacts = this.dom.querySelector<HTMLElement>('.nav-item[data-view="contacts"]');
    if (navContacts) navContacts.title = this.t('nav.contacts');
    const navSettings = this.dom.querySelector<HTMLElement>('.nav-item[data-view="settings"]');
    if (navSettings) navSettings.title = this.t('nav.settings');

    const chatEmpty = this.dom.getElementById('chat-empty');
    if (chatEmpty) chatEmpty.textContent = this.t('chat.selectConversation');
    const msgInput = this.dom.getElementById<HTMLInputElement>('msg-input');
    if (msgInput) msgInput.placeholder = this.t('chat.typeMessage');
    const msgSend = this.dom.getElementById('msg-send');
    if (msgSend) msgSend.textContent = this.t('chat.send');
    const toggleDetail = this.dom.getElementById('toggle-detail');
    if (toggleDetail) toggleDetail.title = this.t('chat.details');
    const detailMobileBack = this.dom.getElementById('detail-mobile-back');
    if (detailMobileBack) detailMobileBack.textContent = `← ${this.t('auth.mobileBack')}`;
    const msgAttach = this.dom.getElementById('msg-attach');
    if (msgAttach) msgAttach.title = this.t('chat.attachFile');
    const msgEmoji = this.dom.getElementById('msg-emoji');
    if (msgEmoji) msgEmoji.title = this.t('chat.emoji');

    const friendsTab = this.dom.querySelector<HTMLElement>('.tab[data-ctab="friends"]');
    if (friendsTab) friendsTab.textContent = this.t('contacts.friends');
    const searchTab = this.dom.querySelector<HTMLElement>('.tab[data-ctab="search"]');
    if (searchTab) searchTab.textContent = this.t('contacts.search');
    const searchUsername = this.dom.getElementById<HTMLInputElement>('search-username');
    if (searchUsername) searchUsername.placeholder = this.t('contacts.enterUsername');
    const searchBtn = this.dom.getElementById('search-btn');
    if (searchBtn) searchBtn.textContent = this.t('contacts.searchBtn');
    const createGroupBtn = this.dom.getElementById('create-group-btn');
    if (createGroupBtn) createGroupBtn.textContent = this.t('contacts.createGroup');
    const createOrgBtn = this.dom.getElementById('create-org-btn');
    if (createOrgBtn) createOrgBtn.textContent = this.t('contacts.createOrg');

    const settingsProfileTitle = this.dom.getElementById('settings-profile-title');
    if (settingsProfileTitle) settingsProfileTitle.textContent = this.t('settings.profile');
    const settingsPasswordTitle = this.dom.getElementById('settings-password-title');
    if (settingsPasswordTitle) settingsPasswordTitle.textContent = this.t('settings.password');
    const settingsLanguageTitle = this.dom.getElementById('settings-language-title');
    if (settingsLanguageTitle) settingsLanguageTitle.textContent = this.t('settings.language');
    const settingsStorageTitle = this.dom.getElementById('settings-storage-title');
    if (settingsStorageTitle) settingsStorageTitle.textContent = this.t('settings.storage');
    const settingsStorageDesc = this.dom.getElementById('settings-storage-desc');
    if (settingsStorageDesc) settingsStorageDesc.textContent = this.t('settings.storageDesc');
    const clearDataBtn = this.dom.getElementById('clear-data-btn');
    if (clearDataBtn) clearDataBtn.textContent = this.t('settings.clearData');
    const editNickname = this.dom.getElementById<HTMLInputElement>('edit-nickname');
    if (editNickname) editNickname.placeholder = this.t('settings.nickname');
    const saveProfileBtn = this.dom.getElementById('save-profile-btn');
    if (saveProfileBtn) saveProfileBtn.textContent = this.t('settings.save');
    const oldPassword = this.dom.getElementById<HTMLInputElement>('old-password');
    if (oldPassword) oldPassword.placeholder = this.t('settings.oldPassword');
    const newPassword = this.dom.getElementById<HTMLInputElement>('new-password');
    if (newPassword) newPassword.placeholder = this.t('settings.newPassword');
    const changePwdBtn = this.dom.getElementById('change-pwd-btn');
    if (changePwdBtn) changePwdBtn.textContent = this.t('settings.change');
    const logoutBtn = this.dom.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.textContent = this.t('settings.logout');
    const settingsAvatar = this.dom.getElementById('settings-avatar');
    if (settingsAvatar) settingsAvatar.title = this.t('settings.clickToChangeAvatar');

    const langEnBtn = this.dom.getElementById('lang-en-btn');
    const langZhBtn = this.dom.getElementById('lang-zh-btn');
    if (langEnBtn) langEnBtn.classList.toggle('btn-primary', this.lang === 'en');
    if (langEnBtn) langEnBtn.classList.toggle('btn-secondary', this.lang !== 'en');
    if (langZhBtn) langZhBtn.classList.toggle('btn-primary', this.lang === 'zh');
    if (langZhBtn) langZhBtn.classList.toggle('btn-secondary', this.lang !== 'zh');
  }

  emitReady(): void {
    this.runtime.hooks.onReady?.(this.client);
  }

  emitAuthenticated(info: { token: string; uid: string; event: AuthenticatedEvent }): void {
    this.runtime.hooks.onAuthenticated?.(info);
  }

  emitLogout(): void {
    this.runtime.hooks.onLogout?.();
  }

  emitMessages(messages: readonly Message[]): void {
    this.runtime.hooks.onMessages?.(messages);
  }

  emitConversationOpen(descriptor: ConversationDescriptor): void {
    this.runtime.hooks.onConversationOpen?.(descriptor);
  }

  emitAppError(error: Error, context: string): void {
    this.runtime.hooks.onError?.(error, context);
  }
}

export function createEmbeddedStorage(initial: Partial<Record<string, string>> = {}): StorageAdapter {
  return createSeededStorage(initial);
}

export function createMainDomScope(doc: Document): AppDomScope {
  return new AppDomScope(doc, doc, doc.body, doc.body, doc.documentElement, doc.body);
}
