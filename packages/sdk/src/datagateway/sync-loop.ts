type IncrementalSyncStatus = 'idle' | 'changed' | 'seq_too_old';

/**
 * 一页增量同步结果：完全由服务端字段驱动循环。
 * - items：本页条目；
 * - hasMore：服务端是否还有更多增量（达到 limit 时为 true）；
 * - cursorSeq：下一次增量同步应使用的 last_seq 游标（本批最大 seq，空批为 0）；
 * - error：seq_too_old 等需要重建的信号。
 */
export interface SyncPage<T> {
  readonly items: T[];
  readonly hasMore: boolean;
  readonly cursorSeq: number;
  readonly error?: string;
}

interface IncrementalSyncOptions<T> {
  readonly initialCursor: number;
  readonly pageSize: number;
  readonly getBatch: (cursor: number, limit: number) => Promise<SyncPage<T>>;
  readonly onBatch?: (items: T[]) => void | Promise<void>;
}

interface PersistentTableSyncOptions<T> extends Omit<IncrementalSyncOptions<T>, 'getBatch'> {
  readonly getBatch: (cursor: number, limit: number, rebuild: boolean) => Promise<SyncPage<T>>;
  readonly onReset?: () => void | Promise<void>;
}

export async function runIncrementalSync<T>(options: IncrementalSyncOptions<T>): Promise<IncrementalSyncStatus> {
  if (options.initialCursor < 0) {
    throw new Error('initialCursor must be non-negative');
  }
  let cursor = options.initialCursor;
  let changed = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await options.getBatch(cursor, options.pageSize);
    if (result.error === 'seq_too_old') {
      return 'seq_too_old';
    }

    if (result.items.length > 0) {
      changed = true;
      await options.onBatch?.(result.items);
    }

    if (!result.hasMore) {
      break;
    }
    if (result.cursorSeq <= cursor) {
      throw new Error('sync cursor must increase');
    }
    cursor = result.cursorSeq;
  }

  return changed ? 'changed' : 'idle';
}

export async function runPersistentTableSync<T>(options: PersistentTableSyncOptions<T>): Promise<IncrementalSyncStatus> {
  if (options.initialCursor < 0) {
    throw new Error('initialCursor must be non-negative');
  }

  let cursor = options.initialCursor;
  let changed = false;
  let rebuilding = cursor === 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await options.getBatch(cursor, options.pageSize, rebuilding);
    if (result.error === 'seq_too_old') {
      if (rebuilding) {
        return changed ? 'changed' : 'seq_too_old';
      }
      await options.onReset?.();
      cursor = 0;
      rebuilding = true;
      changed = true;
      continue;
    }

    if (result.items.length > 0) {
      changed = true;
      await options.onBatch?.(result.items);
    }

    if (!result.hasMore) {
      break;
    }
    if (result.cursorSeq <= cursor) {
      throw new Error('sync cursor must increase');
    }
    cursor = result.cursorSeq;
  }

  rebuilding = false;
  return changed ? 'changed' : 'idle';
}
