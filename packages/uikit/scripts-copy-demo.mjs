import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// web/demo 是独立于 app/、uikit/ 的顶层演示目录（固定 demo 账号，展示各种嵌入
// 场景），与 apps/web/vite.config.ts / packages/uikit/vite.config.ts 各自的构建产物平级，因此不
// 能靠某一份 vite 配置的 publicDir 顺带复制，需要单独拷贝一次。
const src = fileURLToPath(new URL('./examples', import.meta.url));
const dest = fileURLToPath(new URL('../../web/demo', import.meta.url));

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
