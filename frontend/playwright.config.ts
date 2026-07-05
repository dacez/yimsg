import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  // UI E2E 会在全量脚本中与服务端和多浏览器上下文共同运行；
  // 多端同步 / 多实例 UIKit 用例在低资源 CI 或沙箱下偶尔超过 30s，
  // 因此使用 60s 作为单用例上限，避免把资源竞争误判为业务失败。
  timeout: 60_000,
  retries: 0,
  // 默认按 CPU 核数并行运行 UI 用例（Playwright 默认仅用一半核数）。
  // 用例之间互不共享状态、各自创建独立用户，提升并行度只缩短耗时、不降低测试强度。
  // 可用 PLAYWRIGHT_WORKERS 覆盖（数字或百分比，如 "4" / "50%"）。
  workers: process.env.PLAYWRIGHT_WORKERS || '100%',
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
