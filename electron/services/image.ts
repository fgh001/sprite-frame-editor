import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import type { GenerateImageInput, GenerateImageResult, GeneratedImage, KnowledgeItem } from '../../shared/ipc';
import { buildBackgroundPrompt, estimateImageCost } from '../../shared/pricing';
import { getDataDirs } from '../core/paths';
import { addItems, createId } from '../core/knowledge';
import { getSlotRuntime, type SlotRuntime } from '../core/settings';

/** 出图通常比文本慢，给足时间（2K 图偶尔要 60s+） */
const REQUEST_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_IMAGES = 4;
const MAX_PROMPT_LENGTH = 4_000;
const THUMB_MAX_EDGE = 512;
const DEFAULT_BACKGROUND = '#00B140';

interface ImageApiItem {
  b64_json?: string;
  url?: string;
}

interface ImageApiResponse {
  data?: ImageApiItem[];
  error?: { message?: string };
}

function normalizeBackground(color: string | undefined): string {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color.trim())) return color.trim().toUpperCase();
  return DEFAULT_BACKGROUND;
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
    /* 响应体读不出来就只报状态码 */
  }
  const hint =
    res.status === 401
      ? '（API Key 无效或未开通该模型）'
      : res.status === 403
        ? '（没有权限，检查模型是否已在控制台开通）'
        : res.status === 404
          ? '（接口地址不存在，检查 Base URL）'
          : res.status === 429
            ? '（触发限流，稍后再试）'
            : '';
  return `HTTP ${res.status} ${res.statusText}${hint}${detail ? `：${String(detail).slice(0, 400)}` : ''}`;
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<ImageApiResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`调用 ${url} 失败：${reason}（检查网络 / 代理 / Base URL）`);
  }
  if (!response.ok) throw new Error(await describeHttpError(response));
  try {
    return (await response.json()) as ImageApiResponse;
  } catch {
    throw new Error(`接口 ${url} 返回的不是合法 JSON`);
  }
}

/**
 * 不同服务商的参数差异集中在这里：
 * - 豆包：一次只出一张（不认 n），2K 图用 url 返回避免超大 base64；默认打水印需显式关闭；
 *   Seedream 5.x 额外支持 output_format: png（4.x 只能 jpeg，所以按模型名判断）
 * - OpenAI 兼容（gpt-image-1 / FLUX / CogView）：走 response_format: b64_json + n
 */
function buildRequestPlan(
  runtime: SlotRuntime,
  prompt: string,
  size: string,
  count: number,
): { body: Record<string, unknown>; rounds: number } {
  const isDoubao = runtime.providerId === 'doubao';
  const isSeedream5 = /seedream-5/i.test(runtime.model);

  const body: Record<string, unknown> = {
    model: runtime.model,
    prompt,
    size: size || (isDoubao ? '2K' : '1024x1024'),
    response_format: isDoubao ? 'url' : 'b64_json',
  };

  if (isDoubao) {
    body.watermark = false;
    if (isSeedream5) body.output_format = 'png';
    // 豆包单次请求固定出一张，多张就发多次（每张独立计费，心里有数）
    return { body, rounds: count };
  }

  body.n = count;
  return { body, rounds: 1 };
}

/** 二进制签名嗅探扩展名，避免把 JPEG 存成 .png */
function detectExtension(buffer: Buffer): string {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}

