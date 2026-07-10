import type { AppInstance } from './app-instance';
import type { ResolvedLayout } from './session-storage';

export function isMobileInteractionLayout(app: AppInstance, resolvedLayout?: ResolvedLayout): boolean {
  if (resolvedLayout === 'mobile') return true;
  const view = app.dom.ownerDocument.defaultView;
  const shell = app.dom.root.querySelector<HTMLElement>('.mc-app-shell');
  return app.dom.layoutHost.dataset.layout === 'mobile' ||
    app.dom.ownerDocument.body.dataset.layout === 'mobile' ||
    shell?.dataset.layout === 'mobile' ||
    view?.matchMedia('(hover: none), (pointer: coarse)').matches === true ||
    (view?.innerWidth ?? Number.POSITIVE_INFINITY) <= 640;
}
