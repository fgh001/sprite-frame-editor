import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeItem } from '../../shared/ipc';
import { getDataDirs } from './paths';

/**
 * 素材库 = **磁盘目录的镜像**，没有任何索引文件。
 *
 * 设计取舍（按要求）：
 *   - 用户会在资源管理器里直接往 data/knowledge/files/images、files/videos
 *     拷文件、删文件、改名，所以列表必须每次从磁盘现扫；
 *   - 条目 id 由「kind + 文件名」派生，改名后自动得到新 id，不会和旧记录串味；
 *   - 不保存标签 / 备注 / 生成来源 —— 那些都要靠一个额外的索引文件维护，
 *     文件一旦被手动改名就对不上，维护成本大于收益。
 */

/** 素材库按类型分目录：图片与视频物理分开，绝不混放 */
export function mediaDirOf(kind: KnowledgeItem['kind']): string {
  const dirs = getDataDirs();
  return kind === 'video' ? dirs.knowledgeVideos : dirs.knowledgeImages;
}

export function thumbDirOf(kind: KnowledgeItem['kind']): string {
  const dirs = getDataDirs();
  return kind === 'video' ? dirs.knowledgeThumbVideos : dirs.knowledgeThumbImages;
}

/** 素材原文件绝对路径（按 kind 落到 images / videos） */
export function resolveItemPath(item: KnowledgeItem): string {
  return path.join(mediaDirOf(item.kind), item.fileName);
}

/** 缩略图绝对路径 */
export function resolveThumbPath(item: KnowledgeItem, fileName?: string): string {
  return path.join(thumbDirOf(item.kind), fileName ?? `${item.id}.png`);
}

/** 缩略图文件名约定：<id>.png（用 PNG 才能保留透明通道，JPEG 会把透明区填成黑色） */
export function thumbFileNameOf(item: KnowledgeItem): string {
  return `${item.id}.png`;
}

/** 素材库认的扩展名 */
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);

/**
 * 条目 id 由「kind + 文件名」派生。
 * 文件在磁盘上被改名后，下一轮扫描自然得到新 id，缩略图随之重建。
 */
export function stableIdOf(kind: KnowledgeItem['kind'], fileName: string): string {
  return crypto.createHash('sha1').update(`${kind}:${fileName}`).digest('hex').slice(0, 12);
}

interface ScannedFile {
  fileName: string;
  bytes: number;
  modifiedAt: Date;
}

function scanDir(dir: string, exts: Set<string>): ScannedFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // 目录还不存在
  }
  const files: ScannedFile[] = [];
  for (const fileName of entries) {
    if (!exts.has(path.extname(fileName).toLowerCase())) continue;
    try {
      const stat = fs.statSync(path.join(dir, fileName));
      if (!stat.isFile()) continue;
      files.push({ fileName, bytes: stat.size, modifiedAt: stat.mtime });
    } catch {
      /* 读不到（被占用 / 没权限）就跳过这一张，不影响其他文件 */
    }
  }
  return files;
}

function mediaTargets(): { kind: KnowledgeItem['kind']; dir: string; exts: Set<string> }[] {
  const dirs = getDataDirs();
  return [
    { kind: 'image', dir: dirs.knowledgeImages, exts: IMAGE_EXTS },
    { kind: 'video', dir: dirs.knowledgeVideos, exts: VIDEO_EXTS },
  ];
}

/**
 * 列出素材库：目录里有什么就返回什么。
 * 创建时间取文件修改时间（没有索引可记原始创建时间）。
 */
export function listItems(): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  for (const target of mediaTargets()) {
    for (const file of scanDir(target.dir, target.exts)) {
      items.push({
        id: stableIdOf(target.kind, file.fileName),
        fileName: file.fileName,
        kind: target.kind,
        bytes: file.bytes,
        createdAt: file.modifiedAt.toISOString(),
      });
    }
  }
  return items;
}

/** 按 id（= 文件名派生）找条目；找不到返回 null */
export function findItem(id: string): KnowledgeItem | null {
  return listItems().find((item) => item.id === id) ?? null;
}

/** 删除素材：删掉原文件与缩略图。返回是否真的删到了 */
export function removeItem(id: string): boolean {
  const target = findItem(id);
  if (!target) return false;
  for (const file of [resolveItemPath(target), resolveThumbPath(target)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 文件已不存在或被占用时忽略 */
    }
  }
  return true;
}

/** 生成唯一 id（给新文件名用） */
export function createId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${stamp}-${rand}`;
}

/**
 * 把旧版混放（files/ 与 thumbs/ 根目录）的素材迁到 images/ 与 videos/ 子目录。
 *
 * 旧版靠 index.json 记录文件名，现在没有索引，所以直接扫旧根目录里的文件，
 * 按扩展名判定类型后搬走。幂等：已存在的目标文件跳过。
 */
export function migrateToKindFolders(): { moved: number } {
  const dirs = getDataDirs();
  let moved = 0;

  const moveAll = (from: string, to: string, exts: Set<string>): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(from);
    } catch {
      return;
    }
    for (const fileName of entries) {
      if (!exts.has(path.extname(fileName).toLowerCase())) continue;
      const dest = path.join(to, fileName);
      if (fs.existsSync(dest)) continue;
      try {
        fs.renameSync(path.join(from, fileName), dest);
        moved += 1;
      } catch {
        /* 跨盘或占用时忽略，下次再试 */
      }
    }
  };

  // 旧素材根目录：图片进 images、视频进 videos
  moveAll(dirs.knowledgeFiles, dirs.knowledgeImages, IMAGE_EXTS);
  moveAll(dirs.knowledgeFiles, dirs.knowledgeVideos, VIDEO_EXTS);
  // 旧缩略图根目录：缩略图按 id 命名，看不出原素材类型，统一放 images
  moveAll(dirs.knowledgeThumbs, dirs.knowledgeThumbImages, new Set(['.png', '.jpg']));

  return { moved };
}

/** 协议解析用：在 images / videos（以及旧根目录）里找这个文件名 */
export function locateMediaFile(fileName: string): string | null {
  const dirs = getDataDirs();
  const safe = path.basename(fileName);
  const candidates = [
    path.join(dirs.knowledgeImages, safe),
    path.join(dirs.knowledgeVideos, safe),
    path.join(dirs.knowledgeFiles, safe),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 协议解析用：缩略图同名文件可能落在任一类目录里 */
export function locateThumbFile(thumbName: string): string | null {
  const dirs = getDataDirs();
  const safe = path.basename(thumbName);
  const candidates = [
    path.join(dirs.knowledgeThumbImages, safe),
    path.join(dirs.knowledgeThumbVideos, safe),
    path.join(dirs.knowledgeThumbs, safe),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
