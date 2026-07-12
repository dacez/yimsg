// action-mappers.ts —— 出方向 action 的无状态业务工具集中地。
//
// `actions.gen.ts` 只负责 Type + request/response codec + transport.sendBinary。
// 真正的业务整形（target 映射、分页游标、状态校验、msg_id 生成）与响应归一化
// （normalize* / map*）刻意不生成，统一手写在这里，由 client 与 datagateway 直接复用。
// 这里的函数全部无状态、与 transport 无关，可独立测试。

import type {
  BlocklistUser,
  ConversationEntry,
  Contact,
  GroupInfo,
  GroupMember,
  Message,
  MessageBody,
  MutelistEntry,
  UserInfo,
  OrgInfo,
  TagInfo,
  Tag,
} from '../../types';
import {
  BLOCKLIST_ACTIVE,
  CONTACT_DELETED,
  CONTACT_FRIEND,
  CONTACT_PENDING_INCOMING,
  CONTACT_PENDING_OUTGOING,
  MSG_TYPE_RECALL,
  MSG_TYPE_TEXT,
  MUTELIST_ACTIVE,
  STATUS_DELETED,
} from '../../constants';
import type { ConversationTarget, MsgType } from '../types';
import { clampOptionalPageLimit } from './limits';
import { generateMsgId } from './msgid';
import {
  GetBlocklistRequest,
  GetOrgInfosRequest,
  GetOrgInfosResponse,
  GetTagInfosRequest,
  GetTagInfosResponse,
  GetTagsRequest,
  GetTagsResponse,
  SyncTagsRequest,
  SyncTagsResponse,
  GetBlocklistResponse,
  GetContactCountRequest,
  GetContactsRequest,
  GetContactsResponse,
  GetConversationsRequest,
  GetConversationsResponse,
  GetGroupInfosResponse,
  GetGroupMembersRequest,
  GetGroupMembersResponse,
  GetMessagesRequest,
  GetMessagesResponse,
  GetMutelistRequest,
  GetMutelistResponse,
  GetUserInfosResponse,
  PageDirection,
  PageInfo,
  PageQuery,
  SendMessageRequest,
  SyncBlocklistRequest,
  SyncBlocklistResponse,
  SyncContactsRequest,
  SyncContactsResponse,
  SyncConversationsRequest,
  SyncConversationsResponse,
  SyncMessagesRequest,
  SyncMessagesResponse,
  SyncMutelistRequest,
  SyncMutelistResponse,
} from '../generated/yimsg';

const GROUP_MEMBER_PAGE_LIMIT = 500;

// ---- target / 分页 / 校验 工具 ----

export function targetParams(target: ConversationTarget): { target: { uid?: string; group_id?: string } } {
  const groupId = (target as { groupId?: string }).groupId;
  if (typeof groupId === 'string') return { target: { group_id: groupId } };
  return { target: { uid: (target as { toUid: string }).toUid || '0' } };
}

function targetIDs(target?: { uid?: string | number; group_id?: string; groupId?: string; to_uid?: string; friend_uid?: string }): { toUid: string; groupId: string } {
  const groupId = String(target?.group_id || target?.groupId || '0');
  if (groupId !== '0') return { toUid: '0', groupId };
  return { toUid: String(target?.uid || target?.to_uid || target?.friend_uid || '0'), groupId: '0' };
}

function pageField(value: number | undefined): string {
  return String(value ?? 0);
}

// ---- 展示通道统一分页 ----
//
// 所有 get_* 列表使用不透明 keyset 游标（PageQuery/PageInfo），与 sync_* 的 seq 同步游标独立。
// cursor 由服务端编码、客户端原样透传；backward 表示向列表头/向上翻（前插），缺省向尾/向下翻（追加）。

export interface PageParams {
  cursor?: string;
  backward?: boolean;
  around?: string;
  limit?: number;
}

export interface PageInfoResult {
  startCursor: string;
  endCursor: string;
  hasMoreBackward: boolean;
  hasMoreForward: boolean;
  total: number;
}

export function pageQueryOf(params?: PageParams): PageQuery {
  return PageQuery.create({
    cursor: params?.cursor ?? '',
    direction: params?.backward ? PageDirection.PAGE_DIRECTION_BACKWARD : PageDirection.PAGE_DIRECTION_FORWARD,
    limit: pageField(clampOptionalPageLimit(params?.limit)),
    around: params?.around ?? '',
  });
}

