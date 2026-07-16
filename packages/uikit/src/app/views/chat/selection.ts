import type { Message } from '@yimsg/sdk';
import type { AppInstance } from '../../app-instance';
import { clearComposerQuote } from './composer';

export function registerSelectionForwardHandler(app: AppInstance, handler: () => Promise<void> | void) {
  app.chatState.forwardSelectionHandler = handler;
}

export function closeMessageActionMenu(app: AppInstance) {
  app.chatState.messageActionMenu?.remove();
  app.chatState.messageActionMenu = null;
}

function ensureSelectionBar(app: AppInstance) {
  if (app.dom.getElementById('msg-selection-bar')) return;

  const bar = app.dom.ownerDocument.createElement('div');
  bar.id = 'msg-selection-bar';
  bar.className = 'msg-selection-bar hidden';
  bar.innerHTML = `
    <span id="msg-selection-count"></span>
    <div class="msg-selection-actions">
      <button id="msg-selection-cancel" class="btn btn-secondary btn-sm" type="button">${app.escapeHtml(app.t('chat.multiSelectCancel'))}</button>
      <button id="msg-selection-forward" class="btn btn-primary btn-sm" type="button">${app.escapeHtml(app.t('chat.multiSelectForward'))}</button>
    </div>
  `;
  app.$('message-input-area').prepend(bar);
  app.$('msg-selection-cancel').addEventListener('click', () => exitMessageSelectionMode(app));
  app.$('msg-selection-forward').addEventListener('click', () => {
    void app.chatState.forwardSelectionHandler?.();
  });
}

export function updateSelectionBar(app: AppInstance) {
  ensureSelectionBar(app);
  const count = app.chatState.selectedMessageIds.size;
  app.$('msg-selection-count').textContent = app.t('chat.multiSelectCount', { n: String(count) });
  (app.$('msg-selection-forward') as HTMLButtonElement).disabled = count === 0;
  app.$('msg-selection-bar').classList.toggle('hidden', !app.chatState.messageSelectionMode);
}

export function enterMessageSelectionMode(app: AppInstance, seedMsg?: Message) {
  app.chatState.messageSelectionMode = true;
  app.chatState.selectedMessageIds.clear();
  if (seedMsg) app.chatState.selectedMessageIds.add(seedMsg.messageId);
  clearComposerQuote(app);
  updateSelectionBar(app);
  closeMessageActionMenu(app);
  app.views.chat?.renderMessages();
}

export function exitMessageSelectionMode(app: AppInstance) {
  app.chatState.messageSelectionMode = false;
  app.chatState.selectedMessageIds.clear();
  updateSelectionBar(app);
  app.views.chat?.renderMessages();
}
