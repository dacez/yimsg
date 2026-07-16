import type { SessionFileSystem } from '../types';
import type { DbApi } from './persistent';
import { SqliteWorkerApi } from './sqlite-worker-api';
import { LocalSqliteApi, clearAllLocalPersistentDbs, isLocalSqliteAvailable } from './sqlite-local-api';

export function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

async function isOpfsSqliteAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return false;
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle('__yimsg_storage_test__', { create: true });
    await root.removeEntry('__yimsg_storage_test__');
    return true;
  } catch {
    return false;
  }
}

export async function isPersistentFileSystemAvailable(fileSystem: SessionFileSystem): Promise<boolean> {
  if (fileSystem === 'opfs') return isOpfsSqliteAvailable();
  return isLocalSqliteAvailable();
}

export async function createPersistentDbApi(fileSystem: SessionFileSystem): Promise<DbApi> {
  if (fileSystem === 'opfs') {
    return new SqliteWorkerApi();
  }
  return new LocalSqliteApi();
}

export async function clearAllPersistentDataByFileSystem(fileSystem: SessionFileSystem): Promise<void> {
  if (fileSystem === 'opfs') {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return;
    const root = await navigator.storage.getDirectory();
    const entries = (root as unknown as { entries?: () => AsyncIterableIterator<[string, unknown]> }).entries;
    if (typeof entries !== 'function') return;
    for await (const [name] of entries.call(root)) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // Ignore best-effort cleanup failures.
      }
    }
    return;
  }

  await clearAllLocalPersistentDbs();
}