export function mapPageInfo(page: PageInfo | undefined): PageInfoResult {
  return {
    startCursor: page?.start_cursor ?? '',
    endCursor: page?.end_cursor ?? '',
    hasMoreBackward: Boolean(page?.has_more_backward),
    hasMoreForward: Boolean(page?.has_more_forward),
    total: Number(page?.total ?? -1),
  };
}

export function assertValidStatus(status: number | undefined, allowed: readonly number[], required = false): number | undefined {
  if (status === undefined || status === null) {
    if (required) throw new Error('status is required');
    return undefined;
  }
  if (!allowed.includes(status)) throw new Error('status must be a valid non-zero value');
  return status;
}

// ---- 响应归一化 ----

function normalizeMessage(message: Message): Message {
  const ids = targetIDs(message.target || message);
  return {
    ...message,
    target: message.target,
    to_uid: ids.toUid,
    group_id: ids.groupId,
    uid: Number(message.uid || 0),
    seq: Number(message.seq || 0),
    msg_type: Number(message.msg_type || MSG_TYPE_TEXT) as MsgType,
    body: (message.body || {}) as Message['body'],
    send_time: Number(message.send_time || 0),
    status: Number(message.status || 0),
  };
}

function normalizeContact(contact: Contact): Contact {
  const orgId = String(contact.target?.org_id || contact.org_id || '0');
  const ids = orgId !== '0' ? { toUid: '0', groupId: '0' } : targetIDs(contact.target || contact);
  return {
    ...contact,
    target: contact.target,
    friend_uid: ids.toUid,
    group_id: ids.groupId,
    org_id: orgId,
    status: Number(contact.status || 0),
    seq: Number(contact.seq || 0),
  };
}

function normalizeBlocklistUser(user: BlocklistUser): BlocklistUser {
  return {
    ...user,
    status: Number(user.status || 0),
    seq: Number(user.seq || 0),
    created_at: Number(user.created_at || 0),
    updated_at: Number(user.updated_at || 0),
  };
}

function normalizeMutelistEntry(entry: MutelistEntry): MutelistEntry {
  const ids = targetIDs(entry.target || entry);
  return {
    ...entry,
    target: entry.target,
    to_uid: ids.toUid,
    group_id: ids.groupId,
    status: Number(entry.status || 0),
    seq: Number(entry.seq || 0),
    updated_at: Number(entry.updated_at || 0),
  };
}

function normalizeConversation(conversation: ConversationEntry): ConversationEntry {
  const ids = targetIDs(conversation.target || conversation);
  return {
    ...conversation,
    target: conversation.target,
    friend_uid: ids.toUid,
    group_id: ids.groupId,
    last_seq: Number(conversation.last_seq || 0),
    unread_count: Number(conversation.unread_count || 0),
    status: Number(conversation.status || 0),
    last_msg: conversation.last_msg ? normalizeMessage(conversation.last_msg as unknown as Message) : conversation.last_msg,
  };
}

function normalizeGroupInfo(group: GroupInfo): GroupInfo {
  return {
    ...group,
    created_at: Number(group.created_at || 0),
    updated_at: Number(group.updated_at || 0),
  };
}

function normalizeGroupMember(member: GroupMember): GroupMember {
  return {
    ...member,
    role: Number(member.role || 0) as GroupMember['role'],
    joined_at: Number(member.joined_at || 0),
  };
}

// ---- 消息 ----

export function sendMessageRequest(
  target: ConversationTarget,
  body: MessageBody,
  msgType: MsgType = MSG_TYPE_TEXT,
): SendMessageRequest {
  // msg_id 由 SDK 生成（全项目唯一生成点）；撤回时这是撤回事件消息的 ID，body.recall.msg_id 才是被撤回目标。
  return SendMessageRequest.create({
    ...targetParams(target),
    msg_type: msgType,
    msg_id: generateMsgId(),
    body: body as unknown as SendMessageRequest['body'],
  });
}

// 撤回统一走 send_message + MESSAGE_TYPE_RECALL + RecallBody（仅需 msg_id，
// operator_uid/recall_time/text 由服务端设置）。
export function recallMessageRequest(target: ConversationTarget, msgId: string): SendMessageRequest {
  const body: MessageBody = { recall: { msg_id: msgId, operator_uid: '0', recall_time: 0, text: '' } };
  return sendMessageRequest(target, body, MSG_TYPE_RECALL);
}

