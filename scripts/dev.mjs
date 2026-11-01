/**
 * 开发模式：启动 Vite dev server + watch 编译主进程/preload + 拉起 Electron。
 * 主进程或 preload 变更后自动重启 Electron 窗口（preload 只在窗口创建时加载，必须重启）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
// electron 包的默认导出就是 electron.exe 的绝对路径
const electronBinary = require('electron');

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
  // 关掉 esbuild 自带的 "build finished" 输出，改由下面的插件打带标签的日志
  logLevel: 'warning',
};

/** 打印「哪个产物编译完成、多大」，避免两条一样的日志分不清 */
function logBuilt(label) {
  const file = path.join(projectRoot, 'dist-electron', `${label}.cjs`);
  let size = '';
  try {
    size = `（${(fs.statSync(file).size / 1024).toFixed(1)}kb）`;
  } catch {
    size = '';
  }
  console.log(`[watch] ${label} 编译完成${size}`);
}

const server = await createServer({ configFile: path.join(projectRoot, 'vite.config.ts') });
await server.listen();
const devServerUrl = server.resolvedUrls?.local?.[0];
if (!devServerUrl) {
  console.error('[dev] Vite dev server 未返回地址，退出');
  process.exit(1);
}
console.log(`[dev] Vite dev server: ${devServerUrl}`);

let electronProcess = null;
let restarting = false;
let started = false;

function startElectron() {
  if (electronProcess) {
    restarting = true;
    electronProcess.kill();
    electronProcess = null;
  }

  /* IDE 终端（PyCharm / VS Code 装过 Electron 相关插件）常常带 ELECTRON_RUN_AS_NODE=1。
     一旦带上，electron.exe 会以「纯 Node 模式」启动：主进程里 require('electron')
     拿到的是一个路径字符串而不是 { app, BrowserWindow }，第一行就崩，
     表现就是「编译完成 → 启动 Electron → 直接回提示符，窗口永远不出现」。
     这里直接把它从子进程环境里剔掉，不让它污染 Electron。 */
  const childEnv = {
    ...process.env,
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: devServerUrl,
  };
  if (childEnv.ELECTRON_RUN_AS_NODE) {
    console.warn(
      '[dev] 检测到 ELECTRON_RUN_AS_NODE（IDE 终端常见），已从 Electron 子进程中移除；' +
        '不移除的话 Electron 会以纯 Node 模式启动，窗口不会出现。',
    );
    delete childEnv.ELECTRON_RUN_AS_NODE;
  }

  electronProcess = spawn(electronBinary, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: childEnv,
  });

  // spawn 本身失败（路径不存在 / 没权限）只会触发 error，不会触发 close —— 不监听就会静默退出
  electronProcess.on('error', (err) => {
    console.error(`[dev] 启动 Electron 失败：${err.message}`);
    console.error(`[dev] Electron 可执行文件：${electronBinary}`);
    void shutdown(1);
  });

  electronProcess.on('close', (code) => {
    if (restarting) {
      restarting = false;
      return;
    }
    // 正常退出（点关闭 / Ctrl+C）不再打印，避免残留日志脏掉终端；异常退出才报出来
    const normalExit = (code ?? 0) === 0 || code === 3221225786;
    if (!normalExit) {
      console.log(`[dev] Electron 退出（code=${code}），关闭 dev server`);
    }
    void shutdown(code ?? 0);
  });
}

/** 记下退出码，供 exit 钩子判断正常退出还是异常退出（Ctrl+C 时 Electron 的 code 是 0xC000013A） */
let exitCodeHint = 0;

async function shutdown(code) {
  exitCodeHint = code;
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  /* process.exit() 会立刻终止进程，Windows 管道上还没刷出去的 console.log 会直接丢掉 ——
     之前「Electron 退出（code=0）」这行就是这么消失的，让人以为 dev 根本没退。 */
  await new Promise((resolve) => setTimeout(resolve, 80));
  process.exit(code);
}

/** 主进程 / preload 编译完成后重启 Electron（等两个产物都编译好了再启动） */
function createRestartPlugin(label) {
  return {
    name: `restart-electron-${label}`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) {
          console.error(`[dev] ${label} 编译失败，保持上一个版本运行`);
          return;
        }
        logBuilt(label);
        if (!started) return; // 首次启动由主进程编译完成后统一拉起
        console.log(`[dev] ${label} 有改动，重启 Electron`);
        startElectron();
      });
    },
  };
}

const mainCtx = await esbuild.context({
  ...sharedOptions,
  entryPoints: [path.join(projectRoot, 'electron/main.ts')],
  plugins: [
    createRestartPlugin('main'),
    {
      name: 'boot-electron',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0 || started) return;
          started = true;
          console.log('[dev] 主进程编译完成，启动 Electron');
          startElectron();
        });
      },
    },
  ],
});
const preloadCtx = await esbuild.context({
  ...sharedOptions,
  entryPoints: [path.join(projectRoot, 'electron/preload.ts')],
  plugins: [createRestartPlugin('preload')],
});
await mainCtx.watch();
await preloadCtx.watch();

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

/* ---------- 退出诊断 ----------
   「编译完成 → 启动 Electron → 直接回提示符」且没有任何 [dev] 输出，
   说明 dev.mjs 自己静默退出了（不是 Electron 退出，Electron 退出会走 close 回调打印）。
   下面几个钩子能抓出到底是哪条路径退的，以后遇到直接看这几行就够了。

   正常退出（code=0，包括按 Ctrl+C 关掉窗口）时**什么都不打**：
   不打印、不清屏，只把终端还给用户，保留他之前的输出历史。
   异常退出仍保留日志，方便排查。 */
process.on('exit', (code) => {
  // Ctrl+C 关窗口时 Electron 的退出码是 0xC000013A(3221225786)，Node 传到这里可能被截断成 0，
  // 所以用 shutdown() 记下的原始值兜底。
  const effective = code !== 0 ? code : exitCodeHint;
  const normalExit = effective === 0 || effective === 3221225786;
  if (normalExit) return;
  console.error(`[dev] dev.mjs 进程退出，code=${effective}`);
});
process.on('uncaughtException', (err) => {
  console.error('[dev] 未捕获异常：', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[dev] 未处理的 Promise 拒绝：', reason);
});
process.on('beforeExit', (code) => {
  // 事件循环空了（server / watch 全都没保持住）才会走到这里
  console.error(`[dev] 事件循环已空（beforeExit, code=${code}）—— dev server 或 watch 没有保持住进程`);
});
