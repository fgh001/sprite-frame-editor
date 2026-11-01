import fs from 'node:fs';
import path from 'node:path';
import { nativeImage, shell } from 'electron';
import type { EditableImage, GeneratedImage, SaveEditedImageInput } from '../../shared/ipc';
import { getDataDirs } from '../core/paths';
import { createId, locateMediaFile, stableIdOf } from '../core/knowledge';
import { computeUsage } from '../core/usage';
import { msg } from '../core/msg';

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const THUMB_MAX_EDGE = 512;

/** 所有文件操作都限制在便携数据目录内，避免渲染层传任意路径 */
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

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function makeThumb(buffer: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return Buffer.alloc(0);
  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  const resized =
    longest <= THUMB_MAX_EDGE
      ? image
      : width >= height
        ? image.resize({ width: THUMB_MAX_EDGE })
        : image.resize({ height: THUMB_MAX_EDGE });
  return resized.toPNG();
}

/** 打开数据目录：素材库原图 / 生成缓存 / 数据根目录 */
export function openDataDir(kind: 'knowledge' | 'cache' | 'root'): void {
  const dirs = getDataDirs();
  const target =
    kind === 'knowledge'
      ? dirs.knowledge
      : kind === 'cache'
        ? path.join(dirs.cache, 'generated')
        : dirs.root;
  fs.mkdirSync(target, { recursive: true });
  void shell.openPath(target);
}

/** 在资源管理器里定位某个文件 */
export function revealFile(target: string): void {
  const resolved = assertInsideData(target);
  if (!fs.existsSync(resolved)) throw new Error(msg('err.file.missing'));
  shell.showItemInFolder(resolved);
}

/** 把图片读成 data URL 供渲染层放进 canvas 编辑 */
export function readImageAsDataUrl(absPath: string): EditableImage {
  const resolved = assertInsideData(absPath);
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(msg('err.file.imageTooLarge30'));
  const buffer = fs.readFileSync(resolved);
  const image = nativeImage.createFromBuffer(buffer);
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
  const fileName = path.basename(resolved);
  return {
    absPath: resolved,
    fileName,
    dataUrl: `data:${mimeOf(resolved)};base64,${buffer.toString('base64')}`,
    width: size.width,
    height: size.height,
    bytes: buffer.length,
    // 没有索引了，无法记住「生成时用的纯色背景」，编辑器背景初值留空
    backgroundColor: '',
  };
}

/** 保存编辑后的 PNG：写入素材库并登记来源 */
export function saveEditedImage(input: SaveEditedImageInput): GeneratedImage {
  if (!input || typeof input !== 'object') throw new Error(msg('err.file.badSaveArgs'));

  // 仍然校验来源路径在 data 目录内（防止渲染层乱传），但没有索引可记它了
  assertInsideData(input.sourceAbsPath);
  const base64 = String(input.pngBase64 ?? '').replace(/^data:image\/png;base64,/, '');
  if (!base64) throw new Error(msg('err.file.emptyEdit'));

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw new Error(msg('err.file.emptyEdit'));
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(msg('err.file.editTooLarge'));

  const dirs = getDataDirs();
  // id 由最终文件名派生（素材库以磁盘文件名为准）
  const fileName = `${createId('edit')}.png`;
  const id = stableIdOf('image', fileName);
  // 编辑结果一律是图片，进 images 目录
  const absPath = path.join(dirs.knowledgeImages, fileName);
  fs.writeFileSync(absPath, buffer);

  const decoded = nativeImage.createFromBuffer(buffer);
  const size = decoded.isEmpty() ? { width: 0, height: 0 } : decoded.getSize();

  const thumb = makeThumb(buffer);
  if (thumb.length > 0) {
    fs.writeFileSync(path.join(dirs.knowledgeThumbImages, `${id}.png`), thumb);
  }

  return {
    id,
    fileName,
    absPath,
    width: size.width,
    height: size.height,
    bytes: buffer.length,
    inKnowledge: true,
    thumbDataUrl: thumb.length > 0 ? `data:image/png;base64,${thumb.toString('base64')}` : '',
    // 编辑产物可能已去背景，不再记录纯色背景
    backgroundColor: '',
  };
}

export function readUsage() {
  return computeUsage();
}

const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * 读取素材库媒体文件的原始字节。
 * 渲染层拿到后自己拼 blob URL —— 与页面同源，canvas 不会被污染，
 * 也完全绕开自定义协议的 CORS 限制（fetch('kbmedia://...') 在部分环境下会被拒）。
 */
export function readMediaBytes(fileName: string): { data: Uint8Array; mime: string } {
  const abs = locateMediaFile(fileName);
  if (!abs) throw new Error(msg('err.file.assetMissing'));
  const buffer = fs.readFileSync(abs);
  const mime = MEDIA_MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  return { data: new Uint8Array(buffer), mime };
}
