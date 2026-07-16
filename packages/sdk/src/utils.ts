/**
 * Pure logic utility functions — no DOM dependency.
 */

import type { LocalConversation, ConversationTarget } from './types';

/** Convert a LocalConversation to its canonical convKey string ('u:uid' or 'g:gid'). */
export function convKeyOf(conv: LocalConversation): string {
  const groupId = conv.groupId;
  if (groupId && String(groupId) !== '0') return 'g:' + groupId;
  const friendUid = conv.friendUid;
  return 'u:' + String(friendUid || '0');
}

/** Parse a conversation key like 'g:123' or 'u:456'. */
export function parseConvKey(key: string): { isGroup: boolean; id: string } {
  if (key.startsWith('g:')) return { isGroup: true, id: key.slice(2) };
  return { isGroup: false, id: key.slice(2) };
}

/** Convert ConvTarget to internal convKey string. */
export function toConvKey(target: ConversationTarget): string {
  if ('groupId' in target) return 'g:' + target.groupId;
  return 'u:' + target.toUid;
}

/** Convert internal convKey string to ConvTarget. */
export function fromConvKey(convKey: string): ConversationTarget {
  const { isGroup, id } = parseConvKey(convKey);
  return isGroup ? { groupId: id } : { toUid: id };
}

/** Format a timestamp for display. */
export function formatTime(ts: number | string | undefined | null): string {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : parseInt(ts));
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Format file size for display. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function displayUserName(
  user: { remarkName?: string; nickname?: string; username?: string } | undefined | null,
  fallback = '',
): string {
  return user?.remarkName || user?.nickname || user?.username || fallback;
}

export function displayGroupName(
  group: { remarkName?: string; name?: string } | undefined | null,
  fallback = '',
): string {
  return group?.remarkName || group?.name || fallback;
}
