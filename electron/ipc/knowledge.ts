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
} from '../../shared/ipc';
import {
  createId,
  listItems,
  locateMediaFile,
  locateThumbFile,
  mediaDirOf,
  removeItem,
  resolveItemPath,
  resolveThumbPath,
  stableIdOf,
  thumbDirOf,
  thumbFileNameOf,
} from '../core/knowledge';
import { getDataDirs } from '../core/paths';
import { resolveFrameUrl } from './frames';
import { msg } from '../core/msg';

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

/**
 * 补缩略图：手动拷进目录的文件、以及被改名的文件都没有对应缩略图，
 * 不补的话列表里是破图。只在缺图时才解码，已有直接跳过。
 */
function ensureThumb(item: KnowledgeItem): void {
  if (item.kind !== 'image') return;
  const thumbPath = resolveThumbPath(item, `${item.id}.png`);
  if (fs.existsSync(thumbPath)) return;
  const source = resolveItemPath(item);
  if (!fs.existsSync(source)) return;
  try {
    const thumb = makeThumb(fs.readFileSync(source));
    if (thumb.length > 0) fs.writeFileSync(thumbPath, thumb);
  } catch {
    /* 单张失败不影响其他条目（界面会退回显示原图） */
  }
}

export function listKnowledge(): KnowledgeView[] {
  return listItems()
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => {
      ensureThumb(item);
      return toView(item);
    });
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
    title: msg('dialog.import.title'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: msg('dialog.import.media'),
        extensions: [...IMAGE_EXTS, ...VIDEO_EXTS].map((ext) => ext.slice(1)),
      },
      { name: msg('dialog.import.images'), extensions: [...IMAGE_EXTS].map((ext) => ext.slice(1)) },
      { name: msg('dialog.import.videos'), extensions: [...VIDEO_EXTS].map((ext) => ext.slice(1)) },
      { name: msg('dialog.import.all'), extensions: ['*'] },
    ],
  };

  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) {
    return { imported: 0, skippedDuplicates: 0, skippedUnsupported: 0, items: [] };
  }

  for (const dir of [mediaDirOf('image'), mediaDirOf('video'), thumbDirOf('image'), thumbDirOf('video')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /* 没有索引了，无法知道「历史上导入过的文件」的内容指纹（每次全量算哈希太慢），
     所以去重只在本次导入的这批文件之间生效。 */
  const knownHashes = new Set<string>();

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

      const fileName = `${createId('kb')}${ext}`;
      const id = stableIdOf(kind, fileName);
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
        createdAt: new Date().toISOString(),
      });
    } catch {
      skippedUnsupported += 1;
    }
  }

  return {
    imported: created.length,
    skippedDuplicates,
    skippedUnsupported,
    items: created.map(toView),
  };
}

export function removeKnowledge(id: string): void {
  if (!removeItem(id)) throw new Error(msg('err.kb.missing'));
}

/**
 * 重命名素材文件（改的是磁盘上的实际文件名，不是 id）。
 *
 * 为什么要走应用改：直接去 data/knowledge/files/images 里改名，索引 index.json 里
 * 还记着旧文件名，界面上的缩略图会立刻变成破图。
 *
 * 缩略图按 `<id>.png` 命名，跟文件名无关，所以不用动。
 * 重名直接报错、不覆盖。
 */
export function renameKnowledge(id: string, nextName: string): KnowledgeView {
  const existing = listItems();
  const target = existing.find((item) => item.id === id);
  if (!target) throw new Error(msg('err.kb.missing'));

  const raw = String(nextName ?? '').trim();
  if (!raw) throw new Error(msg('err.kb.emptyName'));

  const originalExt = path.extname(target.fileName);
  // 去掉非法字符；用户没写扩展名就自动补回原来的
  let safe = raw.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!safe) throw new Error(msg('err.kb.emptyName'));
  const typedExt = path.extname(safe);
  if (!typedExt) {
    safe = `${safe}${originalExt}`;
  } else if (typedExt.toLowerCase() !== originalExt.toLowerCase()) {
    // 用户写了个别的扩展名 —— 以原扩展名为准，否则系统会认不出文件类型
    safe = `${safe.slice(0, safe.length - typedExt.length)}${originalExt}`;
  }

  if (safe === target.fileName) return toView(target);

  const dir = mediaDirOf(target.kind);
  const dest = path.join(dir, safe);
  if (fs.existsSync(dest)) {
    throw new Error(msg('err.kb.nameExists', { name: safe }));
  }

  const source = resolveItemPath(target);
  if (!fs.existsSync(source)) throw new Error(msg('err.kb.sourceGone'));

  fs.renameSync(source, dest);

  /* 缩略图按 id 命名，而 id 由文件名派生 —— 改名后旧缩略图失配，
     这里顺手删掉，新缩略图会在下次列目录时由 ensureThumb 重建。 */
  try {
    fs.rmSync(resolveThumbPath(target, `${target.id}.png`), { force: true });
  } catch {
    /* 删不掉就留着，只是占一点空间 */
  }

  return toView({
    ...target,
    id: stableIdOf(target.kind, safe),
    fileName: safe,
  });
}

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * 监听素材容器目录（data/knowledge/files/images、files/videos）。
 *
 * 用户会在资源管理器里直接往这两个目录拷文件、删文件、改名 —— 界面必须跟着变，
 * 不能等他手动点「刷新」。这里用 fs.watch 监听，200ms 防抖后广播给所有窗口；
 * 渲染层收到后走统一的数据刷新事件重新读盘。
 */
export function startMediaWatcher(): void {
  const dirs = getDataDirs();
  const targets = [dirs.knowledgeImages, dirs.knowledgeVideos];

  let timer: NodeJS.Timeout | null = null;
  const broadcast = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('kb:mediaChanged');
      }
    }, 200);
  };

  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // recursive: false —— 这两个目录是平铺的，不看子目录，开销最小
      const watcher = fs.watch(dir, { persistent: false }, broadcast);
      watcher.on('error', () => {
        /* 目录被删或权限变化时静默忽略，用户重开应用会重新监听 */
      });
    } catch {
      /* 单个目录监听失败不影响另一个 */
    }
  }
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

  ipcMain.handle('kb:remove', async (_event, id: unknown): Promise<IpcResult<null>> => {
    try {
      if (typeof id !== 'string' || !id) throw new Error(msg('err.kb.noId'));
      removeKnowledge(id);
      return { ok: true, data: null };
    } catch (err) {
      return toError(err);
    }
  });

  /** 重命名素材文件（改磁盘实际文件名 + 索引；重名直接报错不覆盖） */
  ipcMain.handle(
    'kb:rename',
    async (_event, id: unknown, name: unknown): Promise<IpcResult<KnowledgeView>> => {
      try {
        if (typeof id !== 'string' || !id) throw new Error(msg('err.kb.noId'));
        if (typeof name !== 'string') throw new Error(msg('err.kb.badNewName'));
        return { ok: true, data: renameKnowledge(id, name) };
      } catch (err) {
        return toError(err);
      }
    },
  );
}
