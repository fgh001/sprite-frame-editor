import fs from 'node:fs';
import path from 'node:path';
import type {
  GenerateLoopVideoInput,
  GenerateLoopVideoResult,
  LoopVideoProgress,
} from '../../shared/ipc';
import { createId, stableIdOf } from '../core/knowledge';
import { getDataDirs } from '../core/paths';
import { getSlotRuntime } from '../core/settings';
import { msg } from '../core/msg';

const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function assertInsideData(target: unknown): string {
  if (typeof target !== 'string' || !target.trim()) throw new Error(msg('err.video.badImagePath'));
  const root = getDataDirs().root;
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(msg('err.video.outsideData'));
  }
  return resolved;
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

async function describeHttpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed?.error?.message ?? parsed?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* 忽略 */
  }
  // 方舟「模型未开通」会以 404 + ModelNotOpen 返回，单独识别，避免误导成「接口地址错」
  const notOpen = /ModelNotOpen|has not activated|未开通/i.test(detail);
  const hint = notOpen
    ? msg('err.video.hintNotOpen')
    : res.status === 401
      ? msg('err.video.hint401')
      : res.status === 403
        ? msg('err.video.hint403')
        : res.status === 404
          ? msg('err.video.hint404')
          : res.status === 429
            ? msg('err.video.hint429')
            : '';
  const detailPart = detail ? msg('err.video.httpDetail', { detail: String(detail).slice(0, 300) }) : '';
  return msg('err.video.http', {
    status: String(res.status),
    statusText: res.statusText,
    hint,
    detail: detailPart,
  });
}

async function requestJson(
  url: string,
  apiKey: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(msg('err.video.requestFailed', { url, reason }));
  }
  if (!response.ok) throw new Error(await describeHttpError(response));
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(msg('err.video.badJson', { url }));
  }
}

async function downloadVideo(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(msg('err.video.downloadFailed', { reason }));
  }
  if (!response.ok) throw new Error(msg('err.video.downloadHttp', { status: String(response.status) }));
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 图片 → 循环视频。
 * 用豆包 Seedance 的「首帧 + 尾帧」模式，首尾都传同一张图，生成出来的视频天然无缝循环。
 * 结果落盘到素材库（kind = video），可直接预览 / 作为下一阶段输入。
 */
