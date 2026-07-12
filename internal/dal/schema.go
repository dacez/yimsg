// Package dal provides the data access layer with types, schemas, and store implementations.
package dal

// Schemas returns DDL statements for each shard group.
func Schemas() map[string]string {
	return map[string]string{
		"uid":      schemaUID,
		"username": schemaUsername,
		"token":    schemaToken,
		"group":    schemaGroup,
		"org":      schemaOrg,
	}
}

const schemaUID = `
CREATE TABLE IF NOT EXISTS user_info (
    uid           INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    nickname      TEXT    NOT NULL DEFAULT '',
    avatar        TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    uid            INTEGER NOT NULL,
    type           INTEGER NOT NULL,
    id             INTEGER NOT NULL,
    status         INTEGER NOT NULL CHECK (status <> 0),
    remark_name    TEXT    NOT NULL DEFAULT '',
    sort_key       TEXT    NOT NULL DEFAULT '',
    search_text    TEXT    NOT NULL DEFAULT '',
    seq            INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (uid, type, id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_seq ON contacts(uid, seq);
CREATE INDEX IF NOT EXISTS idx_contacts_sort ON contacts(uid, status, sort_key, type, id);
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts(uid, status, search_text);

CREATE TABLE IF NOT EXISTS contacts_version (
    uid         INTEGER PRIMARY KEY,
    gc_safe_seq INTEGER NOT NULL DEFAULT 0,
    max_seq     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blocklist (
    uid       INTEGER NOT NULL,
    block_uid INTEGER NOT NULL,
    status    INTEGER NOT NULL CHECK (status <> 0),
    seq       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (uid, block_uid)
);
CREATE INDEX IF NOT EXISTS idx_blocklist_seq ON blocklist(uid, seq);

CREATE TABLE IF NOT EXISTS blocklist_version (
    uid         INTEGER PRIMARY KEY,
    gc_safe_seq INTEGER NOT NULL DEFAULT 0,
    max_seq     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    uid         INTEGER NOT NULL,
    seq         INTEGER NOT NULL,
    msg_id      TEXT    NOT NULL,
    from_uid    INTEGER NOT NULL,
    to_uid      INTEGER NOT NULL DEFAULT 0,
    group_id    INTEGER NOT NULL DEFAULT 0,
    msg_type    INTEGER NOT NULL DEFAULT 0,
    body        BLOB    NOT NULL,
    search_text TEXT    NOT NULL DEFAULT '',
    send_time   INTEGER NOT NULL,
    status      INTEGER NOT NULL CHECK (status <> 0),
    PRIMARY KEY (uid, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uid_msgid ON messages(uid, msg_id);
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages(uid, search_text);

-- messages_version 只维护 max_seq；消息与会话不做全量同步，因此不需要 gc_safe_seq 安全水线。
CREATE TABLE IF NOT EXISTS messages_version (
    uid     INTEGER PRIMARY KEY,
    max_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
    uid            INTEGER NOT NULL,
    to_uid         INTEGER NOT NULL DEFAULT 0,
    group_id       INTEGER NOT NULL DEFAULT 0,
    seq            INTEGER NOT NULL,
    last_msg_id    TEXT    NOT NULL,
    unread_count   INTEGER NOT NULL DEFAULT 0,
    status         INTEGER NOT NULL CHECK (status <> 0),
    PRIMARY KEY (uid, to_uid, group_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_seq ON conversations(uid, seq);

CREATE TABLE IF NOT EXISTS mutelist (
    uid        INTEGER NOT NULL,
    to_uid     INTEGER NOT NULL DEFAULT 0,
    group_id   INTEGER NOT NULL DEFAULT 0,
    status     INTEGER NOT NULL CHECK (status <> 0),
    seq        INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (uid, to_uid, group_id)
);
CREATE INDEX IF NOT EXISTS idx_mutelist_seq ON mutelist(uid, seq);

CREATE TABLE IF NOT EXISTS mutelist_version (
    uid         INTEGER PRIMARY KEY,
    gc_safe_seq INTEGER NOT NULL DEFAULT 0,
    max_seq     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_session (
    uid        INTEGER NOT NULL,
    token      TEXT    NOT NULL,
    device     TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (uid, token)
);
`

