import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const checks = [];

function fail(message) {
  checks.push(message);
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

for (const removedPath of [
  'src/uikit/auto-mount.ts',
  'public/uikit-auto-demo.html',
]) {
  if (existsSync(new URL(`../${removedPath}`, import.meta.url))) {
    fail(`不应恢复已下线的一行脚本接入文件: ${removedPath}`);
  }
}

function walk(path) {
  const root = new URL(`../${path}`, import.meta.url);
  const files = [];
  for (const entry of readdirSync(root)) {
    const child = `${path}/${entry}`;
    const url = new URL(`../${child}`, import.meta.url);
    const stat = statSync(url);
    if (stat.isDirectory()) files.push(...walk(child));
    else files.push(child);
  }
  return files;
}

const packageJson = read('package.json');
if (packageJson.includes('yimsg-uikit.iife')) {
  fail('package.json 不应引用 IIFE UIKit 产物');
}

for (const file of walk('src').concat(walk('public'), walk('tests'))) {
  const content = read(file);
  if (content.includes('yimsg-uikit.iife') || content.includes('data-yimsg-auto')) {
    fail(`${file} 不应恢复 IIFE 或 data-yimsg-auto 接入`);
  }
}

for (const configPath of ['vite.config.ts', 'vite.uikit.config.ts']) {
  const config = read(configPath);
  if (!config.includes('EMPTY_IMPORT_META') || !config.includes('throw new Error')) {
    fail(`${configPath} 必须把 EMPTY_IMPORT_META 视为构建失败`);
  }
}

const css = read('src/uikit/app/style.css');
if (css.split('\n').length < 80) {
  fail('UIKit CSS 疑似退化为压缩单行，请保持源码可读');
}

if (checks.length > 0) {
  for (const message of checks) {
    console.error(`[frontend guard] ${message}`);
  }
  process.exit(1);
}
