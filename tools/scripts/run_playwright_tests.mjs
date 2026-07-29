import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..', '..');

const modes = {
  e2e: {
    projects: ['chromium-e2e'],
    standalone: false,
  },
  component: {
    projects: ['chromium-component'],
    standalone: true,
  },
  performance: {
    projects: ['chromium-performance'],
    standalone: true,
    workers: 1,
  },
  ui: {
    // 兼容旧入口：执行全部浏览器正确性测试，但仍不混入性能门禁。
    projects: ['chromium-e2e', 'chromium-component'],
    standalone: false,
  },
};

const [modeName, ...extraArgs] = process.argv.slice(2);
const mode = modes[modeName];
if (!mode) {
  console.error(`未知 Playwright 测试分类: ${modeName ?? ''}`);
  console.error(`可用分类: ${Object.keys(modes).join(', ')}`);
  process.exit(2);
}

const playwrightCLI = path.join(ROOT_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
if (!fs.existsSync(playwrightCLI)) {
  console.error('缺少 Playwright 依赖，请先运行 npm ci');
  process.exit(1);
}

const env = {
  ...process.env,
  BOUNDED_LIST_STANDALONE: mode.standalone ? '1' : '0',
};
if (mode.workers) {
  env.PLAYWRIGHT_WORKERS = String(mode.workers);
}

const args = [
  playwrightCLI,
  'test',
  '--config',
  path.join(ROOT_DIR, 'apps', 'web', 'playwright.config.ts'),
  ...mode.projects.flatMap((project) => [`--project=${project}`]),
  '--retries=0',
  ...(mode.workers ? [`--workers=${mode.workers}`] : []),
  ...extraArgs,
];

const result = spawnSync(process.execPath, args, {
  cwd: ROOT_DIR,
  env,
  stdio: 'inherit',
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
