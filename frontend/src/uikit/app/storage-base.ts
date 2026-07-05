export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const TOKEN_KEY = 'token';
const MODE_KEY = 'mode';
const PERSISTENT_UID_KEY = 'persistent_uid';
const LAYOUT_KEY = 'layout';
const LANG_KEY = 'lang';

function createMemoryStorage(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

function isStorageAdapter(value: unknown): value is StorageAdapter {
  if (!value || typeof value !== 'object') return false;
  return (
    typeof (value as StorageAdapter).getItem === 'function' &&
    typeof (value as StorageAdapter).setItem === 'function' &&
    typeof (value as StorageAdapter).removeItem === 'function'
  );
}

export function createBrowserStorage(): StorageAdapter {
  const fallbackStorage = createMemoryStorage();

  try {
    const browserStorage = globalThis.localStorage;
    if (!isStorageAdapter(browserStorage)) return fallbackStorage;

    return {
      getItem(key: string) {
        try {
          return browserStorage.getItem(key);
        } catch {
          return fallbackStorage.getItem(key);
        }
      },
      setItem(key: string, value: string) {
        try {
          browserStorage.setItem(key, value);
        } catch {
          fallbackStorage.setItem(key, value);
        }
      },
      removeItem(key: string) {
        try {
          browserStorage.removeItem(key);
        } catch {
          fallbackStorage.removeItem(key);
        }
      },
    };
  } catch {
    return fallbackStorage;
  }
}

export function createSeededStorage(initial: Partial<Record<string, string>> = {}): StorageAdapter {
  const storage = createMemoryStorage();
  for (const [key, value] of Object.entries(initial)) {
    if (value !== undefined) storage.setItem(key, value);
  }
  return storage;
}

export class StorageScope {
  constructor(private readonly storage: StorageAdapter) {}

  getStoredToken(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  setStoredToken(token: string): void {
    this.storage.setItem(TOKEN_KEY, token);
  }

  clearStoredToken(): void {
    this.storage.removeItem(TOKEN_KEY);
  }

  getStoredMode(): 'memory' | 'persistent' | null {
    const mode = this.storage.getItem(MODE_KEY);
    return mode === 'memory' || mode === 'persistent' ? mode : null;
  }

  setStoredMode(mode: 'memory' | 'persistent'): void {
    this.storage.setItem(MODE_KEY, mode);
  }

  getStoredPersistentUid(): string | null {
    return this.storage.getItem(PERSISTENT_UID_KEY);
  }

  setStoredPersistentUid(uid: string): void {
    this.storage.setItem(PERSISTENT_UID_KEY, uid);
  }

  clearStoredPersistentUid(): void {
    this.storage.removeItem(PERSISTENT_UID_KEY);
  }

  getStoredLayout(): 'desktop' | 'mobile' | 'auto' {
    const raw = this.storage.getItem(LAYOUT_KEY);
    return raw === 'desktop' || raw === 'mobile' || raw === 'auto' ? raw : 'auto';
  }

  setStoredLayout(choice: 'desktop' | 'mobile' | 'auto'): void {
    this.storage.setItem(LAYOUT_KEY, choice);
  }

  clearStoredLayout(): void {
    this.storage.removeItem(LAYOUT_KEY);
  }

  getStoredLang(): 'zh' | 'en' {
    const raw = this.storage.getItem(LANG_KEY);
    return raw === 'en' ? 'en' : 'zh';
  }

  setStoredLang(lang: 'zh' | 'en'): void {
    this.storage.setItem(LANG_KEY, lang);
  }
}