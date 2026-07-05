import type { Contact, LocalConversation } from '../../sdk';

// 列表跨页去重用的「稳定身份键」：与展示序键（会话 seq、好友 sort_key）彻底解耦，
// 只由路由分片身份（friendUid / groupId）决定，绝不随实时重排或改名而变化。
// 提供给 BoundedPageWindow 的 identityOf，保证窗口里同一实体至多出现一次。
// 单聊 groupId 恒为 '0'、群聊 friendUid 恒为 '0'，故 `${friendUid}:${groupId}` 不会跨类型碰撞。

export function conversationIdentity(conv: LocalConversation): string {
  return `${conv.friendUid || '0'}:${conv.groupId || '0'}`;
}

export function contactIdentity(contact: Contact): string {
  const uid = 'toUid' in contact.target ? String(contact.target.toUid) : '0';
  const gid = 'groupId' in contact.target ? String(contact.target.groupId) : '0';
  const oid = 'orgId' in contact.target ? String(contact.target.orgId) : '0';
  return `${uid}:${gid}:${oid}`;
}
