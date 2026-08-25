import { describe, expect, it } from 'vitest';
import { DASHBOARD_TILE_CONFIGS } from '../../src/home-dashboard/model';

describe('home dashboard model', () => {
  it('首页默认提供 9 个互相独立的格子配置', () => {
    expect(DASHBOARD_TILE_CONFIGS).toHaveLength(9);
    expect(new Set(DASHBOARD_TILE_CONFIGS.map((item) => item.instanceId)).size).toBe(9);
    expect(DASHBOARD_TILE_CONFIGS.every((item) => item.defaultSize === '1x1')).toBe(true);
  });
});
