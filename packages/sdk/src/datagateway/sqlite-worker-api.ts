import { FifoMap } from '../internal/bounded';
import { DEFAULT_SQLITE_WORKER_MAX_PENDING_CALLS } from '../internal/sdk-defaults';

export class SqliteWorkerApi {
  private worker: Worker;
  private nextId = 0;
  private readonly pending = new FifoMap<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>({
    capacity: DEFAULT_SQLITE_WORKER_MAX_PENDING_CALLS,
  });

  constructor() {
    this.worker = new Worker(
      new URL('../worker/sqlite.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
  }

  private call(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.pending.size >= DEFAULT_SQLITE_WORKER_MAX_PENDING_CALLS) {
        reject(new Error(`SQLite worker 并发调用已达上限（最多 ${DEFAULT_SQLITE_WORKER_MAX_PENDING_CALLS} 个）`));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  open(dbName: string): Promise<void> {
    return this.call('open', [dbName]) as Promise<void>;
  }

  exec(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.call('exec', [sql, params]) as Promise<{ changes: number }>;
  }

  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    return this.call('query', [sql, params]) as Promise<Record<string, unknown>[]>;
  }

  execBatch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
    return this.call('execBatch', [statements]) as Promise<void>;
  }

  close(): Promise<void> {
    return this.call('close', []) as Promise<void>;
  }

  deleteDb(dbName: string): Promise<void> {
    return this.call('deleteDb', [dbName]) as Promise<void>;
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.forEach((p) => {
      p.reject(new Error('Worker terminated'));
    });
    this.pending.clear();
  }
}