export function getMessagesRequest(params: { to_uid?: string; group_id?: string; page?: PageParams; msg_ids?: string[] }): GetMessagesRequest {
  const hasMsgIds = Boolean(params.msg_ids && params.msg_ids.length > 0);
  if (hasMsgIds && params.page) {
    throw new Error('msg_ids and page are mutually exclusive');
  }
  return GetMessagesRequest.create({
    ...targetParams(params.group_id ? { groupId: params.group_id } : { toUid: params.to_uid ?? '0' }),
    page: hasMsgIds ? undefined : pageQueryOf(params.page),
    msg_ids: params.msg_ids ?? [],
  });
}

export function syncMessagesRequest(params: { last_seq: number; limit?: number }): SyncMessagesRequest {
  return SyncMessagesRequest.create({
    last_seq: String(params.last_seq ?? 0),
    limit: pageField(clampOptionalPageLimit(params.limit)),
  });
}

export function mapMessagesResponse(resp: GetMessagesResponse | SyncMessagesResponse): Message[] {
  return ((resp.messages || []) as unknown as Message[]).map(normalizeMessage);
}

export function mapGetMessagesResponse(resp: GetMessagesResponse): { messages: Message[]; page: PageInfoResult } {
  return { messages: mapMessagesResponse(resp), page: mapPageInfo(resp.page) };
}

export function mapSyncMessagesResponse(resp: SyncMessagesResponse): { messages: Message[]; hasMore: boolean; cursorSeq: number } {
  return {
    messages: mapMessagesResponse(resp),
    hasMore: Boolean(resp.has_more),
    cursorSeq: Number(resp.cursor_seq || 0),
  };
}

// ---- 通讯录 ----

export function getContactsRequest(params: {
  page?: PageParams;
  status?: number;
  friend_uid?: string;
  group_id?: string;
  org_id?: string;
  friend_uids?: readonly string[];
  group_ids?: readonly string[];
  org_ids?: readonly string[];
}): GetContactsRequest {
  const targets = [
    ...(params.friend_uid ? [{ uid: params.friend_uid }] : []),
    ...(params.group_id ? [{ group_id: params.group_id }] : []),
    ...(params.org_id ? [{ org_id: params.org_id }] : []),
    ...(params.friend_uids || []).map((uid) => ({ uid })),
    ...(params.group_ids || []).map((group_id) => ({ group_id })),
    ...(params.org_ids || []).map((org_id) => ({ org_id })),
  ];
  return GetContactsRequest.create({
    targets,
    status: assertValidStatus(params.status, [CONTACT_FRIEND, CONTACT_PENDING_OUTGOING, CONTACT_PENDING_INCOMING, CONTACT_DELETED]),
    page: pageQueryOf(params.page),
  });
}

export function mapGetContactsResponse(resp: GetContactsResponse): {
  contacts: Contact[];
  page: PageInfoResult;
} {
  return {
    contacts: ((resp.contacts || []) as unknown as Contact[]).map(normalizeContact),
    page: mapPageInfo(resp.page),
  };
}

export function contactCountRequest(status: number): GetContactCountRequest {
  return GetContactCountRequest.create({
    status: assertValidStatus(status, [CONTACT_FRIEND, CONTACT_PENDING_OUTGOING, CONTACT_PENDING_INCOMING, CONTACT_DELETED], true),
  });
}

export function syncContactsRequest(params: { last_seq?: number; limit?: number; rebuild?: boolean }): SyncContactsRequest {
  return SyncContactsRequest.create({
    last_seq: String(params.last_seq ?? 0),
    limit: pageField(clampOptionalPageLimit(params.limit)),
    rebuild: Boolean(params.rebuild),
  });
}

export function mapSyncContactsResponse(resp: SyncContactsResponse): { contacts: Contact[]; hasMore: boolean; cursorSeq: number; error?: string } {
  return {
    contacts: ((resp.contacts || []) as unknown as Contact[]).map(normalizeContact),
    hasMore: Boolean(resp.has_more),
    cursorSeq: Number(resp.cursor_seq || 0),
    error: (resp as { error?: string }).error,
  };
}

// ---- 组织 ----
//
// org_info / tag_info 是无 seq 的展示字典（按需查询，与 group_info 同构）；
// org_relation 是唯一的同步域：展开走展示通道不透明游标，同步走 last_seq/cursor_seq。

export function getOrgInfosRequest(orgIds: readonly string[]): GetOrgInfosRequest {
  return GetOrgInfosRequest.create({ org_ids: [...orgIds] });
}

