import type { ConversationTarget } from '../../sdk';

export type AppViewName = 'chat' | 'contacts' | 'settings';

interface AppRoute {
  readonly view: AppViewName;
  readonly conversation?: ConversationTarget;
}

function decodeSegment(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRouteBody(parts: readonly string[]): AppRoute {
  const view = parts[0];
  if (view === 'contacts' || view === 'settings') return { view };
  if (view !== 'chat') return { view: 'chat' };

  const kind = parts[1];
  const id = decodeSegment(parts[2]);
  if (kind === 'u' && id) return { view: 'chat', conversation: { toUid: id } };
  if (kind === 'g' && id) return { view: 'chat', conversation: { groupId: id } };
  return { view: 'chat' };
}

/**
 * hash 路由的命名空间：独立主应用（页面上只有它自己）用 `null`，不加前缀，
 * 保持 `#/chat/u/:uid` 这类深链格式不变；嵌入式 widget 用自己的 `instanceId`，
 * hash 格式变为 `#/<instanceId>/chat/u/:uid`。
 *
 * 同一页面可以同时挂载多个 widget（如客服工作台一屏多开），它们共享同一个
 * 浏览器 `location`/`history`；不加命名空间隔离的话，任意一个 widget 触发的
 * `pushRoute` 都会被其它 widget 的 `hashchange` 监听器一起收到并误当成自己的
 * 路由执行，导致会话串号。
 */
export function routeNamespaceFor(runtime: { readonly embedded: boolean; readonly instanceId: string }): string | null {
  return runtime.embedded ? runtime.instanceId : null;
}

/**
 * 解析 hash 路由。`namespace` 为 `null` 时不做前缀匹配，直接解析整个 hash；
 * 为具体字符串时只认领 `#/<namespace>/...` 前缀下的路由，其它 hash（无前缀，
 * 或属于同页其它 widget 的 namespace）一律返回 `null`，表示这次 hash 变化
 * 不是发给当前实例的，调用方应忽略。
 */
export function parseRoute(hash: string | undefined | null, namespace: string | null): AppRoute | null {
  const parts = String(hash ?? '').replace(/^#/, '').split('/').filter(Boolean);

  if (namespace === null) {
    return parts.length === 0 ? { view: 'chat' } : parseRouteBody(parts);
  }

  if (parts.length === 0 || decodeSegment(parts[0]) !== namespace) return null;
  return parts.length === 1 ? { view: 'chat' } : parseRouteBody(parts.slice(1));
}

export function routeToHash(route: AppRoute, namespace: string | null): string {
  const body = ((): string => {
    if (route.view !== 'chat') return route.view;
    const target = route.conversation;
    if (!target) return 'chat';
    if ('groupId' in target) return `chat/g/${encodeURIComponent(String(target.groupId))}`;
    return `chat/u/${encodeURIComponent(String(target.toUid))}`;
  })();
  return namespace === null ? `#/${body}` : `#/${encodeURIComponent(namespace)}/${body}`;
}

export function getCurrentRoute(namespace: string | null): AppRoute | null {
  if (typeof location === 'undefined') return { view: 'chat' };
  return parseRoute(location.hash, namespace);
}

export function replaceRoute(route: AppRoute, namespace: string | null): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const hash = routeToHash(route, namespace);
  if (location.hash === hash) return;
  history.replaceState(null, '', hash);
}

export function pushRoute(route: AppRoute, namespace: string | null): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const hash = routeToHash(route, namespace);
  if (location.hash === hash) return;
  history.pushState(null, '', hash);
}