async function toImageBuffer(item: ImageApiItem): Promise<Buffer> {
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (!item.url) throw new Error('服务商返回的图片既没有 b64_json 也没有 url');

  // 豆包等返回的 URL 24 小时失效 —— 必须立刻下载存档
  let response: Response;
  try {
    response = await fetch(item.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`下载生成结果失败：${reason}`);
  }
  if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function buildThumb(buffer: Buffer, width: number, height: number): Buffer {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return Buffer.alloc(0);
  const longest = Math.max(width, height);
  if (longest <= THUMB_MAX_EDGE) return image.toPNG();
  const resized = width >= height ? image.resize({ width: THUMB_MAX_EDGE }) : image.resize({ height: THUMB_MAX_EDGE });
  return resized.toPNG();
}

/**
 * 文字生成图片。
 * 游戏角色素材必须能干净抠图，所以提示词里强制纯色背景（颜色由界面指定或自动避让主体色）。
 * 结果一定落盘：勾选 saveToKnowledge 时进素材库（files + thumbs + index.json），
 * 否则放进 cache/generated（可随时清理）。
 */
export async function generateImages(input: GenerateImageInput): Promise<GenerateImageResult> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`提示词过长（上限 ${MAX_PROMPT_LENGTH} 字）`);

  const background = normalizeBackground(input.backgroundColor);
  const count = Math.min(Math.max(Math.trunc(Number(input.count) || 1), 1), MAX_IMAGES);
  const runtime = await getSlotRuntime('image');

  if (!runtime.baseUrl) throw new Error('图像槽位还没有配置 Base URL');
  if (!runtime.model) throw new Error('图像槽位还没有配置模型');
  if (!runtime.apiKey && runtime.providerId !== 'ollama') {
    throw new Error('图像槽位还没有填写 API Key，请到「模型设置 → 图像生成」里保存');
  }

  // 纯色背景约束拼在用户提示词后面
  const fullPrompt = `${prompt}${buildBackgroundPrompt(background)}`;

  const startedAt = Date.now();
  const plan = buildRequestPlan(runtime, fullPrompt, input.size, count);
  const endpoint = joinUrl(runtime.baseUrl, 'images/generations');

  // 按 plan.rounds 依次请求，任一次失败就整体报错（已成功的结果不会丢失，会一并返回）
  const rawItems: ImageApiItem[] = [];
  let lastError: string | null = null;
  for (let round = 0; round < plan.rounds; round += 1) {
    try {
      const body = await postJson(endpoint, runtime.apiKey, plan.body);
      const items = Array.isArray(body.data) ? body.data : [];
      if (items.length === 0) {
        lastError = body.error?.message ?? '接口没有返回任何图片';
        continue;
      }
      rawItems.push(...items);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (rawItems.length === 0) throw err;
      break;
    }
  }

  if (rawItems.length === 0) {
    throw new Error(lastError ? `生成失败：${lastError}` : '接口没有返回任何图片');
  }

  const dirs = getDataDirs();
  // 图片与视频分目录存放：生成的图片一律进 files/images
  const targetDir = input.saveToKnowledge ? dirs.knowledgeImages : path.join(dirs.cache, 'generated');
  const thumbDir = input.saveToKnowledge ? dirs.knowledgeThumbImages : path.join(targetDir, 'thumbs');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  const images: GeneratedImage[] = [];
  const knowledgeItems: KnowledgeItem[] = [];

  for (const item of rawItems) {
    const buffer = await toImageBuffer(item);
    if (buffer.length === 0) continue;

    const id = createId('gen');
    const fileName = `${id}${detectExtension(buffer)}`;
    const absPath = path.join(targetDir, fileName);
    fs.writeFileSync(absPath, buffer);

    const decoded = nativeImage.createFromBuffer(buffer);
    const size = decoded.isEmpty() ? { width: 0, height: 0 } : decoded.getSize();

    const thumb = buildThumb(buffer, size.width, size.height);
    if (thumb.length > 0) {
      fs.writeFileSync(path.join(thumbDir, `${id}.png`), thumb);
    }

    images.push({
      id,
      fileName,
      absPath,
      width: size.width,
      height: size.height,
      bytes: buffer.length,
      inKnowledge: input.saveToKnowledge,
      thumbDataUrl: thumb.length > 0 ? `data:image/png;base64,${thumb.toString('base64')}` : '',
      backgroundColor: background,
    });

    if (input.saveToKnowledge) {
      knowledgeItems.push({
        id,
        fileName,
        kind: 'image',
        bytes: buffer.length,
        width: size.width,
        height: size.height,
        tags: [],
        note: '',
        source: 'ai-generated',
        origin: {
          providerId: runtime.providerId,
          model: runtime.model,
          prompt,
          backgroundColor: background,
        },
        createdAt: new Date().toISOString(),
        asReference: false,
      });
    }
  }

  if (images.length === 0) throw new Error('生成结果为空，可能被服务商过滤，换提示词再试');
  if (knowledgeItems.length > 0) addItems(knowledgeItems);

  return {
    providerId: runtime.providerId,
    model: runtime.model,
    prompt,
    images,
    elapsedMs: Date.now() - startedAt,
    backgroundColor: background,
    estimatedCost: estimateImageCost(runtime.model, images.length),
  };
}
