import type { AppInstance } from '../app-instance';
import { openConversation, refreshChatHeader, refreshConversations, renderConversationList } from './chat/conversation-list';
import { refreshDetailPanel, rerenderCurrentDetailPanel } from './chat/detail-panel';
import { applyConversationGuards } from './chat/composer';
import {
  refreshOpenConversation,
  removeMessage,
  renderMessages,
  scrollToBottom,
} from './chat/message-list';
import { startDMFromContact, switchView } from './chat/navigation';
import { setupChat } from './chat/setup';

export function createChatView(app: AppInstance) {
  return {
    getCurrentConvKey(): string | null {
      return app.chatState.currentConvKey;
    },
    refreshOpenConversation() {
      return refreshOpenConversation(app);
    },
    refreshChatHeader() {
      refreshChatHeader(app);
    },
    async openConversation(target: Parameters<typeof openConversation>[1]) {
      await openConversation(app, target);
    },
    refreshDetailPanel() {
      refreshDetailPanel(app);
    },
    rerenderCurrentDetailPanel() {
      rerenderCurrentDetailPanel(app);
    },
    applyConversationGuards() {
      applyConversationGuards(app);
    },
    registerViewCallbacks(loadContacts: () => void, renderSettings: () => void) {
      app.chatState.loadContactsFn = loadContacts;
      app.chatState.renderSettingsFn = renderSettings;
    },
    renderConversationList(options?: Parameters<typeof renderConversationList>[1]) {
      renderConversationList(app, options);
    },
    refreshConversations(keys: string[]) {
      return refreshConversations(app, keys);
    },
    removeMessage(messageId: string) {
      removeMessage(app, messageId);
    },
    renderMessages() {
      renderMessages(app);
    },
    scrollToBottom() {
      scrollToBottom(app);
    },
    setupChat() {
      setupChat(app);
    },
    startDMFromContact(uid: string) {
      startDMFromContact(app, uid);
    },
    switchView(name: string) {
      switchView(app, name);
    },
  };
}
