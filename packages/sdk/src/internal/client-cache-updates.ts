import type { DisplayInfoCache } from '../state/cache';
import type {
  ConversationTarget,
  UpdateGroupInfoInput,
  UpdateUserInfoInput,
} from '../types';

export function updateRemarkDisplayCache(
  cache: DisplayInfoCache,
  target: ConversationTarget,
  remarkName: string,
): void {
  const groupId = (target as { groupId?: string }).groupId;
  if (typeof groupId === 'string') {
    setGroupDisplayCache(cache, groupId, { remark: remarkName });
    return;
  }
  setUserDisplayCache(cache, (target as { toUid: string }).toUid, { remark: remarkName });
}

export function updateFavoriteGroupDisplayCache(
  cache: DisplayInfoCache,
  groupId: string,
  remarkName?: string,
): void {
  if (remarkName) {
    setGroupDisplayCache(cache, groupId, { remark: remarkName });
  }
}

export function updateUnfavoriteGroupDisplayCache(cache: DisplayInfoCache, groupId: string): void {
  const existing = cache.getGroupInfos([groupId]).get(groupId);
  if (!existing) return;
  setGroupDisplayCache(cache, groupId, { remark: '' });
}

export function updateCreatedGroupDisplayCache(cache: DisplayInfoCache, groupId: string, name: string): void {
  cache.setGroupInfos([{ group_id: groupId, name, avatar: '' }]);
}

export function updateGroupInfoDisplayCache(
  cache: DisplayInfoCache,
  groupId: string,
  info: UpdateGroupInfoInput,
): void {
  setGroupDisplayCache(cache, groupId, {
    name: info.name,
    avatar: info.avatarUrl,
  });
}

export function updateUserInfoDisplayCache(
  cache: DisplayInfoCache,
  uid: string,
  info: UpdateUserInfoInput,
): void {
  setUserDisplayCache(cache, uid, {
    nickname: info.nickname,
    avatar: info.avatarUrl,
  });
}

function setGroupDisplayCache(
  cache: DisplayInfoCache,
  groupId: string,
  patch: { name?: string; avatar?: string; remark?: string },
): void {
  const existing = cache.getGroupInfos([groupId]).get(groupId) || { name: '', avatar: '', remark: '' };
  cache.setGroupInfos([{
    group_id: groupId,
    name: patch.name ?? existing.name,
    avatar: patch.avatar ?? existing.avatar,
    remark: patch.remark ?? existing.remark,
  }]);
}

function setUserDisplayCache(
  cache: DisplayInfoCache,
  uid: string,
  patch: { username?: string; nickname?: string; avatar?: string; remark?: string },
): void {
  const existing = cache.getUserInfos([uid]).get(uid) || { username: '', nickname: '', avatar: '', remark: '' };
  cache.setUserInfos([{
    uid,
    username: patch.username ?? existing.username,
    nickname: patch.nickname ?? existing.nickname,
    avatar: patch.avatar ?? existing.avatar,
    remark: patch.remark ?? existing.remark,
  }]);
}
