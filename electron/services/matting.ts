import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
// 依赖自带 ONNX 模型（node_modules/@imgly/.../dist 内，无需联网）
import { removeBackground } from '@imgly/background-removal-node';
import type { AiMattingResult } from '../../shared/ipc';
import { AI_MATTING_MODEL } from '../../shared/features';
import { getDataDirs } from '../core/paths';
import { msg } from '../core/msg';

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 只允许处理数据目录内的图片 */
function assertInsideData(target: unknown): string {
  if (typeof target !== 'string' || !target.trim()) throw new Error(msg('err.file.badPath'));
  const root = getDataDirs().root;
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(msg('err.file.outsideData'));
  }
  return resolved;
}

/**
 * AI 语义分割抠图（ISNet 模型，纯本地 CPU 推理）。
 * 与颜色/色键无关，主体和背景同色也能正确分离。
 */
export async function removeImageBackground(absPath: string): Promise<AiMattingResult> {
  const resolved = assertInsideData(absPath);
  const buffer = fs.readFileSync(resolved);
  if (buffer.length === 0) throw new Error(msg('err.model.emptyImage'));
  if (buffer.length > 30 * 1024 * 1024) throw new Error(msg('err.file.imageTooLarge30'));

  const mime = EXT_MIME[path.extname(resolved).toLowerCase()] ?? 'image/png';
  const startedAt = Date.now();

  // 库内部按 Blob 的 MIME 决定解码方式，必须带上 type
  const input = new Blob([buffer], { type: mime });
  const result = await removeBackground(input, {
    // 档位见 shared/features.ts：large 最准（单张 10–25 秒），追求速度可改 small
    model: AI_MATTING_MODEL,
    output: { format: 'image/png', quality: 1 },
  });

  const outBuffer = Buffer.from(await result.arrayBuffer());
  if (outBuffer.length === 0) throw new Error(msg('err.model.emptyResult'));

  const decoded = nativeImage.createFromBuffer(outBuffer);
  const size = decoded.isEmpty() ? { width: 0, height: 0 } : decoded.getSize();

  return {
    dataUrl: `data:image/png;base64,${outBuffer.toString('base64')}`,
    width: size.width,
    height: size.height,
    bytes: outBuffer.length,
    elapsedMs: Date.now() - startedAt,
  };
}
