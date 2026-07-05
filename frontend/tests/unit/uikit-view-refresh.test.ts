import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshVisibleViews,
  renderReadyState,
} from '../../src/uikit/app/view-refresh';

function createApp(options: {
  settingsHidden?: boolean;
  contactsHidden?: boolean;
  /** 消息列表是否贴底（默认贴底）；上翻阅读中重绘不得滚底。 */
  messageListNearBottom?: boolean;
} = {}) {
  const switchView = vi.fn();
  const openConversation = vi.fn();
  const renderConversationList = vi.fn();
  const renderMessages = vi.fn();
  const scrollToBottom = vi.fn();
  const rerenderCurrentDetailPanel = vi.fn();
  const refreshDetailPanel = vi.fn();
  const applyConversationGuards = vi.fn();
  const renderSettings = vi.fn();
  const refreshContactsDisplay = vi.fn();
  const showAppView = vi.fn();
  const showToast = vi.fn();
  const app = {
    views: {
      auth: { showAppView },
      chat: {
        switchView,
        openConversation,
        renderConversationList,
        renderMessages,
        scrollToBottom,
        rerenderCurrentDetailPanel,
        refreshDetailPanel,
        applyConversationGuards,
      },
      settings: { renderSettings },
      contacts: { refreshContactsDisplay },
    },
    client: {},
    showToast,
    t: vi.fn((key: string) => key === 'chat.preferenceSyncFailed' ? 'sync failed: ' : key),
    $: vi.fn((id: string) => ({
      // isNearBottom 度量：贴底时 scrollTop + clientHeight >= scrollHeight - 50。
      scrollTop: 0,
      clientHeight: 500,
      scrollHeight: (options.messageListNearBottom ?? true) ? 500 : 2000,
      classList: {
        contains: (className: string) => {
          if (className !== 'hidden') return false;
          if (id === 'view-settings') return options.settingsHidden ?? false;
          if (id === 'view-contacts') return options.contactsHidden ?? false;
          return false;
        },
      },
    })),
  };

  return {
    app: app as unknown as Parameters<typeof renderReadyState>[0],
    switchView,
    openConversation,
    renderConversationList,
    renderMessages,
    scrollToBottom,
    rerenderCurrentDetailPanel,
    refreshDetailPanel,
    applyConversationGuards,
    renderSettings,
    refreshContactsDisplay,
    showAppView,
    showToast,
  };
}

describe('view-refresh helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renderReadyState shows app view and syncs route-driven surfaces', () => {
    vi.stubGlobal('location', { hash: '#/chat' });
    const ctx = createApp();

    renderReadyState(ctx.app);

    expect(ctx.showAppView).toHaveBeenCalledOnce();
    expect(ctx.switchView).toHaveBeenCalledWith('chat', { updateRoute: false });
    expect(ctx.renderConversationList).toHaveBeenCalledOnce();
    expect(ctx.renderSettings).toHaveBeenCalledOnce();
  });

  it('refreshVisibleViews applies shared rerender sequence with visibility rules', () => {
    const ctx = createApp({ settingsHidden: true, contactsHidden: true });

    refreshVisibleViews(ctx.app, {
      detail: 'refresh',
      settings: 'visible',
      contacts: 'always',
    });

    expect(ctx.renderConversationList).toHaveBeenCalledOnce();
    expect(ctx.renderMessages).toHaveBeenCalledOnce();
    expect(ctx.scrollToBottom).toHaveBeenCalledOnce(); // 贴底时保持贴底
    expect(ctx.refreshDetailPanel).toHaveBeenCalledOnce();
    expect(ctx.rerenderCurrentDetailPanel).not.toHaveBeenCalled();
    expect(ctx.renderSettings).not.toHaveBeenCalled();
    expect(ctx.refreshContactsDisplay).toHaveBeenCalledOnce();
    expect(ctx.applyConversationGuards).toHaveBeenCalledOnce();
  });

  it('refreshVisibleViews keeps reading position when user scrolled up', () => {
    const ctx = createApp({ messageListNearBottom: false });

    refreshVisibleViews(ctx.app);

    expect(ctx.renderMessages).toHaveBeenCalledOnce();
    expect(ctx.scrollToBottom).not.toHaveBeenCalled(); // 上翻阅读中不打断
  });
});
