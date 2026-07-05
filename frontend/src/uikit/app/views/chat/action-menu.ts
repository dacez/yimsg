import type { Message } from '../../../../sdk';
import type { AppInstance } from '../../app-instance';
import { setComposerQuote } from './composer';
import { forwardMessages } from './forward';
import { canRecallMessage } from './helpers';
import {
  closeMessageActionMenu,
  enterMessageSelectionMode,
} from './selection';

export function showMessageActionMenu(app: AppInstance, anchor: HTMLElement, msg: Message, fromName: string, x?: number, y?: number) {
  closeMessageActionMenu(app);
  const recallAction = canRecallMessage(app, msg)
    ? `<button class="message-action-item" type="button" data-action="recall">${app.t('chat.recall')}</button>`
    : '';

  const menu = app.dom.ownerDocument.createElement('div');
  menu.className = 'message-action-menu';
  menu.innerHTML = `
    ${recallAction}
    <button class="message-action-item" type="button" data-action="quote">${app.t('chat.quote')}</button>
    <button class="message-action-item" type="button" data-action="forward">${app.t('chat.forward')}</button>
    <button class="message-action-item" type="button" data-action="multi-select">${app.t('chat.multiSelect')}</button>
  `;

  menu.querySelector('[data-action="recall"]')?.addEventListener('click', async () => {
    closeMessageActionMenu(app);
    try {
      await app.client.recallMessage(msg);
    } catch (err) {
      app.showToast(app.t('chat.recallFailed') + (err as Error).message, 'error');
    }
  });
  menu.querySelector('[data-action="quote"]')?.addEventListener('click', () => {
    setComposerQuote(app, msg, fromName);
    closeMessageActionMenu(app);
  });
  menu.querySelector('[data-action="forward"]')?.addEventListener('click', async () => {
    closeMessageActionMenu(app);
    await forwardMessages(app, [msg]);
  });
  menu.querySelector('[data-action="multi-select"]')?.addEventListener('click', () => {
    enterMessageSelectionMode(app, msg);
    closeMessageActionMenu(app);
  });

  app.appendFloatingElement(menu);
  if (typeof x === 'number' && typeof y === 'number') {
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  } else {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(12, rect.right - 116)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
  }
  app.chatState.messageActionMenu = menu;

  const doc = app.dom.ownerDocument;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - rect.width - 12, Math.max(12, rect.left))}px`;
    menu.style.top = `${Math.min(window.innerHeight - rect.height - 12, Math.max(12, rect.top))}px`;
  });

  setTimeout(() => {
    const dismiss = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || anchor.contains(target))) return;
      closeMessageActionMenu(app);
      doc.removeEventListener('click', dismiss);
      doc.removeEventListener('contextmenu', dismiss);
      doc.removeEventListener('keydown', onKeydown);
    };
    const onKeydown = (event: Event) => {
      if ((event as KeyboardEvent).key !== 'Escape') return;
      closeMessageActionMenu(app);
      doc.removeEventListener('click', dismiss);
      doc.removeEventListener('contextmenu', dismiss);
      doc.removeEventListener('keydown', onKeydown);
    };
    doc.addEventListener('click', dismiss);
    doc.addEventListener('contextmenu', dismiss);
    doc.addEventListener('keydown', onKeydown);
  }, 0);
}
