import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BrowserWindow, dialog, ipcMain, nativeImage, protocol } from 'electron';
import type {
  ImportResult,
  IpcErr,
  IpcResult,
  KnowledgeItem,
  KnowledgeView,
  UpdateKnowledgeInput,
} from '../../shared/ipc';
import {
  addItems,
  createId,
  listItems,
  locateMediaFile,
  locateThumbFile,
  mediaDirOf,
  removeItem,
  resolveItemPath,
  resolveThumbPath,
  thumbDirOf,
  thumbFileNameOf,
} from '../core/knowledge';
import { resolveFrameUrl } from './frames';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
const THUMB_MAX_EDGE = 512;
const MAX_IMPORT_BYTES = 300 * 1024 * 1024;
const SCHEME = 'kbmedia';

/**
 * 自定义协议：把 data 目录里的素材以流的方式给渲染层。
 * - kbmedia://file/<fileName>  原图 / 原视频（支持 range，视频可拖动进度）
 * - kbmedia://thumb/<id>.jpg   缩略图
 * 这样界面不用把几 MB 的图片塞进 base64。
 */
export function registerKnowledgeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 必须打开 CORS：否则 <video crossOrigin> 加载会被判为不安全来源（code 4）
        corsEnabled: true,
      },
    },
  ]);
}

const MIME_BY_EXT: Record<string, string> = {
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
 * 返回带 Range 支持的文件响应。
 * 视频必须支持 Range 才能 seek —— 没有它 video.currentTime 改不动，
 * 抽帧会一直等不到 seeked 事件（之前「抽帧没反应」的根因就在这里）。
 * 另外必须带 CORS 头：否则 drawImage(video) 会把 canvas 标成「污染」，
 * toBlob/toDataURL 抛 SecurityError，导致抽出来的帧全是空的。
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

function serveFile(absPath: string, request: Request): Response {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const stat = fs.statSync(absPath);
  const size = stat.size;
  const type = MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
  const rangeHeader = request.headers.get('range');

  if (!rangeHeader) {
    const stream = Readable.toWeb(fs.createReadStream(absPath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const match = /bytes=(\d*)-(\d*)/i.exec(rangeHeader);
  let start = match && match[1] ? Number(match[1]) : 0;
  let end = match && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end > size - 1) end = size - 1;
  if (start > end) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { ...CORS_HEADERS, 'Content-Range': `bytes */${size}` },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(absPath, { start, end })) as ReadableStream;
  return new Response(stream, {
    status: 206,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

export function registerKnowledgeProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      /* 帧相关的两类地址都交给 resolveFrameUrl：
           kbmedia://frame/<项目>/<文件>   → data/frames/sources/<项目>/<文件>
           kbmedia://output/<目录>/<文件>  → data/frames/outputs/<目录>/<文件>
         少了 output 这一支，抠图结果的预览图会全部 404（只剩不到图）。 */
      if (url.hostname === 'frame' || url.hostname === 'output') {
        const abs = resolveFrameUrl(url);
        if (!abs) return new Response('Not Found', { status: 404 });
        return serveFile(abs, request);
      }
      const name = path.basename(decodeURIComponent(url.pathname));
      const abs = url.hostname === 'thumb' ? locateThumbFile(name) : locateMediaFile(name);
      if (!abs) return new Response('Not Found', { status: 404 });
      return serveFile(abs, request);
    } catch (err) {
      console.error('[kbmedia] 读取失败', err);
      return new Response('Bad Request', { status: 400 });
    }
  });
}

function toView(item: KnowledgeItem): KnowledgeView {
  const pngName = thumbFileNameOf(item);
  const legacyJpgName = `${item.id}.jpg`;
  // 兼容早期版本生成的 .jpg 缩略图（会被迁移成 .png）
  const thumbName = fs.existsSync(resolveThumbPath(item, pngName))
    ? pngName
    : fs.existsSync(resolveThumbPath(item, legacyJpgName))
      ? legacyJpgName
      : '';
  return {
    ...item,
    mediaUrl: `${SCHEME}://file/${encodeURIComponent(item.fileName)}`,
    thumbUrl: thumbName ? `${SCHEME}://thumb/${encodeURIComponent(thumbName)}` : '',
    absPath: resolveItemPath(item),
  };
}

/**
 * 一次性迁移：把旧版 JPEG 缩略图重建成 PNG（JPEG 没有透明通道，去背景后透明区会变黑）。
 * 启动时跑一遍，有 .png 就跳过，幂等。
 */
export function migrateThumbnailsToPng(): void {
  for (const item of listItems()) {
    if (item.kind !== 'image') continue;
    const pngPath = resolveThumbPath(item, `${item.id}.png`);
    const jpgPath = resolveThumbPath(item, `${item.id}.jpg`);
    if (fs.existsSync(pngPath)) {
      if (fs.existsSync(jpgPath)) fs.rmSync(jpgPath, { force: true });
      continue;
    }
    const source = resolveItemPath(item);
    if (!fs.existsSync(source)) continue;
    try {
      const buffer = fs.readFileSync(source);
      const thumb = makeThumb(buffer);
      if (thumb.length > 0) fs.writeFileSync(pngPath, thumb);
      if (fs.existsSync(jpgPath)) fs.rmSync(jpgPath, { force: true });
    } catch {
      /* 单张失败不影响其他 */
    }
  }
}

export function listKnowledge(): KnowledgeView[] {
  return listItems()
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toView);
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

/** 弹文件选择框导入图片/视频：复制进 data/knowledge/files，按内容 sha256 去重 */
export async function importKnowledgeFiles(): Promise<ImportResult> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options: Electron.OpenDialogOptions = {
    title: '导入到素材库（图片 / 视频）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片与视频', extensions: [...IMAGE_EXTS, ...VIDEO_EXTS].map((ext) => ext.slice(1)) },
      { name: '图片', extensions: [...IMAGE_EXTS].map((ext) => ext.slice(1)) },
      { name: '视频', extensions: [...VIDEO_EXTS].map((ext) => ext.slice(1)) },
      { name: '全部文件', extensions: ['*'] },
    ],
  };

  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) {
    return { imported: 0, skippedDuplicates: 0, skippedUnsupported: 0, items: [] };
  }

  for (const dir of [mediaDirOf('image'), mediaDirOf('video'), thumbDirOf('image'), thumbDirOf('video')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const knownHashes = new Set(
    listItems()
      .map((item) => item.hash)
      .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0),
  );

  const created: KnowledgeItem[] = [];
  let skippedDuplicates = 0;
  let skippedUnsupported = 0;

  for (const file of picked.filePaths) {
    const ext = path.extname(file).toLowerCase();
    const kind: 'image' | 'video' | null = IMAGE_EXTS.has(ext) ? 'image' : VIDEO_EXTS.has(ext) ? 'video' : null;
    if (!kind) {
      skippedUnsupported += 1;
      continue;
    }

    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMPORT_BYTES) {
        skippedUnsupported += 1;
        continue;
      }

      const buffer = fs.readFileSync(file);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      if (knownHashes.has(hash)) {
        skippedDuplicates += 1;
        continue;
      }
      knownHashes.add(hash);

      const id = createId('kb');
      const fileName = `${id}${ext}`;
      fs.writeFileSync(path.join(mediaDirOf(kind), fileName), buffer);

      let width: number | undefined;
      let height: number | undefined;
      if (kind === 'image') {
        const decoded = nativeImage.createFromBuffer(buffer);
        if (!decoded.isEmpty()) {
          const size = decoded.getSize();
          width = size.width;
          height = size.height;
          const thumb = makeThumb(buffer);
          if (thumb.length > 0) {
            fs.writeFileSync(path.join(thumbDirOf(kind), `${id}.png`), thumb);
          }
        }
      }

      created.push({
        id,
        fileName,
        kind,
        bytes: stat.size,
        width,
        height,
        tags: [],
        note: '',
        source: 'import',
        createdAt: new Date().toISOString(),
        asReference: false,
        hash,
        // 只记录来源路径用于展示；删除时绝不会去碰这个位置
        importedFrom: file,
      });
    } catch {
      skippedUnsupported += 1;
    }
  }

  if (created.length > 0) addItems(created);

  return {
    imported: created.length,
    skippedDuplicates,
    skippedUnsupported,
    items: created.map(toView),
  };
}

