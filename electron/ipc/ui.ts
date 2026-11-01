import { ipcMain } from 'electron';
import type { IpcErr, IpcResult, Lang, ThemeMode } from '../../shared/ipc';
import { getLang, getTheme, setLang, setTheme } from '../core/ui';

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

  ipcMain.handle('ui:getLang', async (): Promise<IpcResult<Lang>> => {
    try {
      return { ok: true, data: getLang() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ui:setLang', async (_event, lang: unknown): Promise<IpcResult<Lang>> => {
    try {
      return { ok: true, data: setLang(lang) };
    } catch (err) {
      return toError(err);
    }
  });
}
