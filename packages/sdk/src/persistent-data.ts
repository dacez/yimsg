import { buildPersistentDbName } from './datagateway/persistent';
import { SqliteWorkerApi } from './datagateway/sqlite-worker-api';

export { ORG_CHILD_PERSON, ORG_CHILD_TAG, STATUS_DELETED } from './constants';
export {
  DEFAULT_FORWARD_MAX_ITEMS,
  DEFAULT_RECALL_WINDOW_SECONDS,
  DEFAULT_SYNC_BATCH_SIZE,
} from './internal/sdk-defaults';

/** 删除指定 UIKit 实例和用户对应的 OPFS 持久库。 */
export async function deletePersistentDataForIdentities(
  uids: readonly string[],
  instanceId: string,
): Promise<void> {
  const db = new SqliteWorkerApi();
  const errors: string[] = [];
  try {
    for (const uid of uids) {
      try {
        await db.deleteDb(buildPersistentDbName(uid, instanceId));
      } catch (error) {
        errors.push(`${uid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`删除本地数据失败：${errors.join('; ')}`);
    }
  } finally {
    db.terminate();
  }
}
