import { mount, type MountHandle } from '../uikit';
import { buildPersistentDbName } from '../sdk/datagateway/persistent';
import { SqliteWorkerApi } from '../sdk/datagateway/sqlite-worker-api';
import {
  DASHBOARD_TILE_CONFIGS,
  type DashboardTileConfig,
  type DashboardTileSize,
  clearRememberedDashboardUids,
  readRememberedDashboardUids,
  rememberDashboardUid,
} from './model';
import './style.css';

interface MountHomeDashboardOptions {
  readonly waitForDomReady?: boolean;
}

interface DashboardTileState {
  readonly config: DashboardTileConfig;
  readonly section: HTMLElement;
  readonly host: HTMLElement;
  readonly status: HTMLElement;
  readonly loadButton: HTMLButtonElement;
  readonly unloadButton: HTMLButtonElement;
  readonly clearButton: HTMLButtonElement;
  readonly sizeSelect: HTMLSelectElement;
  handle: MountHandle | null;
  busy: boolean;
}

type DashboardWindow = Window & {
  __dashboardHandles?: Record<string, MountHandle>;
  __dashboardDemo?: {
    readonly configs: typeof DASHBOARD_TILE_CONFIGS;
    getHandle(hostId: string): MountHandle | null;
    shadowChildCount(hostId: string): number;
    load(hostId: string): Promise<void>;
    unload(hostId: string): void;
    clear(hostId: string): Promise<void>;
  };
};

