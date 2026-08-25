/**
 * 持久化后端工厂。
 *
 * 浏览器端不提供 SQLite 持久化：Web 场景（含嵌入第三方站点的 UIKit）一律使用
 * 内存 DataGateway，请求 persistent 时由 `startSession` 自动降级为 instant。
 * SQLite 只服务于跑在 Node 运行时的本地客户端，`DbApi` 抽象与本工厂保持不变，
 * 便于后续接入其它本地后端。
 */

import type { SessionFileSystem } from '../types';
import type { DbApi } from './persistent';
import { LocalSqliteApi, clearAllLocalPersistentDbs, isLocalSqliteAvailable } from './sqlite-local-api';

export { isNodeRuntime } from '../internal/runtime';

export async function isPersistentFileSystemAvailable(fileSystem: SessionFileSystem): Promise<boolean> {
  switch (fileSystem) {
    case 'local':
      return isLocalSqliteAvailable();
    default:
      return false;
  }
}

export async function createPersistentDbApi(fileSystem: SessionFileSystem): Promise<DbApi> {
  switch (fileSystem) {
    case 'local':
      return new LocalSqliteApi();
    default:
      throw new Error('不支持的持久化后端：' + String(fileSystem));
  }
}

export async function clearAllPersistentDataByFileSystem(fileSystem: SessionFileSystem): Promise<void> {
  switch (fileSystem) {
    case 'local':
      await clearAllLocalPersistentDbs();
      return;
    default:
      return;
  }
}
