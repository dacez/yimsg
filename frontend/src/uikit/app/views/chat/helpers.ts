import type {
  ConversationDescriptor,
  LocalConversation,
  Message,
  UserDisplayInfo,
} from '../../../../sdk';
import {
  MSG_TYPE_FILE,
  MSG_TYPE_IMAGE,
  MSG_TYPE_RECALL,
  MSG_TYPE_SYSTEM,
} from '../../../../constants';
import {
  displayGroupName,
  displayUserName,
} from '../../../../sdk';
import type { AppInstance } from '../../app-instance';
import { isMobileInteractionLayout } from '../../utils';

export function currentConversation(app: AppInstance): ConversationDescriptor | null {
  return app.chatState.currentConvKey ? app.client.describeConversation(app.chatState.currentConvKey) : null;
}

function isConversationPaneVisible(app: AppInstance): boolean {
  const chatView = app.$('view-chat');
  if (chatView.classList.contains('hidden')) return false;
  if (!isMobileInteractionLayout(app)) return true;
  return chatView.classList.contains('mobile-showing-chat');
}

export function canAutoClearUnreadCurrentConversation(app: AppInstance): boolean {
  return Boolean(currentConversation(app) && isConversationPaneVisible(app));
}

// 纯文本预览：真实内容来自 body，由 describeMessage 派生可读文本。
function plainText(app: AppInstance, msg: Message): string {
  const msgType = msg.messageType;
  if (msgType === MSG_TYPE_IMAGE) return app.t('chat.previewImage');
  if (msgType === MSG_TYPE_FILE) return app.t('chat.previewFile');
  return app.client.describeMessage(msg).text.replace(/\n/g, ' ');
}

export function msgPreview(
  app: AppInstance,
  msg: Message,
  isGroup: boolean,
  senderMap?: ReadonlyMap<string, UserDisplayInfo>,
): string {
  const base = plainText(app, msg);
  if (msg.messageType === MSG_TYPE_SYSTEM) return base;
  if (msg.messageType === MSG_TYPE_IMAGE || msg.messageType === MSG_TYPE_FILE) return base;

  const fromUid = msg.senderId || '0';
  if (isGroup && fromUid !== '0') {
    const sender = senderMap?.get(fromUid) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
    return displayUserName(sender, app.t('chat.unknown')) + ': ' + base;
  }
  return base;
}

export function quotePreview(app: AppInstance, msg: Message): string {
  return plainText(app, msg);
}

export function formatForwardBlockText(app: AppInstance, count: number): string {
  return app.t('chat.forwardBlockSummary', { n: String(count) });
}

export function canRecallMessage(app: AppInstance, msg: Message): boolean {
  if (msg.senderId !== app.client.getSessionSnapshot().currentUid) return false;
  if (msg.messageType === MSG_TYPE_SYSTEM) return false;
  // 已是撤回占位/事件的消息不可再撤回。
  if (msg.messageType === MSG_TYPE_RECALL) return false;

  const recallWindowSeconds = app.client.getClientConfig().recallWindowsSeconds;
  if (recallWindowSeconds <= 0) return false;
  return Date.now() - msg.sentAt <= recallWindowSeconds * 1000;
}

export function conversationLabel(app: AppInstance, conv: LocalConversation): string {
  const conversation = app.client.describeConversation(conv);
  if (conversation.kind === 'group') {
    const group = app.client.getGroupInfos([conversation.id]).get(conversation.id) || { name: '', avatarUrl: '', remarkName: '' };
    return displayGroupName(group, app.t('chat.group'));
  }
  const user = app.client.getUserInfos([conversation.id]).get(conversation.id) || { nickname: '', avatarUrl: '', remarkName: '', username: '' };
  return displayUserName(user, conversation.id);
}
