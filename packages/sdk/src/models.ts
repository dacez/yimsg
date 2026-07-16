import {
  GROUP_ROLE_MEMBER,
  GROUP_ROLE_OWNER,
  MSG_TYPE_FILE,
  MSG_TYPE_FORWARD,
  MSG_TYPE_IMAGE,
  MSG_TYPE_MARKDOWN,
  MSG_TYPE_QUOTE,
  MSG_TYPE_RECALL,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_TEXT,
} from './constants';

// ---- Literal types (used across data interfaces) ----
export type MsgType =
  | typeof MSG_TYPE_TEXT
  | typeof MSG_TYPE_IMAGE
  | typeof MSG_TYPE_SYSTEM
  | typeof MSG_TYPE_FILE
  | typeof MSG_TYPE_RECALL
  | typeof MSG_TYPE_QUOTE
  | typeof MSG_TYPE_FORWARD
  | typeof MSG_TYPE_MARKDOWN;

// ---- Strongly-typed message body (mirrors protobuf MessageBody) ----
// 字段名与线协议（snake_case）一致，便于本地 protobuf 编解码。
export interface TextBody {
  text: string;
}
export interface MarkdownBody {
  markdown: string;
}
export interface ImageBody {
  media_id: string;
  size?: number;
  width?: number;
  height?: number;
  mime?: string;
  caption?: string;
}
export interface FileBody {
  media_id: string;
  name: string;
  size?: number;
  mime?: string;
}
export interface SystemBody {
  text: string;
}
export interface RecallBody {
  msg_id: string;
  operator_uid: string;
  recall_time: number;
  text: string;
}
export interface QuoteBody {
  quote_msg_id: string;
  quote_preview?: string;
  text?: TextBody;
}
export interface ForwardBody {
  msg_ids: string[];
  title?: string;
}
export interface MessageBody {
  text?: TextBody;
  image?: ImageBody;
  system?: SystemBody;
  file?: FileBody;
  recall?: RecallBody;
  quote?: QuoteBody;
  forward?: ForwardBody;
  markdown?: MarkdownBody;
}
export type GroupRole = typeof GROUP_ROLE_MEMBER | typeof GROUP_ROLE_OWNER;

// Server response envelope
export interface WsResponse {
  request_id: string;
  ok: boolean;
  error?: string;
  error_code?: string;

  uid?: string;
  token?: string;
  profile?: UserInfo;
  contacts?: Contact[];
  users?: BlocklistUser[];
  mutes?: MutelistEntry[];
  seq?: number;
  msg_id?: string;
  messages?: Message[];
  conversations?: ConversationEntry[];
  total?: number;
  unread_count?: number;
  group_id?: string;
  members?: GroupMember[];
  profiles?: UserInfo[];
  groups?: GroupInfo[];
  url?: string;
  size?: number;
  client_config?: ClientConfig;
}

export interface ClientConfig {
  cache_ttl_seconds?: number;
  cache_max_entries?: number;
  recall_window_seconds?: number;
  batch_max_limit?: number;
}

export interface UserInfo {
  uid: string;
  username: string;
  nickname: string;
  avatar: string;
  remark?: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationTargetData {
  uid?: string;
  group_id?: string;
  /** 组织 ID（仅通讯录条目使用，会话目标不携带）。 */
  org_id?: string;
}

export interface Contact {
  target?: ConversationTargetData;
  /** @deprecated 仅供本地存储兼容，协议使用 target.uid。 */
  friend_uid?: string;
  /** @deprecated 仅供本地存储兼容，协议使用 target.group_id。 */
  group_id?: string;
  /** @deprecated 仅供本地存储兼容，协议使用 target.org_id。 */
  org_id?: string;
  status: number;
  seq: number;
  remark_name?: string;
  /** 通讯录排序键投影（服务端计算下发，仅同步数据）。 */
  sort_key?: string;
  /** 通讯录搜索投影（服务端计算下发，不含 username）。 */
  search_text?: string;
}

export interface BlocklistUser {
  uid: string;
  status?: number;
  seq: number;
  created_at: number;
  updated_at: number;
}

export interface MutelistEntry {
  target?: ConversationTargetData;
  /** @deprecated 仅供本地存储兼容，协议使用 target.uid。 */
  to_uid?: string;
  /** @deprecated 仅供本地存储兼容，协议使用 target.group_id。 */
  group_id?: string;
  status: number;
  seq: number;
  updated_at?: number;
}

export interface Message {
  uid: number;
  seq: number;
  msg_id: string;
  from_uid: string;
  target?: ConversationTargetData;
  /** @deprecated 仅供本地存储兼容，协议使用 target.uid。 */
  to_uid?: string;
  /** @deprecated 仅供本地存储兼容，协议使用 target.group_id。 */
  group_id?: string;
  msg_type: MsgType;
  body: MessageBody;
  /** 搜索投影，由 body 派生，仅本地持久层使用。 */
  search_text?: string;
  send_time: number;
  status?: number;
}

export interface ConversationEntry {
  target?: ConversationTargetData;
  /** @deprecated 仅供本地存储兼容，协议使用 target.uid。 */
  friend_uid?: string;
  /** @deprecated 仅供本地存储兼容，协议使用 target.group_id。 */
  group_id?: string;
  last_seq: number;
  last_msg: Message | null;
  unread_count?: number;
  status?: number;
}

export interface GroupInfo {
  group_id: string;
  name: string;
  avatar: string;
  owner_uid: string;
  remark?: string;
  created_at: number;
  updated_at: number;
}

export interface GroupMember {
  uid: string;
  role: GroupRole;
  joined_at: number;
}

/** 组织展示资料字典：仅名字/头像，不参与同步（与 GroupInfo 同构）。 */
export interface OrgInfo {
  org_id: string;
  name: string;
  avatar?: string;
}

/** tag（部门/横向分组）展示资料字典：仅名字/头像，不参与同步。 */
export interface TagInfo {
  tag_id: string;
  name: string;
  avatar?: string;
}

/**
 * 组织关系表条目（在线展开与同步共用）：组织架构唯一的同步域。
 * child_type 区分 child_id 是人（uid）还是 tag（tag_id）；GRANT 类型的管理员授权
 * 与组织架构位置解耦，不出现在展开/同步结果里。
 * rank / title / sort_key 是这条边的属性，一人多岗即多条边、各边独立排序。
 */
export interface Tag {
  tag_id: string;
  child_id: string;
  child_type: number;
  title?: string;
  rank: number;
  sort_key: string;
  status: number;
  seq: number;
}

export interface Notification {
  type: string;
  target?: ConversationTargetData;
  /** 触发本次通知的消息 id；通知合并时取最新一条。仅 messages:received 携带。 */
  msg_id?: string;
  /** 发生变化的组织 ID。仅 org:updated 携带。 */
  org_id?: string;
  /** @deprecated 仅供旧本地事件路径兼容，协议使用 target.uid。 */
  from_uid?: string;
  /** @deprecated 仅供旧本地事件路径兼容，协议使用 target.group_id。 */
  group_id?: string;
  uid?: string;
}

// Local conversation (normalized)
export interface LocalConversation {
  target?: ConversationTargetData;
  group_id: string;
  friend_uid: string;
  last_seq: number;
  last_msg: Message | null;
  unread_count?: number;
  status?: number;
}
