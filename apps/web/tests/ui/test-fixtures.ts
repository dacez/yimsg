import { test as base, expect, devices } from '@playwright/test';

const test = base;

test.afterEach(async ({ browser }) => {
  // Chromium 在 Windows 高并发下同时关闭多个带 worker/OPFS 的 context 偶尔会互相等待。
  // 先并行关闭各 context 的页面，再顺序释放 context，既不降低测试 worker 并发度，
  // 也避免业务断言完成后把整份用例预算耗在浏览器清理阶段。
  for (const context of browser.contexts()) {
    await Promise.allSettled(context.pages().map((page) => page.close({ runBeforeUnload: false })));
    await context.close();
  }
});

export { test, expect, devices };
export type { BrowserContext, Page } from '@playwright/test';
