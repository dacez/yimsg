export type DashboardTileSize = '1x1' | '2x1' | '1x2' | '2x2';

export interface DashboardTileConfig {
  readonly key: string;
  readonly title: string;
  readonly instanceId: string;
  readonly defaultSize: DashboardTileSize;
}

export const DASHBOARD_TILE_CONFIGS: readonly DashboardTileConfig[] = [
  { key: 'grid-1', title: '格 1', instanceId: 'home-grid-1', defaultSize: '1x1' },
  { key: 'grid-2', title: '格 2', instanceId: 'home-grid-2', defaultSize: '1x1' },
  { key: 'grid-3', title: '格 3', instanceId: 'home-grid-3', defaultSize: '1x1' },
  { key: 'grid-4', title: '格 4', instanceId: 'home-grid-4', defaultSize: '1x1' },
  { key: 'grid-5', title: '格 5', instanceId: 'home-grid-5', defaultSize: '1x1' },
  { key: 'grid-6', title: '格 6', instanceId: 'home-grid-6', defaultSize: '1x1' },
  { key: 'grid-7', title: '格 7', instanceId: 'home-grid-7', defaultSize: '1x1' },
  { key: 'grid-8', title: '格 8', instanceId: 'home-grid-8', defaultSize: '1x1' },
  { key: 'grid-9', title: '格 9', instanceId: 'home-grid-9', defaultSize: '1x1' },
] as const;
