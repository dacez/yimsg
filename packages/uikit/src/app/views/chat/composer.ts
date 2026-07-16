import type {
  Message,
} from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from '../../app-instance';
import { currentConversation, quotePreview } from './helpers';
import { appendLiveMessageToPage } from './message-page';

function ensureQuoteBar(app: AppInstance) {
  if (app.dom.getElementById('msg-quote-bar')) return;

  const bar = app.dom.ownerDocument.createElement('div');
  bar.id = 'msg-quote-bar';
  bar.className = 'msg-quote-bar hidden';
  bar.innerHTML = `<span id="msg-quote-text"></span><button id="msg-quote-close" class="icon-btn" type="button" aria-label="${app.escapeHtml(app.t('chat.closeQuoteAria'))}">×</button>`;
  app.$('message-input-area').prepend(bar);
  app.$('msg-quote-close').addEventListener('click', () => clearComposerQuote(app));
}

export function clearComposerQuote(app: AppInstance) {
  app.chatState.composerQuote = null;
  app.dom.getElementById('msg-quote-bar')?.classList.add('hidden');
}

export function setComposerQuote(app: AppInstance, msg: Message, fromName: string) {
  ensureQuoteBar(app);
  app.chatState.composerQuote = {
    msgId: msg.messageId,
    fromUid: msg.senderId,
    fromName,
    msgType: msg.messageType,
    preview: quotePreview(app, msg).slice(0, APP_CONFIG.chat.quotePreviewChars),
    target: currentConversation(app)?.target || null,
  };
  app.$('msg-quote-bar').classList.remove('hidden');
  app.$('msg-quote-text').textContent = `${app.chatState.composerQuote.fromName}: ${app.chatState.composerQuote.preview}`;
}

export function applyConversationGuards(app: AppInstance) {
  const input = app.$('msg-input') as HTMLInputElement;
  const sendBtn = app.$('msg-send') as HTMLButtonElement;
  const attachBtn = app.$('msg-attach') as HTMLButtonElement;
  const emojiBtn = app.$('msg-emoji') as HTMLButtonElement;
  input.disabled = false;
  sendBtn.disabled = false;
  attachBtn.disabled = false;
  emojiBtn.disabled = false;
  input.placeholder = app.t('chat.typeMessage');
  app.$('message-input-area').classList.remove('is-blocked');
}

export async function sendMessage(app: AppInstance) {
  const input = app.$('msg-input') as HTMLInputElement;
  const content = input.value.trim();
  if (input.disabled || !content || !app.chatState.currentConvKey) return;

  const target = app.client.describeConversation(app.chatState.currentConvKey).target;
  try {
    app.client.validateTextMessage(content);
    input.value = '';

    if (app.chatState.composerQuote) {
      const quote = app.chatState.composerQuote;
      const result = await app.client.sendQuotedTextMessage(target, {
        text: content,
        quoteMsgId: quote.msgId,
        quotePreview: quote.preview,
      });
      appendLiveMessageToPage(app, result.message);
      clearComposerQuote(app);
      app.views.chat?.renderMessages();
      app.views.chat?.scrollToBottom();
      return;
    }

    const result = await app.client.sendText(target, content);
    appendLiveMessageToPage(app, result.message);
    clearComposerQuote(app);
    app.views.chat?.renderMessages();
    app.views.chat?.scrollToBottom();
  } catch (e) {
    app.showToast(app.t('chat.failedToSend') + (e as Error).message, 'error');
  }
}

export async function uploadAndSend(app: AppInstance, file: File, type: 'image' | 'file') {
  if (!app.chatState.currentConvKey) return;
  if ((app.$('msg-input') as HTMLInputElement).disabled) return;

  try {
    const data = await app.client.uploadFile(file, type === 'image' ? 'image' : 'file');
    const target = app.client.describeConversation(app.chatState.currentConvKey).target;

    const result = type === 'image'
      ? await app.client.sendImage(target, { mediaId: data.mediaId, size: data.size, mime: file.type })
      : await app.client.sendFile(target, { mediaId: data.mediaId, name: file.name, size: data.size, mime: file.type });
    appendLiveMessageToPage(app, result.message);
    app.views.chat?.renderMessages();
    app.views.chat?.scrollToBottom();
  } catch (e) {
    app.showToast(app.t('chat.uploadFailedColon') + (e as Error).message, 'error');
  }
}
