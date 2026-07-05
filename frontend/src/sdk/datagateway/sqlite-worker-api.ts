export class SqliteWorkerApi {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(
      new URL('../../worker/sqlite.worker.ts', import.meta.url),
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
    for (const p of this.pending.values()) {
      p.reject(new Error('Worker terminated'));
    }
    this.pending.clear();
  }
}
