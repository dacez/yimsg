import type {
  Message,
} from '@yimsg/sdk';
import { displayUserName } from '@yimsg/sdk';
import { APP_CONFIG } from '../../../app-config';
import type { AppInstance } from '../../app-instance';
import { showGroupMemberPicker } from '../group-member-picker';
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
  const markdownToggle = app.dom.getElementById<HTMLButtonElement>('msg-markdown-toggle');
  if (markdownToggle) markdownToggle.disabled = false;
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
  // 引用回复只承载纯文本正文（QuoteBody.text），引用中无法发送 Markdown 消息。
  app.chatState.composerMarkdownMode = false;
  syncComposerMarkdownButton(app);
  const markdownToggle = app.dom.getElementById<HTMLButtonElement>('msg-markdown-toggle');
  if (markdownToggle) markdownToggle.disabled = true;
}

function syncComposerMarkdownButton(app: AppInstance): void {
  const active = app.chatState.composerMarkdownMode;
  const button = app.dom.getElementById<HTMLButtonElement>('msg-markdown-toggle');
  if (button) {
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const input = app.dom.getElementById<HTMLTextAreaElement>('msg-input');
  if (input) input.placeholder = app.t(active ? 'chat.typeMarkdownMessage' : 'chat.typeMessage');
}

export function toggleComposerMarkdownMode(app: AppInstance): void {
  if (app.chatState.composerQuote) return;
  app.chatState.composerMarkdownMode = !app.chatState.composerMarkdownMode;
  syncComposerMarkdownButton(app);
}

export function applyConversationGuards(app: AppInstance) {
  const input = app.$('msg-input') as HTMLTextAreaElement;
  const sendBtn = app.$('msg-send') as HTMLButtonElement;
  const attachBtn = app.$('msg-attach') as HTMLButtonElement;
  const emojiBtn = app.$('msg-emoji') as HTMLButtonElement;
  const markdownToggle = app.$('msg-markdown-toggle') as HTMLButtonElement;
  input.disabled = false;
  sendBtn.disabled = false;
  attachBtn.disabled = false;
  emojiBtn.disabled = false;
  markdownToggle.disabled = !!app.chatState.composerQuote;
  syncComposerMarkdownButton(app);
  app.$('message-input-area').classList.remove('is-blocked');
}

/** 取出仍留在文本里的待发送 @ 提及；手动删掉 "@昵称" 片段的会被过滤掉，不当成有效提及发送。 */
function pendingMentionedUids(app: AppInstance, content: string): string[] {
  const result: string[] = [];
  for (const [uid, name] of app.chatState.composerMentions) {
    if (content.includes(`@${name}`)) result.push(uid);
  }
  return result;
}

/** @全体成员同理：手动删掉 "@所有人" 片段的不当成有效提及发送。 */
function pendingMentionAll(app: AppInstance, content: string): boolean {
  return app.chatState.composerMentionAll && content.includes(`@${app.t('groupMemberPicker.allMembers')}`);
}

export async function sendMessage(app: AppInstance) {
  const input = app.$('msg-input') as HTMLTextAreaElement;
  const content = input.value.trim();
  if (input.disabled || !content || !app.chatState.currentConvKey) return;

  const target = app.client.describeConversation(app.chatState.currentConvKey).target;
  try {
    // @ 提及与引用回复互斥（QuoteBody 不带提及字段，引用优先），与 Markdown 也互斥
    // （MentionBody 不是富文本）；只要还有提及（具体成员或 @全体成员）且没在引用，就按提及消息发送。
    const mentionedUids = app.chatState.composerQuote ? [] : pendingMentionedUids(app, content);
    const mentionAll = !app.chatState.composerQuote && pendingMentionAll(app, content);
    if (mentionedUids.length > 0 || mentionAll) {
      const sendPromise = app.client.sendMention(target, { text: content, mentionedUids, mentionAll });
      input.value = '';
      app.chatState.composerMentions = new Map();
      app.chatState.composerMentionAll = false;
      const result = await sendPromise;
      appendLiveMessageToPage(app, result.message);
      app.views.chat?.renderMessages();
      app.views.chat?.scrollToBottom();
      return;
    }

    if (app.chatState.composerMarkdownMode && !app.chatState.composerQuote) {
      const sendPromise = app.client.sendMarkdown(target, content);
      input.value = '';
      app.chatState.composerMentions = new Map();
      app.chatState.composerMentionAll = false;
      const result = await sendPromise;
      appendLiveMessageToPage(app, result.message);
      app.views.chat?.renderMessages();
      app.views.chat?.scrollToBottom();
      return;
    }

    app.client.validateTextMessage(content);
    input.value = '';
    app.chatState.composerMentions = new Map();
    app.chatState.composerMentionAll = false;

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
  if ((app.$('msg-input') as HTMLTextAreaElement).disabled) return;

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

/**
 * 群聊输入框里刚敲下 "@" 时拉起群成员选择器；单聊没有可 @ 的对象，跳过。
 * 选中具体成员：把光标前那个刚输入的 "@" 换成 "@昵称 "。
 * 选中"所有人"：换成 "@所有人 "，标记 composerMentionAll。
 * 取消选择：原样保留 "@"，不做任何撤销处理。
 */
export async function maybeTriggerMentionPicker(app: AppInstance, input: HTMLTextAreaElement): Promise<void> {
  if (input.disabled || !app.chatState.currentConvKey) return;
  const conversation = app.client.describeConversation(app.chatState.currentConvKey);
  if (conversation.kind !== 'group') return;
  const caret = input.selectionStart ?? input.value.length;
  if (input.value[caret - 1] !== '@') return;

  const currentUid = app.client.getSessionSnapshot().currentUid;
  const pick = await showGroupMemberPicker(app, conversation.id, {
    excludeUids: [currentUid],
    includeMentionAll: true,
  });
  if (!pick) return;

  const name = pick.kind === 'all' ? app.t('groupMemberPicker.allMembers') : displayUserName(app.client.getUserInfos([pick.uid]).get(pick.uid), pick.uid);
  const mentionText = `@${name} `;
  const before = input.value.slice(0, caret - 1);
  const after = input.value.slice(caret);
  input.value = before + mentionText + after;
  const cursor = before.length + mentionText.length;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  if (pick.kind === 'all') app.chatState.composerMentionAll = true;
  else app.chatState.composerMentions.set(pick.uid, name);
}
