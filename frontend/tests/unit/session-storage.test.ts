import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredLayout,
  clearStoredPersistentUid,
  clearStoredToken,
  setStorageAdapter,
  getStoredLayout,
  getStoredMode,
  getStoredPersistentUid,
  getStoredToken,
  resetStorageAdapter,
  setStoredLayout,
  setStoredMode,
  setStoredPersistentUid,
  setStoredToken,
} from '../../src/uikit/app/session-storage';

function createMockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
}

describe('session-storage', () => {
  beforeEach(() => {
    const storage = createMockLocalStorage();
    vi.stubGlobal('localStorage', storage);
    setStorageAdapter(storage);
  });

  afterEach(() => {
    resetStorageAdapter();
    vi.unstubAllGlobals();
  });

  it('stores and clears token in the UI layer', () => {
    expect(getStoredToken()).toBeNull();

    setStoredToken('tok123');
    expect(getStoredToken()).toBe('tok123');

    clearStoredToken();
    expect(getStoredToken()).toBeNull();
  });

  it('stores mode and ignores invalid persisted values', () => {
    expect(getStoredMode()).toBeNull();

    setStoredMode('persistent');
    expect(getStoredMode()).toBe('persistent');

    localStorage.setItem('mode', 'invalid');
    expect(getStoredMode()).toBeNull();
  });

  it('stores and clears the persisted persistent uid', () => {
    expect(getStoredPersistentUid()).toBeNull();

    setStoredPersistentUid('1001');
    expect(getStoredPersistentUid()).toBe('1001');

    clearStoredPersistentUid();
    expect(getStoredPersistentUid()).toBeNull();
  });

  it('layout preference defaults to auto when unset or invalid', () => {
    expect(getStoredLayout()).toBe('auto');

    localStorage.setItem('layout', 'garbage');
    expect(getStoredLayout()).toBe('auto');
  });

  it('stores and clears the layout preference', () => {
    setStoredLayout('mobile');
    expect(getStoredLayout()).toBe('mobile');

    setStoredLayout('desktop');
    expect(getStoredLayout()).toBe('desktop');

    setStoredLayout('auto');
    expect(getStoredLayout()).toBe('auto');

    clearStoredLayout();
    expect(getStoredLayout()).toBe('auto');
  });

  it('falls back to memory storage when global localStorage is incomplete', async () => {
    resetStorageAdapter();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.stubGlobal('localStorage', {});

    const mod = await import('../../src/uikit/app/session-storage');

    expect(mod.getStoredToken()).toBeNull();
    mod.setStoredToken('tok123');
    expect(mod.getStoredToken()).toBe('tok123');
    expect(mod.getStoredLayout()).toBe('auto');
  });
});
