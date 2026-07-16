import {
  AcceptFriendRequest, AcceptFriendResponse,
  AddFriendRequest, AddFriendResponse,
  AddGroupMemberRequest, AddGroupMemberResponse,
  AuthenticateRequest, AuthenticateResponse,
  BlockUserRequest, BlockUserResponse,
  BlocklistUpdatedNotification,
  ContactsUpdatedNotification,
  ConversationsClearunreadNotification,
  ConversationsDeleteNotification,
  CreateGroupRequest, CreateGroupResponse,
  DeleteConversationRequest, DeleteConversationResponse,
  DeleteFriendRequest, DeleteFriendResponse,
  DeleteMessageRequest, DeleteMessageResponse,
  FavoriteGroupRequest, FavoriteGroupResponse,
  GetBlocklistRequest, GetBlocklistResponse,
  GetContactsRequest, GetContactsResponse,
  GetConversationsRequest, GetConversationsResponse,
  GetGroupInfosRequest, GetGroupInfosResponse,
  GetGroupMembersRequest, GetGroupMembersResponse,
  GetMessagesRequest, GetMessagesResponse,
  GetMutelistRequest, GetMutelistResponse,
  GetOrgInfosRequest, GetOrgInfosResponse,
  GetTagInfosRequest, GetTagInfosResponse,
  GetTagsRequest, GetTagsResponse,
  GetContactCountRequest, GetContactCountResponse,
  GetUnreadCountRequest, GetUnreadCountResponse,
  GetUserInfosRequest, GetUserInfosResponse,
  LoginRequest, LoginResponse,
  LogoutRequest, LogoutResponse,
  ClearUnreadRequest, ClearUnreadResponse,
  MessagesDeleteNotification,
  MessagesReceivedNotification,
  MuteConversationRequest, MuteConversationResponse,
  MutelistUpdatedNotification,
  PingRequest, PingResponse,
  RecallMessageRequest, RecallMessageResponse,
  RegisterRequest, RegisterResponse,
  RejectFriendRequest, RejectFriendResponse,
  RemoveGroupMemberRequest, RemoveGroupMemberResponse,
  SearchUserRequest, SearchUserResponse,
  SendMessageRequest, SendMessageResponse,
  SessionKickedNotification,
  SyncBlocklistRequest, SyncBlocklistResponse,
  SyncContactsRequest, SyncContactsResponse,
  SyncConversationsRequest, SyncConversationsResponse,
  SyncMessagesRequest, SyncMessagesResponse,
  SyncMutelistRequest, SyncMutelistResponse,
  SyncTagsRequest, SyncTagsResponse,
  OrgUpdatedNotification,
  Type,
  UnblockUserRequest, UnblockUserResponse,
  UnfavoriteGroupRequest, UnfavoriteGroupResponse,
  UnmuteConversationRequest, UnmuteConversationResponse,
  UpdateGroupInfoRequest, UpdateGroupInfoResponse,
  UpdatePasswordRequest, UpdatePasswordResponse,
  UpdateRemarkRequest, UpdateRemarkResponse,
  UpdateUserInfoRequest, UpdateUserInfoResponse,
} from '@yimsg/protocol';
import { encodeFrame, type Frame } from '../../../src/transport/frame';

type TestProtobufMessageCodec<T = unknown> = {
  encode(message: T): { finish(): Uint8Array };
  decode(input: Uint8Array): T;
  fromJSON(object: unknown): T;
};

export const CORE_ACTION_NAMES = [
  'acceptFriend','addFriend','addGroupMember','authenticate','blockUser','createGroup',
  'deleteConversation','deleteFriend','deleteMessage','favoriteGroup','getBlocklist',
  'getContacts','getConversations','getGroupInfos','getGroupMembers','getMessages',
  'getMutelist','getContactCount','getUnreadCount','getUserInfos',
  'getOrgInfos','getTagInfos','getTags','syncTags',
  'login','logout','clearUnread','muteConversation','ping','recallMessage','register',
  'rejectFriend','removeGroupMember','searchUser','sendMessage',
  'syncBlocklist','syncContacts','syncConversations','syncMessages','syncMutelist',
  'unblockUser','unfavoriteGroup','unmuteConversation',
  'updateGroupInfo','updatePassword','updateRemark','updateUserInfo',
] as const;

export type CoreActionName = typeof CORE_ACTION_NAMES[number];

export const CORE_NOTIFICATION_TYPES = [
  'messages:received',
  'contacts:updated',
  'session:kicked',
  'conversations:clearunread',
  'conversations:delete',
  'messages:delete',
  'blocklist:updated',
  'mutelist:updated',
  'org:updated',
] as const;

