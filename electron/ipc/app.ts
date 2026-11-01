import { app, ipcMain, shell } from 'electron';
import type { AppInfo, IpcResult } from '../../shared/ipc';
import { getDataDirs } from '../core/paths';
import { msg } from '../core/msg';

function buildAppInfo(): AppInfo {
  const dirs = getDataDirs();
  return {
    name: msg('app.name'),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    dataDir: dirs.root,
    dirs,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  };
}

/** 注册基础 IPC（应用信息 / 打开数据目录） */
export function registerAppIpc(): void {
  ipcMain.handle('app:info', (): IpcResult<AppInfo> => {
    try {
      return { ok: true, data: buildAppInfo() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('app:openDataDir', async (): Promise<IpcResult<null>> => {
    try {
      const { root } = getDataDirs();
      const message = await shell.openPath(root);
      if (message) return { ok: false, error: message };
      return { ok: true, data: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
