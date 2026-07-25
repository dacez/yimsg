import { describe, expect, it, vi } from 'vitest';
import { switchView } from '../../src/app/views/chat/navigation';

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
  // switchView 离开 chat 视图时会调用 closeGlobalChatSearch，需要给这几个全局搜索
  // DOM 元素也提供 stub（value + classList），否则 app.$() 返回 undefined 会直接抛错。
  const genericElements = new Map<string, ReturnType<typeof makeToggle> & { value: string }>();
  const stubElement = (id: string) => {
    let el = genericElements.get(id);
    if (!el) {
      el = { ...makeToggle(), value: '' };
      genericElements.set(id, el);
    }
    return el;
  };

  const app = {
    runtime: { viewMode, embedded: false, instanceId: 'default' },
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
    $: (id: string) => (views as Record<string, ReturnType<typeof makeToggle>>)[id.replace('view-', '')] ?? stubElement(id),
  };

  return { app: app as unknown as Parameters<typeof switchView>[0], views, navItems, loadContactsFn, renderSettingsFn };
}

describe('chat navigation switchView', () => {
  it('full viewMode switches to the requested view', () => {
    const { app, views } = createApp('full');

    switchView(app, 'contacts');

    expect(views.contacts.state.hidden).toBe(false);
    expect(views.chat.state.hidden).toBe(true);
  });

  it('chat-only viewMode forces every switchView call back to chat', () => {
    const { app, views, navItems, loadContactsFn } = createApp('chat-only');

    switchView(app, 'contacts');

    expect(views.chat.state.hidden).toBe(false);
    expect(views.contacts.state.hidden).toBe(true);
    expect(navItems.chat.state.active).toBe(true);
    expect(loadContactsFn).not.toHaveBeenCalled();
  });

  it('chat-only viewMode ignores requests to switch to settings', () => {
    const { app, views, renderSettingsFn } = createApp('chat-only');

    switchView(app, 'settings');

    expect(views.chat.state.hidden).toBe(false);
    expect(views.settings.state.hidden).toBe(true);
    expect(renderSettingsFn).not.toHaveBeenCalled();
  });

  it('contacts-only viewMode forces every switchView call back to contacts', () => {
    const { app, views, navItems, loadContactsFn } = createApp('contacts-only');

    switchView(app, 'chat');

    expect(views.contacts.state.hidden).toBe(false);
    expect(views.chat.state.hidden).toBe(true);
    expect(navItems.contacts.state.active).toBe(true);
    expect(loadContactsFn).toHaveBeenCalled();
  });

  it('contacts-only viewMode ignores requests to switch to settings', () => {
    const { app, views, renderSettingsFn } = createApp('contacts-only');

    switchView(app, 'settings');

    expect(views.contacts.state.hidden).toBe(false);
    expect(views.settings.state.hidden).toBe(true);
    expect(renderSettingsFn).not.toHaveBeenCalled();
  });
});
