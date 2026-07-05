export type ClientMode = 'memory' | 'persistent';
/** 启动页可选布局偏好。'auto' 表示根据视口/指针类型自动判定。 */
export type LayoutChoice = 'desktop' | 'mobile' | 'auto';
/** 实际应用的布局值，只有两种。 */
export type ResolvedLayout = 'desktop' | 'mobile';
import {
  StorageScope,
  createBrowserStorage,
  type StorageAdapter,
} from './storage-base';

export type { StorageAdapter } from './storage-base';

const defaultStorage = new StorageScope(createBrowserStorage());
let storage = defaultStorage;

export function setStorageAdapter(adapter: StorageAdapter): void {
  storage = new StorageScope(adapter);
}

export function resetStorageAdapter(): void {
  storage = defaultStorage;
}

export function getStoredToken(): string | null {
  return storage.getStoredToken();
}

export function setStoredToken(token: string): void {
  storage.setStoredToken(token);
}

export function clearStoredToken(): void {
  storage.clearStoredToken();
}

export function getStoredMode(): ClientMode | null {
  return storage.getStoredMode();
}

export function setStoredMode(mode: ClientMode): void {
  storage.setStoredMode(mode);
}

export function getStoredPersistentUid(): string | null {
  return storage.getStoredPersistentUid();
}

export function setStoredPersistentUid(uid: string): void {
  storage.setStoredPersistentUid(uid);
}

export function clearStoredPersistentUid(): void {
  storage.clearStoredPersistentUid();
}

export function getStoredLayout(): LayoutChoice {
  return storage.getStoredLayout();
}

export function setStoredLayout(choice: LayoutChoice): void {
  storage.setStoredLayout(choice);
}

export function clearStoredLayout(): void {
  storage.clearStoredLayout();
}
