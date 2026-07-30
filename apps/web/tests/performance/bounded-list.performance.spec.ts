import type { TestInfo } from '@playwright/test';
import { expect, test } from '../support/test-fixtures';
import {
  callBoundedListHarness as call,
  openBoundedListHarness,
  type BoundedListTestItem as TestItem,
} from '../support/bounded-list/fixture';

interface TimingSummary {
  readonly samples: number[];
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

interface PerformanceRecord {
  readonly name: string;
  readonly dataSize: number;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly durationMs?: number;
  readonly timings?: TimingSummary;
  readonly count: number;
  readonly domRows: number;
  readonly heapDeltaBytes?: number;
  readonly hardwareConcurrency: number;
  readonly userAgent: string;
}

function summarize(samples: number[]): TimingSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    samples,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? 0,
  };
}

async function attachRecord(testInfo: TestInfo, record: PerformanceRecord): Promise<void> {
  await testInfo.attach(`${record.name}.json`, {
    body: Buffer.from(JSON.stringify(record, null, 2)),
    contentType: 'application/json',
  });
}

test.describe('BoundedList 超大数据与性能门禁', () => {
  test.describe.configure({ retries: 0 });
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openBoundedListHarness(page);
  });

  test('本地 100,000 条过滤排序首屏 P95 ≤ 1500ms，DOM ≤ 200', async ({ page }, testInfo) => {
    const samples: number[] = [];
    let finalCount = 0;
    let finalRows = 0;
    for (let round = 0; round < 21; round++) {
      const result = await page.evaluate(async () => {
        const api = (window as unknown as {
          boundedListTestHarness: {
            mount(config: unknown): Promise<string>;
            state(key: string): { count: number };
            rowCount(key: string): number;
            removeCase(key: string): void;
          };
        }).boundedListTestHarness;
        const started = performance.now();
        const key = await api.mount({
          sourceKind: 'local',
          itemCount: 100_000,
          pageSize: 40,
          maxPages: 5,
          reachPx: -1,
          initialQuery: { keyword: 'item-99' },
        });
        document.body.offsetHeight;
        const durationMs = performance.now() - started;
        const count = api.state(key).count;
        const domRows = api.rowCount(key);
        api.removeCase(key);
        return { durationMs, count, domRows };
      });
      if (round > 0) samples.push(result.durationMs);
      finalCount = result.count;
      finalRows = result.domRows;
    }

    const timings = summarize(samples);
    const record: PerformanceRecord = {
      name: 'bounded-list-local-100k-reset',
      dataSize: 100_000,
      pageSize: 40,
      maxPages: 5,
      timings,
      count: finalCount,
      domRows: finalRows,
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    await attachRecord(testInfo, record);

    expect(finalCount).toBeLessThanOrEqual(200);
    expect(finalRows).toBeLessThanOrEqual(200);
    expect(timings.p95).toBeLessThanOrEqual(1_500);
  });

  test('逻辑 1,000,000 条连续翻 250 页，单页 P95 ≤ 100ms 且窗口恒 ≤ 500', async ({ page }, testInfo) => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        boundedListTestHarness: {
          mount(config: unknown): Promise<string>;
          loadMore(key: string, direction: 'forward'): Promise<void>;
          state(key: string): { count: number };
          rowCount(key: string): number;
          rowIds(key: string): string[];
          fetchCalls(key: string): unknown[];
          removeCase(key: string): void;
        };
      }).boundedListTestHarness;
      const key = await api.mount({
        logicalCount: 1_000_000,
        pageSize: 100,
        maxPages: 5,
        reachPx: -1,
      });
      const samples: number[] = [];
      let maxCount = 0;
      let maxRows = 0;
      for (let pageIndex = 0; pageIndex < 250; pageIndex++) {
        const started = performance.now();
        await api.loadMore(key, 'forward');
        document.body.offsetHeight;
        samples.push(performance.now() - started);
        maxCount = Math.max(maxCount, api.state(key).count);
        maxRows = Math.max(maxRows, api.rowCount(key));
      }
      const count = api.state(key).count;
      const domRows = api.rowCount(key);
      const rowIds = api.rowIds(key);
      const fetchCount = api.fetchCalls(key).length;
      api.removeCase(key);
      return { samples, maxCount, maxRows, count, domRows, rowIds, fetchCount };
    });
    const timings = summarize(result.samples.slice(10));
    const record: PerformanceRecord = {
      name: 'bounded-list-logical-1m-pagination',
      dataSize: 1_000_000,
      pageSize: 100,
      maxPages: 5,
      timings,
      count: result.count,
      domRows: result.domRows,
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    await attachRecord(testInfo, record);

    expect(result.maxCount).toBeLessThanOrEqual(500);
    expect(result.maxRows).toBeLessThanOrEqual(500);
    expect(result.count).toBe(500);
    expect(result.domRows).toBe(500);
    expect(result.fetchCount).toBe(251);
    expect(result.rowIds.at(0)).toBe('24600');
    expect(result.rowIds.at(-1)).toBe('25099');
    expect(timings.p95).toBeLessThanOrEqual(100);
    expect(timings.max).toBeLessThanOrEqual(250);
  });

  test('200 行窗口连续 patch 200 次，P95 ≤ 50ms 且没有 DOM 增长', async ({ page }, testInfo) => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        boundedListTestHarness: {
          mount(config: unknown): Promise<string>;
          loadMore(key: string, direction: 'forward'): Promise<void>;
          patchLabel(key: string, id: string, label: string): boolean;
          state(key: string): { count: number };
          rowCount(key: string): number;
          removeCase(key: string): void;
        };
      }).boundedListTestHarness;
      const key = await api.mount({
        logicalCount: 1_000_000,
        pageSize: 40,
        maxPages: 5,
        reachPx: -1,
      });
      for (let index = 0; index < 4; index++) await api.loadMore(key, 'forward');
      const samples: number[] = [];
      for (let index = 0; index < 200; index++) {
        const id = String(index);
        const started = performance.now();
        api.patchLabel(key, id, `patched-${index}`);
        document.body.offsetHeight;
        samples.push(performance.now() - started);
      }
      const count = api.state(key).count;
      const domRows = api.rowCount(key);
      api.removeCase(key);
      return { samples, count, domRows };
    });
    const timings = summarize(result.samples.slice(20));
    const record: PerformanceRecord = {
      name: 'bounded-list-200-row-patch',
      dataSize: 1_000_000,
      pageSize: 40,
      maxPages: 5,
      timings,
      count: result.count,
      domRows: result.domRows,
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    await attachRecord(testInfo, record);

    expect(result.count).toBe(200);
    expect(result.domRows).toBe(200);
    expect(timings.p95).toBeLessThanOrEqual(50);
    expect(timings.max).toBeLessThanOrEqual(200);
  });

  test('同一任务 10,000 次 invalidate 只触发一次追平请求', async ({ page }, testInfo) => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        boundedListTestHarness: {
          mount(config: unknown): Promise<string>;
          clearFetchCalls(key: string): void;
          invalidate(key: string, options: { count: number }): void;
          frames(count: number): Promise<void>;
          waitForIdle(key: string): Promise<void>;
          fetchCalls(key: string): unknown[];
          state(key: string): { count: number };
          rowCount(key: string): number;
          removeCase(key: string): void;
        };
      }).boundedListTestHarness;
      const key = await api.mount({
        logicalCount: 1_000_000,
        pageSize: 100,
        maxPages: 5,
        reachPx: -1,
      });
      api.clearFetchCalls(key);
      const started = performance.now();
      for (let index = 0; index < 10_000; index++) api.invalidate(key, {});
      const enqueueDurationMs = performance.now() - started;
      await api.frames(2);
      await api.waitForIdle(key);
      const fetchCount = api.fetchCalls(key).length;
      const count = api.state(key).count;
      const domRows = api.rowCount(key);
      api.removeCase(key);
      return { enqueueDurationMs, fetchCount, count, domRows };
    });
    const record: PerformanceRecord = {
      name: 'bounded-list-10k-invalidate',
      dataSize: 1_000_000,
      pageSize: 100,
      maxPages: 5,
      durationMs: result.enqueueDurationMs,
      count: result.count,
      domRows: result.domRows,
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    await attachRecord(testInfo, record);

    expect(result.fetchCount).toBe(1);
    expect(result.enqueueDurationMs).toBeLessThanOrEqual(500);
    expect(result.count).toBe(100);
    expect(result.domRows).toBe(100);
  });

  test('创建与 dispose 300 次后注册表归零，强制 GC 堆增长 ≤ 16MiB', async ({ page }, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    for (let index = 0; index < 20; index++) {
      const key = await call<string>(page, 'mount', {
        itemCount: 0,
        autoReset: false,
        pillHost: 'false',
      });
      await call(page, 'removeCase', key);
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const before = await cdp.send('Runtime.getHeapUsage') as { usedSize: number };

    const durationMs = await page.evaluate(async () => {
      const api = (window as unknown as {
        boundedListTestHarness: {
          mount(config: unknown): Promise<string>;
          removeCase(key: string): void;
        };
      }).boundedListTestHarness;
      const started = performance.now();
      for (let index = 0; index < 300; index++) {
        const key = await api.mount({
          itemCount: 0,
          autoReset: false,
          pillHost: 'false',
        });
        api.removeCase(key);
      }
      return performance.now() - started;
    });
    await cdp.send('HeapProfiler.collectGarbage');
    const after = await cdp.send('Runtime.getHeapUsage') as { usedSize: number };
    const heapDeltaBytes = Math.max(0, after.usedSize - before.usedSize);
    const record: PerformanceRecord = {
      name: 'bounded-list-300-create-dispose',
      dataSize: 0,
      pageSize: 10,
      maxPages: 3,
      durationMs,
      count: 0,
      domRows: 0,
      heapDeltaBytes,
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    await attachRecord(testInfo, record);

    expect(await call<string[]>(page, 'registryIds')).toEqual([]);
    await expect(page.locator('.bl-case')).toHaveCount(0);
    expect(heapDeltaBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  test('BL-BUG-010：连续 1,000 次 upsertLocal 后仍必须满足硬上限', async ({ page }, testInfo) => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        boundedListTestHarness: {
          mount(config: unknown): Promise<string>;
          upsertLocal(key: string, item: TestItem): void;
          state(key: string): { count: number };
          rowCount(key: string): number;
        };
      }).boundedListTestHarness;
      const key = await api.mount({
        logicalCount: 1_000_000,
        pageSize: 50,
        maxPages: 4,
        freshEdge: 'tail',
        reachPx: -1,
      });
      const started = performance.now();
      for (let index = 0; index < 1_000; index++) {
        api.upsertLocal(key, {
          id: `live-${index}`,
          label: `live-${index}`,
          order: 1_000_000 + index,
        });
      }
      document.body.offsetHeight;
      return {
        durationMs: performance.now() - started,
        count: api.state(key).count,
        domRows: api.rowCount(key),
      };
    });
    const record: PerformanceRecord = {
      name: 'bounded-list-1k-live-upsert',
      dataSize: 1_000_000,
      pageSize: 50,
      maxPages: 4,
      durationMs: result.durationMs,
      count: result.count,
      domRows: result.domRows,
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      userAgent: await page.evaluate(() => navigator.userAgent),
    };
    await attachRecord(testInfo, record);

    expect(result.count).toBeLessThanOrEqual(200);
    expect(result.domRows).toBeLessThanOrEqual(200);
  });
});
