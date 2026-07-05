import './app/style.css';
import { AppInstance, createMainDomScope } from './app/app-instance';
import { startApp } from './app/main-app';
import { APP_SHELL_HTML } from './app/shell';

interface MountAppOptions {
  readonly waitForDomReady?: boolean;
}

let activeCleanup: (() => void) | null = null;

function bootApp(): void {
  if (typeof document === 'undefined') return;
  activeCleanup?.();
  if (!document.querySelector('.mc-app-shell')) {
    document.body.innerHTML = APP_SHELL_HTML.trim();
  }
  const app = new AppInstance({
    dom: createMainDomScope(document),
    runtime: {
      embedded: false,
      instanceId: 'default',
      hooks: {},
    },
  });
  activeCleanup = startApp(app);
}

export function mountApp(options: MountAppOptions = {}): void {
  const wait = options.waitForDomReady !== false;
  if (wait && typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bootApp(), { once: true });
    return;
  }
  bootApp();
}
