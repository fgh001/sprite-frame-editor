import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FrameOutputView,
  FrameProjectView,
  IpcErr,
  IpcResult,
  SaveFrameProjectInput,
} from '../../shared/ipc';
import { getDataDirs } from '../core/paths';
import { msg } from '../core/msg';
import {
  frameFilePath,
  listFrameOutputs,
  listFrameProjects,
  projectDirOf,
  removeFrameFile,
  removeFrameProject,
  renameFrameOutput,
  renameFrameProject,
  saveFrameProject,
  writeFrameFile,
} from '../core/frames';

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function validateSave(raw: unknown): SaveFrameProjectInput {
  if (!raw || typeof raw !== 'object') throw new Error(msg('err.frames.badArgs'));
  const input = raw as Partial<SaveFrameProjectInput>;
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new Error(msg('err.frames.empty'));
  }
  if (input.frames.length > 600) throw new Error(msg('err.frames.tooMany'));
  return {
    name: typeof input.name === 'string' ? input.name : '',
    sourceVideo: typeof input.sourceVideo === 'string' ? input.sourceVideo : '',
    fps: Number(input.fps) || 12,
    width: Math.max(1, Math.round(Number(input.width) || 1)),
    height: Math.max(1, Math.round(Number(input.height) || 1)),
    backgroundRemoved: Boolean(input.backgroundRemoved),
    frames: input.frames.filter((item): item is string => typeof item === 'string'),
  };
}

export function registerFramesIpc(): void {
  ipcMain.handle('frames:list', async (): Promise<IpcResult<FrameProjectView[]>> => {
    try {
      return { ok: true, data: listFrameProjects() };
    } catch (err) {
      return toError(err);
    }
  });

  /* 独立列出 outputs/ 下的抠图结果 —— 不依赖源集合是否还在 */
  ipcMain.handle('frames:listOutputs', async (): Promise<IpcResult<FrameOutputView[]>> => {
    try {
      return { ok: true, data: listFrameOutputs() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('frames:save', async (_event, raw: unknown): Promise<IpcResult<FrameProjectView>> => {
    try {
      const input = validateSave(raw);
      return { ok: true, data: saveFrameProject(input) };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('frames:remove', async (_event, id: unknown): Promise<IpcResult<null>> => {
    try {
      if (typeof id !== 'string' || !id) throw new Error(msg('err.frames.badId'));
      removeFrameProject(id);
      return { ok: true, data: null };
    } catch (err) {
      return toError(err);
    }
  });

  /** 重命名帧集合（改磁盘文件夹名 + meta.json；重名直接报错不覆盖） */
  ipcMain.handle(
    'frames:rename',
    async (_event, id: unknown, name: unknown): Promise<IpcResult<FrameProjectView>> => {
      try {
        if (typeof id !== 'string' || !id) throw new Error(msg('err.frames.badId'));
        if (typeof name !== 'string') throw new Error(msg('err.frames.badNewName'));
        return { ok: true, data: renameFrameProject(id, name) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 重命名抠图结果目录（保留 -matte / -key 后缀；重名直接报错不覆盖） */
  ipcMain.handle(
    'frames:renameOutput',
    async (_event, name: unknown, nextName: unknown): Promise<IpcResult<string>> => {
      try {
        if (typeof name !== 'string' || !name) throw new Error(msg('err.frames.badOutputName'));
        if (typeof nextName !== 'string') throw new Error(msg('err.frames.badNewName'));
        return { ok: true, data: renameFrameOutput(name, nextName) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 删掉集合里的某一帧（找循环帧后手动剔多余帧用） */
  ipcMain.handle(
    'frames:removeFrame',
    async (_event, id: unknown, fileName: unknown): Promise<IpcResult<{ frameCount: number }>> => {
      try {
        if (typeof id !== 'string' || !id) throw new Error(msg('err.frames.badId'));
        if (typeof fileName !== 'string' || !fileName) throw new Error(msg('err.frames.badFileName'));
        return { ok: true, data: removeFrameFile(id, fileName) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 用编辑器改完的 PNG 覆盖某一帧（素材库里直接编辑帧集合的单帧） */
  ipcMain.handle(
    'frames:writeFrame',
    async (_event, id: unknown, fileName: unknown, png: unknown): Promise<IpcResult<null>> => {
      try {
        if (typeof id !== 'string' || !id) throw new Error(msg('err.frames.badId'));
        if (typeof fileName !== 'string' || !fileName) throw new Error(msg('err.frames.badFileName'));
        if (typeof png !== 'string' || !png) throw new Error(msg('err.frames.badData'));
        writeFrameFile(id, fileName, png);
        return { ok: true, data: null };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle('frames:openDir', async (_event, id: unknown): Promise<IpcResult<null>> => {
    try {
      const target = typeof id === 'string' && id ? projectDirOf(id) : getDataDirs().frames;
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { ok: true, data: null };
    } catch (err) {
      return toError(err);
    }
  });
}

/**
 * kbmedia://frame/<projectId>/<fileName>  → data/frames/sources/<projectId>/<fileName>
 * kbmedia://output/<dirName>/<fileName>   → data/frames/outputs/<dirName>/<fileName>
 *
 * 两套目录分开解析：hostname 决定去 sources 还是 outputs 找。
 */
export function resolveFrameUrl(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (segments.length < 2) return null;
  const [first, fileName] = segments;
  const safeName = path.basename(fileName);

  if (url.hostname === 'output') {
    const abs = path.join(getDataDirs().frameOutputs, path.basename(first), safeName);
    return fs.existsSync(abs) ? abs : null;
  }

  const abs = frameFilePath(first, safeName);
  return fs.existsSync(abs) ? abs : null;
}