export function mapGetOrgInfosResponse(resp: GetOrgInfosResponse): OrgInfo[] {
  return (resp.orgs || []).map((o) => ({
    org_id: String(o.org_id || '0'),
    name: String(o.name || ''),
    avatar: String(o.avatar || ''),
  }));
}

export function getTagInfosRequest(orgId: string, tagIds: readonly string[]): GetTagInfosRequest {
  return GetTagInfosRequest.create({ org_id: orgId, tag_ids: [...tagIds] });
}

export function mapGetTagInfosResponse(resp: GetTagInfosResponse): TagInfo[] {
  return (resp.tags || []).map((t) => ({
    tag_id: String(t.tag_id || '0'),
    name: String(t.name || ''),
    avatar: String(t.avatar || ''),
  }));
}

export function getTagsRequest(params: {
  org_id: string;
  tag_id: string;
  page?: PageParams;
}): GetTagsRequest {
  return GetTagsRequest.create({
    org_id: params.org_id,
    tag_id: params.tag_id,
    page: pageQueryOf(params.page),
  });
}

function normalizeTag(item: {
  tag_id?: string;
  child_id?: string;
  child_type?: number;
  title?: string;
  rank?: string | number;
  sort_key?: string;
  status?: number;
  seq?: string | number;
}): Tag {
  return {
    tag_id: String(item.tag_id || '0'),
    child_id: String(item.child_id || '0'),
    child_type: Number(item.child_type || 0),
    title: String(item.title || ''),
    rank: Number(item.rank || 0),
    sort_key: String(item.sort_key || ''),
    status: Number(item.status || 0),
    seq: Number(item.seq || 0),
  };
}

export function mapGetTagsResponse(resp: GetTagsResponse): {
  tags: Tag[];
  page: PageInfoResult;
} {
  return {
    tags: (resp.tags || []).map(normalizeTag),
    page: mapPageInfo(resp.page),
  };
}

export function syncTagsRequest(params: {
  org_id: string;
  last_seq?: number;
  limit?: number;
  rebuild?: boolean;
}): SyncTagsRequest {
  return SyncTagsRequest.create({
    org_id: params.org_id,
    last_seq: String(params.last_seq ?? 0),
    limit: pageField(clampOptionalPageLimit(params.limit)),
    rebuild: Boolean(params.rebuild),
  });
}

export function mapSyncTagsResponse(resp: SyncTagsResponse): {
  tags: Tag[];
  hasMore: boolean;
  cursorSeq: number;
} {
  return {
    tags: (resp.tags || []).map(normalizeTag),
    hasMore: Boolean(resp.has_more),
    cursorSeq: Number(resp.cursor_seq || 0),
  };
}

// ---- 会话 ----

export function getConversationsRequest(params: { page?: PageParams; targets?: ConversationTarget[] }): GetConversationsRequest {
  return GetConversationsRequest.create({
    page: pageQueryOf(params.page),
    targets: (params.targets ?? []).map((t) => targetParams(t).target),
  });
}

export function mapGetConversationsResponse(resp: GetConversationsResponse): {
  conversations: ConversationEntry[];
  page: PageInfoResult;
} {
  return {
    conversations: ((resp.conversations || []) as unknown as ConversationEntry[]).map(normalizeConversation),
    page: mapPageInfo(resp.page),
  };
}

export function syncConversationsRequest(params: { last_seq?: number; limit?: number }): SyncConversationsRequest {
  return SyncConversationsRequest.create({
    last_seq: String(params.last_seq ?? 0),
    limit: pageField(clampOptionalPageLimit(params.limit)),
  });
}

export function mapSyncConversationsResponse(resp: SyncConversationsResponse): { conversations: ConversationEntry[]; hasMore: boolean; cursorSeq: number } {
  return {
    conversations: ((resp.conversations || []) as unknown as ConversationEntry[]).map(normalizeConversation),
    hasMore: Boolean(resp.has_more),
    cursorSeq: Number(resp.cursor_seq || 0),
  };
}

// ---- 屏蔽列表 ----

export function getBlocklistRequest(params?: {
  page?: PageParams;
  status?: number;
  uids?: readonly string[];
}): GetBlocklistRequest {
  return GetBlocklistRequest.create({
    status: assertValidStatus(params?.status, [BLOCKLIST_ACTIVE, STATUS_DELETED]),
    uids: [...(params?.uids || [])],
    page: pageQueryOf(params?.page),
  });
}

