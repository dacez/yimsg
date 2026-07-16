import { freezeObject } from './readonly';
import type {
  ConversationDescriptor,
  ConversationTarget,
  LocalConversation,
  Message,
} from '../types';
import { convKeyOf, fromConvKey, parseConvKey, toConvKey } from '../utils';

type ConversationSource = ConversationTarget | LocalConversation | string;

function descriptorFromKey(key: string): ConversationDescriptor {
  const parsed = parseConvKey(key);
  return freezeObject({
    key,
    kind: parsed.isGroup ? 'group' as const : 'direct' as const,
    id: parsed.id,
    target: fromConvKey(key),
  });
}

function isLocalConversation(source: ConversationTarget | LocalConversation): source is LocalConversation {
  return 'lastSeq' in source || 'lastMessage' in source;
}

export function describeConversation(source: ConversationSource): ConversationDescriptor {
  if (typeof source === 'string') return descriptorFromKey(source);
  if (isLocalConversation(source)) return descriptorFromKey(convKeyOf(source));
  return descriptorFromKey(toConvKey(source));
}

export function describeMessageConversation(message: Message, currentUid: string): ConversationDescriptor {
  const groupId = message.groupId;
  if (groupId && groupId !== '0') return descriptorFromKey(`g:${groupId}`);

  const senderId = message.senderId;
  const recipientId = message.recipientId;
  const peerId = senderId === currentUid ? recipientId : senderId;
  return descriptorFromKey(`u:${peerId || '0'}`);
}
