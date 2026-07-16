export type DashboardTileMode = 'instant' | 'persistent';
export type DashboardTileSize = '1x1' | '2x1' | '1x2' | '2x2';

export interface DashboardTileConfig {
  readonly key: string;
  readonly title: string;
  readonly mode: DashboardTileMode;
  readonly instanceId: string;
  readonly defaultSize: DashboardTileSize;
}

export const DASHBOARD_TILE_CONFIGS: readonly DashboardTileConfig[] = [
  { key: 'grid-1', title: '格 1 · 持久存储', mode: 'persistent', instanceId: 'home-grid-1', defaultSize: '1x1' },
  { key: 'grid-2', title: '格 2 · Instant', mode: 'instant', instanceId: 'home-grid-2', defaultSize: '1x1' },
  { key: 'grid-3', title: '格 3 · 持久存储', mode: 'persistent', instanceId: 'home-grid-3', defaultSize: '1x1' },
  { key: 'grid-4', title: '格 4 · Instant', mode: 'instant', instanceId: 'home-grid-4', defaultSize: '1x1' },
  { key: 'grid-5', title: '格 5 · 持久存储', mode: 'persistent', instanceId: 'home-grid-5', defaultSize: '1x1' },
  { key: 'grid-6', title: '格 6 · Instant', mode: 'instant', instanceId: 'home-grid-6', defaultSize: '1x1' },
  { key: 'grid-7', title: '格 7 · 持久存储', mode: 'persistent', instanceId: 'home-grid-7', defaultSize: '1x1' },
  { key: 'grid-8', title: '格 8 · Instant', mode: 'instant', instanceId: 'home-grid-8', defaultSize: '1x1' },
  { key: 'grid-9', title: '格 9 · 持久存储', mode: 'persistent', instanceId: 'home-grid-9', defaultSize: '1x1' },
] as const;

const DASHBOARD_UIDS_KEY_PREFIX = 'yimsg:home-dashboard:uids:';

function getDashboardUidsKey(instanceId: string): string {
  return `${DASHBOARD_UIDS_KEY_PREFIX}${instanceId}`;
}

function getSafeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readRememberedDashboardUids(instanceId: string): string[] {
  const storage = getSafeLocalStorage();
  if (!storage) return [];

  try {
    const raw = storage.getItem(getDashboardUidsKey(instanceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

export function rememberDashboardUid(instanceId: string, uid: string): void {
  if (!uid) return;
  const storage = getSafeLocalStorage();
  if (!storage) return;

  const next = Array.from(new Set([...readRememberedDashboardUids(instanceId), uid]));
  storage.setItem(getDashboardUidsKey(instanceId), JSON.stringify(next));
}

export function clearRememberedDashboardUids(instanceId: string): void {
  const storage = getSafeLocalStorage();
  storage?.removeItem(getDashboardUidsKey(instanceId));
}
