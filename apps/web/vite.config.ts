import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/app/',
  // demo/ 由 UIKit workspace 的 build:examples 步骤复制到 ../../web/demo，
  // 主 App 构建不应把 public/ 一并复制到 web/app/ 下。
  publicDir: false,
  build: {
    outDir: '../../web/app',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        homeDashboard: resolve(__dirname, 'home-dashboard.html'),
      },
      onwarn(warning, defaultHandler) {
        if (warning.code === 'EMPTY_IMPORT_META' || warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') {
          throw new Error(`[app build] ${warning.code}: ${warning.message}`);
        }
        defaultHandler(warning);
      },
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
