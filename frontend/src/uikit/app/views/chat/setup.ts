import type { AppInstance } from '../../app-instance';
import { uploadAndSend, sendMessage } from './composer';
import { showGroupDetail, showUserDetail } from './detail-panel';
import { setupEmojiPicker } from './emoji-picker';
import { forwardMessages } from './forward';
import { isNearBottom } from './message-list';
import { registerSelectionForwardHandler } from './selection';
import { isMobileInteractionLayout } from '../../utils';

export function setupChat(app: AppInstance) {
  app.$('msg-send').addEventListener('click', () => {
    void sendMessage(app);
  });
  app.$('msg-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).shiftKey) {
      e.preventDefault();
      void sendMessage(app);
    }
  });

  app.$('chat-header').addEventListener('click', (event) => {
    if (!isMobileInteractionLayout(app)) return;
    const rect = app.$('chat-header').getBoundingClientRect();
    const me = event as MouseEvent;
    if (me.clientX - rect.left < 56) {
      app.$('view-chat').classList.remove('mobile-showing-chat');
    }
  });

  setupEmojiPicker(app);

  registerSelectionForwardHandler(app, async () => {
    const selected = app.chatState.currentMessages.filter((message) => app.chatState.selectedMessageIds.has(message.messageId));
    if (selected.length === 0) {
      app.showToast(app.t('chat.multiSelectEmpty'), 'error');
      return;
    }
    await forwardMessages(app, selected);
  });

  let attachMenuOpen = false;
  app.$('msg-attach').addEventListener('click', () => {
    if (attachMenuOpen) {
      app.dom.querySelector('.attach-menu')?.remove();
      attachMenuOpen = false;
      return;
    }

    const menu = app.dom.ownerDocument.createElement('div');
    menu.className = 'attach-menu';
    menu.innerHTML = `
      <button class="attach-menu-item" data-type="image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        ${app.t('chat.image')}
      </button>
      <button class="attach-menu-item" data-type="file">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        ${app.t('chat.file')}
      </button>
    `;
    app.$('message-input-area').appendChild(menu);
    attachMenuOpen = true;

    menu.querySelector('[data-type="image"]')?.addEventListener('click', () => {
      (app.$('file-picker-image') as HTMLInputElement).click();
      menu.remove();
      attachMenuOpen = false;
    });
    menu.querySelector('[data-type="file"]')?.addEventListener('click', () => {
      (app.$('file-picker-file') as HTMLInputElement).click();
      menu.remove();
      attachMenuOpen = false;
    });

    setTimeout(() => {
      const handler = (event: Event) => {
        if (!menu.contains(event.target as Node) && (event.target as HTMLElement).id !== 'msg-attach') {
          menu.remove();
          attachMenuOpen = false;
          app.dom.ownerDocument.removeEventListener('click', handler);
        }
      };
      app.dom.ownerDocument.addEventListener('click', handler);
    }, 0);
  });

  app.$('file-picker-image').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) {
      void uploadAndSend(app, input.files[0], 'image');
      input.value = '';
    }
  });
  app.$('file-picker-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) {
      void uploadAndSend(app, input.files[0], 'file');
      input.value = '';
    }
  });

  // 滚动监听由各列表的 BoundedStreamWindow 统一持有（首次 render 时挂载）。
  // 这里只兜底"贴底时图片完成加载使内容增高"：load 不冒泡，用捕获监听。
  app.$('message-list').addEventListener('load', () => {
    const list = app.$('message-list');
    if (isNearBottom(list)) list.scrollTop = list.scrollHeight;
  }, true);

  app.$('toggle-detail').addEventListener('click', () => {
    if (app.chatState.detailOpen) {
      app.chatState.detailRequestId++;
      app.chatState.detailOpen = false;
      app.$('right-panel').classList.add('collapsed');
      app.$('view-chat').classList.remove('mobile-showing-detail');
      return;
    }
    if (!app.chatState.currentConvKey) return;

    const conversation = app.client.describeConversation(app.chatState.currentConvKey);
    if (conversation.kind === 'group') void showGroupDetail(app, conversation.id);
    else void showUserDetail(app, conversation.id);
  });

  app.$('detail-mobile-back').addEventListener('click', () => {
    app.chatState.detailRequestId++;
    app.chatState.detailOpen = false;
    app.$('right-panel').classList.add('collapsed');
    app.$('view-chat').classList.remove('mobile-showing-detail');
  });
}
