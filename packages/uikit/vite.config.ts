import { defineConfig } from 'vite';
import { resolve } from 'path';

// 独立构建配置：将 packages/uikit/src 打包为可嵌入的库文件。
//
// 同时产出两种格式，服务于跨域嵌入第三方站点的两类宿主：
// - ESM（yimsg-uikit.js）：`<script type="module">` import；
// - IIFE（yimsg-uikit.iife.js）：普通 `<script src>` 即可拿到全局 YimsgUIKit，
//   宿主不需要把页面改造成 module script，是「给个网址就能嵌」的最短路径。
//
// 两种格式跨域加载都依赖服务端按 allowed_origins 返回 CORS 头。
export default defineConfig({
  root: '.',
  base: '/uikit/',
  // demo/ 由独立的 npm run build:examples 步骤复制到 ../../web/demo，
  // uikit 库构建不应把 public/ 一并复制到 web/uikit/ 下。
  publicDir: false,
  build: {
    outDir: '../../web/uikit',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'YimsgUIKit',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'iife' ? 'yimsg-uikit.iife.js' : 'yimsg-uikit.js'),
    },
    rollupOptions: {
      external: [],
      onwarn(warning, defaultHandler) {
        // IIFE 是单文件格式，动态 import 必然被内联，INEFFECTIVE_DYNAMIC_IMPORT
        // 是该格式固有的、不是缺陷。EMPTY_IMPORT_META 仍视为构建失败：源码一旦
        // 引入 import.meta.url，IIFE 产物里它为空，资源定位会静默失效。
        if (warning.code === 'EMPTY_IMPORT_META') {
          throw new Error(`[uikit build] ${warning.code}: ${warning.message}`);
        }
        defaultHandler(warning);
      },
    },
  },
});
