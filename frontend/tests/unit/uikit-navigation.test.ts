import { describe, expect, it, vi } from 'vitest';
import { switchView } from '../../src/uikit/app/views/chat/navigation';

vi.mock('../../src/uikit/app/router', () => ({
  pushRoute: vi.fn(),
}));

import { pushRoute } from '../../src/uikit/app/router';

type ViewName = 'chat' | 'contacts' | 'settings';

function makeToggle() {
  const state = { hidden: false, active: false };
  return {
    state,
    classList: {
      add: (cls: string) => { if (cls === 'hidden') state.hidden = true; if (cls === 'active') state.active = true; },
      remove: (cls: string) => { if (cls === 'hidden') state.hidden = false; if (cls === 'active') state.active = false; },
    },
  };
}

function createApp(viewMode?: 'full' | 'chat-only' | 'contacts-only') {
  const views: Record<ViewName, ReturnType<typeof makeToggle>> = {
    chat: makeToggle(),
    contacts: makeToggle(),
    settings: makeToggle(),
  };
  const navItems: Record<ViewName, ReturnType<typeof makeToggle>> = {
    chat: makeToggle(),
    contacts: makeToggle(),
    settings: makeToggle(),
  };
  const loadContactsFn = vi.fn();
  const renderSettingsFn = vi.fn();

  const app = {
    runtime: { viewMode },
    chatState: { currentConvKey: null, currentConversation: null, loadContactsFn, renderSettingsFn },
    dom: {
      querySelectorAll: (selector: string) => {
        if (selector === '#main-content > .view') return [views.chat, views.contacts, views.settings];
        if (selector === '.nav-item') return [navItems.chat, navItems.contacts, navItems.settings];
        return [];
      },
      querySelector: (selector: string) => {
        const match = /data-view="(\w+)"/.exec(selector);
        return match ? navItems[match[1] as ViewName] ?? null : null;
      },
    },
    $: (id: string) => views[id.replace('view-', '') as ViewName],
  };

  return { app: app as unknown as Parameters<typeof switchView>[0], views, navItems, loadContactsFn, renderSettingsFn };
}

describe('chat navigation switchView', () => {
  it('full viewMode switches to the requested view and pushes its route', () => {
    const { app, views } = createApp('full');

    switchView(app, 'contacts');

    expect(views.contacts.state.hidden).toBe(false);
    expect(views.chat.state.hidden).toBe(true);
    expect(pushRoute).toHaveBeenCalledWith({ view: 'contacts', conversation: undefined });
  });

  it('chat-only viewMode forces every switchView call back to chat', () => {
    const { app, views, navItems, loadContactsFn } = createApp('chat-only');

    switchView(app, 'contacts');

    expect(views.chat.state.hidden).toBe(false);
    expect(views.contacts.state.hidden).toBe(true);
    expect(navItems.chat.state.active).toBe(true);
    expect(loadContactsFn).not.toHaveBeenCalled();
    expect(pushRoute).toHaveBeenCalledWith({ view: 'chat', conversation: undefined });
  });

  it('chat-only viewMode ignores host hash routing to settings without updating the route', () => {
    const { app, views, renderSettingsFn } = createApp('chat-only');
    vi.mocked(pushRoute).mockClear();

    switchView(app, 'settings', { updateRoute: false });

    expect(views.chat.state.hidden).toBe(false);
    expect(views.settings.state.hidden).toBe(true);
    expect(renderSettingsFn).not.toHaveBeenCalled();
    expect(pushRoute).not.toHaveBeenCalled();
  });

  it('contacts-only viewMode forces every switchView call back to contacts', () => {
    const { app, views, navItems, loadContactsFn } = createApp('contacts-only');

    switchView(app, 'chat');

    expect(views.contacts.state.hidden).toBe(false);
    expect(views.chat.state.hidden).toBe(true);
    expect(navItems.contacts.state.active).toBe(true);
    expect(loadContactsFn).toHaveBeenCalled();
    expect(pushRoute).toHaveBeenCalledWith({ view: 'contacts', conversation: undefined });
  });

  it('contacts-only viewMode ignores host hash routing to settings without updating the route', () => {
    const { app, views, renderSettingsFn } = createApp('contacts-only');
    vi.mocked(pushRoute).mockClear();

    switchView(app, 'settings', { updateRoute: false });

    expect(views.contacts.state.hidden).toBe(false);
    expect(views.settings.state.hidden).toBe(true);
    expect(renderSettingsFn).not.toHaveBeenCalled();
    expect(pushRoute).not.toHaveBeenCalled();
  });
});