export const SERVER_ERROR_CODES = [
  'INVALID_FRAME',
  'FRAME_TOO_LARGE',
  'INVALID_PROTOBUF',
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'UNKNOWN_ACTION',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT',
  'FORBIDDEN',
  'SEQ_TOO_OLD',
  'BATCH_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
] as const;

export const ACTION_RESPONSE_SCHEMAS: Record<CoreActionName, TestProtobufMessageCodec> = Object.fromEntries(
  CORE_ACTION_NAMES.map(action => [action, responseCodec(actionType(action))]),
) as Record<CoreActionName, TestProtobufMessageCodec>;

export function parseActionResponse(action: CoreActionName, payload: Record<string, unknown>): Record<string, unknown> {
  return responseCodec(actionType(action)).fromJSON(payload) as Record<string, unknown>;
}

export function decodeActionResponse(frame: Frame): Record<string, unknown> {
  return responseCodec(frame.typeId).decode(frame.body) as Record<string, unknown>;
}

export function encodeResponseFrame(codec: 'b', typeId: number, requestId: string, payload: Record<string, unknown>): Uint8Array {
  const respCodec = responseCodec(typeId);
  const body = (respCodec as any).encode((respCodec as any).fromPartial(payload)).finish();
  return encodeFrame(codec, requestId, typeId, body);
}

export function encodeNotificationFrame(codec: 'b', notification: { type: typeof CORE_NOTIFICATION_TYPES[number] } & Record<string, unknown>): Uint8Array {
  const typeId = notificationType(notification.type);
  const notifCodec = notificationCodec(typeId);
  const body = (notifCodec as any).encode((notifCodec as any).fromPartial(notification)).finish();
  return encodeFrame(codec, '0', typeId, body);
}

export function actionType(action: CoreActionName): number {
  switch (action) {
    case 'register': return Type.TYPE_ACTION_REGISTER;
    case 'login': return Type.TYPE_ACTION_LOGIN;
    case 'authenticate': return Type.TYPE_ACTION_AUTHENTICATE;
    case 'logout': return Type.TYPE_ACTION_LOGOUT;
    case 'ping': return Type.TYPE_ACTION_PING;
    case 'updateUserInfo': return Type.TYPE_ACTION_UPDATE_USER_INFO;
    case 'updatePassword': return Type.TYPE_ACTION_UPDATE_PASSWORD;
    case 'getUserInfos': return Type.TYPE_ACTION_GET_USER_INFOS;
    case 'searchUser': return Type.TYPE_ACTION_SEARCH_USER;
    case 'addFriend': return Type.TYPE_ACTION_ADD_FRIEND;
    case 'acceptFriend': return Type.TYPE_ACTION_ACCEPT_FRIEND;
    case 'rejectFriend': return Type.TYPE_ACTION_REJECT_FRIEND;
    case 'deleteFriend': return Type.TYPE_ACTION_DELETE_FRIEND;
    case 'updateRemark': return Type.TYPE_ACTION_UPDATE_REMARK;
    case 'getContacts': return Type.TYPE_ACTION_GET_CONTACTS;
    case 'getContactCount': return Type.TYPE_ACTION_GET_CONTACT_COUNT;
    case 'syncContacts': return Type.TYPE_ACTION_SYNC_CONTACTS;
    case 'favoriteGroup': return Type.TYPE_ACTION_FAVORITE_GROUP;
    case 'unfavoriteGroup': return Type.TYPE_ACTION_UNFAVORITE_GROUP;
    case 'blockUser': return Type.TYPE_ACTION_BLOCK_USER;
    case 'unblockUser': return Type.TYPE_ACTION_UNBLOCK_USER;
    case 'getBlocklist': return Type.TYPE_ACTION_GET_BLOCKLIST;
    case 'syncBlocklist': return Type.TYPE_ACTION_SYNC_BLOCKLIST;
    case 'sendMessage': return Type.TYPE_ACTION_SEND_MESSAGE;
    case 'syncMessages': return Type.TYPE_ACTION_SYNC_MESSAGES;
    case 'getMessages': return Type.TYPE_ACTION_GET_MESSAGES;
    case 'deleteMessage': return Type.TYPE_ACTION_DELETE_MESSAGE;
    case 'recallMessage': return Type.TYPE_ACTION_RECALL_MESSAGE;
    case 'getConversations': return Type.TYPE_ACTION_GET_CONVERSATIONS;
    case 'syncConversations': return Type.TYPE_ACTION_SYNC_CONVERSATIONS;
    case 'getUnreadCount': return Type.TYPE_ACTION_GET_UNREAD_COUNT;
    case 'clearUnread': return Type.TYPE_ACTION_CLEAR_UNREAD;
    case 'deleteConversation': return Type.TYPE_ACTION_DELETE_CONVERSATION;
    case 'muteConversation': return Type.TYPE_ACTION_MUTE_CONVERSATION;
    case 'unmuteConversation': return Type.TYPE_ACTION_UNMUTE_CONVERSATION;
    case 'getMutelist': return Type.TYPE_ACTION_GET_MUTELIST;
    case 'getOrgInfos': return Type.TYPE_ACTION_GET_ORG_INFOS;
    case 'getTagInfos': return Type.TYPE_ACTION_GET_TAG_INFOS;
    case 'getTags': return Type.TYPE_ACTION_GET_TAGS;
    case 'syncTags': return Type.TYPE_ACTION_SYNC_TAGS;
    case 'syncMutelist': return Type.TYPE_ACTION_SYNC_MUTELIST;
    case 'createGroup': return Type.TYPE_ACTION_CREATE_GROUP;
    case 'getGroupInfos': return Type.TYPE_ACTION_GET_GROUP_INFOS;
    case 'getGroupMembers': return Type.TYPE_ACTION_GET_GROUP_MEMBERS;
    case 'updateGroupInfo': return Type.TYPE_ACTION_UPDATE_GROUP_INFO;
    case 'addGroupMember': return Type.TYPE_ACTION_ADD_GROUP_MEMBER;
    case 'removeGroupMember': return Type.TYPE_ACTION_REMOVE_GROUP_MEMBER;
    default: return 0;
  }
}

