import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import type {
  AiMattingResult,
  EditableImage,
  GeneratedImage,
  IpcErr,
  IpcResult,
  SaveEditedImageInput,
  UsageStats,
} from '../../shared/ipc';
import { FEATURE_AI_MATTING } from '../../shared/features';
import { removeImageBackground } from '../services/matting';
import { birefnetStatus, removeBackgroundBirefnet } from '../services/birefnet';
import {
  cancelBatch,
  findPyshim,
  listLocalModels,
  probeRembg,
  removeBackgroundBatch,
  removeBackgroundWithRembg,
} from '../services/rembg-cli';
import { keyOutDirectory, sampleBackground } from '../services/color-key';
import { getDataDirs } from '../core/paths';
import { msg } from '../core/msg';
import { trimLoopInDirectory } from '../services/loop-trim';
import { openDataDir, readImageAsDataUrl, readMediaBytes, readUsage, revealFile, saveEditedImage } from './media';

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerFilesIpc(): void {
  ipcMain.handle('files:removeBackground', async (_event, absPath: unknown): Promise<IpcResult<AiMattingResult>> => {
    try {
      if (!FEATURE_AI_MATTING) throw new Error(msg('err.file.mattingDisabled'));
      if (typeof absPath !== 'string') throw new Error(msg('err.file.badPath'));
      return { ok: true, data: await removeImageBackground(absPath) };
    } catch (err) {
      return toError(err);
    }
  });

  // BiRefNet（rembg 同款，ONNX 推理），比 ISNet 细但对 CPU 更重
  ipcMain.handle(
    'files:removeBackgroundBirefnet',
    async (_event, absPath: unknown, options: unknown): Promise<IpcResult<AiMattingResult>> => {
      try {
        if (typeof absPath !== 'string') throw new Error(msg('err.file.badPath'));
        const raw = (options && typeof options === 'object' ? options : {}) as {
          threshold?: number;
          feather?: number;
        };
        return {
          ok: true,
          data: await removeBackgroundBirefnet(absPath, {
            threshold: Number(raw.threshold) || undefined,
            feather: Number.isFinite(raw.feather) ? Number(raw.feather) : undefined,
          }),
        };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle(
    'files:rembgRemove',
    async (_event, absPath: unknown, options: unknown): Promise<IpcResult<AiMattingResult>> => {
      try {
        if (typeof absPath !== 'string') throw new Error(msg('err.file.badPath'));
        if (!absPath) throw new Error(msg('err.file.emptyImagePath'));
        const raw = (options && typeof options === 'object' ? options : {}) as {
          model?: string;
          alphaMatting?: boolean;
          noDecontaminate?: boolean;
        };
        const result = await removeBackgroundWithRembg(absPath, {
          model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
          alphaMatting: raw.alphaMatting === true,
          noDecontaminate: raw.noDecontaminate === true,
        });
        return { ok: true, data: result as unknown as AiMattingResult };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle(
    'files:rembgStatus',
    async (): Promise<IpcResult<{ available: boolean; message: string }>> => {
      try {
        const python = findPyshim();
        if (!python) {
          return {
            ok: true,
            data: { available: false, message: msg('err.file.noPyshim') },
          };
        }
        return { ok: true, data: { ...(await probeRembg(python)) } };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 列出本地已下载的 rembg 模型（只让用户选这些，避免现场下载超时） */
  ipcMain.handle(
    'files:rembgModels',
    async (): Promise<IpcResult<{ name: string; sizeMb: number }[]>> => {
      try {
        return { ok: true, data: listLocalModels() };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 对磁盘上的帧目录做「找循环点 + 裁掉尾部多余帧」 */
  ipcMain.handle(
    'files:trimLoop',
    async (
      _event,
      frameDir: unknown,
      dryRun: unknown,
      prefer: unknown,
      keepCycles: unknown,
    ): Promise<
      IpcResult<{
        kept: number;
        removed: number;
        loopFrame: number;
        score: number;
        cycleLength: number;
        cycles: number;
      }>
    > => {
      try {
        if (typeof frameDir !== 'string' || !frameDir) throw new Error(msg('err.file.badFrameDir'));
        return {
          ok: true,
          data: trimLoopInDirectory(
            frameDir,
            dryRun === true,
            Number(prefer) || 0,
            true,
            Number.isFinite(Number(keepCycles)) && keepCycles !== null && keepCycles !== undefined
              ? Number(keepCycles)
              : undefined,
          ),
        };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 强制停止正在跑的批量抠图（kill 掉 Python 子进程） */
  ipcMain.handle(
    'files:rembgCancel',
    async (_event, jobId: unknown): Promise<IpcResult<{ cancelled: boolean }>> => {
      try {
        if (typeof jobId !== 'string' || !jobId) throw new Error(msg('err.file.badJobId'));
        return { ok: true, data: { cancelled: cancelBatch(jobId) } };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 从帧项目的第一帧取四角平均色，作为传统抠图的背景色初值 */
  ipcMain.handle(
    'files:sampleFrameBackground',
    async (_event, frameDir: unknown): Promise<IpcResult<{ r: number; g: number; b: number }>> => {
      try {
        if (typeof frameDir !== 'string' || !frameDir) throw new Error(msg('err.file.badFrameDir'));
        const files = fs
          .readdirSync(frameDir)
          .filter((name) => /^frame_\d+\.png$/i.test(name))
          .sort();
        if (files.length === 0) throw new Error(msg('err.file.noFrames'));
        const buffer = fs.readFileSync(path.join(frameDir, files[0]));
        const color = sampleBackground(buffer);
        if (!color) throw new Error(msg('err.file.colorPickFailed'));
        return { ok: true, data: color };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /** 批量传统抠图：颜色键控，输出到「<目录>-key」 */
  ipcMain.handle(
    'files:batchKeyOut',
    async (
      _event,
      frameDir: unknown,
      options: unknown,
    ): Promise<IpcResult<{ total: number; elapsedMs: number; skipped: string[]; outDir: string }>> => {
      try {
        if (typeof frameDir !== 'string' || !frameDir) throw new Error(msg('err.file.badFrameDir'));
        const raw = (options && typeof options === 'object' ? options : {}) as {
          colors?: unknown;
          tolerance?: unknown;
          mode?: unknown;
          edgeTrim?: unknown;
        };
        const colors = Array.isArray(raw.colors)
          ? raw.colors
              .filter((item): item is { r: number; g: number; b: number } => {
                if (!item || typeof item !== 'object') return false;
                const c = item as { r?: unknown; g?: unknown; b?: unknown };
                return (
                  Number.isFinite(Number(c.r)) &&
                  Number.isFinite(Number(c.g)) &&
                  Number.isFinite(Number(c.b))
                );
              })
              .map((c) => ({ r: Number(c.r), g: Number(c.g), b: Number(c.b) }))
          : [];
        if (colors.length === 0) throw new Error(msg('err.file.needColor'));
        return {
          ok: true,
          data: keyOutDirectory(frameDir, {
            colors,
            tolerance: Number(raw.tolerance) || 20,
            mode: raw.mode === 'global' ? 'global' : 'connected',
            edgeTrim: Number(raw.edgeTrim) || 0,
          }),
        };
      } catch (err) {
        return toError(err);
      }
    },
  );

  /**
   * 批量抠图：对一个帧项目目录整体处理，边处理边把进度推回渲染层。
   * 事件名 rembg:batchProgress，payload { done, total, file }
   */
  ipcMain.handle(
    'files:rembgBatch',
    async (
      event,
      frameDir: unknown,
      options: unknown,
      jobId: unknown,
    ): Promise<IpcResult<{ total: number; elapsedMs: number; errors: string[]; outDir: string }>> => {
      try {
        if (typeof frameDir !== 'string' || !frameDir) throw new Error(msg('err.file.badFrameDir'));
        const raw = (options && typeof options === 'object' ? options : {}) as {
          model?: string;
          alphaMatting?: boolean;
          noDecontaminate?: boolean;
          workers?: unknown;
        };
        // 输出统一放 frames/outputs/，和抽帧集合（frames/sources/）分层
        const outDir = path.join(getDataDirs().frameOutputs, `${path.basename(frameDir)}-matte`);
        const result = await removeBackgroundBatch(
          frameDir,
          outDir,
          {
            model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
            alphaMatting: raw.alphaMatting === true,
            noDecontaminate: raw.noDecontaminate === true,
            workers: Number(raw.workers) || 1,
          },
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('rembg:batchProgress', progress);
            }
          },
          typeof jobId === 'string' && jobId ? jobId : undefined,
        );
        return { ok: true, data: { ...result, outDir } };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle(
    'files:birefnetStatus',
    async (): Promise<IpcResult<{ available: boolean; modelPath: string; sizeMb: number }>> => {
      try {
        return { ok: true, data: birefnetStatus() };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle('files:openDir', async (_event, kind: unknown): Promise<IpcResult<null>> => {
    try {
      if (kind !== 'knowledge' && kind !== 'cache' && kind !== 'root') {
        throw new Error(msg('err.file.badDirKind'));
      }
      openDataDir(kind);
      return { ok: true, data: null };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('files:reveal', async (_event, absPath: unknown): Promise<IpcResult<null>> => {
    try {
      if (typeof absPath !== 'string') throw new Error(msg('err.file.badPath'));
      revealFile(absPath);
      return { ok: true, data: null };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('files:readImage', async (_event, absPath: unknown): Promise<IpcResult<EditableImage>> => {
    try {
      if (typeof absPath !== 'string') throw new Error(msg('err.file.badPath'));
      return { ok: true, data: readImageAsDataUrl(absPath) };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle(
    'files:readMedia',
    async (_event, fileName: unknown): Promise<IpcResult<{ data: Uint8Array; mime: string }>> => {
      try {
        if (typeof fileName !== 'string' || !fileName) throw new Error(msg('err.file.badFileName'));
        return { ok: true, data: readMediaBytes(fileName) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle('files:saveEdited', async (_event, raw: unknown): Promise<IpcResult<GeneratedImage>> => {
    try {
      if (!raw || typeof raw !== 'object') throw new Error(msg('err.file.badSaveArgs'));
      const input = raw as Partial<SaveEditedImageInput>;
      if (typeof input.sourceAbsPath !== 'string') throw new Error(msg('err.file.noSourcePath'));
      if (typeof input.pngBase64 !== 'string') throw new Error(msg('err.file.noImageData'));
      return {
        ok: true,
        data: saveEditedImage({
          sourceAbsPath: input.sourceAbsPath,
          pngBase64: input.pngBase64,
          note: typeof input.note === 'string' ? input.note : undefined,
        }),
      };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ai:usage', async (): Promise<IpcResult<UsageStats>> => {
    try {
      return { ok: true, data: readUsage() };
    } catch (err) {
      return toError(err);
    }
  });
}
