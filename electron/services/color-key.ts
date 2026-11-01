import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { getDataDirs } from '../core/paths';
import { msg } from '../core/msg';
import { listFrameFiles, writeFrameOutputMeta } from '../core/frames';

/**
 * 批量传统抠图（颜色键控）。
 *
 * 为什么放在主进程：帧项目都在磁盘上（data/frames/<项目>/），
 * 前端要处理就得先把每帧读成 blob 再回写，绕一大圈；
 * 主进程直接读文件 → 解码 → 算 → 写 PNG，最省事也最快。
 *
 * 算法和编辑器里的「传统抠图」保持一致：
 *   1. RGB 欧氏距离（不用 HSL —— 紫背景和紫发色相相同，HSL 会误删）
 *   2. distance ≤ threshold → 删（alpha=0）
 *   3. distance ≥ threshold → 保留
 *   4. 「仅连通」模式下从四边泛洪，保护角色内部被包围的同色区域
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface BatchKeyOutOptions {
  /** 背景色（可以多个，取最近的） */
  colors: RgbColor[];
  /** 容差 0–63，内部会乘 7 变成 RGB 距离阈值（0–441） */
  tolerance: number;
  /** global = 全局删；connected = 只删与画面边缘连通的背景 */
  mode: 'global' | 'connected';
  /** 把紧贴透明区的像素再削掉几圈（0–4） */
  edgeTrim?: number;
}

/** 从图片四角取平均色，作为背景色初值 */
export function sampleBackground(buffer: Buffer): RgbColor | null {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width < 4 || height < 4) return null;
  const bitmap = image.toBitmap(); // BGRA
  if (bitmap.length < width * height * 4) return null;

  const patch = Math.min(12, Math.floor(Math.min(width, height) / 8));
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - patch, 0],
    [0, height - patch],
    [width - patch, height - patch],
  ];
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (const [ox, oy] of corners) {
    for (let y = oy; y < oy + patch; y += 1) {
      for (let x = ox; x < ox + patch; x += 1) {
        const i = (y * width + x) * 4;
        sumB += bitmap[i];
        sumG += bitmap[i + 1];
        sumR += bitmap[i + 2];
        count += 1;
      }
    }
  }
  if (count === 0) return null;
  return {
    r: Math.round(sumR / count),
    g: Math.round(sumG / count),
    b: Math.round(sumB / count),
  };
}

/** 对单张图做颜色键控，返回新的 PNG buffer */
export function keyOut(buffer: Buffer, options: BatchKeyOutOptions): Buffer {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error(msg('err.model.decodeFailed'));
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA，可写副本
  const total = width * height;
  if (bitmap.length < total * 4) throw new Error(msg('err.model.bitmapIncomplete'));

  const threshold = Math.max(0, options.tolerance) * 7;
  const colors = options.colors.length > 0 ? options.colors : [{ r: 255, g: 0, b: 255 }];

  // 先标记「颜色上像背景」的像素
  const matches = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    const p = index * 4;
    const r = bitmap[p + 2];
    const g = bitmap[p + 1];
    const b = bitmap[p];
    let best = Infinity;
    for (const color of colors) {
      const dr = r - color.r;
      const dg = g - color.g;
      const db = b - color.b;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      if (distance < best) best = distance;
    }
    if (best <= threshold) matches[index] = 1;
  }

  // 决定哪些真的删掉
  const removed = new Uint8Array(total);
  if (options.mode === 'global') {
    removed.set(matches);
  } else {
    // 仅连通：从四边泛洪，只有连到画面边缘的背景才删
    const visited = new Uint8Array(total);
    const stack: number[] = [];
    for (let x = 0; x < width; x += 1) {
      stack.push(x, (height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
      stack.push(y * width, y * width + width - 1);
    }
    while (stack.length > 0) {
      const index = stack.pop() as number;
      if (index < 0 || index >= total || visited[index]) continue;
      visited[index] = 1;
      if (matches[index] !== 1) continue;
      removed[index] = 1;
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0) stack.push(index - 1);
      if (x < width - 1) stack.push(index + 1);
      if (y > 0) stack.push(index - width);
      if (y < height - 1) stack.push(index + width);
    }
  }

  // 应用删除
  for (let index = 0; index < total; index += 1) {
    if (removed[index] === 1) {
      const p = index * 4;
      bitmap[p] = 0;
      bitmap[p + 1] = 0;
      bitmap[p + 2] = 0;
      bitmap[p + 3] = 0;
    }
  }

  // 边缘收缩：把紧贴透明区的像素再吃掉 N 圈，消掉抗锯齿造成的杂边
  const trim = Math.min(4, Math.max(0, options.edgeTrim ?? 0));
  for (let pass = 0; pass < trim; pass += 1) {
    const snapshot = new Uint8Array(removed);
    for (let index = 0; index < total; index += 1) {
      if (removed[index] === 1) continue;
      const x = index % width;
      const y = (index - x) / width;
      const touches =
        (x > 0 && snapshot[index - 1] === 1) ||
        (x < width - 1 && snapshot[index + 1] === 1) ||
        (y > 0 && snapshot[index - width] === 1) ||
        (y < height - 1 && snapshot[index + width] === 1);
      if (touches) {
        removed[index] = 1;
        const p = index * 4;
        bitmap[p + 3] = 0;
      }
    }
  }

  const out = nativeImage.createFromBitmap(Buffer.from(bitmap), { width, height });
  return out.toPNG();
}

export interface BatchKeyOutResult {
  total: number;
  elapsedMs: number;
  skipped: string[];
  outDir: string;
}

/**
 * 批量处理一个帧目录，输出到同级的「<目录>-key」。
 * 原帧保持不动，方便对比和回退。
 */
export function keyOutDirectory(inDir: string, options: BatchKeyOutOptions): BatchKeyOutResult {
  const started = Date.now();
  if (!fs.existsSync(inDir)) throw new Error(msg('err.frames.dirMissing', { dir: inDir }));

  // 输出统一放 frames/outputs/，和抽帧集合（frames/sources/）分层
  const outDir = path.join(getDataDirs().frameOutputs, `${path.basename(inDir)}-key`);
  fs.mkdirSync(outDir, { recursive: true });

  // 动态读源集合里的图片（不看命名），用户在文件夹里放了什么就处理什么
  const files = listFrameFiles(inDir);

  const skipped: string[] = [];
  let done = 0;
  for (const name of files) {
    try {
      const buffer = fs.readFileSync(path.join(inDir, name));
      const result = keyOut(buffer, options);
      fs.writeFileSync(path.join(outDir, name), result);
      done += 1;
    } catch (err) {
      skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* 把「这是传统抠图、源集合叫什么」写进目录里的 meta.json，
     之后用户随便改目录名，界面也读得出正确类型和来源。 */
  writeFrameOutputMeta(outDir, {
    kind: 'key',
    sourceName: path.basename(inDir),
    createdAt: new Date().toISOString(),
  });

  return { total: done, elapsedMs: Date.now() - started, skipped, outDir };
}
