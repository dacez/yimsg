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
-- 节点表：组织、部门、横向分组统一为 tag；根 tag 的 tag_id == org_id，
-- 其 name / avatar 即组织名称与头像（通讯录组织条目的展示数据源）。
CREATE TABLE IF NOT EXISTS org_tag (
    org_id     INTEGER NOT NULL,
    tag_id     INTEGER NOT NULL,
    name       TEXT    NOT NULL DEFAULT '',
    avatar     TEXT    NOT NULL DEFAULT '',
    status     INTEGER NOT NULL CHECK (status <> 0),
    seq        INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_org_tag_seq ON org_tag(org_id, seq);

-- 边表：唯一的关系表。一行是"tag 包含子 tag"（child_tag_id>0, uid=0）
-- 或"tag 包含人"（uid>0, child_tag_id=0），互斥；rank/title/sort_key 是边的属性。
CREATE TABLE IF NOT EXISTS org_tag_item (
    org_id       INTEGER NOT NULL,
    tag_id       INTEGER NOT NULL,
    child_tag_id INTEGER NOT NULL DEFAULT 0,
    uid          INTEGER NOT NULL DEFAULT 0,
    title        TEXT    NOT NULL DEFAULT '',
    rank         INTEGER NOT NULL DEFAULT 2147483647,
    sort_key     TEXT    NOT NULL DEFAULT '',
    status       INTEGER NOT NULL CHECK (status <> 0),
    seq          INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (org_id, tag_id, child_tag_id, uid)
);
-- 展开一个 tag：仅 ACTIVE 行，子 tag 与人混合的绝对排序 + keyset 分页，索引即最终顺序。
CREATE INDEX IF NOT EXISTS idx_org_tag_item_order ON org_tag_item(org_id, tag_id, status, rank, sort_key, child_tag_id, uid);
-- 同步游标：seq 增量顺扫。
CREATE INDEX IF NOT EXISTS idx_org_tag_item_seq ON org_tag_item(org_id, seq);
-- 按人反查：离职判定（是否还有边）、昵称变化刷投影、未来"定位某人"。
CREATE INDEX IF NOT EXISTS idx_org_tag_item_uid ON org_tag_item(org_id, uid);

-- 版本表：节点与边共用的单一 seq 空间 + GC 水位线（先例：messages_version）。
CREATE TABLE IF NOT EXISTS org_version (
    org_id      INTEGER PRIMARY KEY,
    gc_safe_seq INTEGER NOT NULL DEFAULT 0,
    max_seq     INTEGER NOT NULL DEFAULT 0
);
`
