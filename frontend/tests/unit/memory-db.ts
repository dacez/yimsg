/**
 * MemoryDb — in-memory SQLite that implements DbApi for unit testing.
 * Uses better-sqlite3 (synchronous API wrapped in async to match DbApi).
 */
import Database from 'better-sqlite3';
import type { DbApi } from '../../src/sdk/datagateway/persistent';
import { MessageBody } from '../../src/sdk/generated/yimsg';

function encodeTextBody(text: string): Buffer {
  return Buffer.from(MessageBody.encode({ text: { text } } as MessageBody).finish());
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY,
  msg_id TEXT UNIQUE,
  from_uid TEXT NOT NULL DEFAULT '0',
  to_uid TEXT NOT NULL DEFAULT '0',
  group_id TEXT NOT NULL DEFAULT '0',
  msg_type INTEGER,
  body BLOB,
  search_text TEXT NOT NULL DEFAULT '',
  send_time INTEGER,
  status INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages(search_text);

CREATE TABLE IF NOT EXISTS conversations (
  to_uid TEXT NOT NULL DEFAULT '0',
  group_id TEXT NOT NULL DEFAULT '0',
  seq INTEGER,
  last_msg_id TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (to_uid, group_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  type INTEGER NOT NULL,
  id TEXT NOT NULL DEFAULT '0',
  status INTEGER,
  remark_name TEXT NOT NULL DEFAULT '',
  sort_key TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  seq INTEGER,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_sort ON contacts(status, sort_key, type, id);
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts(status, search_text);

CREATE TABLE IF NOT EXISTS org_tag (
  org_id TEXT NOT NULL DEFAULT '0',
  tag_id TEXT NOT NULL DEFAULT '0',
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  seq INTEGER,
  PRIMARY KEY (org_id, tag_id)
);

CREATE TABLE IF NOT EXISTS org_tag_item (
  org_id TEXT NOT NULL DEFAULT '0',
  tag_id TEXT NOT NULL DEFAULT '0',
  child_tag_id TEXT NOT NULL DEFAULT '0',
  uid TEXT NOT NULL DEFAULT '0',
  title TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 2147483647,
  sort_key TEXT NOT NULL DEFAULT '',
  seq INTEGER,
  PRIMARY KEY (org_id, tag_id, child_tag_id, uid)
);
-- 展开即最终顺序：与服务端 idx_org_tag_item_order 同构（本地无 status，tombstone 即删）。
CREATE INDEX IF NOT EXISTS idx_org_tag_item_order ON org_tag_item(org_id, tag_id, rank, sort_key, child_tag_id, uid);


CREATE TABLE IF NOT EXISTS blocklist (
  uid TEXT PRIMARY KEY,
  status INTEGER NOT NULL DEFAULT 0,
  seq INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_blocklist_status ON blocklist(status, updated_at, uid);

CREATE TABLE IF NOT EXISTS mutelist (
  to_uid TEXT NOT NULL DEFAULT '0',
  group_id TEXT NOT NULL DEFAULT '0',
  status INTEGER NOT NULL DEFAULT 0,
  seq INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (to_uid, group_id)
);
CREATE INDEX IF NOT EXISTS idx_mutelist_updated_at ON mutelist(updated_at, to_uid, group_id);

CREATE TABLE IF NOT EXISTS displayinfo (
  uid TEXT NOT NULL DEFAULT '0',
  group_id TEXT NOT NULL DEFAULT '0',
  username TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  remark_name TEXT NOT NULL DEFAULT '',
  updated_at INTEGER,
  PRIMARY KEY (uid, group_id)
);
CREATE INDEX IF NOT EXISTS idx_displayinfo_updated_at ON displayinfo(updated_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export class MemoryDb implements DbApi {
  private db: Database.Database | null = null;

  async open(_dbName: string): Promise<void> {
    this.db = new Database(':memory:');
    this.db.exec(SCHEMA);
  }

  async exec(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    if (!this.db) throw new Error('DB not open');
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return { changes: result.changes };
  }

  async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    if (!this.db) throw new Error('DB not open');
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[];
  }

  async execBatch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
    if (!this.db) throw new Error('DB not open');
    const txn = this.db.transaction(() => {
      for (const s of statements) {
        const stmt = this.db!.prepare(s.sql);
        if (s.params) stmt.run(...s.params);
        else stmt.run();
      }
    });
    txn();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async deleteDb(_dbName: string): Promise<void> {
    await this.close();
  }
}

// ---- Test data helpers ----

export interface MsgSeed {
  seq: number;
  fromUid?: string;
  toUid?: string;
  groupId?: string;
  content?: string;
  status?: number;
}

export async function seedMessages(db: DbApi, msgs: MsgSeed[]): Promise<void> {
  const stmts = msgs.map((m) => {
    const text = m.content || `message_${m.seq}`;
    return {
      sql: 'INSERT INTO messages (seq, msg_id, from_uid, to_uid, group_id, msg_type, body, search_text, send_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        m.seq,
        `msg_${m.seq}`,
        m.fromUid || '100',
        m.toUid || '200',
        m.groupId || '0',
        1,
        encodeTextBody(text),
        text,
        1000 + m.seq,
        m.status || 0,
      ],
    };
  });
  await db.execBatch(stmts);
}

export async function seedConversation(
  db: DbApi,
  toUid: string,
  groupId: string,
  lastSeq: number,
): Promise<void> {
  await db.exec(
    'INSERT INTO conversations (to_uid, group_id, seq, last_msg_id, unread_count, status) VALUES (?, ?, ?, ?, ?, ?)',
    [toUid, groupId, lastSeq, `msg_${lastSeq}`, 0, 0],
  );
}
