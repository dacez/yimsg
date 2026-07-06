import type {
  UserInfo as RawUserInfo,
  Contact as RawContact,
  BlocklistUser as RawBlocklistUser,
  MutelistEntry as RawMutelistEntry,
  Message as RawMessage,
  GroupMember as RawGroupMember,
  LocalConversation as RawLocalConversation,
  OrgInfo as RawOrgInfo,
  TagInfo as RawTagInfo,
  Tag as RawTag,
} from '../../types';
import type {
  UserInfo,
  UserDisplayInfo,
  Contact,
  BlocklistUser,
  Message,
  GroupDisplayInfo,
  GroupMember,
  LocalConversation,
  MutelistEntry,
  OrgInfo,
  OrgDisplayInfo,
  TagInfo,
  TagDisplayInfo,
  Tag,
} from '../types';
import { MSG_TYPE_TEXT } from '../../constants';
import { freezeObject } from './readonly';

export function mapUserInfo(profile: RawUserInfo): UserInfo {
  return freezeObject({
    uid: String(profile.uid),
    username: profile.username || '',
    nickname: profile.nickname || '',
    avatarUrl: profile.avatar || '',
    remarkName: profile.remark,
    createdAt: profile.created_at || 0,
    updatedAt: profile.updated_at || 0,
  });
}

export function mapUserDisplayInfo(info: { username: string; nickname: string; avatar: string; remark: string }): UserDisplayInfo {
  return freezeObject({
    username: info.username || '',
    nickname: info.nickname || '',
    avatarUrl: info.avatar || '',
    remarkName: info.remark || '',
  });
}

export function mapGroupDisplayInfo(info: { name: string; avatar: string; remark: string }): GroupDisplayInfo {
  return freezeObject({
    name: info.name || '',
    avatarUrl: info.avatar || '',
    remarkName: info.remark || '',
  });
}

function mapTarget(source?: { uid?: string | number; group_id?: string; groupId?: string; to_uid?: string; friend_uid?: string }) {
  const groupId = String(source?.group_id || source?.groupId || '0');
  if (groupId !== '0') return { groupId };
  return { toUid: String(source?.uid || source?.to_uid || source?.friend_uid || '0') };
}

export function mapContact(contact: RawContact): Contact {
  const orgId = String(contact.target?.org_id || contact.org_id || '0');
  if (orgId !== '0') {
    return freezeObject({
      target: { orgId },
      friendUid: '0',
      groupId: '0',
      orgId,
      status: Number(contact.status || 0),
      seq: Number(contact.seq || 0),
      remarkName: contact.remark_name,
      sortKey: contact.sort_key,
      searchText: contact.search_text,
    });
  }
  return freezeObject({
    target: mapTarget(contact.target || contact),
    friendUid: mapTarget(contact.target || contact).toUid ?? '0',
    groupId: mapTarget(contact.target || contact).groupId ?? '0',
    orgId: '0',
    status: Number(contact.status || 0),
    seq: Number(contact.seq || 0),
    remarkName: contact.remark_name,
    sortKey: contact.sort_key,
    searchText: contact.search_text,
  });
}

export function mapOrgInfo(org: RawOrgInfo): OrgInfo {
  return freezeObject({
    orgId: String(org.org_id || '0'),
    name: String(org.name || ''),
    avatarUrl: String(org.avatar || ''),
  });
}

export function mapOrgDisplayInfo(info: { name: string; avatar: string }): OrgDisplayInfo {
  return freezeObject({
    name: info.name || '',
    avatarUrl: info.avatar || '',
  });
}

export function mapTagInfo(tag: RawTagInfo): TagInfo {
  return freezeObject({
    tagId: String(tag.tag_id || '0'),
    name: String(tag.name || ''),
    avatarUrl: String(tag.avatar || ''),
  });
}

export function mapTagDisplayInfo(info: { name: string; avatar: string }): TagDisplayInfo {
  return freezeObject({
    name: info.name || '',
    avatarUrl: info.avatar || '',
  });
}

export function mapTag(item: RawTag): Tag {
  return freezeObject({
    tagId: String(item.tag_id || '0'),
    childId: String(item.child_id || '0'),
    childType: Number(item.child_type || 0),
    title: String(item.title || ''),
    rank: Number(item.rank || 0),
    sortKey: String(item.sort_key || ''),
    role: Number(item.role || 0),
    seq: Number(item.seq || 0),
  });
}

