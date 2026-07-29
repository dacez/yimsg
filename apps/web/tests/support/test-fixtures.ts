import { test as base, expect, devices } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

const managedContexts = new WeakSet<BrowserContext>();
const cleanupTimeoutMs = 5_000;

async function settleCleanup(action: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, cleanupTimeoutMs);
  });
  try {
    await Promise.race([action().then(() => undefined, () => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const test = base.extend({
  context: async ({ context }, use) => {
    managedContexts.add(context);
    await use(context);
  },
});

test.afterEach(async ({ browser }) => {
  // 先关闭页面，释放 worker、WebSocket 和 OPFS 资源；默认 context 仍交给 Playwright 回收。
  // 手动创建的额外 context 由这里顺序关闭，并限制单次清理预算，避免清理阻塞整个 worker。
  for (const context of browser.contexts()) {
    await Promise.all(
      context.pages().map((page) =>
        settleCleanup(() => page.close({ runBeforeUnload: false })),
      ),
    );
    if (managedContexts.has(context)) continue;
    await settleCleanup(() => context.close());
  }
});

export { test, expect, devices };
export type { BrowserContext, Page } from '@playwright/test';
