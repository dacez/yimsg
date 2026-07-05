import { execSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FullConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_ENV_DIR = path.join(ROOT, '.tmp', 'playwright', RUN_ID);
const DATA_DIR = path.join(TEST_ENV_DIR, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const CONFIG = path.join(TEST_ENV_DIR, 'config.toml');
const SERVER_EXE = path.join(TEST_ENV_DIR, process.platform === 'win32' ? 'server.exe' : 'server');
const PREFIX_FILE = path.join(DATA_DIR, 'test-seed-prefix.txt');
const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function isServerRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(`${BASE_URL}/`, {
      method: 'HEAD',
      timeout: 2000,
    }, (res) => {
      res.resume();
      resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function writeConfig() {
  fs.mkdirSync(TEST_ENV_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, `
[server]
host = "127.0.0.1"
port = ${PORT}
machine_id = 1
tls_cert = ""
tls_key = ""

[database]
data_dir = "${DATA_DIR.replace(/\\/g, '/')}"
shard_count = 4

[session]
ttl_seconds = 2592000
token_bytes = 32

[gc]
message_max_count = 100000
conversation_max_count = 10000
session_cleanup_interval_secs = 3600
contact_gc_interval_secs = 3600
message_gc_interval_secs = 3600
conversation_gc_interval_secs = 3600
user_gc_interval_secs = 3600

[frontend]
static_dir = "${path.join(ROOT, 'web').replace(/\\/g, '/')}"

[media]
upload_dir = "${MEDIA_DIR.replace(/\\/g, '/')}"
max_avatar_bytes = 5242880
max_image_bytes = 10485760
max_file_bytes = 104857600

[client]
cache_ttl_seconds = 60
cache_max_entries = 1000

[message]
recall_window_seconds = 3
`.trimStart(), 'utf-8');
}

export default async function globalSetup(_config: FullConfig) {
  process.env.PLAYWRIGHT_BASE_URL = BASE_URL;
  process.env.TEST_ENV_DIR = TEST_ENV_DIR;
  process.env.TEST_SERVER_PORT = String(PORT);

  writeConfig();

  console.log('[globalSetup] Running test-seed...');
  execSync(`go run ./tools/cmd/test-seed -config "${CONFIG}"`, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 60_000,
  });

  // 复用全量测试脚本预先编译好的服务端二进制（同一份源码），避免重复 go build。
  // 未提供预构建产物时（如单独运行 npm run test:ui）回退到本地构建。
  let serverExe = SERVER_EXE;
  const prebuiltServer = process.env.YIMSG_PREBUILT_SERVER;
  if (prebuiltServer && fs.existsSync(prebuiltServer)) {
    console.log(`[globalSetup] Reusing prebuilt server: ${prebuiltServer}`);
    serverExe = prebuiltServer;
  } else {
    console.log('[globalSetup] Building server...');
    execSync(`go build -o "${SERVER_EXE}" ./cmd/server`, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 60_000,
    });
  }

  // 标准前端构建会同时生成主应用与 UIKit bundle，
  // 供主应用页面与 uikit Playwright 规范用例共同访问。
  // 全量测试脚本已构建一次 web/，通过 YIMSG_SKIP_FRONTEND_BUILD=1 跳过重复构建。
  if (process.env.YIMSG_SKIP_FRONTEND_BUILD === '1') {
    console.log('[globalSetup] Skipping frontend build (reusing prebuilt web/).');
  } else {
    console.log('[globalSetup] Building frontend bundles...');
    execSync('npm run build', {
      cwd: path.join(ROOT, 'frontend'),
      stdio: 'inherit',
      timeout: 120_000,
    });
  }
  const uikitDemo = path.join(ROOT, 'web', 'uikit-demo.html');
  // 示例 HTML 体积极小，始终覆盖同步，避免 playwright 反复使用陈旧模板。
  console.log('[globalSetup] Refreshing uikit demo htmls...');
  fs.copyFileSync(path.join(ROOT, 'frontend', 'public', 'uikit-demo.html'), uikitDemo);
  const uikitMultiDemo = path.join(ROOT, 'web', 'uikit-multi-demo.html');
  fs.copyFileSync(path.join(ROOT, 'frontend', 'public', 'uikit-multi-demo.html'), uikitMultiDemo);

  console.log('[globalSetup] Starting server...');
  const server = spawn(serverExe, [CONFIG], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  server.unref();
  process.env.TEST_SERVER_PID = String(server.pid);

  console.log('[globalSetup] Waiting for server...');
  for (let i = 0; i < 40; i++) {
    if (await isServerRunning()) {
      console.log('[globalSetup] Server ready.');
      break;
    }
    await sleep(500);
    if (i === 39) throw new Error('Server did not start within 20s');
  }

  if (fs.existsSync(PREFIX_FILE)) {
    process.env.TEST_SEED_PREFIX = fs.readFileSync(PREFIX_FILE, 'utf-8').trim();
    console.log(`[globalSetup] TEST_SEED_PREFIX = ${process.env.TEST_SEED_PREFIX}`);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
