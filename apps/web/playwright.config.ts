import { defineConfig } from '@playwright/test';

const boundedListStandalone = process.env.BOUNDED_LIST_STANDALONE === '1';

function configuredWorkers(): number | string {
  const raw = process.env.PLAYWRIGHT_WORKERS;
  if (!raw) return '100%';
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export default defineConfig({
  testDir: './tests',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || './test-results',
  // 总预算覆盖 beforeEach、测试体和清理；具体业务等待仍使用各自的短超时。
  timeout: 120_000,
  // 正确性与性能门禁都禁用 retry，确保并发失败和性能退化不会被重跑掩盖。
  retries: 0,
  workers: configuredWorkers(),
  // BoundedList 组件与性能测试由 route.fulfill 提供独立宿主，无需账号、数据库或后端。
  globalSetup: boundedListStandalone ? undefined : './tests/support/global-setup.ts',
  globalTeardown: boundedListStandalone ? undefined : './tests/support/global-teardown.ts',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:18080',
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-e2e',
      testMatch: 'e2e/**/*.spec.ts',
      use: { browserName: 'chromium', channel: 'chromium' },
    },
    {
      name: 'chromium-component',
      testMatch: 'component/**/*.spec.ts',
      fullyParallel: true,
      use: { browserName: 'chromium', channel: 'chromium' },
    },
    {
      name: 'chromium-performance',
      testMatch: 'performance/**/*.performance.spec.ts',
      fullyParallel: false,
      retries: 0,
      use: { browserName: 'chromium', channel: 'chromium' },
    },
  ],
});
