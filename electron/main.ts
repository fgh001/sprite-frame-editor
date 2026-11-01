import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { getDataDirs } from './core/paths';
import { msg } from './core/msg';
import { getLang } from './core/ui';
import { migrateToKindFolders } from './core/knowledge';
import { migrateFramesToSubfolders } from './core/frames';
import { cancelAllBatches } from './services/rembg-cli';
import { registerAppIpc } from './ipc/app';
import { registerFilesIpc } from './ipc/files';
import { registerFramesIpc } from './ipc/frames';
import {
  migrateThumbnailsToPng,
  registerKnowledgeIpc,
  registerKnowledgeProtocol,
  registerKnowledgeScheme,
} from './ipc/knowledge';
import { registerSettingsIpc } from './ipc/settings';
import { registerUiIpc } from './ipc/ui';
import { registerVideoIpc } from './ipc/video';

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = !app.isPackaged && Boolean(devServerUrl);

// kbmedia:// 协议必须在 app ready 之前登记特权（否则视频无法 seek）
registerKnowledgeScheme();

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#16181d',
    title: msg('app.name'),
    autoHideMenuBar: true,
    /* 开发模式的窗口 / 任务栏图标。
       打包后不需要：exe 自带图标资源，Windows 会直接用。
       而 build-resources 不进 asar，所以只在 dev 下读这个路径。 */
    ...(isDev ? { icon: path.join(app.getAppPath(), 'build-resources', 'icon.ico') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 界面里的外链交给系统浏览器；只放行 http(s)，其余一律拒绝
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 禁止渲染层跳到任意地址（避免外部页面顶替应用界面）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  if (isDev && devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

/* 单实例锁：
   打包后必须加 —— 两个实例会抢同一个 data 目录，互相覆盖写文件。
   开发时跳过 —— 上次 Ctrl+C / 关 IDE 终端后，Electron 可能变成「看不见的孤儿进程」
   （窗口没显示、进程还活着），下次 npm run dev 就会被它挡掉：
   退出码 0、一行日志都没有，极难排查。开发环境本来也不需要这个锁。 */
const hasSingleInstanceLock = isDev ? true : app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  console.log('[main] 已存在另一个实例，本次启动退出（单实例锁）');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    // 启动即确保便携数据目录存在（config / knowledge / projects / cache / logs）
    getDataDirs();
    /* 提前读一次界面语言：主进程返回的 error 文案靠它翻译。
       不预热的话，第一条错误可能用回默认简中。 */
    getLang();
    registerAppIpc();
    registerSettingsIpc();
    registerFilesIpc();
    registerUiIpc();
    registerKnowledgeProtocol();
    registerKnowledgeIpc();
    registerVideoIpc();
    registerFramesIpc();
    // 旧版混放的素材迁到 files/images、files/videos 子目录（幂等）
    const migration = migrateToKindFolders();
    if (migration.moved > 0) console.log(`[knowledge] 已迁移 ${migration.moved} 个文件到分类型目录`);
    // 旧版 JPEG 缩略图重建为 PNG（JPEG 无透明通道，去背景后会显示黑底）
    migrateThumbnailsToPng();
    // 旧版帧目录平铺在 frames/ 下，迁到 sources/（抽帧集合）和 outputs/（抠图结果）
    migrateFramesToSubfolders();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  /* 退出前把还在跑的 Python 抠图进程连根拔掉。
     不处理的话：关掉窗口后 Python 会继续把整批帧跑完，表现为
     "应用明明关了，回来一看图片全被抠好了"，而且这期间一直占着 CPU。 */
  app.on('before-quit', () => {
    const killed = cancelAllBatches();
    if (killed > 0) console.log(`[rembg] 退出前终止了 ${killed} 个抠图进程`);
  });
}
