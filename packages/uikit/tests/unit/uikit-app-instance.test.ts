import { describe, expect, it, vi } from 'vitest';
import { AppDomScope, AppInstance, AppStorageScope, createEmbeddedStorage } from '../../src/app/app-instance';

function createDomScope() {
  const elements = new Map<string, HTMLElement>();
  const ownerDocument = {
    createElement: vi.fn(() => ({
      className: '',
      textContent: '',
      innerHTML: '',
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      remove: vi.fn(),
    })),
  } as unknown as Document;
  const root = {
    querySelector: vi.fn((selector: string) => selector.startsWith('#') ? (elements.get(selector.slice(1)) ?? null) : null),
    querySelectorAll: vi.fn(() => []),
    getElementById: vi.fn((id: string) => elements.get(id) ?? null),
  } as unknown as ShadowRoot;
  const host = { dataset: {}, classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() }, style: { setProperty: vi.fn(), removeProperty: vi.fn() } } as unknown as HTMLElement;
  return new AppDomScope(root, ownerDocument, host, host, host, host);
}

describe('AppInstance', () => {
  it('embedded storage instances are isolated', () => {
    const a = new AppStorageScope(createEmbeddedStorage());
    const b = new AppStorageScope(createEmbeddedStorage());

    a.setStoredToken('token-a');
    a.setStoredMode('instant');
    b.setStoredToken('token-b');
    b.setStoredMode('persistent');

    expect(a.getStoredToken()).toBe('token-a');
    expect(b.getStoredToken()).toBe('token-b');
    expect(a.getStoredMode()).toBe('instant');
    expect(b.getStoredMode()).toBe('persistent');
  });

  it('each app instance keeps its own language and runtime identity', () => {
    const appA = new AppInstance({
      dom: createDomScope(),
      storageAdapter: createEmbeddedStorage(),
      runtime: { embedded: true, instanceId: 'grid-a', hooks: {} },
      locale: 'zh-CN',
    });
    const appB = new AppInstance({
      dom: createDomScope(),
      storageAdapter: createEmbeddedStorage(),
      runtime: { embedded: true, instanceId: 'grid-b', hooks: {} },
      locale: 'en',
    });

    appA.setLang('zh');
    appB.setLang('en');

    expect(appA.getLang()).toBe('zh');
    expect(appB.getLang()).toBe('en');
    expect(appA.runtime.instanceId).toBe('grid-a');
    expect(appB.runtime.instanceId).toBe('grid-b');
  });

  describe('bounded list registry', () => {
    function createApp() {
      return new AppInstance({
        dom: createDomScope(),
        storageAdapter: createEmbeddedStorage(),
        runtime: { embedded: true, instanceId: 'bounded-lists', hooks: {} },
        locale: 'zh-CN',
      });
    }

    it('invalidateBoundedLists calls every registered controller', async () => {
      const app = createApp();
      const invalidateA = vi.fn();
      const invalidateB = vi.fn();
      app.registerBoundedList({ id: 'a', invalidate: invalidateA });
      app.registerBoundedList({ id: 'b', invalidate: invalidateB });

      app.invalidateBoundedLists();
      await Promise.resolve();

      expect(invalidateA).toHaveBeenCalledOnce();
      expect(invalidateB).toHaveBeenCalledOnce();
    });

    it('the disposer returned by registerBoundedList unregisters that controller only', async () => {
      const app = createApp();
      const invalidateA = vi.fn();
      const invalidateB = vi.fn();
      const unregisterA = app.registerBoundedList({ id: 'a', invalidate: invalidateA });
      app.registerBoundedList({ id: 'b', invalidate: invalidateB });

      unregisterA();
      app.invalidateBoundedLists();
      await Promise.resolve();

      expect(invalidateA).not.toHaveBeenCalled();
      expect(invalidateB).toHaveBeenCalledOnce();
    });

    it('re-registering the same id replaces the previous controller', async () => {
      const app = createApp();
      const first = vi.fn();
      const second = vi.fn();
      app.registerBoundedList({ id: 'conversations', invalidate: first });
      app.registerBoundedList({ id: 'conversations', invalidate: second });

      app.invalidateBoundedLists();
      await Promise.resolve();

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it('a controller that throws or rejects does not stop the others from being invalidated', async () => {
      const app = createApp();
      const failingSync = vi.fn(() => { throw new Error('boom'); });
      const failingAsync = vi.fn(async () => { throw new Error('boom-async'); });
      const ok = vi.fn();
      app.registerBoundedList({ id: 'failing-sync', invalidate: failingSync });
      app.registerBoundedList({ id: 'failing-async', invalidate: failingAsync });
      app.registerBoundedList({ id: 'ok', invalidate: ok });

      expect(() => app.invalidateBoundedLists()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(failingSync).toHaveBeenCalledOnce();
      expect(failingAsync).toHaveBeenCalledOnce();
      expect(ok).toHaveBeenCalledOnce();
    });
  });
});
