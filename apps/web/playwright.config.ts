import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  // UI E2E 会在全量脚本中与服务端和多浏览器上下文共同运行；
  // 总预算覆盖 beforeEach、测试体和清理；各业务状态仍使用自身的 5-20s 断言超时。
  // 多端同步 / 多实例 UIKit 在默认并发下会连续经历多段状态等待，因此总预算需高于
  // 任意单段超时之和，避免所有业务状态均按时完成后在夹具清理阶段误判超时。
  timeout: 120_000,
  // 全并发（下方 workers: '100%'）下个别用例可能撞上 CPU 争抢导致的偶发超时，
  // 失败自动重跑一次以吸收这类基础设施抖动；真实回归会连续两次失败，不会被掩盖。
  retries: 1,
  // 默认按 CPU 核数并行运行 UI 用例（Playwright 默认仅用一半核数）。
  // 用例之间互不共享状态、各自创建独立用户，提升并行度只缩短耗时、不降低测试强度。
  // 可用 PLAYWRIGHT_WORKERS 覆盖（数字或百分比，如 "4" / "50%"）。环境变量恒为字符串，
  // 而 Playwright 校验只接受真正的 number 类型或以 "%" 结尾的字符串，纯数字字符串会被
  // 拒绝，因此这里做一次数字字符串到 number 的转换。
  workers: (() => {
    const raw = process.env.PLAYWRIGHT_WORKERS;
    if (!raw) return '100%';
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  })(),
  globalSetup: './tests/ui/global-setup.ts',
  globalTeardown: './tests/ui/global-teardown.ts',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:18080',
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // 使用完整 chromium 构建（channel: 'chromium'）以新版无头模式运行，
      // 而非单独的 chrome-headless-shell 二进制：后者是一个额外的大体积下载，
      // 在受限代理 / 沙箱网络下最易被中断而导致整轮 UI 测试失败；
      // 完整 chromium 构建下载更稳定，且功能与无头能力完全一致。
      use: { browserName: 'chromium', channel: 'chromium' },
    },
  ],
});