export function actionByType(typeId: number): CoreActionName | undefined {
  const action = CORE_ACTION_NAMES.find(name => actionType(name) === typeId);
  return action;
}

export function requestCodec(typeId: number): TestProtobufMessageCodec {
  switch (typeId) {
    case Type.TYPE_ACTION_REGISTER: return RegisterRequest;
    case Type.TYPE_ACTION_LOGIN: return LoginRequest;
    case Type.TYPE_ACTION_AUTHENTICATE: return AuthenticateRequest;
    case Type.TYPE_ACTION_LOGOUT: return LogoutRequest;
    case Type.TYPE_ACTION_PING: return PingRequest;
    case Type.TYPE_ACTION_UPDATE_USER_INFO: return UpdateUserInfoRequest;
    case Type.TYPE_ACTION_UPDATE_PASSWORD: return UpdatePasswordRequest;
    case Type.TYPE_ACTION_GET_USER_INFOS: return GetUserInfosRequest;
    case Type.TYPE_ACTION_SEARCH_USER: return SearchUserRequest;
    case Type.TYPE_ACTION_ADD_FRIEND: return AddFriendRequest;
    case Type.TYPE_ACTION_ACCEPT_FRIEND: return AcceptFriendRequest;
    case Type.TYPE_ACTION_REJECT_FRIEND: return RejectFriendRequest;
    case Type.TYPE_ACTION_DELETE_FRIEND: return DeleteFriendRequest;
    case Type.TYPE_ACTION_UPDATE_REMARK: return UpdateRemarkRequest;
    case Type.TYPE_ACTION_GET_CONTACTS: return GetContactsRequest;
    case Type.TYPE_ACTION_GET_CONTACT_COUNT: return GetContactCountRequest;
    case Type.TYPE_ACTION_SYNC_CONTACTS: return SyncContactsRequest;
    case Type.TYPE_ACTION_FAVORITE_GROUP: return FavoriteGroupRequest;
    case Type.TYPE_ACTION_UNFAVORITE_GROUP: return UnfavoriteGroupRequest;
    case Type.TYPE_ACTION_BLOCK_USER: return BlockUserRequest;
    case Type.TYPE_ACTION_UNBLOCK_USER: return UnblockUserRequest;
    case Type.TYPE_ACTION_GET_BLOCKLIST: return GetBlocklistRequest;
    case Type.TYPE_ACTION_SYNC_BLOCKLIST: return SyncBlocklistRequest;
    case Type.TYPE_ACTION_SEND_MESSAGE: return SendMessageRequest;
    case Type.TYPE_ACTION_SYNC_MESSAGES: return SyncMessagesRequest;
    case Type.TYPE_ACTION_GET_MESSAGES: return GetMessagesRequest;
    case Type.TYPE_ACTION_DELETE_MESSAGE: return DeleteMessageRequest;
    case Type.TYPE_ACTION_RECALL_MESSAGE: return RecallMessageRequest;
    case Type.TYPE_ACTION_GET_CONVERSATIONS: return GetConversationsRequest;
    case Type.TYPE_ACTION_SYNC_CONVERSATIONS: return SyncConversationsRequest;
    case Type.TYPE_ACTION_GET_UNREAD_COUNT: return GetUnreadCountRequest;
    case Type.TYPE_ACTION_CLEAR_UNREAD: return ClearUnreadRequest;
    case Type.TYPE_ACTION_DELETE_CONVERSATION: return DeleteConversationRequest;
    case Type.TYPE_ACTION_MUTE_CONVERSATION: return MuteConversationRequest;
    case Type.TYPE_ACTION_UNMUTE_CONVERSATION: return UnmuteConversationRequest;
    case Type.TYPE_ACTION_GET_MUTELIST: return GetMutelistRequest;
    case Type.TYPE_ACTION_SYNC_MUTELIST: return SyncMutelistRequest;
    case Type.TYPE_ACTION_GET_ORG_INFOS: return GetOrgInfosRequest;
    case Type.TYPE_ACTION_GET_TAG_INFOS: return GetTagInfosRequest;
    case Type.TYPE_ACTION_GET_TAGS: return GetTagsRequest;
    case Type.TYPE_ACTION_SYNC_TAGS: return SyncTagsRequest;
    case Type.TYPE_ACTION_CREATE_GROUP: return CreateGroupRequest;
    case Type.TYPE_ACTION_GET_GROUP_INFOS: return GetGroupInfosRequest;
    case Type.TYPE_ACTION_GET_GROUP_MEMBERS: return GetGroupMembersRequest;
    case Type.TYPE_ACTION_UPDATE_GROUP_INFO: return UpdateGroupInfoRequest;
    case Type.TYPE_ACTION_ADD_GROUP_MEMBER: return AddGroupMemberRequest;
    case Type.TYPE_ACTION_REMOVE_GROUP_MEMBER: return RemoveGroupMemberRequest;
    default: throw new Error(`unknown request type: ${typeId}`);
  }
}

