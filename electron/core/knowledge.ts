import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeItem } from '../../shared/ipc';
import { getDataDirs } from './paths';

interface KnowledgeIndex {
  version: number;
  items: KnowledgeItem[];
}

const INDEX_VERSION = 1;

let cached: KnowledgeIndex | null = null;

export function getIndexFilePath(): string {
  return path.join(getDataDirs().knowledge, 'index.json');
}

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

function normalizeIndex(parsed: unknown): KnowledgeIndex {
  if (!parsed || typeof parsed !== 'object') return { version: INDEX_VERSION, items: [] };
  const raw = parsed as Partial<KnowledgeIndex>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    version: INDEX_VERSION,
    items: items.filter((item): item is KnowledgeItem => Boolean(item) && typeof item.id === 'string' && typeof item.fileName === 'string'),
  };
}

export function loadIndex(): KnowledgeIndex {
  if (cached) return cached;
  try {
    cached = normalizeIndex(JSON.parse(fs.readFileSync(getIndexFilePath(), 'utf8')));
  } catch {
    cached = { version: INDEX_VERSION, items: [] };
  }
  return cached;
}

function persist(index: KnowledgeIndex): void {
  const file = getIndexFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // 原子写：先写临时文件再改名，避免索引写坏导致素材“丢失”
  fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function listItems(): KnowledgeItem[] {
  return loadIndex().items;
}

export function addItems(items: KnowledgeItem[]): void {
  if (items.length === 0) return;
  const index = loadIndex();
  const next: KnowledgeIndex = { version: INDEX_VERSION, items: [...items, ...index.items] };
  persist(next);
  cached = next;
}

export function removeItem(id: string, deleteFiles: boolean): boolean {
  const index = loadIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) return false;

  if (deleteFiles) {
    for (const file of [resolveItemPath(target), resolveThumbPath(target)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 文件已不存在时忽略 */
      }
    }
  }

  const next: KnowledgeIndex = { version: INDEX_VERSION, items: index.items.filter((item) => item.id !== id) };
  persist(next);
  cached = next;
  return true;
}

/** 生成唯一 id */
export function createId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${stamp}-${rand}`;
}

/**
 * 把旧版混放（files/ 与 thumbs/ 根目录）的素材迁到 images/ 与 videos/ 子目录。
 * 幂等：找不到旧文件就跳过，可以每次启动都跑。
 */
export function migrateToKindFolders(): { moved: number } {
  const dirs = getDataDirs();
  const index = loadIndex();
  let moved = 0;

  for (const item of index.items) {
    // 原文件
    const legacyFile = path.join(dirs.knowledgeFiles, item.fileName);
    const targetFile = resolveItemPath(item);
    if (fs.existsSync(legacyFile) && !fs.existsSync(targetFile)) {
      try {
        fs.renameSync(legacyFile, targetFile);
        moved += 1;
      } catch {
        /* 跨盘或占用时忽略，下次再试 */
      }
    }

    // 缩略图（.png 优先，兼容旧的 .jpg）
    for (const ext of ['png', 'jpg']) {
      const legacyThumb = path.join(dirs.knowledgeThumbs, `${item.id}.${ext}`);
      const targetThumb = resolveThumbPath(item, `${item.id}.${ext}`);
      if (fs.existsSync(legacyThumb) && !fs.existsSync(targetThumb)) {
        try {
          fs.renameSync(legacyThumb, targetThumb);
          moved += 1;
        } catch {
          /* 同上 */
        }
      }
    }
  }

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
