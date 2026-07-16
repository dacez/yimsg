import { type LayoutChoice, type ResolvedLayout } from './session-storage';
import { resolveLayout } from './startup-mode';
import type { AppInstance } from './app-instance';

/**
 * 布局装配：全部方法都以 `AppInstance` 为作用域，确保多实例挂载彼此独立。
 */

export function applyResolvedLayoutForApp(app: AppInstance, layout: ResolvedLayout): void {
  app.dom.layoutHost.dataset.layout = layout;
  const shell = app.dom.root.querySelector<HTMLElement>('.mc-app-shell');
  if (shell && shell !== app.dom.layoutHost) {
    shell.dataset.layout = layout;
  }
}

function applyLayoutFromPreferenceForApp(app: AppInstance): ResolvedLayout {
  const choice = app.storage.getStoredLayout();
  const resolved = resolveLayout(choice, {
    matchMedia: typeof window !== 'undefined' ? window.matchMedia?.bind(window) : undefined,
    innerWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    width: app.runtime.embedded ? (app.dom.viewportHost.getBoundingClientRect().width || app.dom.viewportHost.clientWidth || undefined) : undefined,
  });
  applyResolvedLayoutForApp(app, resolved);
  return resolved;
}

export function watchLayoutChangesForApp(app: AppInstance): () => void {
  let lastApplied: ResolvedLayout | null = null;
  const doc = app.dom.ownerDocument;
  const apply = () => {
    const next = applyLayoutFromPreferenceForApp(app);
    if (next !== lastApplied) {
      lastApplied = next;
      doc.dispatchEvent(new CustomEvent('yimsg:layout-changed', { detail: next }));
    }
  };
  apply();
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('resize', apply, { passive: true });
  return () => window.removeEventListener('resize', apply);
}

export function persistAndApplyLayoutForApp(app: AppInstance, choice: LayoutChoice): ResolvedLayout {
  app.storage.setStoredLayout(choice);
  return applyLayoutFromPreferenceForApp(app);
}