function responseCodec(typeId: number): TestProtobufMessageCodec {
  switch (typeId) {
    case Type.TYPE_ACTION_REGISTER: return RegisterResponse;
    case Type.TYPE_ACTION_LOGIN: return LoginResponse;
    case Type.TYPE_ACTION_AUTHENTICATE: return AuthenticateResponse;
    case Type.TYPE_ACTION_LOGOUT: return LogoutResponse;
    case Type.TYPE_ACTION_PING: return PingResponse;
    case Type.TYPE_ACTION_UPDATE_USER_INFO: return UpdateUserInfoResponse;
    case Type.TYPE_ACTION_UPDATE_PASSWORD: return UpdatePasswordResponse;
    case Type.TYPE_ACTION_GET_USER_INFOS: return GetUserInfosResponse;
    case Type.TYPE_ACTION_SEARCH_USER: return SearchUserResponse;
    case Type.TYPE_ACTION_ADD_FRIEND: return AddFriendResponse;
    case Type.TYPE_ACTION_ACCEPT_FRIEND: return AcceptFriendResponse;
    case Type.TYPE_ACTION_REJECT_FRIEND: return RejectFriendResponse;
    case Type.TYPE_ACTION_DELETE_FRIEND: return DeleteFriendResponse;
    case Type.TYPE_ACTION_UPDATE_REMARK: return UpdateRemarkResponse;
    case Type.TYPE_ACTION_GET_CONTACTS: return GetContactsResponse;
    case Type.TYPE_ACTION_GET_CONTACT_COUNT: return GetContactCountResponse;
    case Type.TYPE_ACTION_SYNC_CONTACTS: return SyncContactsResponse;
    case Type.TYPE_ACTION_FAVORITE_GROUP: return FavoriteGroupResponse;
    case Type.TYPE_ACTION_UNFAVORITE_GROUP: return UnfavoriteGroupResponse;
    case Type.TYPE_ACTION_BLOCK_USER: return BlockUserResponse;
    case Type.TYPE_ACTION_UNBLOCK_USER: return UnblockUserResponse;
    case Type.TYPE_ACTION_GET_BLOCKLIST: return GetBlocklistResponse;
    case Type.TYPE_ACTION_SYNC_BLOCKLIST: return SyncBlocklistResponse;
    case Type.TYPE_ACTION_SEND_MESSAGE: return SendMessageResponse;
    case Type.TYPE_ACTION_SYNC_MESSAGES: return SyncMessagesResponse;
    case Type.TYPE_ACTION_GET_MESSAGES: return GetMessagesResponse;
    case Type.TYPE_ACTION_DELETE_MESSAGE: return DeleteMessageResponse;
    case Type.TYPE_ACTION_RECALL_MESSAGE: return RecallMessageResponse;
    case Type.TYPE_ACTION_GET_CONVERSATIONS: return GetConversationsResponse;
    case Type.TYPE_ACTION_SYNC_CONVERSATIONS: return SyncConversationsResponse;
    case Type.TYPE_ACTION_GET_UNREAD_COUNT: return GetUnreadCountResponse;
    case Type.TYPE_ACTION_CLEAR_UNREAD: return ClearUnreadResponse;
    case Type.TYPE_ACTION_DELETE_CONVERSATION: return DeleteConversationResponse;
    case Type.TYPE_ACTION_MUTE_CONVERSATION: return MuteConversationResponse;
    case Type.TYPE_ACTION_UNMUTE_CONVERSATION: return UnmuteConversationResponse;
    case Type.TYPE_ACTION_GET_MUTELIST: return GetMutelistResponse;
    case Type.TYPE_ACTION_SYNC_MUTELIST: return SyncMutelistResponse;
    case Type.TYPE_ACTION_GET_ORG_INFOS: return GetOrgInfosResponse;
    case Type.TYPE_ACTION_GET_TAG_INFOS: return GetTagInfosResponse;
    case Type.TYPE_ACTION_GET_TAGS: return GetTagsResponse;
    case Type.TYPE_ACTION_SYNC_TAGS: return SyncTagsResponse;
    case Type.TYPE_ACTION_CREATE_GROUP: return CreateGroupResponse;
    case Type.TYPE_ACTION_GET_GROUP_INFOS: return GetGroupInfosResponse;
    case Type.TYPE_ACTION_GET_GROUP_MEMBERS: return GetGroupMembersResponse;
    case Type.TYPE_ACTION_UPDATE_GROUP_INFO: return UpdateGroupInfoResponse;
    case Type.TYPE_ACTION_ADD_GROUP_MEMBER: return AddGroupMemberResponse;
    case Type.TYPE_ACTION_REMOVE_GROUP_MEMBER: return RemoveGroupMemberResponse;
    default: throw new Error(`unknown response type: ${typeId}`);
  }
}