const schemaUsername = `
CREATE TABLE IF NOT EXISTS user_lookup (
    username TEXT    PRIMARY KEY,
    uid      INTEGER NOT NULL
);
`

const schemaToken = `
CREATE TABLE IF NOT EXISTS session (
    token     TEXT    PRIMARY KEY,
    uid       INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expire_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_uid ON session(uid);
`

const schemaGroup = `
CREATE TABLE IF NOT EXISTS group_info (
    group_id   INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL DEFAULT '',
    avatar     TEXT    NOT NULL DEFAULT '',
    owner_uid  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_member (
    group_id       INTEGER NOT NULL,
    uid            INTEGER NOT NULL,
    role           INTEGER NOT NULL DEFAULT 0,
    joined_at      INTEGER NOT NULL,
    PRIMARY KEY (group_id, uid)
);
-- 群成员展示通道 keyset 分页：按 role 倒序、uid 升序。
CREATE INDEX IF NOT EXISTS idx_group_member_order ON group_member(group_id, role, uid);
`

const schemaOrg = `
-- 组织字典表：仅组织展示信息，无 seq/status，不参与同步（与 group_info 同构）。
CREATE TABLE IF NOT EXISTS org_info (
    org_id     INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL DEFAULT '',
    avatar     TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- tag 字典表：部门/横向分组的展示信息，无 seq/status，不参与同步。
CREATE TABLE IF NOT EXISTS tag_info (
    org_id     INTEGER NOT NULL,
    tag_id     INTEGER NOT NULL,
    name       TEXT    NOT NULL DEFAULT '',
    avatar     TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, tag_id)
);

-- tags：唯一的同步域（组织关系表）。一行是"某父节点（组织根传 org_id、
-- 部门传 tag_id）下挂一个子项"，child_type 区分子项是人（PERSON, child_id=uid）、
-- tag（TAG, child_id=tag_id）还是管理员授权（GRANT, child_id=uid）；GRANT 行
-- 表示该用户被授权管理 tag_id 为根的整棵子树，与组织架构位置（PERSON 行）
-- 完全解耦，不进入展开/同步的展示结果；rank/title/sort_key 是边的属性，
-- GRANT 行不使用，取默认值。
CREATE TABLE IF NOT EXISTS tags (
    org_id     INTEGER NOT NULL,
    tag_id     INTEGER NOT NULL,
    child_id   INTEGER NOT NULL,
    child_type INTEGER NOT NULL CHECK (child_type <> 0),
    title      TEXT    NOT NULL DEFAULT '',
    rank       INTEGER NOT NULL DEFAULT 2147483647,
    sort_key   TEXT    NOT NULL DEFAULT '',
    status     INTEGER NOT NULL CHECK (status <> 0),
    seq        INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, tag_id, child_id, child_type)
);
-- 展开一个父节点：仅 ACTIVE 行，tag 与人混合的绝对排序 + keyset 分页，索引即最终顺序。
CREATE INDEX IF NOT EXISTS idx_tags_order ON tags(org_id, tag_id, status, rank, sort_key, child_type, child_id);
-- 同步游标：seq 增量顺扫。
CREATE INDEX IF NOT EXISTS idx_tags_seq ON tags(org_id, seq);
-- 按子项反查：离职判定（人是否还有边）、昵称/tag 改名联动刷投影。
CREATE INDEX IF NOT EXISTS idx_tags_child ON tags(org_id, child_type, child_id);

-- 版本表：tags 的 seq 空间 + GC 水位线（先例：messages_version）。
CREATE TABLE IF NOT EXISTS org_version (
    org_id      INTEGER PRIMARY KEY,
    gc_safe_seq INTEGER NOT NULL DEFAULT 0,
    max_seq     INTEGER NOT NULL DEFAULT 0
);
`
