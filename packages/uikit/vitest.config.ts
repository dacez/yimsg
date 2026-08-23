import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // 显式超时，不用 vitest 默认的 5s。UIKit 单测里多个用例在测试体内做动态 import
    // （`uikit-mount` 导入整个 `src` 及其 SDK 依赖图）或构造数万条压力数据，而
    // `run_all_tests.sh` 会先跑 protocolgen 重写协议生成物，把 vite 变换缓存整体作废；
    // 冷缓存下仅 transform 就要 20s 左右，默认 5s 会把"导入慢"误报成用例失败。
    // 这里只放宽到能容纳冷缓存首轮导入，仍足以捕获真正的挂起。
    testTimeout: 20_000,
  },
});
