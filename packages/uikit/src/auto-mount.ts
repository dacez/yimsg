/**
 * 一行脚本自动挂载。
 *
 * 目标是把第三方站点的接入成本压到最低：宿主页放一个 `<script>` 标签和一个容器
 * 元素，不写任何 JavaScript。
 *
 * ```html
 * <div data-yimsg-widget style="height:640px"></div>
 * <script src="https://im.example.com/uikit/yimsg-uikit.iife.js" data-yimsg-auto></script>
 * ```
 *
 * 服务端地址从 `document.currentScript.src` 推导——脚本从哪个源加载，服务端就是
 * 那个源，宿主连 `serverUrl` 都不用填。这里刻意不使用模块自身的 `import.meta`
 * 地址：IIFE 产物里它为空，而自动挂载恰恰只服务于 classic script。
 *
 * ESM 加载路径下 `document.currentScript` 为 null，本模块静默跳过——那条路径的
 * 使用者会自己调用 `mount()`。
 */

import { mount } from './embed';
import type { MountHandle, MountOptions } from './options';
import type { LocaleOption } from './i18n';
import type { ThemeOption } from './theme';
import type { UIKitViewMode } from './options';

/** 宿主用来声明「请自动挂载」的属性。缺少它时本模块什么都不做。 */
const AUTO_ATTR = 'data-yimsg-auto';

/** 未显式指定选择器时的默认容器。 */
const DEFAULT_TARGET_SELECTOR = '[data-yimsg-widget]';

/**
 * 捕获当前脚本元素。
 *
 * `document.currentScript` 只在脚本同步执行期间有效，因此必须在模块顶层立即读取，
 * 不能推迟到 DOMContentLoaded 之类的回调里。
 *
 * 两个 `typeof` 守卫缺一不可：Node / SSR 下没有 `document`，测试桩环境里可能有
 * `document` 却没有 `HTMLScriptElement`，直接 `instanceof` 会抛 ReferenceError。
 */
const currentScript: HTMLScriptElement | null =
  typeof document !== 'undefined' &&
  typeof HTMLScriptElement !== 'undefined' &&
  document.currentScript instanceof HTMLScriptElement
    ? document.currentScript
    : null;

/**
 * 从 bundle 地址推导服务端根地址：去掉末尾的 `/uikit/<文件名>`。
 *
 * `https://im.example.com/uikit/yimsg-uikit.iife.js` → `https://im.example.com`
 * `https://host/yimsg/uikit/yimsg-uikit.iife.js`     → `https://host/yimsg`
 *
 * 地址无法解析时返回空串，调用方据此回退到同源默认行为。
 */
export function deriveServerUrlFromScriptSrc(src: string): string {
  const trimmed = (src ?? '').trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  // 末尾两段固定是 uikit/<文件名>；不是这个形状时按「同目录即根」保守处理。
  if (segments.length >= 2 && segments[segments.length - 2] === 'uikit') {
    segments.splice(segments.length - 2, 2);
  } else {
    segments.pop();
  }
  const basePath = segments.length > 0 ? `/${segments.join('/')}` : '';
  return `${parsed.origin}${basePath}`;
}

/** 把 `data-yimsg-*` 属性读成一个普通字符串，空值统一成 undefined。 */
function readAttr(script: HTMLScriptElement, name: string): string | undefined {
  const value = script.getAttribute(`data-yimsg-${name}`);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 把脚本标签上的 `data-yimsg-*` 翻译成 MountOptions。 */
export function readMountOptionsFromScript(script: HTMLScriptElement): MountOptions {
  const explicitServerUrl = readAttr(script, 'server-url');
  const serverUrl = explicitServerUrl ?? deriveServerUrlFromScriptSrc(script.src);
  const options: {
    serverUrl?: string;
    token?: string;
    theme?: ThemeOption;
    locale?: LocaleOption;
    layout?: MountOptions['layout'];
    viewMode?: UIKitViewMode;
  } = {};

  if (serverUrl) options.serverUrl = serverUrl;
  const token = readAttr(script, 'token');
  if (token) options.token = token;
  const theme = readAttr(script, 'theme');
  if (theme) options.theme = theme as ThemeOption;
  const locale = readAttr(script, 'locale');
  if (locale) options.locale = locale as LocaleOption;
  const layout = readAttr(script, 'layout');
  if (layout === 'desktop' || layout === 'mobile' || layout === 'auto') options.layout = layout;
  const viewMode = readAttr(script, 'view-mode');
  if (viewMode === 'full' || viewMode === 'chat-only' || viewMode === 'contacts-only') {
    options.viewMode = viewMode;
  }
  return options;
}

/** 解析要挂载的容器集合。 */
function resolveHosts(script: HTMLScriptElement): HTMLElement[] {
  const selector = readAttr(script, 'target') ?? DEFAULT_TARGET_SELECTOR;
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

/**
 * 按脚本标签上的声明挂载。返回句柄数组，供调用方（含测试）检查结果。
 *
 * 找不到容器时不挂载、不抛错，也不擅自往宿主页插入元素——嵌入方的 DOM 不归我们支配。
 */
export function autoMountFromScript(script: HTMLScriptElement): MountHandle[] {
  if (!script.hasAttribute(AUTO_ATTR)) return [];

  const hosts = resolveHosts(script);
  if (hosts.length === 0) {
    console.warn(
      `[yimsg/uikit] ${AUTO_ATTR} 已声明，但没有找到容器元素（默认查找 ${DEFAULT_TARGET_SELECTOR}，可用 data-yimsg-target 指定选择器）`,
    );
    return [];
  }

  const options = readMountOptionsFromScript(script);
  const handles: MountHandle[] = [];
  for (const host of hosts) {
    try {
      handles.push(mount(host, options));
    } catch (error) {
      console.error('[yimsg/uikit] 自动挂载失败', error);
    }
  }
  return handles;
}

/**
 * 模块加载时的入口：只有 classic script 且声明了 `data-yimsg-auto` 才会真正挂载。
 * DOM 尚未就绪（脚本放在 `<head>`）时推迟到 `DOMContentLoaded`。
 */
export function runAutoMount(): void {
  if (!currentScript || !currentScript.hasAttribute(AUTO_ATTR)) return;
  const script = currentScript;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoMountFromScript(script), { once: true });
    return;
  }
  autoMountFromScript(script);
}
