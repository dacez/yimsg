import { describe, expect, it } from 'vitest';
import { buildPersistentDbName } from '../../../src/sdk/datagateway/persistent';
import {
  clearAllPersistentDataByFileSystem,
  createPersistentDbApi,
  isPersistentFileSystemAvailable,
} from '../../../src/sdk/datagateway/sqlite-db-factory';

const LOCAL_SQLITE_TEST_TIMEOUT_MS = 30_000;

describe('sqlite-db-factory (node local backend)', () => {
  it('local 文件系统在 Node 环境可用', async () => {
    await expect(isPersistentFileSystemAvailable('local')).resolves.toBe(true);
  });

  // better-sqlite3 是原生 SQLite 后端；首次全量测试会同时安装/加载浏览器和原生依赖，
  // 在低资源 CI / 沙箱里可能明显慢于 Vitest 默认 5s，因此该用例单独放宽超时。
  it('createPersistentDbApi(local) 可读写并删除数据库文件', async () => {
    const db = await createPersistentDbApi('local');
    const dbName = buildPersistentDbName(`ut-${Date.now()}`, 'factory-local');

    try {
      await db.open(dbName);
      await db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      await db.exec('INSERT INTO t (v) VALUES (?)', ['ok']);
      const rows = await db.query('SELECT v FROM t ORDER BY id ASC');
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.v || '')).toBe('ok');
    } finally {
      await db.deleteDb(dbName);
      await db.close();
    }
  }, LOCAL_SQLITE_TEST_TIMEOUT_MS);

  it('clearAllPersistentDataByFileSystem(local) 可执行且不抛错', async () => {
    await expect(clearAllPersistentDataByFileSystem('local')).resolves.toBeUndefined();
  });
});