const TILE_SIZE_OPTIONS: ReadonlyArray<{ value: DashboardTileSize; label: string }> = [
  { value: '1x1', label: '1x1 标准' },
  { value: '2x1', label: '2x1 宽' },
  { value: '1x2', label: '1x2 高' },
  { value: '2x2', label: '2x2 大' },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDashboardShell(): string {
  const cards = DASHBOARD_TILE_CONFIGS.map((config, index) => `
    <section class="home-dashboard__cell" id="dashboard-cell-${config.key}" data-size="${config.defaultSize}">
      <div class="home-dashboard__cell-header">
        <div class="home-dashboard__cell-heading">
          <h2>${escapeHtml(config.title)}</h2>
          <p>模式：${config.mode.toUpperCase()} · 实例 ${index + 1}</p>
        </div>
        <div class="home-dashboard__cell-controls">
          <label class="home-dashboard__cell-size">
            <span>尺寸</span>
            <select id="dashboard-size-${config.key}" aria-label="${escapeHtml(config.title)}尺寸">
              ${TILE_SIZE_OPTIONS.map((option) => `
                <option value="${option.value}"${option.value === config.defaultSize ? ' selected' : ''}>${escapeHtml(option.label)}</option>
              `).join('')}
            </select>
          </label>
          <button type="button" class="home-dashboard__button" id="dashboard-load-${config.key}">加载</button>
          <button type="button" class="home-dashboard__button" id="dashboard-unload-${config.key}">卸载</button>
          <button type="button" class="home-dashboard__button home-dashboard__button-danger" id="dashboard-clear-${config.key}">删除数据</button>
        </div>
      </div>
      <div class="home-dashboard__cell-status" id="dashboard-status-${config.key}">待加载</div>
      <div class="home-dashboard__cell-host" id="dashboard-host-${config.key}" data-testid="dashboard-host-${config.key}"></div>
    </section>
  `).join('');

  return `
    <main class="home-dashboard">
      <header class="home-dashboard__hero">
        <div>
          <h1>yimsg 九宫格控制台</h1>
          <p>该页面直接挂载 9 个独立 UIKit 实例；每格都支持调尺寸、加载、卸载与删除本格本地数据。</p>
        </div>
      </header>
      <section class="home-dashboard__grid" id="home-dashboard-grid">
        ${cards}
      </section>
    </main>
  `;
}

function resolveWsUrl(): string {
  if (typeof window === 'undefined') return '/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function isPersistentTile(config: DashboardTileConfig): boolean {
  return config.mode === 'persistent';
}

async function clearTilePersistentData(config: DashboardTileConfig): Promise<void> {
  if (!isPersistentTile(config)) return;
  const uids = readRememberedDashboardUids(config.instanceId);
  if (uids.length === 0) return;

  const db = new SqliteWorkerApi();
  const errors: string[] = [];
  try {
    for (const uid of uids) {
      try {
        await db.deleteDb(buildPersistentDbName(uid, config.instanceId));
      } catch (error) {
        errors.push(`${uid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`删除本地数据失败：${errors.join('; ')}`);
    }
  } finally {
    db.terminate();
  }
}

function setTileStatus(state: DashboardTileState, text: string): void {
  state.status.textContent = text;
}

function syncTileUi(state: DashboardTileState): void {
  state.section.dataset.mounted = state.handle ? 'true' : 'false';
  state.loadButton.disabled = state.busy || Boolean(state.handle);
  state.unloadButton.disabled = state.busy || !state.handle;
  state.clearButton.disabled = state.busy;
  state.sizeSelect.disabled = state.busy;
}

function getDashboardWindow(): DashboardWindow | null {
  if (typeof window === 'undefined') return null;
  return window as DashboardWindow;
}

async function loadTile(state: DashboardTileState): Promise<void> {
  if (state.handle || state.busy) return;

  state.busy = true;
  setTileStatus(state, '加载中…');
  syncTileUi(state);

  try {
    state.handle = mount(state.host, {
      wsUrl: resolveWsUrl(),
      uploadUrl: '/api/upload',
      theme: 'auto',
      locale: 'zh-CN',
      layout: 'auto',
      mode: state.config.mode,
      instanceId: state.config.instanceId,
      onAuthenticated(info) {
        rememberDashboardUid(state.config.instanceId, info.uid);
        setTileStatus(state, `已登录 · UID ${info.uid}`);
      },
      onLogout() {
        setTileStatus(state, '已登出');
      },
      onError(error, context) {
        setTileStatus(state, `错误：${context}`);
        console.error('[home-dashboard]', context, error);
      },
    });
    const dashboardWindow = getDashboardWindow();
    if (dashboardWindow) {
      dashboardWindow.__dashboardHandles ??= {};
      dashboardWindow.__dashboardHandles[state.host.id] = state.handle;
    }
    setTileStatus(state, '已加载');
  } catch (error) {
    state.handle = null;
    setTileStatus(state, '加载失败');
    console.error('[home-dashboard] failed to mount tile', state.config.instanceId, error);
  } finally {
    state.busy = false;
    syncTileUi(state);
  }
}

function unloadTile(state: DashboardTileState): void {
  if (!state.handle || state.busy) return;
  state.busy = true;
  setTileStatus(state, '卸载中…');
  syncTileUi(state);

  try {
    state.handle.unmount();
    state.handle = null;
    const dashboardWindow = getDashboardWindow();
    if (dashboardWindow?.__dashboardHandles) {
      delete dashboardWindow.__dashboardHandles[state.host.id];
    }
    setTileStatus(state, '已卸载');
  } finally {
    state.busy = false;
    syncTileUi(state);
  }
}

async function clearTile(state: DashboardTileState): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  setTileStatus(state, '删除中…');
  syncTileUi(state);

  try {
    if (state.handle) {
      state.handle.unmount();
      state.handle = null;
      const dashboardWindow = getDashboardWindow();
      if (dashboardWindow?.__dashboardHandles) {
        delete dashboardWindow.__dashboardHandles[state.host.id];
      }
    }
    await clearTilePersistentData(state.config);
    clearRememberedDashboardUids(state.config.instanceId);
    setTileStatus(state, '数据已清空');
  } catch (error) {
    setTileStatus(state, '删除失败');
    console.error('[home-dashboard] failed to clear tile data', state.config.instanceId, error);
  } finally {
    state.busy = false;
    syncTileUi(state);
  }
}

function createTileState(config: DashboardTileConfig): DashboardTileState {
  const section = document.getElementById(`dashboard-cell-${config.key}`);
  const host = document.getElementById(`dashboard-host-${config.key}`);
  const status = document.getElementById(`dashboard-status-${config.key}`);
  const loadButton = document.getElementById(`dashboard-load-${config.key}`);
  const unloadButton = document.getElementById(`dashboard-unload-${config.key}`);
  const clearButton = document.getElementById(`dashboard-clear-${config.key}`);
  const sizeSelect = document.getElementById(`dashboard-size-${config.key}`);

  if (
    !(section instanceof HTMLElement)
    || !(host instanceof HTMLElement)
    || !(status instanceof HTMLElement)
    || !(loadButton instanceof HTMLButtonElement)
    || !(unloadButton instanceof HTMLButtonElement)
    || !(clearButton instanceof HTMLButtonElement)
    || !(sizeSelect instanceof HTMLSelectElement)
  ) {
    throw new Error(`[home-dashboard] missing tile DOM for ${config.instanceId}`);
  }

  const state: DashboardTileState = {
    config,
    section,
    host,
    status,
    loadButton,
    unloadButton,
    clearButton,
    sizeSelect,
    handle: null,
    busy: false,
  };

  sizeSelect.value = config.defaultSize;
  section.dataset.size = config.defaultSize;
  sizeSelect.addEventListener('change', () => {
    section.dataset.size = sizeSelect.value;
  });
  loadButton.addEventListener('click', () => { void loadTile(state); });
  unloadButton.addEventListener('click', () => { unloadTile(state); });
  clearButton.addEventListener('click', () => { void clearTile(state); });
  syncTileUi(state);
  return state;
}

function exposeDashboardApi(states: ReadonlyMap<string, DashboardTileState>): void {
  const dashboardWindow = getDashboardWindow();
  if (!dashboardWindow) return;

  dashboardWindow.__dashboardHandles = {};
  dashboardWindow.__dashboardDemo = {
    configs: DASHBOARD_TILE_CONFIGS,
    getHandle(hostId: string) {
      return dashboardWindow.__dashboardHandles?.[hostId] ?? null;
    },
    shadowChildCount(hostId: string) {
      return document.getElementById(hostId)?.shadowRoot?.childNodes.length ?? 0;
    },
    load(hostId: string) {
      const state = states.get(hostId);
      return state ? loadTile(state) : Promise.resolve();
    },
    unload(hostId: string) {
      const state = states.get(hostId);
      if (state) unloadTile(state);
    },
    clear(hostId: string) {
      const state = states.get(hostId);
      return state ? clearTile(state) : Promise.resolve();
    },
  };
}

function bootHomeDashboard(): void {
  if (typeof document === 'undefined') return;
  document.body.innerHTML = buildDashboardShell();

  const states = new Map<string, DashboardTileState>();
  for (const config of DASHBOARD_TILE_CONFIGS) {
    const state = createTileState(config);
    states.set(state.host.id, state);
  }
  exposeDashboardApi(states);

  for (const state of states.values()) {
    void loadTile(state);
  }
}

export function mountHomeDashboard(options: MountHomeDashboardOptions = {}): void {
  const wait = options.waitForDomReady !== false;
  if (wait && typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bootHomeDashboard(), { once: true });
    return;
  }
  bootHomeDashboard();
}
