/**
 * yimsg SDK — UI-framework agnostic IM client library.
 *
 * Usage:
 *   import { YimsgClient } from './sdk';
 *   const client = new YimsgClient({ wsUrl: 'wss://example.com/ws' });
 *   // login / authenticate 会在未连接时自动建连
 *   await client.authenticate(token);      // token 由应用层管理
 *   await client.startSession({ storage }); // storage 由应用层表达业务意图
 *   client.on('messages:received', ({ messages }) => { ... }); // 事件载荷只读，不要直接修改
 */

export { YimsgClient } from './client';

// Public types
export type {
  ClientOptions,
  ClientConfig,
  ClientEvents,
  AuthResult,
  ConvTarget,
  GroupConvTarget,
  ConversationTarget,
  ConversationKind,
  ConversationDescriptor,
  UserDisplayInfo,
  GroupDisplayInfo,
  UserInfo,
  Contact,
  ContactPage,
  BlocklistUser,
  BlocklistUserPage,
  Message,
  MessageBody,
  TextBody,
  MarkdownBody,
  ImageBody,
  FileBody,
  SystemBody,
  RecallBody,
  QuoteBody,
  ForwardBody,
  MessageQuoteInfo,
  ForwardAttachmentInfo,
  MessageContentDescriptor,
  ConversationEntry,
  ConversationPage,
  GroupInfo,
  GroupMember,
  GroupMemberPage,
  LocalConversation,
  GroupRole,
  MsgType,
  ConnectionState,
  SessionState,
  SessionMode,
  SessionFileSystem,
  SessionStorageMode,
  SessionLocalDataResetScope,
  SessionStartOptions,
  SessionStartResult,
  SessionSnapshot,
  SessionTransitionReason,
  SessionStateChangedEvent,
  ConnectionEvent,
  AuthenticatedEvent,
  SessionKickedEvent,
  MessagesReceivedEvent,
  MessagesDeletedEvent,
  ConversationsClearunreadEvent,
  ConversationsDeleteEvent,
  ConversationsSentEvent,
  UnreadUpdatedEvent,
  ContactsUpdatedEvent,
  BlocklistUpdatedEvent,
  MutelistUpdatedEvent,
  DisplayInfoScope,
  DisplayInfoUpdatedEvent,
  ClientErrorEvent,
  UploadCategory,
  SentMessage,
  UploadResult,
  MutelistEntry,
  MutelistEntryPage,
  UpdateUserInfoInput,
  UpdateGroupInfoInput,
  SendQuotedTextInput,
  SendImageInput,
  SendFileInput,
  SdkMaxMemoryBreakdown,
  SdkMaxMemoryEstimate,
  SyncReadiness,
  SyncDomain,
  SyncStatus,
  SessionSyncEvent,
  OrgInfo,
  OrgDisplayInfo,
  TagInfo,
  TagDisplayInfo,
  Tag,
  TagsPage,
  OrgContactTarget,
  OrgUpdatedEvent,
} from './types';

// Bounded collection 运行时统计类型（getBoundedCollectionStats 的返回结构）
export type { BoundedStats } from './internal/bounded';
export type { BoundedCollectionStats, DisplayInfoCacheStats } from './state/cache';

// Pure utilities (no DOM)
export { formatTime, formatFileSize, displayUserName, displayGroupName } from './utils';

// 展示通道分页游标辅助：由 seq 推导不透明游标，供 SDK 测试与工具构造续翻游标
//（UI 层一律透传服务端返回的不透明边界游标，不自行构造）。
export { encodeSeqCursor as seqCursor } from './internal/page-cursor';

export {
  YimsgError,
  PreconditionError,
  ValidationError,
  AuthError,
  ConnectionError,
  RequestError,
  ProtocolValidationError,
  StorageModeError,
  isYimsgError,
} from './errors';

// Constants
export {
  MSG_TYPE_TEXT,
  MSG_TYPE_IMAGE,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_FILE,
  MSG_TYPE_RECALL,
  MSG_TYPE_QUOTE,
  MSG_TYPE_FORWARD,
  MSG_TYPE_MARKDOWN,
  CONTACT_FRIEND,
  CONTACT_DELETED,
  CONTACT_PENDING_OUTGOING,
  CONTACT_PENDING_INCOMING,
  GROUP_ROLE_MEMBER,
  GROUP_ROLE_OWNER,
} from '../constants';
