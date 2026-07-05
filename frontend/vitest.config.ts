import { defineConfig } from 'vitest/config';

// 覆盖率阈值说明：
// - 单测覆盖率用于 CI 质量趋势指标，默认在执行 `npm run test:unit:coverage` 时生效。
// - 阈值保守起步，后续逐步上调；临时下调需同步在 `docs/测试方案.md` 留痕。
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // 单测覆盖率口径仅包含 UI 无关的 SDK 源码。
      // UIKit / 视图 / Worker 主要由 Playwright UI 测试与 SDK 集成测试覆盖，
      // 不在单测覆盖率阈值内；若未来引入组件级单测，可扩大此 include 列表。
      include: ['src/sdk/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/sdk/**/types.ts',
        'src/sdk/contracts.typecheck.ts',
        'src/sdk/index.ts',
      ],
      thresholds: {
        lines: 55,
        statements: 55,
        functions: 55,
        branches: 50,
      },
    },
  },
});
