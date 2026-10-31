/**
 * 一次性构建主进程 + preload 到 dist-electron/。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const sharedOptions = {
  bundle: true,
  platform: 'node',
  // Electron 45 → Node 22
  target: 'node22',
  format: 'cjs',
  outdir: path.join(projectRoot, 'dist-electron'),
  outExtension: { '.js': '.cjs' },
  sourcemap: true,
  // electron 与原生模块（AI 抠图）由运行时从 node_modules 加载，绝不打包
  external: ['electron', '@imgly/background-removal-node', 'onnxruntime-node', 'sharp'],
  logLevel: 'info',
};

await Promise.all([
  esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(projectRoot, 'electron/main.ts')],
  }),
  esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(projectRoot, 'electron/preload.ts')],
  }),
]);

console.log('[build-main] dist-electron/main.cjs + preload.cjs 构建完成');
