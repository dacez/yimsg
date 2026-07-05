/**
 * uikit 对外挂载参数类型与规范化。
 *
 * 本模块只做类型与默认值处理：
 * - 容器可以是 HTMLElement，也可以是 CSS 选择器；
 * - `theme` / `locale` 等参数规范成内部形态；
 * - 所有回调字段可选。
 *
 * `MountHandle` 作为对外契约同样在此定义，保持一个文件一个清晰职责。
 */

import type {
  ClientOptions,
  YimsgClient,
  Message,
  ConversationDescriptor,
  AuthenticatedEvent,
} from '../sdk';
import type { LocaleOption, Messages } from './i18n';
import type { ThemeOption } from './theme';

/** mount 可接收的容器：直接的元素或 CSS 选择器。 */
export type MountTarget = HTMLElement | string;

/**
 * UIKit 存储模式。
 * - `memory`：纯内存 DataGateway，不落盘，刷新即丢失；所有环境都可用。
 * - `persistent`：请求持久化会话，具体本地存储实现由 SDK 内部决定。
 * - `persistent-cleardata`：先请求重置当前用户本地会话数据，再按持久化会话启动。
 *   用户切换账号或希望从干净状态启动时使用；若当前环境不可持久化会自动降级为 `memory`。
 */
export type UIKitMode = 'memory' | 'persistent' | 'persistent-cleardata';

/** 宿主传入的装载参数。 */
export interface MountOptions extends Pick<ClientOptions, 'wsUrl' | 'uploadUrl' | 'requestTimeout' | 'reconnectInterval' | 'heartbeatInterval' | 'recallWindowSeconds'> {
  /** 当前挂载实例的唯一标识；用于 memory/persistent 状态与 持久存储 dbName 隔离。 */
  readonly instanceId?: string;
  /** 宿主已持有的 token（SSO 场景），widget 会自动 authenticate。 */
  readonly token?: string;
  /** 异步 token 提供者，widget 在挂载时调用一次；返回空字符串视为无 token。 */
  readonly getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** 复用宿主已有的 client 实例；若已 ready 则跳过登录页。 */
  readonly client?: YimsgClient;
  /** 强制布局；默认根据容器宽度自动选择。 */
  readonly layout?: 'desktop' | 'mobile' | 'auto';
  /**
  * 存储模式，默认 `memory`。
   *
  * - `memory`：内存 DataGateway，始终可用；
  * - `persistent`：请求持久化会话；不可用时自动降级为 `memory` 并通过 `onError` 通知宿主；
  * - `persistent-cleardata`：先重置当前用户本地会话数据，再按持久化会话启动；不可用时降级为 `memory`。
   *
   * 当宿主通过 `client` 传入已经 ready 的实例时，UIKit 不会再次初始化，此参数不生效。
   */
  readonly mode?: UIKitMode;
  /** 主题。默认 `auto`（跟随系统 prefers-color-scheme）。 */
  readonly theme?: ThemeOption;
  /** 语言。默认 `auto`（跟随 `navigator.language`）。 */
  readonly locale?: LocaleOption;
  /** 覆盖内置文案；按 key 合并。 */
  readonly messages?: Partial<Messages>;
  /** widget 挂载且事件绑定完成时调用；此时用户可能还未登录。 */
  readonly onReady?: (client: YimsgClient) => void;
  /** 登录 / 鉴权成功后回调（含 token），用于宿主保存 token 或做埋点。 */
  readonly onAuthenticated?: (info: { token: string; uid: string; event: AuthenticatedEvent }) => void;
  /** 用户主动登出或被踢后调用。 */
  readonly onLogout?: () => void;
  /** 新消息批次（包含自己发的与接收的）；一次 messages:received 合并的多条会一起回调。 */
  readonly onMessages?: (messages: readonly Message[]) => void;
  /** 用户在 UI 里打开某会话时触发。 */
  readonly onConversationOpen?: (descriptor: ConversationDescriptor) => void;
  /** 任何用户可见错误；可用于宿主埋点或展示 toast。 */
  readonly onError?: (error: Error, context: string) => void;
}

/** widget 对外暴露的句柄，用于程序化控制。 */
export interface MountHandle {
  /** 销毁 widget：清空 shadow root、解绑事件；若拥有 client 也会 logout。 */
  readonly unmount: () => void;
  /** 内部 SDK client；宿主可继续监听事件 / 调用业务方法。 */
  readonly client: YimsgClient;
  /** 容器内部的 shadow root，便于调试或测试。 */
  readonly shadowRoot: ShadowRoot;
  /** 运行期切换主题。 */
  readonly setTheme: (theme: ThemeOption) => void;
  /** 运行期切换语言与文案覆盖。 */
  readonly setLocale: (locale: LocaleOption, messages?: Partial<Messages>) => void;
  /** 打开指定会话；若不存在会保持原状。 */
  readonly openConversation: (target: { friendUid?: string; groupId?: string }) => Promise<void>;
  /** 以程序方式触发登出并回到认证页。 */
  readonly logout: () => Promise<void>;
  /** 监听 widget 级事件（与 SDK 事件相互独立）。 */
  readonly on: WidgetOn;
}

/** widget 级事件签名。 */
export interface WidgetEvents {
  'authenticated': (info: { token: string; uid: string; event: AuthenticatedEvent }) => void;
  'logout': () => void;
  'messages': (messages: readonly Message[]) => void;
  'conversation:open': (descriptor: ConversationDescriptor) => void;
  'error': (error: Error, context: string) => void;
}

export type WidgetOn = <K extends keyof WidgetEvents>(event: K, handler: WidgetEvents[K]) => () => void;

/** 把 target 解析为 HTMLElement，否则抛出清晰错误。 */
export function resolveContainer(target: MountTarget): HTMLElement {
  if (typeof target === 'string') {
    if (typeof document === 'undefined') {
      throw new Error('[yimsg/uikit] 无 DOM 环境，无法根据选择器查找容器');
    }
    const el = document.querySelector(target);
    if (!el) throw new Error(`[yimsg/uikit] 找不到容器：${target}`);
    if (!(el instanceof HTMLElement)) {
      throw new Error(`[yimsg/uikit] 选择器 ${target} 指向的不是 HTMLElement`);
    }
    return el;
  }
  if (!target || !(target instanceof HTMLElement)) {
    throw new Error('[yimsg/uikit] mount 需要一个 HTMLElement 或 CSS 选择器');
  }
  return target;
}