export async function generateLoopVideo(
  input: GenerateLoopVideoInput,
  onProgress: (progress: LoopVideoProgress) => void,
): Promise<GenerateLoopVideoResult> {
  const runtime = await getSlotRuntime('video');
  if (!runtime.baseUrl) throw new Error(msg('err.video.noBaseUrl'));
  if (!runtime.model) throw new Error(msg('err.video.noModel'));
  if (!runtime.apiKey) throw new Error(msg('err.video.noKey'));

  const imagePath = assertInsideData(input.imageAbsPath);
  const buffer = fs.readFileSync(imagePath);
  if (buffer.length === 0) throw new Error(msg('err.video.emptyImage'));
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(msg('err.video.imageTooLarge'));
  const mime = EXT_MIME[path.extname(imagePath).toLowerCase()] ?? 'image/png';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const duration = Math.min(12, Math.max(2, Math.round(Number(input.duration) || 5)));
  const resolution = input.resolution || '720p';
  const mode = input.mode === 'reference' ? 'reference' : 'direct';

  // 组装提示词：用户描述 + 背景锁定 + 参考素材约束
  const basePrompt = (input.prompt || '').trim() || msg('prompt.video.default');
  const constraints: string[] = [];
  if (input.lockBackground !== false) {
    constraints.push(msg('prompt.video.bg'));
  }
  if (mode === 'reference') {
    constraints.push(msg('prompt.video.ref'));
  }
  const prompt = [basePrompt, ...constraints].join('\n');

  // 构造 content：direct = 首尾同图循环；reference = 素材库参考图（多模态参考）
  const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];

  if (mode === 'reference') {
    const refs = (input.referenceImagePaths ?? []).slice(0, 4);
    if (refs.length === 0) throw new Error(msg('err.video.needRef'));
    for (const refPath of refs) {
      const abs = assertInsideData(refPath);
      const refBuffer = fs.readFileSync(abs);
      if (refBuffer.length === 0) continue;
      if (refBuffer.length > MAX_IMAGE_BYTES) throw new Error(msg('err.video.refTooLarge'));
      const refMime = EXT_MIME[path.extname(abs).toLowerCase()] ?? 'image/png';
      content.push({
        type: 'image_url',
        image_url: { url: `data:${refMime};base64,${refBuffer.toString('base64')}` },
        role: 'reference_image',
      });
    }
  } else {
    content.push({ type: 'image_url', image_url: { url: dataUrl }, role: 'first_frame' });
    // 尾帧用同一张图 → 首尾一致，循环时不会跳
    content.push({ type: 'image_url', image_url: { url: dataUrl }, role: 'last_frame' });
  }

  onProgress({ stage: 'submitting', message: msg('err.video.submitting') });
  const endpoint = joinUrl(runtime.baseUrl, 'contents/generations/tasks');
  const created = await requestJson(endpoint, runtime.apiKey, {
    method: 'POST',
    body: {
      model: runtime.model,
      content,
      resolution,
      ratio: mode === 'reference' ? '16:9' : 'adaptive',
      duration,
      watermark: false,
    },
  });

  const taskId = typeof created.id === 'string' ? created.id : '';
  if (!taskId) throw new Error(msg('err.video.noTaskId'));

  const startedAt = Date.now();
  let videoUrl = '';
  let lastMessage = '';

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const info = await requestJson(joinUrl(runtime.baseUrl, `contents/generations/tasks/${taskId}`), runtime.apiKey, {
      method: 'GET',
    });
    const status = String(info.status ?? '');
    const content = (info.content ?? {}) as { video_url?: string };

    if (status === 'succeeded') {
      videoUrl = content.video_url ?? '';
      break;
    }
    if (status === 'failed') {
      const error = info.error as { message?: string } | undefined;
      throw new Error(
        msg('err.video.genFailed', { reason: error?.message ?? msg('err.video.noReason') }),
      );
    }
    if (status === 'cancelled' || status === 'expired') {
      throw new Error(msg(status === 'cancelled' ? 'err.video.cancelled' : 'err.video.expired'));
    }

    const elapsed = Date.now() - startedAt;
    const message = msg(status === 'queued' ? 'err.video.queued' : 'err.video.generating');
    if (message !== lastMessage || elapsed % 15_000 < POLL_INTERVAL_MS) {
      lastMessage = message;
      onProgress({
        stage: status === 'queued' ? 'queued' : 'running',
        message: msg('err.video.waiting', {
          message,
          seconds: String(Math.round(elapsed / 1000)),
        }),
        taskId,
        percent: Math.min(90, Math.round((elapsed / 600_000) * 100)),
      });
    }
  }

  if (!videoUrl) throw new Error(msg('err.video.timeout'));

  onProgress({ stage: 'downloading', message: msg('err.video.downloading'), taskId, percent: 95 });
  const videoBuffer = await downloadVideo(videoUrl);
  if (videoBuffer.length === 0) throw new Error(msg('err.video.emptyDownload'));

  const dirs = getDataDirs();
  // id 由最终文件名派生（素材库以磁盘文件名为准）
  const fileName = `${createId('video')}.mp4`;
  const id = stableIdOf('video', fileName);
  // 视频单独一个目录，不跟图片混放
  fs.mkdirSync(dirs.knowledgeVideos, { recursive: true });
  const absPath = path.join(dirs.knowledgeVideos, fileName);
  fs.writeFileSync(absPath, videoBuffer);

  onProgress({ stage: 'done', message: msg('err.video.done'), taskId, percent: 100 });

  return {
    taskId,
    id,
    fileName,
    absPath,
    bytes: videoBuffer.length,
    durationSeconds: duration,
    resolution,
    elapsedMs: Date.now() - startedAt,
    inKnowledge: true,
  };
}
