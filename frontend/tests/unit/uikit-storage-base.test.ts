import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StorageScope,
  createBrowserStorage,
  createSeededStorage,
} from '../../src/uikit/app/storage-base';

describe('uikit storage-base', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and writes seeded values through a shared storage scope', () => {
    const scope = new StorageScope(createSeededStorage({
      token: 'tok123',
      mode: 'persistent',
      persistent_uid: '1001',
      layout: 'desktop',
      lang: 'en',
    }));

    expect(scope.getStoredToken()).toBe('tok123');
    expect(scope.getStoredMode()).toBe('persistent');
    expect(scope.getStoredPersistentUid()).toBe('1001');
    expect(scope.getStoredLayout()).toBe('desktop');
    expect(scope.getStoredLang()).toBe('en');

    scope.clearStoredToken();
    scope.setStoredMode('memory');
    scope.clearStoredPersistentUid();
    scope.setStoredLayout('mobile');
    scope.setStoredLang('zh');

    expect(scope.getStoredToken()).toBeNull();
    expect(scope.getStoredMode()).toBe('memory');
    expect(scope.getStoredPersistentUid()).toBeNull();
    expect(scope.getStoredLayout()).toBe('mobile');
    expect(scope.getStoredLang()).toBe('zh');
  });

  it('falls back to memory when localStorage throws at runtime', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('read failed');
      }),
      setItem: vi.fn(() => {
        throw new Error('write failed');
      }),
      removeItem: vi.fn(() => {
        throw new Error('remove failed');
      }),
    });

    const storage = createBrowserStorage();
    storage.setItem('token', 'tok-fallback');
    expect(storage.getItem('token')).toBe('tok-fallback');
    storage.removeItem('token');
    expect(storage.getItem('token')).toBeNull();
  });
});