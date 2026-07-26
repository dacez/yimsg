import type { ForwardAttachmentInfo, Message, MessageQuoteInfo } from '@yimsg/sdk';
import { displayUserName, formatTime } from '@yimsg/sdk';
import type { AppInstance } from '../../app-instance';
import { describeError } from '../../error-i18n';
import { fillMessageBubble } from './message-list';

// 转发详情/引用详情都复用同一套"消息条目"渲染：头部姓名+时间，正文复用 fillMessageBubble
// （与消息列表内联渲染完全一致，图片可点开大图、文件可下载）。全程用 createElement/textContent
// 拼装 DOM，不走 innerHTML 拼串——标题、发件人昵称、引用预览等都来自消息正文，是外部可控内容。
function renderDetailMessageItem(app: AppInstance, msg: Message): HTMLElement {
  const myUid = app.client.getSessionSnapshot().currentUid;
  const fromUid = msg.senderId || '0';
  const isSelf = fromUid === myUid;
  const sender = app.client.getUserInfos([fromUid]).get(fromUid)
    || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
  const fromName = isSelf ? app.t('chat.selfName') : displayUserName(sender, fromUid);

  const item = app.dom.ownerDocument.createElement('div');
  item.className = 'message-detail-item';

  const header = app.dom.ownerDocument.createElement('div');
  header.className = 'message-detail-item-header';
  const name = app.dom.ownerDocument.createElement('span');
  name.className = 'message-detail-item-name';
  name.textContent = fromName;
  const time = app.dom.ownerDocument.createElement('span');
  time.textContent = formatTime(msg.sentAt);
  header.appendChild(name);
  header.appendChild(time);
  item.appendChild(header);

  const bubble = app.dom.ownerDocument.createElement('div');
  bubble.className = 'message-bubble';
  fillMessageBubble(app, bubble, msg);
  item.appendChild(bubble);
  return item;
}

function renderPlaceholderItem(app: AppInstance, text: string): HTMLElement {
  const item = app.dom.ownerDocument.createElement('div');
  item.className = 'message-detail-item message-detail-missing';
  item.textContent = text;
  return item;
}

function openDetailModal(app: AppInstance, title: string, wide: boolean): { list: HTMLElement } {
  const modal = app.$('modal-content');
  modal.classList.toggle('modal-content-wide', wide);
  modal.innerHTML = '';

  const titleEl = app.dom.ownerDocument.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;

  const list = app.dom.ownerDocument.createElement('div');
  list.className = 'message-detail-list';
  list.textContent = app.t('common.loading');

  const actions = app.dom.ownerDocument.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = app.dom.ownerDocument.createElement('button') as HTMLButtonElement;
  closeBtn.className = 'btn btn-secondary';
  closeBtn.type = 'button';
  closeBtn.textContent = app.t('common.close');
  closeBtn.addEventListener('click', () => {
    modal.classList.remove('modal-content-wide');
    app.closeModal();
  });
  actions.appendChild(closeBtn);

  modal.appendChild(titleEl);
  modal.appendChild(list);
  modal.appendChild(actions);
  app.$('modal-overlay').classList.remove('hidden');

  return { list };
}

/** 转发消息点击查看：按 msg_ids 拉取被转发消息全文，逐条展示；已被删除的条目用占位文案兜底。 */
export async function showForwardDetailModal(app: AppInstance, forward: ForwardAttachmentInfo): Promise<void> {
  const { list } = openDetailModal(app, forward.title || app.t('chat.forwardPreviewLabel'), true);
  try {
    const messages = await app.client.getMessagesByIds(forward.messageIds);
    const byId = new Map(messages.map((m) => [m.messageId, m]));
    list.textContent = '';
    for (const msgId of forward.messageIds) {
      const msg = byId.get(msgId);
      list.appendChild(
        msg ? renderDetailMessageItem(app, msg) : renderPlaceholderItem(app, app.t('chat.forwardMessageNotFound')),
      );
    }
  } catch (e) {
    list.textContent = app.t('chat.forwardDetailLoadFailed') + describeError(app, e);
  }
}

/** 引用消息点击查看：按 quote_msg_id 拉取被引用的原始消息全文；原消息已不存在时退回展示引用预览。 */
export async function showQuoteDetailModal(app: AppInstance, quote: MessageQuoteInfo): Promise<void> {
  const { list } = openDetailModal(app, app.t('chat.quoteDetailTitle'), false);
  try {
    const messages = await app.client.getMessagesByIds([quote.messageId]);
    list.textContent = '';
    if (messages[0]) {
      list.appendChild(renderDetailMessageItem(app, messages[0]));
    } else {
      list.appendChild(renderPlaceholderItem(app, app.t('chat.quoteMessageNotFound')));
      list.appendChild(renderPlaceholderItem(app, quote.preview));
    }
  } catch (e) {
    list.textContent = app.t('chat.quoteDetailLoadFailed') + describeError(app, e);
  }
}
