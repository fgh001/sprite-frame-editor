import { ipcMain } from 'electron';
import type { IpcErr, IpcResult, ThemeMode } from '../../shared/ipc';
import { getTheme, setTheme } from '../core/ui';

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerUiIpc(): void {
  ipcMain.handle('ui:getTheme', async (): Promise<IpcResult<ThemeMode>> => {
    try {
      return { ok: true, data: getTheme() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ui:setTheme', async (_event, theme: unknown): Promise<IpcResult<ThemeMode>> => {
    try {
      return { ok: true, data: setTheme(theme) };
    } catch (err) {
      return toError(err);
    }
  });
}
