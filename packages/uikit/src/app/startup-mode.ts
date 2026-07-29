import type { ClientMode } from './session-storage';

export function needsInitialModeSelection(token: string | null): boolean {
  return !token;
}

export function resolveModeAfterAuth(mode: ClientMode | null): ClientMode {
  return mode ?? 'instant';
}

export function shouldResetPersistentStorage(mode: ClientMode, storedPersistentUid: string | null, currentUid: string): boolean {
  return mode === 'persistent' && Boolean(storedPersistentUid) && storedPersistentUid !== currentUid;
}