export function updateKnowledge(input: UpdateKnowledgeInput): KnowledgeView {
  const existing = listItems();
  const target = existing.find((item) => item.id === input.id);
  if (!target) throw new Error('素材不存在');

  const updated: KnowledgeItem = {
    ...target,
    tags: Array.isArray(input.tags)
      ? input.tags
          .map((tag) => String(tag).trim())
          .filter((tag) => tag.length > 0)
          .slice(0, 30)
      : target.tags,
    note: typeof input.note === 'string' ? input.note.slice(0, 500) : target.note,
    asReference: typeof input.asReference === 'boolean' ? input.asReference : target.asReference,
  };

  // 索引层没有单独的 update：先摘掉旧记录再插回，文件保持不动
  removeItem(input.id, false);
  addItems([updated]);
  return toView(updated);
}

export function removeKnowledge(id: string): void {
  if (!removeItem(id, true)) throw new Error('素材不存在');
}

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerKnowledgeIpc(): void {
  ipcMain.handle('kb:list', async (): Promise<IpcResult<KnowledgeView[]>> => {
    try {
      return { ok: true, data: listKnowledge() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('kb:importFiles', async (): Promise<IpcResult<ImportResult>> => {
    try {
      return { ok: true, data: await importKnowledgeFiles() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('kb:update', async (_event, raw: unknown): Promise<IpcResult<KnowledgeView>> => {
    try {
      if (!raw || typeof raw !== 'object') throw new Error('参数无效');
      const input = raw as Partial<UpdateKnowledgeInput>;
      if (typeof input.id !== 'string' || !input.id) throw new Error('缺少素材 id');
      return {
        ok: true,
        data: updateKnowledge({
          id: input.id,
          tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
          note: typeof input.note === 'string' ? input.note : undefined,
          asReference: typeof input.asReference === 'boolean' ? input.asReference : undefined,
        }),
      };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('kb:remove', async (_event, id: unknown): Promise<IpcResult<null>> => {
    try {
      if (typeof id !== 'string' || !id) throw new Error('缺少素材 id');
      removeKnowledge(id);
      return { ok: true, data: null };
    } catch (err) {
      return toError(err);
    }
  });
}