function notificationType(type: typeof CORE_NOTIFICATION_TYPES[number]): number {
  switch (type) {
    case 'messages:received': return Type.TYPE_NOTIFY_MESSAGES_RECEIVED;
    case 'contacts:updated': return Type.TYPE_NOTIFY_CONTACTS_UPDATED;
    case 'session:kicked': return Type.TYPE_NOTIFY_SESSION_KICKED;
    case 'conversations:clearunread': return Type.TYPE_NOTIFY_CONVERSATIONS_CLEARUNREAD;
    case 'conversations:delete': return Type.TYPE_NOTIFY_CONVERSATIONS_DELETE;
    case 'messages:delete': return Type.TYPE_NOTIFY_MESSAGES_DELETE;
    case 'blocklist:updated': return Type.TYPE_NOTIFY_BLOCKLIST_UPDATED;
    case 'mutelist:updated': return Type.TYPE_NOTIFY_MUTELIST_UPDATED;
    case 'org:updated': return Type.TYPE_NOTIFY_ORG_UPDATED;
  }
}

function notificationCodec(typeId: number): TestProtobufMessageCodec {
  switch (typeId) {
    case Type.TYPE_NOTIFY_MESSAGES_RECEIVED: return MessagesReceivedNotification;
    case Type.TYPE_NOTIFY_CONTACTS_UPDATED: return ContactsUpdatedNotification;
    case Type.TYPE_NOTIFY_SESSION_KICKED: return SessionKickedNotification;
    case Type.TYPE_NOTIFY_CONVERSATIONS_CLEARUNREAD: return ConversationsClearunreadNotification;
    case Type.TYPE_NOTIFY_CONVERSATIONS_DELETE: return ConversationsDeleteNotification;
    case Type.TYPE_NOTIFY_MESSAGES_DELETE: return MessagesDeleteNotification;
    case Type.TYPE_NOTIFY_BLOCKLIST_UPDATED: return BlocklistUpdatedNotification;
    case Type.TYPE_NOTIFY_MUTELIST_UPDATED: return MutelistUpdatedNotification;
    case Type.TYPE_NOTIFY_ORG_UPDATED: return OrgUpdatedNotification;
    default: throw new Error(`unknown notification type: ${typeId}`);
  }
}
