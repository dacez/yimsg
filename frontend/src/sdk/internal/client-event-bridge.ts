import { freezeArray, freezeObject } from './readonly';
import { MSG_TYPE_RECALL } from '../../constants';
import { conversationKeyFromMessage, mapMessage } from './model-mappers';
import type { YimsgError } from '../errors';
import type {
  ClientEvents,
  ContactsUpdateReason,
  DisplayInfoScope,
  SessionSnapshot,
} from '../types';
import type {
  Contact as RawContact,
  Message as RawMessage,
} from '../../types';

type ConnectionEventName =
  | 'connection:connected'
  | 'connection:disconnected'
  | 'connection:reconnecting';

type EmitClientEvent = <K extends keyof ClientEvents>(
  event: K,
  payload: Parameters<ClientEvents[K]>[0],
) => void;

interface ClientEventBridgeDeps {
  emitClientEvent: EmitClientEvent;
  getSessionSnapshot: () => SessionSnapshot;
}

export function normalizeRecallEvents(messages: RawMessage[], options: { sortBySeq?: boolean } = {}): RawMessage[] {
  const patchedByMsgID = new Map<string, RawMessage>();
  const passthrough: RawMessage[] = [];

  for (const message of messages) {
    const recall = message.body?.recall;
    // recall 事件消息（新 msg_id，recall.msg_id 指向原消息）：折叠为原消息的撤回占位。
    if (message.msg_type === MSG_TYPE_RECALL && recall && String(recall.msg_id) !== String(message.msg_id)) {
      patchedByMsgID.set(String(recall.msg_id), {
        ...message,
        msg_id: String(recall.msg_id),
      });
      continue;
    }
    passthrough.push(message);
  }

  if (patchedByMsgID.size === 0) {
    return messages;
  }

  const normalized: RawMessage[] = [];
  for (const message of passthrough) {
    const patched = patchedByMsgID.get(message.msg_id);
    if (!patched) {
      normalized.push(message);
      continue;
    }
    normalized.push({
      ...message,
      seq: patched.seq,
      msg_type: patched.msg_type,
      body: patched.body,
      send_time: patched.send_time,
    });
    patchedByMsgID.delete(message.msg_id);
  }

  for (const patched of patchedByMsgID.values()) {
    normalized.push(patched);
  }

  if (options.sortBySeq) {
    normalized.sort((a, b) => a.seq - b.seq);
  }
  return normalized;
}

export class ClientEventBridge {
  constructor(private readonly deps: ClientEventBridgeDeps) {}

  emitConnectionEvent(eventName: ConnectionEventName): void {
    this.deps.emitClientEvent(eventName, freezeObject({
      snapshot: this.deps.getSessionSnapshot(),
    }));
  }

  emitAuthenticated(uid: string): void {
    this.deps.emitClientEvent('auth:authenticated', freezeObject({
      uid,
      snapshot: this.deps.getSessionSnapshot(),
    }));
  }

  emitSessionKicked(): void {
    this.deps.emitClientEvent('session:kicked', freezeObject({
      snapshot: this.deps.getSessionSnapshot(),
    }));
  }

  emitMessagesReceived(messages: RawMessage[]): void {
    const currentUid = this.deps.getSessionSnapshot().currentUid;
    const mappedMessages = freezeArray(messages.map(mapMessage));
    const conversationKeys = freezeArray(
      [...new Set(messages.map(message => conversationKeyFromMessage(message, currentUid)))],
    );
    this.deps.emitClientEvent('messages:received', freezeObject({
      messages: mappedMessages,
      conversationKeys,
    }));
  }

  /** 本端发送消息成功：keys 为发出消息所在会话 key，UI 据此让该会话移动到顶部。 */
  emitConversationsSent(keys: string[]): void {
    this.deps.emitClientEvent('conversations:sent', freezeObject({
      keys: freezeArray([...keys]),
    }));
  }

  emitContactsUpdated(reason: ContactsUpdateReason): void {
    this.deps.emitClientEvent('contacts:updated', freezeObject({
      reason,
    }));
  }

  emitDisplayUpdated(keys: string[], scope: DisplayInfoScope): void {
    this.deps.emitClientEvent('display:updated', freezeObject({
      keys: freezeArray([...keys]),
      scope,
    }));
  }

  emitError(error: YimsgError, context: string): void {
    this.deps.emitClientEvent('error', freezeObject({
      error,
      context,
      snapshot: this.deps.getSessionSnapshot(),
    }));
  }

  handleMessagesReceived(messages: RawMessage[]): void {
    // 空数组也要派发：messages:received 现在是“重绘信号”，UI 收到即重新拉取 get_*；
    // 非空时 messages 仅承载 onMessages 内容（角标/响铃）。
    const normalized = normalizeRecallEvents(messages, { sortBySeq: true });
    this.emitMessagesReceived(normalized);
  }

  handleContactsChanged(_contacts: RawContact[], _replace = false): void {
    this.emitContactsUpdated('notification_sync');
  }

  handleBlocklistChanged(): void {
    this.deps.emitClientEvent('blocklist:updated', freezeObject({
      snapshot: this.deps.getSessionSnapshot(),
      reason: 'notification',
    }));
  }

  handleMutelistChanged(): void {
    this.deps.emitClientEvent('mutelist:updated', freezeObject({
      snapshot: this.deps.getSessionSnapshot(),
      reason: 'notification',
    }));
  }

  handleOrgsChanged(orgIds: string[]): void {
    this.deps.emitClientEvent('org:updated', freezeObject({
      snapshot: this.deps.getSessionSnapshot(),
      orgIds: Object.freeze([...orgIds]),
    }));
  }

  handleUnreadCleared(convKey: string): void {
    this.deps.emitClientEvent('conversations:clearunread', freezeObject({
      keys: freezeArray([convKey]),
    }));
  }

  handleConversationDeleted(convKey: string): void {
    this.deps.emitClientEvent('conversations:delete', freezeObject({
      keys: freezeArray([convKey]),
    }));
  }

  handleMessageDeleted(messageId: string, convKey: string): void {
    this.deps.emitClientEvent('messages:deleted', freezeObject({
      messageId,
      key: convKey,
    }));
  }
}
