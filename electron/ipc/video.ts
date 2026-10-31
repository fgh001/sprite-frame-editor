import { ipcMain } from 'electron';
import type {
  GenerateLoopVideoInput,
  GenerateLoopVideoResult,
  IpcErr,
  IpcResult,
} from '../../shared/ipc';
import { generateLoopVideo } from '../services/video';

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function validate(raw: unknown): GenerateLoopVideoInput {
  if (!raw || typeof raw !== 'object') throw new Error('生成参数无效');
  const input = raw as Partial<GenerateLoopVideoInput>;

  if (typeof input.imageAbsPath !== 'string' || !input.imageAbsPath.trim()) {
    throw new Error('请先选择一张图片');
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt.slice(0, 1000) : '';
  const duration = Math.min(12, Math.max(2, Math.round(Number(input.duration) || 5)));
  const resolution = input.resolution === '480p' || input.resolution === '1080p' ? input.resolution : '720p';
  const mode = input.mode === 'reference' ? 'reference' : 'direct';
  const referenceImagePaths = Array.isArray(input.referenceImagePaths)
    ? input.referenceImagePaths.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 4)
    : [];

  if (mode === 'reference' && referenceImagePaths.length === 0) {
    throw new Error('参考模式下至少要选 1 张参考图');
  }

  return {
    imageAbsPath: input.imageAbsPath,
    prompt,
    duration,
    resolution,
    mode,
    referenceImagePaths,
    lockBackground: input.lockBackground !== false,
  };
}

export function registerVideoIpc(): void {
  ipcMain.handle('video:generateLoop', async (event, raw: unknown): Promise<IpcResult<GenerateLoopVideoResult>> => {
    try {
      const input = validate(raw);
      const data = await generateLoopVideo(input, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('video:progress', progress);
      });
      return { ok: true, data };
    } catch (err) {
      return toError(err);
    }
  });
}
