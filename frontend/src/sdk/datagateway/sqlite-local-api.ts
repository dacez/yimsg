import type { DbApi } from './persistent';

type BetterSqlite3Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number };
    all: (...params: unknown[]) => Record<string, unknown>[];
  };
  close(): void;
};

type BetterSqlite3Constructor = new (file: string) => BetterSqlite3Database;

const SCHEMA_VERSION = '16';
const DB_FILE_PREFIX = 'yimsg-';
const DB_FILE_SUFFIX = '.db';
const DEFAULT_LOCAL_DB_DIRNAME = '.yimsg-sdk';

const SCHEMA_SQL = `
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
  status INTEGER NOT NULL CHECK (status <> 0)
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_uid, seq);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_uid, seq);
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages(search_text);

CREATE TABLE IF NOT EXISTS conversations (
  to_uid TEXT NOT NULL DEFAULT '0',
  group_id TEXT NOT NULL DEFAULT '0',
  seq INTEGER,
  last_msg_id TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL CHECK (status <> 0),
  PRIMARY KEY (to_uid, group_id)
);
-- 展示通道 keyset 分页按 seq 倒序（活跃→沉默）。
CREATE INDEX IF NOT EXISTS idx_conversations_seq ON conversations(seq);

CREATE TABLE IF NOT EXISTS contacts (
  type INTEGER NOT NULL,
  id TEXT NOT NULL DEFAULT '0',
  status INTEGER CHECK (status <> 0),
  remark_name TEXT NOT NULL DEFAULT '',
  sort_key TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  seq INTEGER,
  PRIMARY KEY (type, id)
);
-- friend/默认展示按 (sort_key, type, id) 升序；pending 展示按 seq 倒序。
CREATE INDEX IF NOT EXISTS idx_contacts_sort ON contacts(status, sort_key, type, id);
CREATE INDEX IF NOT EXISTS idx_contacts_seq ON contacts(status, seq);
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts(status, search_text);

CREATE TABLE IF NOT EXISTS blocklist (
  uid TEXT PRIMARY KEY,
  status INTEGER NOT NULL CHECK (status <> 0),
  seq INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);
-- 展示通道 keyset 分页按 seq 倒序（新→旧）。
CREATE INDEX IF NOT EXISTS idx_blocklist_seq ON blocklist(status, seq);

CREATE TABLE IF NOT EXISTS mutelist (
  to_uid TEXT NOT NULL DEFAULT '0',
  group_id TEXT NOT NULL DEFAULT '0',
  status INTEGER NOT NULL CHECK (status <> 0),
  seq INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (to_uid, group_id)
);
-- 展示通道 keyset 分页按 seq 倒序（新→旧）。
CREATE INDEX IF NOT EXISTS idx_mutelist_seq ON mutelist(status, seq);

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

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

async function ensureNodeRuntime(): Promise<void> {
  if (!isNodeRuntime()) {
    throw new Error('local sqlite backend requires Node.js runtime');
  }
}

async function loadBetterSqlite3(): Promise<BetterSqlite3Constructor> {
  const mod = await import('better-sqlite3');
  return (mod.default as unknown) as BetterSqlite3Constructor;
}

async function resolveDbRootDir(): Promise<string> {
  await ensureNodeRuntime();
  const path = await import('node:path');
  const os = await import('node:os');
  const cwd = typeof process.cwd === 'function' ? process.cwd() : '';
  return cwd
    ? path.join(cwd, DEFAULT_LOCAL_DB_DIRNAME)
    : path.join(os.tmpdir(), DEFAULT_LOCAL_DB_DIRNAME);
}

async function resolveDbFilePath(dbName: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const rootDir = await resolveDbRootDir();
  await fs.mkdir(rootDir, { recursive: true });
  return path.join(rootDir, dbName);
}

function isLocalPersistentDbFile(name: string): boolean {
  return name.startsWith(DB_FILE_PREFIX)
    && (name.endsWith(DB_FILE_SUFFIX)
      || name.endsWith(`${DB_FILE_SUFFIX}-wal`)
      || name.endsWith(`${DB_FILE_SUFFIX}-shm`));
}

function dbFilePaths(filePath: string): string[] {
  return [filePath, `${filePath}-wal`, `${filePath}-shm`];
}

function initializeSchema(db: BetterSqlite3Database): void {
  db.exec(SCHEMA_SQL);
  const versionRows = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").all() as Array<{ value?: string }>;
  const version = versionRows[0]?.value ?? '';
  if (version === SCHEMA_VERSION) return;

  db.exec('DROP TABLE IF EXISTS messages');
  db.exec('DROP TABLE IF EXISTS conversations');
  db.exec('DROP TABLE IF EXISTS contacts');
  db.exec('DROP TABLE IF EXISTS blocklist');
  db.exec('DROP TABLE IF EXISTS mutelist');
  db.exec('DROP TABLE IF EXISTS displayinfo');
  db.exec('DROP TABLE IF EXISTS tags');
  db.exec('DROP TABLE IF EXISTS meta');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(SCHEMA_VERSION);
}

export async function isLocalSqliteAvailable(): Promise<boolean> {
  if (!isNodeRuntime()) return false;
  try {
    await loadBetterSqlite3();
    return true;
  } catch {
    return false;
  }
}

export async function clearAllLocalPersistentDbs(): Promise<void> {
  if (!isNodeRuntime()) return;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const rootDir = await resolveDbRootDir();
  let names: string[] = [];
  try {
    names = await fs.readdir(rootDir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!isLocalPersistentDbFile(name)) continue;
    try {
      await fs.rm(path.join(rootDir, name), { force: true });
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }
}

export class LocalSqliteApi implements DbApi {
  private db: BetterSqlite3Database | null = null;
  private currentDbPath = '';

  async open(dbName: string): Promise<void> {
    const Database = await loadBetterSqlite3();
    const filePath = await resolveDbFilePath(dbName);

    if (this.db) {
      this.db.close();
      this.db = null;
      this.currentDbPath = '';
    }

    this.db = new Database(filePath);
    this.currentDbPath = filePath;
    this.db.exec('PRAGMA journal_mode = WAL');
    initializeSchema(this.db);
  }

  async exec(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    if (!this.db) throw new Error('DB not open');
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params ?? []));
    return { changes: Number(result.changes || 0) };
  }

  async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    if (!this.db) throw new Error('DB not open');
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params ?? []));
  }

  async execBatch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
    if (!this.db) throw new Error('DB not open');
    this.db.exec('BEGIN');
    try {
      for (const statement of statements) {
        this.db.prepare(statement.sql).run(...(statement.params ?? []));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.currentDbPath = '';
  }

  async deleteDb(dbName: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const filePath = await resolveDbFilePath(dbName);
    if (this.currentDbPath && this.currentDbPath === filePath) {
      await this.close();
    }
    for (const candidate of dbFilePaths(filePath)) {
      await fs.rm(candidate, { force: true });
    }
  }
}
