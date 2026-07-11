import appCssText from './app/style.css?inline';
import { YimsgClient, type LocalConversation } from '../sdk';
import { startApp } from './app/main-app';
import { AppDomScope, AppInstance, createEmbeddedStorage } from './app/app-instance';
import { APP_SHELL_HTML, rewriteAppStylesForShadow } from './app/shell';
import { applyResolvedLayoutForApp } from './app/layout';
import { refreshVisibleViews } from './app/view-refresh';
import { resolveContainer, type MountHandle, type MountOptions, type MountTarget, type WidgetOn } from './options';
import {
  EMBEDDED_WIDGET_MIN_HEIGHT,
  EMBEDDED_WIDGET_MIN_WIDTH,
  isEmbeddedWidgetTooSmall,
  resolveResponsiveLayout,
} from './responsive-layout';
import { applyThemeVarsToElement, clearThemeVarsFromElement, resolveTheme, watchSystemTheme, type ThemeOption, type ThemeTokens } from './theme';

export { type MountOptions, type MountHandle, type MountTarget, type WidgetOn, type WidgetEvents, type UIKitMode, type UIKitViewMode } from './options';
export type { ThemeOption, ThemePreset, ThemeTokens } from './theme';
export type { LocaleOption, LocaleCode, Messages } from './i18n';

const APP_THEME_VAR_MAP = [
  ['--primary', 'primary'],
  ['--primary-hover', 'primaryHover'],
  ['--primary-light', 'primaryMuted'],
  ['--bg-page', 'background'],
  ['--bg-panel', 'surface'],
  ['--bg-hover', 'listBackground'],
  ['--bg-active', 'primaryMuted'],
  ['--text-primary', 'text'],
  ['--text-secondary', 'textMuted'],
  ['--text-placeholder', 'textMuted'],
  ['--border', 'border'],
  ['--bubble-self', 'bubbleSelf'],
  ['--bubble-other', 'bubbleOther'],
  ['--error', 'danger'],
  ['--font-family', 'fontFamily'],
  ['--font-size-body', 'fontSize'],
  ['--radius-lg', 'radius'],
  ['--radius-md', 'radius'],
  ['--radius-sm', 'radius'],
] as const satisfies ReadonlyArray<readonly [string, keyof ThemeTokens]>;

type Disposer = () => void;

class WidgetEventBus {
  private table = new Map<string, Set<(...args: unknown[]) => void>>();

  on<K extends Parameters<WidgetOn>[0]>(event: K, handler: Parameters<WidgetOn>[1]): Disposer {
    let set = this.table.get(event);
    if (!set) {
      set = new Set();
      this.table.set(event, set);
    }
    set.add(handler as (...args: unknown[]) => void);
    return () => set?.delete(handler as (...args: unknown[]) => void);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.table.get(event);
    if (!set) return;
    for (const handler of set) {
      try { handler(...args); } catch { /* ignore */ }
    }
  }

  clear(): void {
    this.table.clear();
  }
}

