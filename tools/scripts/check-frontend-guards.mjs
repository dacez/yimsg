import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const checks = [];
const root = new URL('../../', import.meta.url);

function fail(message) {
  checks.push(message);
}

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

for (const removedPath of [
  'packages/uikit/src/auto-mount.ts',
  'packages/uikit/examples/uikit-auto-demo.html',
]) {
  if (existsSync(new URL(removedPath, root))) {
    fail(`不应恢复已下线的一行脚本接入文件: ${removedPath}`);
  }
}

function walk(path) {
  const dir = new URL(path, root);
  const files = [];
  for (const entry of readdirSync(dir)) {
    const child = `${path}/${entry}`;
    const url = new URL(child, root);
    const stat = statSync(url);
    if (stat.isDirectory()) files.push(...walk(child));
    else files.push(child);
  }
  return files;
}

function moduleSpecifiers(content) {
  const specifiers = [];
  const pattern = /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  const sideEffectPattern = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(sideEffectPattern)) specifiers.push(match[1]);
  return specifiers;
}

function checkDependencyBoundary(path, forbiddenPrefixes) {
  for (const file of walk(path).filter((item) => item.endsWith('.ts'))) {
    for (const specifier of moduleSpecifiers(read(file))) {
      if (forbiddenPrefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
        fail(`${file} 不得依赖 ${specifier}`);
      }
    }
  }
}

checkDependencyBoundary('protocol', ['@yimsg/sdk', '@yimsg/uikit', '@yimsg/web']);
checkDependencyBoundary('packages/sdk/src', ['@yimsg/uikit', '@yimsg/web']);
checkDependencyBoundary('packages/uikit/src', ['@yimsg/protocol', '@yimsg/web']);
checkDependencyBoundary('apps/web/src', ['@yimsg/sdk', '@yimsg/protocol']);

const packageJson = read('package.json');
if (packageJson.includes('yimsg-uikit.iife')) {
  fail('package.json 不应引用 IIFE UIKit 产物');
}

const sourceAndTestRoots = [
  'protocol/generated/typescript',
  'packages/sdk/src',
  'packages/sdk/tests',
  'packages/uikit/src',
  'packages/uikit/examples',
  'packages/uikit/tests',
  'apps/web/src',
  'apps/web/tests',
];
for (const file of sourceAndTestRoots.flatMap(walk)) {
  const content = read(file);
  if (content.includes('yimsg-uikit.iife') || content.includes('data-yimsg-auto')) {
    fail(`${file} 不应恢复 IIFE 或 data-yimsg-auto 接入`);
  }
}

for (const configPath of ['apps/web/vite.config.ts', 'packages/uikit/vite.config.ts']) {
  const config = read(configPath);
  if (!config.includes('EMPTY_IMPORT_META') || !config.includes('throw new Error')) {
    fail(`${configPath} 必须把 EMPTY_IMPORT_META 视为构建失败`);
  }
}

const css = read('packages/uikit/src/app/style.css');
if (css.split('\n').length < 80) {
  fail('UIKit CSS 疑似退化为压缩单行，请保持源码可读');
}

if (checks.length > 0) {
  for (const message of checks) {
    console.error(`[frontend guard] ${message}`);
  }
  process.exit(1);
}
