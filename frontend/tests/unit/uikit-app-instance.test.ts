import { describe, expect, it, vi } from 'vitest';
import { AppDomScope, AppInstance, AppStorageScope, createEmbeddedStorage } from '../../src/uikit/app/app-instance';

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
    a.setStoredMode('memory');
    b.setStoredToken('token-b');
    b.setStoredMode('persistent');

    expect(a.getStoredToken()).toBe('token-a');
    expect(b.getStoredToken()).toBe('token-b');
    expect(a.getStoredMode()).toBe('memory');
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
});