function parseCssPixels(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveHostSize(host: HTMLElement): { width: number; height: number } {
  const rect = host.getBoundingClientRect();
  const view = host.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(host);
  return {
    width: rect.width || host.clientWidth || parseCssPixels(computed?.width),
    height: rect.height || host.clientHeight || parseCssPixels(computed?.height),
  };
}

function resolveSizeGuardLocale(options: MountOptions, host: HTMLElement): 'zh-CN' | 'en' {
  if (options.locale === 'en' || options.locale === 'zh-CN') return options.locale;
  const language = host.ownerDocument.defaultView?.navigator.language?.toLowerCase() ?? '';
  return language.startsWith('en') ? 'en' : 'zh-CN';
}

function formatSizeGuardCopy(
  locale: 'zh-CN' | 'en',
  currentWidth: number,
  currentHeight: number,
): { title: string; body: string } {
  if (locale === 'en') {
    return {
      title: 'Container too small',
      body: `Current host size is ${currentWidth} x ${currentHeight} px. yimsg UIKit requires at least ${EMBEDDED_WIDGET_MIN_WIDTH} x ${EMBEDDED_WIDGET_MIN_HEIGHT} px to render completely. Enlarge the container and try again.`,
    };
  }

  return {
    title: '容器太小，无法完整显示',
    body: `当前宿主尺寸为 ${currentWidth} x ${currentHeight} px。yimsg UIKit 至少需要 ${EMBEDDED_WIDGET_MIN_WIDTH} x ${EMBEDDED_WIDGET_MIN_HEIGHT} px 才能完整显示，请放大容器后重试。`,
  };
}

function applyAppThemeVars(element: HTMLElement, theme: ReturnType<typeof resolveTheme>): void {
  for (const [cssVar, token] of APP_THEME_VAR_MAP) {
    element.style.setProperty(cssVar, theme.tokens[token]);
  }
}

function clearAppThemeVars(element: HTMLElement): void {
  for (const [cssVar] of APP_THEME_VAR_MAP) {
    element.style.removeProperty(cssVar);
  }
}

function findConversation(_client: YimsgClient, target: { friendUid?: string; groupId?: string }): LocalConversation | undefined {
  if (target.groupId) return { groupId: target.groupId, friendUid: '0', lastSeq: 0, lastMessage: null };
  if (target.friendUid) return { groupId: '0', friendUid: target.friendUid, lastSeq: 0, lastMessage: null };
  return undefined;
}

function resolveInstanceId(host: HTMLElement, options: MountOptions): string {
  if ('instanceId' in options && typeof (options as MountOptions & { instanceId?: string }).instanceId === 'string' && (options as MountOptions & { instanceId?: string }).instanceId) {
    return (options as MountOptions & { instanceId?: string }).instanceId!;
  }
  // 未显式指定、宿主也没有稳定 id 时固定回退为 'default'（与非嵌入式 app.ts 的槽位一致）：
  // persistent 模式下 DB 文件按 uid+instanceId 命名，回退值若每次 mount 都不同，会导致
  // 同一账号每次都对应一个新的空库，persistent 形同虚设。同页需要并发挂载多个独立持久化
  // 实例时（如 home-dashboard），调用方必须显式传各自不同的 instanceId。
  return host.id || 'default';
}

export function mount(container: MountTarget, options: MountOptions = {}): MountHandle {
  const host = resolveContainer(container);
  const ownerDocument = host.ownerDocument;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '';

  const ownsClient = !options.client;
  const client = options.client ?? new YimsgClient({
    wsUrl: options.wsUrl,
    uploadUrl: options.uploadUrl,
    requestTimeout: options.requestTimeout,
    reconnectInterval: options.reconnectInterval,
    reconnectNotifyThreshold: options.reconnectNotifyThreshold,
    heartbeatInterval: options.heartbeatInterval,
  });

  const eventBus = new WidgetEventBus();
  if (options.onAuthenticated) eventBus.on('authenticated', options.onAuthenticated as Parameters<WidgetOn>[1]);
  if (options.onLogout) eventBus.on('logout', options.onLogout as Parameters<WidgetOn>[1]);
  if (options.onMessages) eventBus.on('messages', options.onMessages as Parameters<WidgetOn>[1]);
  if (options.onConversationOpen) eventBus.on('conversation:open', options.onConversationOpen as Parameters<WidgetOn>[1]);
  if (options.onError) eventBus.on('error', options.onError as Parameters<WidgetOn>[1]);

  const requestedMode = options.mode ?? 'memory';
  const instanceId = resolveInstanceId(host, options);
  const storageAdapter = createEmbeddedStorage({
    mode: requestedMode === 'memory' ? 'memory' : 'persistent',
    layout: options.layout ?? 'auto',
    ...(options.token ? { token: options.token } : {}),
  });

  const styleEl = ownerDocument.createElement('style');
  styleEl.textContent = rewriteAppStylesForShadow(appCssText);
  shadow.appendChild(styleEl);

  const shellTemplate = ownerDocument.createElement('template');
  shellTemplate.innerHTML = APP_SHELL_HTML.trim();
  shadow.appendChild(shellTemplate.content.cloneNode(true));
  const appShell = shadow.querySelector<HTMLElement>('.mc-app-shell');
  if (!appShell) throw new Error('[yimsg/uikit] failed to create app shell');
  appShell.dataset.viewMode = options.viewMode ?? 'full';
  appShell.dataset.embedded = 'true';
  const sizeGuardTitle = shadow.querySelector<HTMLElement>('.mc-size-guard-title');
  const sizeGuardBody = shadow.querySelector<HTMLElement>('.mc-size-guard-body');

  let theme = resolveTheme(options.theme);
  applyThemeVarsToElement(host, theme);
  applyAppThemeVars(appShell, theme);

  const app = new AppInstance({
    client,
    storageAdapter,
    dom: new AppDomScope(shadow, ownerDocument, appShell, appShell, appShell, host),
    runtime: {
      embedded: true,
      requestedMode,
      viewMode: options.viewMode ?? 'full',
      initialToken: options.token,
      getInitialToken: options.getToken,
      initialLayout: options.layout,
      instanceId,
      hooks: {
        onReady: options.onReady,
        onAuthenticated: (info) => eventBus.emit('authenticated', info),
        onLogout: () => eventBus.emit('logout'),
        onMessages: (messages) => eventBus.emit('messages', messages),
        onConversationOpen: (descriptor) => eventBus.emit('conversation:open', descriptor),
        onError: (error, context) => eventBus.emit('error', error, context),
      },
    },
    locale: options.locale,
    messages: options.messages,
  });
  app.applyStaticTranslations();
  const disposeApp = startApp(app);

  const applyEmbeddedSizeState = (width: number, height: number) => {
    const tooSmall = isEmbeddedWidgetTooSmall({ width, height });
    appShell.dataset.sizeState = tooSmall ? 'too-small' : 'ready';
    if (!tooSmall) {
      if (sizeGuardTitle) sizeGuardTitle.textContent = '';
      if (sizeGuardBody) sizeGuardBody.textContent = '';
      return;
    }

    const locale = resolveSizeGuardLocale(options, host);
    const copy = formatSizeGuardCopy(locale, Math.round(width), Math.round(height));
    if (sizeGuardTitle) sizeGuardTitle.textContent = copy.title;
    if (sizeGuardBody) sizeGuardBody.textContent = copy.body;
  };

  const applyEmbeddedLayout = () => {
    const size = resolveHostSize(host);
    applyResolvedLayoutForApp(app, resolveResponsiveLayout(options.layout ?? 'auto', {
      width: size.width || undefined,
      innerWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
      matchMedia: typeof window !== 'undefined' ? window.matchMedia?.bind(window) : undefined,
    }));
    applyEmbeddedSizeState(size.width, size.height);
  };
  applyEmbeddedLayout();
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => applyEmbeddedLayout());
    resizeObserver.observe(host);
  }
  const stopThemeWatch = watchSystemTheme(() => {
    if (theme.preset !== 'auto') return;
    theme = resolveTheme(options.theme);
    applyThemeVarsToElement(host, theme);
    applyAppThemeVars(appShell, theme);
  });

  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    disposeApp();
    resizeObserver?.disconnect();
    stopThemeWatch();
    shadow.innerHTML = '';
    clearThemeVarsFromElement(host);
    clearAppThemeVars(appShell);
    eventBus.clear();
    if (ownsClient) {
      void client.logout().catch(() => undefined).finally(() => {
        client.destroy();
      });
    }
  };

  const on: WidgetOn = (event, handler) => eventBus.on(event, handler);

  return {
    client,
    shadowRoot: shadow,
    unmount: cleanup,
    setTheme: (nextTheme: ThemeOption) => {
      theme = resolveTheme(nextTheme);
      applyThemeVarsToElement(host, theme);
      applyAppThemeVars(appShell, theme);
    },
    setLocale: (locale, messages) => {
      app.setLang(locale === 'en' ? 'en' : 'zh', messages);
      refreshVisibleViews(app, {
        detail: 'rerender',
        settings: 'always',
        contacts: 'always',
      });
    },
    openConversation: async (target) => {
      if (target.friendUid) {
        app.views.chat?.startDMFromContact(target.friendUid);
        return;
      }
      const existing = findConversation(client, target);
      if (!existing) return;
      app.views.chat?.switchView('chat');
      await app.views.chat?.openConversation(existing);
    },
    logout: async () => {
      await client.logout();
      app.views.auth?.showAuthView();
      eventBus.emit('logout');
    },
    on,
  };
}
