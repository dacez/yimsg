import type { AppInstance } from './app-instance';
import type { ResolvedLayout } from './session-storage';

const ACTION_TRIGGER_VISIBLE_TRANSITION = 'background-color .15s ease, color .15s ease';

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

export function applyMessageActionTriggerVisibility(
  app: AppInstance,
  resolvedLayout?: ResolvedLayout,
): void {
  const visible = isMobileInteractionLayout(app, resolvedLayout);
  app.dom.root.querySelectorAll<HTMLElement>('.message-actions-trigger').forEach((button) => {
    if (visible) {
      button.style.opacity = '1';
      button.style.transition = ACTION_TRIGGER_VISIBLE_TRANSITION;
    } else {
      button.style.removeProperty('opacity');
      button.style.removeProperty('transition');
    }
  });
}

export function applyMessageActionTriggerVisibilityForButton(
  app: AppInstance,
  button: HTMLElement,
): void {
  if (!isMobileInteractionLayout(app)) return;
  button.style.opacity = '1';
  button.style.transition = ACTION_TRIGGER_VISIBLE_TRANSITION;
}
