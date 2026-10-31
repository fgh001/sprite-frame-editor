import fs from 'node:fs';
import path from 'node:path';
import type {
  GenerateLoopVideoInput,
  GenerateLoopVideoResult,
  KnowledgeItem,
  LoopVideoProgress,
} from '../../shared/ipc';
import { addItems, createId } from '../core/knowledge';
import { getDataDirs } from '../core/paths';
import { getSlotRuntime } from '../core/settings';

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
  if (typeof target !== 'string' || !target.trim()) throw new Error('图片路径无效');
  const root = getDataDirs().root;
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('不允许访问数据目录以外的文件');
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
    ? '（该账号还没开通这个视频模型：去方舟控制台「开通管理」开通 Seedance；注意 2.5 要求账户余额 ≥ 200 元）'
    : res.status === 401
      ? '（API Key 无效或未开通该模型）'
      : res.status === 403
        ? '（没有权限，检查视频模型是否已在控制台开通）'
        : res.status === 404
          ? '（接口地址不存在，检查 Base URL）'
          : res.status === 429
            ? '（触发限流，稍后再试）'
            : '';
  return `HTTP ${res.status} ${res.statusText}${hint}${detail ? `：${String(detail).slice(0, 300)}` : ''}`;
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
    throw new Error(`请求 ${url} 失败：${reason}（检查网络 / 代理 / VPN，或 Base URL）`);
  }
  if (!response.ok) throw new Error(await describeHttpError(response));
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`接口 ${url} 返回的不是合法 JSON`);
  }
}

async function downloadVideo(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`下载视频失败：${reason}`);
  }
  if (!response.ok) throw new Error(`下载视频失败：HTTP ${response.status}`);
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
  if (!runtime.baseUrl) throw new Error('视频槽位还没有配置 Base URL');
  if (!runtime.model) throw new Error('视频槽位还没有配置模型');
  if (!runtime.apiKey) throw new Error('视频槽位还没有填写 API Key，请到「模型设置 → 视频生成」里保存');

  const imagePath = assertInsideData(input.imageAbsPath);
  const buffer = fs.readFileSync(imagePath);
  if (buffer.length === 0) throw new Error('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片过大（上限 20MB），请先缩尺寸');
  const mime = EXT_MIME[path.extname(imagePath).toLowerCase()] ?? 'image/png';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const duration = Math.min(12, Math.max(2, Math.round(Number(input.duration) || 5)));
  const resolution = input.resolution || '720p';
  const mode = input.mode === 'reference' ? 'reference' : 'direct';

  // 组装提示词：用户描述 + 背景锁定 + 参考素材约束
  const basePrompt =
    (input.prompt || '').trim() || '角色轻微呼吸、衣摆与发丝自然摆动，镜头固定，动作首尾衔接无缝循环';
  const constraints: string[] = [];
  if (input.lockBackground !== false) {
    constraints.push(
      '【背景要求】严格保持原图的纯色背景不变：颜色、亮度、平整度都不得变化；禁止新增地面、道具、光斑、烟雾、阴影或渐变，禁止更换场景或改变画面构图。',
    );
  }
  if (mode === 'reference') {
    constraints.push(
      '【参考要求】参考素材仅用于参考动作节奏与姿态变化；不要复制参考素材里的角色外观、服装、配色或画风，保持原图美术风格不变。',
    );
  }
  const prompt = [basePrompt, ...constraints].join('\n');

  // 构造 content：direct = 首尾同图循环；reference = 素材库参考图（多模态参考）
  const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];

  if (mode === 'reference') {
    const refs = (input.referenceImagePaths ?? []).slice(0, 4);
    if (refs.length === 0) throw new Error('参考模式下至少要选 1 张参考图');
    for (const refPath of refs) {
      const abs = assertInsideData(refPath);
      const refBuffer = fs.readFileSync(abs);
      if (refBuffer.length === 0) continue;
      if (refBuffer.length > MAX_IMAGE_BYTES) throw new Error('参考图过大（上限 20MB）');
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

  onProgress({ stage: 'submitting', message: '正在提交生成任务…' });
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
  if (!taskId) throw new Error('服务商没有返回任务 id');

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
      throw new Error(`生成失败：${error?.message ?? '服务商未说明原因'}`);
    }
    if (status === 'cancelled' || status === 'expired') {
      throw new Error(`任务已${status === 'cancelled' ? '取消' : '过期'}`);
    }

    const elapsed = Date.now() - startedAt;
    const message = status === 'queued' ? '排队中…' : '生成中…';
    if (message !== lastMessage || elapsed % 15_000 < POLL_INTERVAL_MS) {
      lastMessage = message;
      onProgress({
        stage: status === 'queued' ? 'queued' : 'running',
        message: `${message}（已等待 ${Math.round(elapsed / 1000)} 秒）`,
        taskId,
        percent: Math.min(90, Math.round((elapsed / 600_000) * 100)),
      });
    }
  }

  if (!videoUrl) throw new Error('等待超时（20 分钟）：任务可能仍在服务商侧排队，稍后可重试');

  onProgress({ stage: 'downloading', message: '正在下载视频…', taskId, percent: 95 });
  const videoBuffer = await downloadVideo(videoUrl);
  if (videoBuffer.length === 0) throw new Error('下载到的视频为空');

  const dirs = getDataDirs();
  const id = createId('video');
  const fileName = `${id}.mp4`;
  // 视频单独一个目录，不跟图片混放
  fs.mkdirSync(dirs.knowledgeVideos, { recursive: true });
  const absPath = path.join(dirs.knowledgeVideos, fileName);
  fs.writeFileSync(absPath, videoBuffer);

  const item: KnowledgeItem = {
    id,
    fileName,
    kind: 'video',
    bytes: videoBuffer.length,
    tags: [],
    note: '',
    source: 'ai-generated',
    origin: { providerId: runtime.providerId, model: runtime.model, prompt },
    createdAt: new Date().toISOString(),
    asReference: false,
  };
  addItems([item]);

  onProgress({ stage: 'done', message: '生成完成，已存入素材库', taskId, percent: 100 });

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
