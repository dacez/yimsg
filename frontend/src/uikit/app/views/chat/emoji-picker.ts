import type { AppInstance } from '../../app-instance';
import { EMOJI_CATEGORIES } from './emoji-data';

function insertEmojiAtCursor(input: HTMLInputElement, emoji: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const value = input.value;
  input.value = value.slice(0, start) + emoji + value.slice(end);
  const cursor = start + emoji.length;
  input.focus();
  input.setSelectionRange(cursor, cursor);
}

export function setupEmojiPicker(app: AppInstance) {
  let panel: HTMLElement | null = null;
  let outsideClickHandler: ((event: Event) => void) | null = null;
  let activeCategoryId = EMOJI_CATEGORIES[0].id;

  function renderGrid(container: HTMLElement, categoryId: string) {
    const category = EMOJI_CATEGORIES.find((c) => c.id === categoryId) ?? EMOJI_CATEGORIES[0];
    container.innerHTML = category.emojis
      .map((emoji) => `<button type="button" class="emoji-picker-item">${emoji}</button>`)
      .join('');
  }

  function closePanel() {
    panel?.remove();
    panel = null;
    if (outsideClickHandler) {
      app.dom.ownerDocument.removeEventListener('click', outsideClickHandler);
      outsideClickHandler = null;
    }
  }

  function openPanel() {
    if (panel) {
      closePanel();
      return;
    }

    const el = app.dom.ownerDocument.createElement('div');
    el.className = 'emoji-picker';
    el.innerHTML = `
      <div class="emoji-picker-tabs">
        ${EMOJI_CATEGORIES.map((c) => `<button type="button" class="emoji-picker-tab${c.id === activeCategoryId ? ' active' : ''}" data-category="${c.id}">${c.icon}</button>`).join('')}
      </div>
      <div class="emoji-picker-grid"></div>
    `;
    app.$('message-input-area').appendChild(el);
    panel = el;

    const grid = el.querySelector('.emoji-picker-grid') as HTMLElement;
    renderGrid(grid, activeCategoryId);

    grid.addEventListener('click', (event) => {
      const btn = (event.target as HTMLElement).closest('.emoji-picker-item');
      if (!btn) return;
      insertEmojiAtCursor(app.$('msg-input') as HTMLInputElement, btn.textContent || '');
    });

    el.querySelector('.emoji-picker-tabs')?.addEventListener('click', (event) => {
      const tab = (event.target as HTMLElement).closest('.emoji-picker-tab') as HTMLElement | null;
      if (!tab) return;
      activeCategoryId = tab.dataset.category || activeCategoryId;
      el.querySelectorAll('.emoji-picker-tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderGrid(grid, activeCategoryId);
    });

    setTimeout(() => {
      const handler = (event: Event) => {
        if (!el.contains(event.target as Node) && (event.target as HTMLElement).id !== 'msg-emoji') {
          closePanel();
        }
      };
      outsideClickHandler = handler;
      app.dom.ownerDocument.addEventListener('click', handler);
    }, 0);
  }

  app.$('msg-emoji').addEventListener('click', () => {
    openPanel();
  });
}