export function mapBlocklistUser(user: RawBlocklistUser): BlocklistUser {
  return freezeObject({
    uid: String(user.uid || '0'),
    status: Number(user.status || 0),
    seq: Number(user.seq || 0),
    createdAt: Number(user.created_at || 0),
    updatedAt: Number(user.updated_at || 0),
  });
}

export function mapMutelistEntry(entry: RawMutelistEntry): MutelistEntry {
  return freezeObject({
    target: mapTarget(entry.target || entry),
    toUid: mapTarget(entry.target || entry).toUid ?? '0',
    groupId: mapTarget(entry.target || entry).groupId ?? '0',
    status: Number(entry.status || 0),
    seq: Number(entry.seq || 0),
    updatedAt: Number(entry.updated_at || 0),
  });
}

function mapBody(body: RawMessage['body'] | undefined): Message['body'] {
  const b = (body || {}) as NonNullable<RawMessage['body']>;
  const out: Message['body'] = {};
  if (b.text) out.text = { text: b.text.text || '' };
  if (b.markdown) out.markdown = { markdown: b.markdown.markdown || '' };
  if (b.system) out.system = { text: b.system.text || '' };
  if (b.image) {
    out.image = {
      media_id: String(b.image.media_id || '0'),
      size: Number(b.image.size || 0),
      width: Number(b.image.width || 0),
      height: Number(b.image.height || 0),
      mime: b.image.mime || '',
      caption: b.image.caption || '',
    };
  }
  if (b.file) {
    out.file = {
      media_id: String(b.file.media_id || '0'),
      name: b.file.name || '',
      size: Number(b.file.size || 0),
      mime: b.file.mime || '',
    };
  }
  if (b.recall) {
    out.recall = {
      msg_id: String(b.recall.msg_id || '0'),
      operator_uid: String(b.recall.operator_uid || '0'),
      recall_time: Number(b.recall.recall_time || 0),
      text: b.recall.text || '',
    };
  }
  if (b.quote) {
    out.quote = {
      quote_msg_id: String(b.quote.quote_msg_id || '0'),
      quote_preview: b.quote.quote_preview || '',
      text: { text: b.quote.text?.text || '' },
    };
  }
  if (b.forward) {
    out.forward = {
      msg_ids: (b.forward.msg_ids || []).map((id) => String(id)),
      title: b.forward.title || '',
    };
  }
  return out;
}

export function mapMessage(message: RawMessage): Message {
  return freezeObject({
    seq: Number(message.seq || 0),
    messageId: String(message.msg_id || ''),
    senderId: String(message.from_uid || '0'),
    recipientId: mapTarget(message.target || message).toUid ?? '0',
    groupId: mapTarget(message.target || message).groupId ?? '0',
    messageType: Number(message.msg_type || MSG_TYPE_TEXT) as Message['messageType'],
    body: mapBody(message.body),
    sentAt: Number(message.send_time || 0),
    status: Number(message.status || 0),
  });
}

export function conversationKeyFromMessage(message: RawMessage, currentUid: string): string {
  const target = mapTarget(message.target || message);
  if ('groupId' in target) return `g:${target.groupId}`;
  const peerUid = String(message.from_uid) === currentUid ? target.toUid : String(message.from_uid || '0');
  return `u:${peerUid}`;
}

export function mapLocalConversation(entry: RawLocalConversation): LocalConversation {
  return freezeObject({
    groupId: mapTarget(entry.target || entry).groupId ?? '0',
    friendUid: mapTarget(entry.target || entry).toUid ?? '0',
    lastSeq: Number(entry.last_seq || 0),
    lastMessage: entry.last_msg ? mapMessage(entry.last_msg) : null,
    unreadCount: Number(entry.unread_count || 0),
    status: Number(entry.status || 0),
  });
}

export function mapGroupMember(member: RawGroupMember): GroupMember {
  return freezeObject({
    userId: String(member.uid || '0'),
    role: Number(member.role || 0) as GroupMember['role'],
    joinedAt: Number(member.joined_at || 0),
  });
}
