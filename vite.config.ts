import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  // 打包后走 file:// 加载，必须用相对路径
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
      '@shared': path.join(root, 'shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron 内置 Chromium，无需为老浏览器降级
    target: 'chrome130',
    sourcemap: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
