/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';

let db: Database | null = null;

const SCHEMA_VERSION = '14';

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

CREATE TABLE IF NOT EXISTS tags (
  org_id TEXT NOT NULL DEFAULT '0',
  tag_id TEXT NOT NULL DEFAULT '0',
  child_id TEXT NOT NULL DEFAULT '0',
  child_type INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 2147483647,
  sort_key TEXT NOT NULL DEFAULT '',
  role INTEGER NOT NULL DEFAULT 0,
  seq INTEGER,
  PRIMARY KEY (org_id, tag_id, child_id, child_type)
);
-- 展开即最终顺序：与服务端 idx_tags_order 同构（本地无 status，tombstone 即删）。
CREATE INDEX IF NOT EXISTS idx_tags_order ON tags(org_id, tag_id, rank, sort_key, child_type, child_id);


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
  org_id TEXT NOT NULL DEFAULT '0',
  tag_id TEXT NOT NULL DEFAULT '0',
  username TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  remark_name TEXT NOT NULL DEFAULT '',
  updated_at INTEGER,
  PRIMARY KEY (uid, group_id, org_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_displayinfo_updated_at ON displayinfo(updated_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

async function handleOpen(dbName: string): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  if (!sqlite3.oo1.OpfsDb) {
    throw new Error('persistent storage backend not available');
  }
  db = new sqlite3.oo1.OpfsDb(dbName, 'cw');

  // Schema version check: rebuild if mismatch
  db.exec(SCHEMA);
  const verRows = db.selectObjects("SELECT value FROM meta WHERE key = 'schema_version'") as { value: string }[];
  const ver = verRows[0]?.value || '';
  if (ver !== SCHEMA_VERSION) {
    // Drop old tables and recreate
    db.exec('DROP TABLE IF EXISTS messages');
    db.exec('DROP TABLE IF EXISTS conversations');
    db.exec('DROP TABLE IF EXISTS contacts');
    db.exec('DROP TABLE IF EXISTS blocklist');
    db.exec('DROP TABLE IF EXISTS mutelist');
    db.exec('DROP TABLE IF EXISTS displayinfo');
    db.exec('DROP TABLE IF EXISTS tags');
    db.exec('DROP TABLE IF EXISTS meta');
    db.exec(SCHEMA);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", { bind: [SCHEMA_VERSION] });
  }
}

function handleExec(sql: string, params?: unknown[]): { changes: number } {
  if (!db) throw new Error('DB not open');
  db.exec({ sql, bind: params as never });
  return { changes: db.changes() };
}

function handleQuery(sql: string, params?: unknown[]): Record<string, unknown>[] {
  if (!db) throw new Error('DB not open');
  return db.selectObjects(sql, params as never) as Record<string, unknown>[];
}

function handleExecBatch(statements: { sql: string; params?: unknown[] }[]): void {
  if (!db) throw new Error('DB not open');
  db.exec('BEGIN');
  try {
    for (const s of statements) {
      db.exec({ sql: s.sql, bind: s.params as never });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function handleClose(): void {
  if (db) {
    db.close();
    db = null;
  }
}

async function handleDeleteDb(dbName: string): Promise<void> {
  handleClose();
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(dbName);
  } catch (_) {
    // File may not exist, ignore
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = e.data as {
    id: number;
    method: string;
    args: unknown[];
  };
  try {
    let result: unknown;
    switch (method) {
      case 'open':
        result = await handleOpen(args[0] as string);
        break;
      case 'exec':
        result = handleExec(args[0] as string, args[1] as unknown[] | undefined);
        break;
      case 'query':
        result = handleQuery(args[0] as string, args[1] as unknown[] | undefined);
        break;
      case 'execBatch':
        result = handleExecBatch(args[0] as { sql: string; params?: unknown[] }[]);
        break;
      case 'close':
        result = handleClose();
        break;
      case 'deleteDb':
        result = await handleDeleteDb(args[0] as string);
        break;
      default:
        throw new Error('Unknown method: ' + method);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
