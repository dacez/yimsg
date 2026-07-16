import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_TILE_CONFIGS,
  clearRememberedDashboardUids,
  readRememberedDashboardUids,
  rememberDashboardUid,
} from '../../src/home-dashboard/model';

describe('home dashboard model', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
      removeItem(key: string) {
        store.delete(key);
      },
    });
  });

  it('首页默认提供 9 个互相独立的格子配置', () => {
    expect(DASHBOARD_TILE_CONFIGS).toHaveLength(9);
    expect(new Set(DASHBOARD_TILE_CONFIGS.map((item) => item.instanceId)).size).toBe(9);
    expect(DASHBOARD_TILE_CONFIGS.every((item) => item.defaultSize === '1x1')).toBe(true);
  });

  it('会记住同一格子出现过的 uid，并在清理时一次删空', () => {
    rememberDashboardUid('home-grid-1', '1001');
    rememberDashboardUid('home-grid-1', '1002');
    rememberDashboardUid('home-grid-1', '1001');

    expect(readRememberedDashboardUids('home-grid-1')).toEqual(['1001', '1002']);

    clearRememberedDashboardUids('home-grid-1');
    expect(readRememberedDashboardUids('home-grid-1')).toEqual([]);
  });
});
