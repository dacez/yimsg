# Schema 字段对照

> 主要对照：`internal/dal/schema.go`。
> 最后复核：2026-07-06。
> 触发更新：任一 `CREATE TABLE`、索引、字段默认值或路由键说明变化时同步更新。
> 入口关系：上级索引见 [`../README.md`](../README.md)；本文是 `internal/dal/schema.go` 字段、主键和索引的字段级对照入口。
> 维护口径：本文只描述当前 DDL 字段、主键、索引和路由键；字段业务语义、读写流程和 GC 规则见同目录领域文档及上级专题文档。
> 注意：数据库 schema 变更必须先征求确认；项目处于研发阶段，不编写 migration、`ALTER TABLE` 升级逻辑或旧数据兼容代码。

## 目录

- [1. 总览](#1-总览)
- [2. uid 分片](#2-uid-分片)
  - [2.1 `user_info`](#21-user_info)
  - [2.2 `contacts`](#22-contacts)
  - [2.3 `contacts_version`](#23-contacts_version)
  - [2.4 `blocklist`](#24-blocklist)
  - [2.5 `blocklist_version`](#25-blocklist_version)
  - [2.6 `messages`](#26-messages)
  - [2.7 `messages_version`](#27-messages_version)
  - [2.8 `conversations`](#28-conversations)
  - [2.9 `mutelist`](#29-mutelist)
  - [2.10 `mutelist_version`](#210-mutelist_version)
  - [2.11 `user_session`](#211-user_session)
- [3. username 分片](#3-username-分片)
  - [3.1 `user_lookup`](#31-user_lookup)
- [4. token 分片](#4-token-分片)
  - [4.1 `session`](#41-session)
- [5. group 分片](#5-group-分片)
  - [5.1 `group_info`](#51-group_info)
  - [5.2 `group_member`](#52-group_member)
- [6. org 分片](#6-org-分片)
  - [6.1 `org_info`](#61-org_info)
  - [6.2 `tag_info`](#62-tag_info)
  - [6.3 `tags`](#63-tags)
  - [6.4 `org_version`](#64-org_version)
- [7. 状态与类型常量](#7-状态与类型常量)
- [8. 维护检查点](#8-维护检查点)

## 1. 总览

| 分片组 | 路由键 | 表 | 对应设计 |
|---|---|---|---|
| `uid` | `uid` | `user_info`、`contacts`、`contacts_version`、`blocklist`、`blocklist_version`、`messages`、`messages_version`、`conversations`、`mutelist`、`mutelist_version`、`user_session` | 用户、通讯录、屏蔽列表、消息、会话、免打扰、登录态 |
| `username` | `username` | `user_lookup` | 用户名到 UID 映射 |
| `token` | `token` | `session` | 登录 session |
| `group` | `group_id` | `group_info`、`group_member` | 群资料与成员 |
| `org` | `org_id` | `org_info`、`tag_info`、`tags`、`org_version` | 组织/tag 展示字典、组织关系表（唯一同步域）与同步版本 |

当前共 **5 个分片组、19 张表**。

## 2. uid 分片

### 2.1 `user_info`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER PRIMARY KEY` | 用户 ID |
| `username` | `TEXT NOT NULL` | 用户名 |
| `password_hash` | `TEXT NOT NULL` | bcrypt 密码哈希 |
| `nickname` | `TEXT NOT NULL DEFAULT ''` | 昵称 |
| `avatar` | `TEXT NOT NULL DEFAULT ''` | 头像 URL |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

索引：仅主键。

### 2.2 `contacts`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER NOT NULL` | 所属用户 |
| `type` | `INTEGER NOT NULL` | 目标类型：1=好友，2=群收藏，3=组织 |
| `id` | `INTEGER NOT NULL` | 目标 ID：随 `type` 分别表示 `friend_uid`、`group_id` 或 `org_id` |
| `status` | `INTEGER NOT NULL CHECK (status <> 0)` | 联系人状态，0 禁止入库 |
| `remark_name` | `TEXT NOT NULL DEFAULT ''` | 备注名 |
| `sort_key` | `TEXT NOT NULL DEFAULT ''` | 通讯录排序键投影：有备注按备注、否则按昵称/群名/组织名归一化（首版小写） |
| `search_text` | `TEXT NOT NULL DEFAULT ''` | 通讯录搜索投影：拼接 remark_name 与昵称/群名/组织名，**不含 username** |
| `seq` | `INTEGER NOT NULL DEFAULT 0` | 联系人变更序列 |
| `created_at` | `INTEGER NOT NULL DEFAULT 0` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL DEFAULT 0` | 更新时间，毫秒时间戳 |

主键：`(uid, type, id)`。

> `contacts` 是“通讯录排序/搜索投影 + 同步流”，不是普通 cache：`sort_key`/`search_text` 都是投影，真实展示名由代码按 `remark_name` 与 profile/group/org info 实时计算，不落库 `display_name`。

索引：

- `idx_contacts_seq(uid, seq)`
- `idx_contacts_sort(uid, status, sort_key, type, id)`
- `idx_contacts_search(uid, status, search_text)`（首版用普通索引 + LIKE，后续可换 FTS）

### 2.3 `contacts_version`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER PRIMARY KEY` | 所属用户 |
| `gc_safe_seq` | `INTEGER NOT NULL DEFAULT 0` | 已被物理清理的安全水位 |
| `max_seq` | `INTEGER NOT NULL DEFAULT 0` | 当前最大联系人序列 |

索引：仅主键。

### 2.4 `blocklist`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER NOT NULL` | 操作者 UID |
| `block_uid` | `INTEGER NOT NULL` | 被屏蔽 UID |
| `status` | `INTEGER NOT NULL CHECK (status <> 0)` | 屏蔽列表状态，0 禁止入库 |
| `seq` | `INTEGER NOT NULL DEFAULT 0` | 屏蔽列表变更序列 |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

主键：`(uid, block_uid)`。

索引：`idx_blocklist_seq(uid, seq)`。

### 2.5 `blocklist_version`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER PRIMARY KEY` | 所属用户 |
| `gc_safe_seq` | `INTEGER NOT NULL DEFAULT 0` | 已被物理清理的安全水位 |
| `max_seq` | `INTEGER NOT NULL DEFAULT 0` | 当前最大屏蔽列表序列 |

索引：仅主键。

### 2.6 `messages`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER NOT NULL` | 收件箱所属用户 |
| `seq` | `INTEGER NOT NULL` | 用户收件箱内单调递增序列 |
| `msg_id` | `TEXT NOT NULL` | 全局消息 ID；UUIDv7 的 base64url 编码（22 字符），由 SDK 生成 |
| `from_uid` | `INTEGER NOT NULL` | 发送者 UID |
| `to_uid` | `INTEGER NOT NULL DEFAULT 0` | 单聊接收者 UID；群消息为 0 |
| `group_id` | `INTEGER NOT NULL DEFAULT 0` | 群 ID；单聊为 0 |
| `msg_type` | `INTEGER NOT NULL DEFAULT 0` | 消息类型，必须与 `body` 的 oneof kind 一致 |
| `body` | `BLOB NOT NULL` | protobuf 编码后的 `MessageBody`，禁止空 bytes；元数据列继续列化，仅正文 blob 化 |
| `search_text` | `TEXT NOT NULL DEFAULT ''` | 消息搜索投影，由 `body` 派生；图片等不可搜索时为空或 caption |
| `send_time` | `INTEGER NOT NULL` | 发送时间，毫秒时间戳 |
| `status` | `INTEGER NOT NULL CHECK (status <> 0)` | 消息状态；0 禁止入库；删除 tombstone 用于同步后删除本地行 |

主键：`(uid, seq)`。

索引：

- `idx_messages_uid_msgid(uid, msg_id)`，唯一。
- `idx_messages_search(uid, search_text)`（首版用普通索引 + LIKE，后续可换 FTS）。

### 2.7 `messages_version`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER PRIMARY KEY` | 所属用户 |
| `max_seq` | `INTEGER NOT NULL DEFAULT 0` | 当前最大消息 / 会话统一序列 |

索引：仅主键。

> 消息与会话不做全量同步：真实大规模 IM 中全量同步消息不现实（动辄十几 GB，同步耗时且后端无法长期存储），只能定期清理。因此 `messages_version` 不设 `gc_safe_seq` 安全水线，消息按 `message_max_count` 保留窗口直接 GC。

### 2.8 `conversations`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER NOT NULL` | 所属用户 |
| `to_uid` | `INTEGER NOT NULL DEFAULT 0` | 单聊对端 UID；群会话为 0 |
| `group_id` | `INTEGER NOT NULL DEFAULT 0` | 群 ID；单聊为 0 |
| `seq` | `INTEGER NOT NULL` | 最近会话事件对应的消息序列，协议层仍映射为 `last_seq` |
| `last_msg_id` | `TEXT NOT NULL` | 最近消息 ID；UUIDv7 的 base64url 编码（22 字符） |
| `unread_count` | `INTEGER NOT NULL DEFAULT 0` | 未读数 |
| `status` | `INTEGER NOT NULL CHECK (status <> 0)` | 会话状态，0 禁止入库 |

主键：`(uid, to_uid, group_id)`。

索引：`idx_conversations_seq(uid, seq)`。

### 2.9 `mutelist`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER NOT NULL` | 所属用户 |
| `to_uid` | `INTEGER NOT NULL DEFAULT 0` | 单聊对端 UID；群会话为 0 |
| `group_id` | `INTEGER NOT NULL DEFAULT 0` | 群 ID；单聊为 0 |
| `status` | `INTEGER NOT NULL CHECK (status <> 0)` | 免打扰状态；`1` 开启，`0xff` 关闭 / 删除 tombstone，0 禁止入库 |
| `seq` | `INTEGER NOT NULL DEFAULT 0` | 免打扰变更序列 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

主键：`(uid, to_uid, group_id)`。

索引：`idx_mutelist_seq(uid, seq)`。

### 2.10 `mutelist_version`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER PRIMARY KEY` | 所属用户 |
| `gc_safe_seq` | `INTEGER NOT NULL DEFAULT 0` | 已被物理清理的安全水位 |
| `max_seq` | `INTEGER NOT NULL DEFAULT 0` | 当前最大免打扰序列 |

索引：仅主键。

### 2.11 `user_session`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `uid` | `INTEGER NOT NULL` | 用户 ID |
| `token` | `TEXT NOT NULL` | session token |
| `device` | `TEXT NOT NULL DEFAULT ''` | 设备标识 |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |

主键：`(uid, token)`。

索引：仅主键。

## 3. username 分片

### 3.1 `user_lookup`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `username` | `TEXT PRIMARY KEY` | 用户名 |
| `uid` | `INTEGER NOT NULL` | 用户 ID |

索引：仅主键。

## 4. token 分片

### 4.1 `session`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `token` | `TEXT PRIMARY KEY` | session token |
| `uid` | `INTEGER NOT NULL` | 用户 ID |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `expire_at` | `INTEGER NOT NULL` | 过期时间，毫秒时间戳 |

索引：`idx_session_uid(uid)`。

## 5. group 分片

### 5.1 `group_info`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `group_id` | `INTEGER PRIMARY KEY` | 群 ID |
| `name` | `TEXT NOT NULL DEFAULT ''` | 群名称 |
| `avatar` | `TEXT NOT NULL DEFAULT ''` | 群头像 |
| `owner_uid` | `INTEGER NOT NULL` | 群主 UID |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

索引：仅主键。

### 5.2 `group_member`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `group_id` | `INTEGER NOT NULL` | 群 ID |
| `uid` | `INTEGER NOT NULL` | 成员 UID |
| `role` | `INTEGER NOT NULL DEFAULT 0` | 成员角色 |
| `joined_at` | `INTEGER NOT NULL` | 入群时间，毫秒时间戳 |

主键：`(group_id, uid)`。

索引：`idx_group_member_order(group_id, role, uid)`（群成员展示通道 keyset 分页：role 倒序、uid 升序）。

## 6. org 分片

路由键 `org_id`（Snowflake 生成）；一个组织的字典、关系与版本同分片。
`org_info` / `tag_info` 是无 seq/status 的展示字典（与 `group_info` 同构，不参与同步）；
`tags` 是唯一的同步域：`seq` 来自 `org_version.max_seq`，tombstone 由 Org GC 物理清理并升 `gc_safe_seq` 水位线。

### 6.1 `org_info`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `org_id` | `INTEGER PRIMARY KEY` | 组织 ID |
| `name` | `TEXT NOT NULL DEFAULT ''` | 组织名称 |
| `avatar` | `TEXT NOT NULL DEFAULT ''` | 组织头像 |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

索引：仅主键。无 seq/status，不参与同步；改名原地更新。

### 6.2 `tag_info`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `org_id` | `INTEGER NOT NULL` | 所属组织 |
| `tag_id` | `INTEGER NOT NULL` | tag（部门/横向分组）ID |
| `name` | `TEXT NOT NULL DEFAULT ''` | tag 名 |
| `avatar` | `TEXT NOT NULL DEFAULT ''` | tag 图标 |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

主键：`(org_id, tag_id)`。无 seq/status，不参与同步；改名原地更新并级联刷新 `tags` 里以其为子项的边的 `sort_key`；删除物理删行（无 tombstone）。

### 6.3 `tags`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `org_id` | `INTEGER NOT NULL` | 所属组织 |
| `tag_id` | `INTEGER NOT NULL` | 父节点 ID；展开/挂载组织根传 `org_id` |
| `child_id` | `INTEGER NOT NULL` | 子项 ID：`child_type=PERSON` 时为 uid，`=TAG` 时为 tag_id |
| `child_type` | `INTEGER NOT NULL CHECK (child_type <> 0)` | 1=PERSON，2=TAG |
| `title` | `TEXT NOT NULL DEFAULT ''` | 本节点下的职务展示（仅人条目常用） |
| `rank` | `INTEGER NOT NULL DEFAULT 2147483647` | 边的排序值，越小越靠前；默认表示未显式排序 |
| `sort_key` | `TEXT NOT NULL DEFAULT ''` | 名字归一化排序键（人取昵称、tag 取 tag 名） |
| `role` | `INTEGER NOT NULL DEFAULT 1 CHECK (role <> 0)` | 1=MEMBER，2=ADMIN；标识该子项在这个父节点下是否为管理员 |
| `status` | `INTEGER NOT NULL CHECK (status <> 0)` | 1=ACTIVE，0xff=DELETED tombstone |
| `seq` | `INTEGER NOT NULL DEFAULT 0` | 同步序号 |
| `created_at` | `INTEGER NOT NULL` | 创建时间，毫秒时间戳 |
| `updated_at` | `INTEGER NOT NULL` | 更新时间，毫秒时间戳 |

主键：`(org_id, tag_id, child_id, child_type)`。

索引：

- `idx_tags_order(org_id, tag_id, status, rank, sort_key, child_type, child_id)`（展开即最终顺序）
- `idx_tags_seq(org_id, seq)`（同步游标顺扫）
- `idx_tags_child(org_id, child_type, child_id)`（离职判定、昵称/tag 改名联动刷投影）

### 6.4 `org_version`

| 字段 | 类型 / 约束 | 说明 |
|---|---|---|
| `org_id` | `INTEGER PRIMARY KEY` | 组织 ID |
| `gc_safe_seq` | `INTEGER NOT NULL DEFAULT 0` | 已被物理清理的安全水位 |
| `max_seq` | `INTEGER NOT NULL DEFAULT 0` | `tags` 当前最大序列 |

索引：仅主键。

## 7. 状态与类型常量

以下常量来自 `internal/dal/types.go`，用于解释上文字段中的 `status`、`role` 与 `msg_type` 取值；DDL 与本地 SDK schema 均约束 `status <> 0`，写入或响应出现 0 视为 bug。

| 字段 | 常量 / 取值 | 说明 |
|---|---|---|
| `contacts.status` | `1` = `ContactFriend` | 好友或已收藏群 |
| `contacts.status` | `2` = `ContactPending` | 待处理好友申请 |
| `contacts.status` | `0xff` = `ContactDeleted` | 已删除 tombstone，供增量同步和 Contact GC 使用 |
| `blocklist.status` | `1` = `BlocklistActive` | 屏蔽列表生效 |
| `blocklist.status` | `0xff` = `BlocklistDeleted` | 已解除 tombstone，供增量同步使用 |
| `messages.status` | `1` = `MessageActive` | 正常消息 |
| `messages.status` | `0xff` = `MessageDeleted` | 已删除 tombstone；持久 SDK 收到后删除本地消息行 |
| `conversations.status` | `1` = `ConversationActive` | 正常会话 |
| `conversations.status` | `0xff` = `ConversationDeleted` | 已删除 tombstone；持久 SDK 收到后删除本地会话行，Conversation GC 按 `seq` 窗口直接清理会话行 |
| `mutelist.status` | `1` = `MutelistActive` | 会话免打扰开启 |
| `mutelist.status` | `0xff` = `MutelistDeleted` | 会话免打扰关闭 tombstone，供增量同步和 Mute GC 使用 |
| `group_member.role` | `0` = `RoleMember` | 普通成员 |
| `group_member.role` | `2` = `RoleOwner` | 群主 |
| `messages.msg_type` | `1` = `MsgText` | 文本消息，`body.text` |
| `messages.msg_type` | `2` = `MsgImage` | 图片消息，`body.image`（仅 `media_id` 引用） |
| `messages.msg_type` | `3` = `MsgSystem` | 系统消息，`body.system` |
| `messages.msg_type` | `4` = `MsgFile` | 文件消息，`body.file`（仅 `media_id` 引用） |
| `messages.msg_type` | `5` = `MsgRecall` | 撤回事件消息，`body.recall` |
| `messages.msg_type` | `6` = `MsgQuote` | 引用消息，`body.quote` |
| `messages.msg_type` | `7` = `MsgForward` | 转发消息，`body.forward` |
| `messages.msg_type` | `8` = `MsgMarkdown` | Markdown 消息，`body.markdown` |

## 8. 维护检查点

修改以下代码时必须同步本文：

- `internal/dal/schema.go`：任何 `CREATE TABLE`、字段、主键、索引变化。
- `internal/dal/*_store.go`：若新增字段开始参与读写、排序或过滤，需要补充字段用途说明。
- `docs/server/db/数据库设计总览.md`：表清单、分片组、GC 概览变化时需要与本文互相核对。
