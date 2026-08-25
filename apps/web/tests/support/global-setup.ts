import { execSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FullConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_ENV_DIR = path.join(ROOT, '.tmp', 'playwright', RUN_ID);
const DATA_DIR = path.join(TEST_ENV_DIR, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const CONFIG = path.join(TEST_ENV_DIR, 'config.toml');
const SERVER_EXE = path.join(TEST_ENV_DIR, process.platform === 'win32' ? 'server.exe' : 'server');
const PREFIX_FILE = path.join(DATA_DIR, 'test-seed-prefix.txt');
let PORT = 0;
let BASE_URL = '';
// 第三方宿主站点：跨域嵌入用例需要一个与服务端不同源的页面来源。
// 服务端跑在 127.0.0.1，宿主页跑在 localhost——浏览器按主机名字符串判定同源，
// 两者虽指向同一台机器，但仍是两个 origin。
let THIRD_PARTY_PORT = 0;
let THIRD_PARTY_ORIGIN = '';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('无法读取 Playwright 测试端口'));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

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
allowed_origins = ["${THIRD_PARTY_ORIGIN}"]

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

// startThirdPartyHost 拉起一个只提供宿主页模板的静态服务器，充当「客户自己的网站」。
// 模板里的 __SERVER_ORIGIN__ 占位替换成 yimsg 服务端地址，UIKit 由该地址跨域加载。
function startThirdPartyHost(): void {
  const templateDir = path.join(__dirname, 'third-party-host');
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\//, '') || 'esm.html';
    const file = path.join(templateDir, path.basename(name));
    if (!file.endsWith('.html') || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const html = fs.readFileSync(file, 'utf-8').replace(/__SERVER_ORIGIN__/g, BASE_URL);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.listen(THIRD_PARTY_PORT, '127.0.0.1');
  // 不阻塞 Playwright 主进程退出：进程结束时服务器随之消失。
  server.unref();
}

export default async function globalSetup(_config: FullConfig) {
  PORT = await findFreePort();
  BASE_URL = `http://127.0.0.1:${PORT}`;
  THIRD_PARTY_PORT = await findFreePort();
  THIRD_PARTY_ORIGIN = `http://localhost:${THIRD_PARTY_PORT}`;
  process.env.PLAYWRIGHT_BASE_URL = BASE_URL;
  process.env.TEST_ENV_DIR = TEST_ENV_DIR;
  process.env.TEST_SERVER_PORT = String(PORT);
  process.env.THIRD_PARTY_HOST_ORIGIN = THIRD_PARTY_ORIGIN;

  writeConfig();
  startThirdPartyHost();

  console.log('[globalSetup] Running test-seed...');
  execSync(`go run ./server/tools/cmd/test-seed -config "${CONFIG}"`, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 120_000,
  });

  // 复用全量测试脚本预先编译好的服务端二进制（同一份源码），避免重复 go build。
  // 未提供预构建产物时（如单独运行 tools/run_e2e_tests.sh）回退到本地构建。
  let serverExe = SERVER_EXE;
  const prebuiltServer = process.env.YIMSG_PREBUILT_SERVER;
  if (prebuiltServer && fs.existsSync(prebuiltServer)) {
    console.log(`[globalSetup] Reusing prebuilt server: ${prebuiltServer}`);
    serverExe = prebuiltServer;
  } else {
    console.log('[globalSetup] Building server...');
    execSync(`go build -o "${SERVER_EXE}" ./server/cmd/yimsg-server`, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 120_000,
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
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 120_000,
    });
  }
  const webDemoDir = path.join(ROOT, 'web', 'demo');
  fs.mkdirSync(webDemoDir, { recursive: true });
  // 示例 HTML 体积极小，始终覆盖同步，避免 playwright 反复使用陈旧模板。
  console.log('[globalSetup] Refreshing uikit demo htmls...');
  fs.copyFileSync(path.join(ROOT, 'packages', 'uikit', 'examples', 'embed.html'), path.join(webDemoDir, 'embed.html'));
  fs.copyFileSync(path.join(ROOT, 'packages', 'uikit', 'examples', 'embed-multi.html'), path.join(webDemoDir, 'embed-multi.html'));

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
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`Server exited before readiness (code=${server.exitCode}, signal=${server.signalCode})`);
      }
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
