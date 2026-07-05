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

export function parseRoute(hash: string | undefined | null): AppRoute {
  const cleaned = String(hash ?? '').replace(/^#/, '').replace(/^\//, '');
  if (!cleaned) return { view: 'chat' };

  const parts = cleaned.split('/');
  const view = parts[0];
  if (view === 'contacts' || view === 'settings') return { view };
  if (view !== 'chat') return { view: 'chat' };

  const kind = parts[1];
  const id = decodeSegment(parts[2]);
  if (kind === 'u' && id) return { view: 'chat', conversation: { toUid: id } };
  if (kind === 'g' && id) return { view: 'chat', conversation: { groupId: id } };
  return { view: 'chat' };
}

export function routeToHash(route: AppRoute): string {
  if (route.view !== 'chat') return `#/${route.view}`;
  const target = route.conversation;
  if (!target) return '#/chat';
  if ('groupId' in target) return `#/chat/g/${encodeURIComponent(String(target.groupId))}`;
  return `#/chat/u/${encodeURIComponent(String(target.toUid))}`;
}

export function getCurrentRoute(): AppRoute {
  if (typeof location === 'undefined') return { view: 'chat' };
  return parseRoute(location.hash);
}

export function replaceRoute(route: AppRoute): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const hash = routeToHash(route);
  if (location.hash === hash) return;
  history.replaceState(null, '', hash);
}

export function pushRoute(route: AppRoute): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const hash = routeToHash(route);
  if (location.hash === hash) return;
  history.pushState(null, '', hash);
}
