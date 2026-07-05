import { defineConfig } from 'vite';
import { resolve } from 'path';

// 独立构建配置：将 frontend/src/uikit 打包为可嵌入的 ESM 库文件。
export default defineConfig({
  root: '.',
  base: '/chat/uikit/',
  build: {
    outDir: '../web/uikit',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/uikit/index.ts'),
      name: 'YimsgUIKit',
      formats: ['es'],
      fileName: () => 'yimsg-uikit.js',
    },
    rollupOptions: {
      external: [],
      onwarn(warning, defaultHandler) {
        if (warning.code === 'EMPTY_IMPORT_META' || warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') {
          throw new Error(`[uikit build] ${warning.code}: ${warning.message}`);
        }
        defaultHandler(warning);
      },
    },
  },
});
