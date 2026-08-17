import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { build } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ENTRY = path.join(__dirname, 'browser-harness.ts');
const HARNESS_ORIGIN = 'http://bounded-list.test';
let bundlePromise: Promise<string> | undefined;

export interface BoundedListTestItem {
  readonly id: string;
  readonly label: string;
  readonly order: number;
}

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>BoundedList Playwright Harness</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: sans-serif; }
      #fixtures { display: flex; flex-wrap: wrap; gap: 24px; padding: 16px; }
      .bl-case { position: relative; width: 360px; min-height: 190px; border: 1px solid #999; }
      .bl-scroller { width: 100%; height: 160px; overflow-y: auto; outline: none; }
      .bl-scroller:focus { outline: 2px solid #1769ff; }
      .bl-row { display: block; width: 100%; padding: 4px 8px; border-bottom: 1px solid #ddd; }
      .bl-row[data-selected="true"] { background: #dce9ff; }
      .bl-row[data-selectable="false"] { opacity: 0.45; }
      .list-boundary-hint, .empty-state { min-height: 24px; padding: 3px 8px; }
      .list-updated-pill { position: absolute; z-index: 2; right: 8px; bottom: 8px; padding: 4px 8px; background: #1769ff; color: white; }
      .hidden { display: none !important; }
      .bl-explicit-pill-host { position: relative; min-height: 1px; }
    </style>
  </head>
  <body>
    <main id="fixtures"></main>
    <script type="module" src="/__bounded-list.js"></script>
  </body>
</html>`;

async function bundleHarness(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2020',
      minify: false,
      lib: {
        entry: HARNESS_ENTRY,
        formats: ['es'],
      },
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  });
  const outputs = Array.isArray(result)
    ? result
    : 'output' in result
      ? [result]
      : [];
  for (const output of outputs) {
    const chunk = output.output.find((item) => item.type === 'chunk' && item.isEntry);
    if (chunk?.type === 'chunk') return chunk.code;
  }
  throw new Error('BoundedList 浏览器测试宿主构建后没有入口 chunk');
}

async function harnessBundle(): Promise<string> {
  bundlePromise ??= bundleHarness();
  return bundlePromise;
}

export async function callBoundedListHarness<T>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return page.evaluate(
    ({ methodName, methodArgs }) => {
      const harness = (window as unknown as {
        boundedListTestHarness: Record<string, (...values: unknown[]) => unknown>;
      }).boundedListTestHarness;
      return harness[methodName](...methodArgs);
    },
    { methodName: method, methodArgs: args },
  ) as Promise<T>;
}

export async function openBoundedListHarness(page: Page): Promise<void> {
  const javascript = await harnessBundle();
  await page.route(`${HARNESS_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__bounded-list.js') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: javascript,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });
  await page.goto(`${HARNESS_ORIGIN}/`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}