export function mapGetBlocklistResponse(resp: GetBlocklistResponse): {
  users: BlocklistUser[];
  page: PageInfoResult;
} {
  return {
    users: ((resp.users || []) as unknown as BlocklistUser[]).map(normalizeBlocklistUser),
    page: mapPageInfo(resp.page),
  };
}

export function syncBlocklistRequest(params: { last_seq?: number; limit?: number; rebuild?: boolean }): SyncBlocklistRequest {
  return SyncBlocklistRequest.create({
    last_seq: String(params.last_seq ?? 0),
    limit: pageField(clampOptionalPageLimit(params.limit)),
    rebuild: Boolean(params.rebuild),
  });
}

export function mapSyncBlocklistResponse(resp: SyncBlocklistResponse): { users: BlocklistUser[]; hasMore: boolean; cursorSeq: number; error?: string } {
  return {
    users: ((resp.users || []) as unknown as BlocklistUser[]).map(normalizeBlocklistUser),
    hasMore: Boolean(resp.has_more),
    cursorSeq: Number(resp.cursor_seq || 0),
    error: (resp as { error?: string }).error,
  };
}

// ---- 免打扰列表 ----

export function getMutelistRequest(params?: {
  page?: PageParams;
  status?: number;
  to_uid?: string;
  group_id?: string;
  to_uids?: readonly string[];
  group_ids?: readonly string[];
}): GetMutelistRequest {
  const targets = [
    ...(params?.to_uid ? [{ uid: params.to_uid }] : []),
    ...(params?.group_id ? [{ group_id: params.group_id }] : []),
    ...(params?.to_uids || []).map((uid) => ({ uid })),
    ...(params?.group_ids || []).map((group_id) => ({ group_id })),
  ];
  return GetMutelistRequest.create({
    targets,
    status: assertValidStatus(params?.status, [MUTELIST_ACTIVE, STATUS_DELETED]),
    page: pageQueryOf(params?.page),
  });
}

export function mapGetMutelistResponse(resp: GetMutelistResponse): {
  mutes: MutelistEntry[];
  page: PageInfoResult;
} {
  return {
    mutes: ((resp.mutes || []) as unknown as MutelistEntry[]).map(normalizeMutelistEntry),
    page: mapPageInfo(resp.page),
  };
}

export function syncMutelistRequest(params: { last_seq?: number; limit?: number; rebuild?: boolean }): SyncMutelistRequest {
  return SyncMutelistRequest.create({
    last_seq: String(params.last_seq ?? 0),
    limit: pageField(clampOptionalPageLimit(params.limit)),
    rebuild: Boolean(params.rebuild),
  });
}

export function mapSyncMutelistResponse(resp: SyncMutelistResponse): { mutes: MutelistEntry[]; hasMore: boolean; cursorSeq: number; error?: string } {
  return {
    mutes: ((resp.mutes || []) as unknown as MutelistEntry[]).map(normalizeMutelistEntry),
    hasMore: Boolean(resp.has_more),
    cursorSeq: Number(resp.cursor_seq || 0),
    error: (resp as { error?: string }).error,
  };
}

// ---- 用户 / 群 ----

export function mapGetUserInfosResponse(resp: GetUserInfosResponse): UserInfo[] {
  return (resp.profiles || []) as unknown as UserInfo[];
}

export function mapGetGroupInfosResponse(resp: GetGroupInfosResponse): GroupInfo[] {
  const groups = ((resp.groups || []) as unknown as GroupInfo[]).map(normalizeGroupInfo);
  const remarks = (resp as { remarks?: Record<string, string> }).remarks;
  if (remarks) {
    for (const group of groups) {
      if (remarks[group.group_id]) group.remark = remarks[group.group_id];
    }
  }
  return groups;
}

export function groupMembersRequest(groupId: string, params?: { page?: PageParams }): GetGroupMembersRequest {
  const page = params?.page ? { ...params.page } : {};
  const requestedLimit = page.limit ?? GROUP_MEMBER_PAGE_LIMIT;
  page.limit = Math.min(Math.max(1, requestedLimit), GROUP_MEMBER_PAGE_LIMIT);
  return GetGroupMembersRequest.create({
    group_id: groupId,
    page: pageQueryOf(page),
  });
}

export function mapGetGroupMembersResponse(resp: GetGroupMembersResponse): {
  total: number;
  members: GroupMember[];
  page: PageInfoResult;
} {
  const members = ((resp.members || []) as unknown as GroupMember[]).map(normalizeGroupMember);
  const page = mapPageInfo(resp.page);
  return { total: page.total, members, page };
}
