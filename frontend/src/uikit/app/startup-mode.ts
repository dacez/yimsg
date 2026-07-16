import type { ClientMode, LayoutChoice, ResolvedLayout } from './session-storage';
import {
  detectResponsiveLayout,
  resolveResponsiveLayout,
  type ResponsiveLayoutEnvironment,
} from '../responsive-layout';

export function needsInitialModeSelection(token: string | null): boolean {
  return !token;
}

export function resolveModeAfterAuth(mode: ClientMode | null): ClientMode {
  return mode ?? 'instant';
}

export function shouldResetPersistentStorage(mode: ClientMode, storedPersistentUid: string | null, currentUid: string): boolean {
  return mode === 'persistent' && Boolean(storedPersistentUid) && storedPersistentUid !== currentUid;
}

/** 视口提示，一般传入 `window` 即可。测试时可替换为 mock。 */
interface LayoutEnvironment extends ResponsiveLayoutEnvironment {}

/** 当用户选 auto（或读到未知值）时，根据视口宽度与指针类型自动判定布局。 */
export function autoDetectLayout(env: LayoutEnvironment): ResolvedLayout {
  return detectResponsiveLayout(env);
}

/** 将用户持久化的选择解析为最终应用的布局。 */
export function resolveLayout(choice: LayoutChoice, env: LayoutEnvironment): ResolvedLayout {
  return resolveResponsiveLayout(choice, env);
}
