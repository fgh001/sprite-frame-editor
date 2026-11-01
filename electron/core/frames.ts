import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import type {
  FrameOutputView,
  FrameProjectMeta,
  FrameProjectOutput,
  FrameProjectView,
  SaveFrameProjectInput,
} from '../../shared/ipc';
import { getDataDirs } from './paths';
import { msg } from './msg';

/**
 * 帧动画项目存储：
 *   data/frames/<文件夹名>/meta.json
 *   data/frames/<文件夹名>/frame_000.png ...
 * 一个视频抽出来的帧 = 一个文件夹，用户可自定义文件夹名。
 */

const META_FILE = 'meta.json';

/** 文件名里不能出现的字符统一换成下划线，防止越权写到别处 */
export function sanitizeFolderName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\.+$/, '')
    .slice(0, 60);
  return cleaned || `frames_${Date.now()}`;
}

/**
 * 抽帧集合目录：data/frames/sources/<id>/
 *
 * 为什么分两层（sources / outputs）：抽帧集合是「输入」，抠图结果是「产出」，
 * 混在同一个目录里既难区分，也不好批量清理（想删掉所有抠图结果得一个个挑）。
 */
export function projectDirOf(id: string): string {
  /* 带 -matte / -key 后缀的是「抠图结果」，去 outputs/ 找。
     前端的「定位文件夹」按钮会直接把 walk-matte 这种 id 传进来。 */
  if (/-(matte|key)$/i.test(id)) {
    return path.join(getDataDirs().frameOutputs, id);
  }
  return path.join(getDataDirs().frameSources, id);
}

/** 抠图结果目录：data/frames/outputs/<id>-matte/ */
export function outputDirOf(id: string, kind: 'matte' | 'key'): string {
  return path.join(getDataDirs().frameOutputs, `${id}-${kind}`);
}

/** 项目内某一帧的绝对路径（fileName 只允许单纯文件名） */
export function frameFilePath(id: string, fileName: string): string {
  const safe = path.basename(fileName);
  return path.join(projectDirOf(id), safe);
}

function readMeta(dir: string): FrameProjectMeta | null {
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), 'utf8');
    const parsed = JSON.parse(raw) as FrameProjectMeta;
    if (!parsed || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeMeta(dir: string, meta: FrameProjectMeta): void {
  const target = path.join(dir, META_FILE);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function toView(meta: FrameProjectMeta): FrameProjectView {
  const dir = projectDirOf(meta.id);
  let frameFileNames: string[] = [];
  try {
    frameFileNames = fs
      .readdirSync(dir)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
  } catch {
    frameFileNames = [];
  }

  /* 顺便看看这个项目跑过哪些批量抠图 —— 结果统一放在 data/frames/outputs/ 下，
     和抽帧集合（data/frames/sources/）分开两层，输入和产出不会混。 */
  const outputs: FrameProjectOutput[] = [];
  for (const kind of ['matte', 'key'] as const) {
    const outDir = outputDirOf(meta.id, kind);
    try {
      if (!fs.statSync(outDir).isDirectory()) continue;
      const outNames = fs
        .readdirSync(outDir)
        .filter((name) => /^frame_\d+\.png$/i.test(name))
        .sort();
      if (outNames.length === 0) continue;
      outputs.push({
        kind,
        name: path.basename(outDir),
        absPath: outDir,
        frameCount: outNames.length,
        // 预览走 kbmedia://output/<目录名>/<文件名>，协议层会去 outputs/ 下找。
        // 返回**全部**帧地址：列表只显示前 6 张，但播放窗口需要完整序列。
        previewUrls: outNames.map(
          (name) =>
            `kbmedia://output/${encodeURIComponent(`${meta.id}-${kind}`)}/${encodeURIComponent(name)}`,
        ),
      });
    } catch {
      /* 目录不存在就跳过，这很正常 */
    }
  }

  return {
    ...meta,
    absPath: dir,
    frameFileNames,
    /* URL 带上每帧的 mtime 做版本号：编辑器改过某一帧后 mtime 变了，
       URL 随之变化，Chromium 不会命中旧缓存，列表预览才会换成新图。 */
    frameUrls: frameFileNames.map((name) => {
      let ver = 0;
      try {
        ver = Math.round(fs.statSync(path.join(dir, name)).mtimeMs);
      } catch {
        /* 文件刚好被删，退回 0 */
      }
      return `kbmedia://frame/${encodeURIComponent(meta.id)}/${encodeURIComponent(name)}?v=${ver}`;
    }),
    outputs,
  };
}

/** 列出全部项目（按创建时间倒序） */
export function listFrameProjects(): FrameProjectView[] {
  // 只扫 sources/：outputs/ 是抠图产出，不当作独立项目
  const root = getDataDirs().frameSources;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // 目录被用户删掉了：不报错，当成「还没有项目」，下次保存时会重建
    return [];
  }

  const projects: FrameProjectView[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    /* 下划线开头的是内部缓存（_preview 抽帧预览），不算正式集合。
       在这里统一挡掉，所有页面（帧动画 / 批量抠图 / 找循环帧）都不会看到它。 */
    if (entry.name.startsWith('_')) continue;
    const dir = path.join(root, entry.name);

    let meta = readMeta(dir);
    if (!meta) {
      /* meta.json 被删了但图片还在 —— 宽容处理：自动重建一份 meta。
         用户经常直接进文件夹删东西，不该因此让整个项目消失。
         只有目录里一张 frame_*.png 都没有时才跳过（那是真的空壳）。 */
      meta = rebuildMeta(dir, entry.name);
      if (!meta) continue;
    }

    const view = toView(meta);
    // 一帧都没有的空项目不展示（文件可能已经被手动清空）
    if (view.frameFileNames.length === 0) continue;
    projects.push(view);
  }

  projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return projects;
}

/**
 * 独立列出 data/frames/outputs/ 下的所有抠图结果。
 *
 * 为什么要单独扫：抠图结果是「产出的产物」，不该依赖源集合还在。
 * 用户删掉源集合（sources/）之后，outputs/ 里的结果仍然应该能看到、能播放、能删除。
 */
export function listFrameOutputs(): FrameOutputView[] {
  const root = getDataDirs().frameOutputs;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const outputs: FrameOutputView[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 内部缓存产出的结果（_preview-matte 之类）同样不上列表
    if (entry.name.startsWith('_')) continue;
    const dir = path.join(root, entry.name);

    let frameFileNames: string[] = [];
    try {
      frameFileNames = fs
        .readdirSync(dir)
        .filter((name) => /^frame_\d+\.png$/i.test(name))
        .sort();
    } catch {
      continue;
    }
    if (frameFileNames.length === 0) continue;

    const kind: 'matte' | 'key' = /-key$/i.test(entry.name) ? 'key' : 'matte';
    outputs.push({
      name: entry.name,
      kind,
      absPath: dir,
      frameCount: frameFileNames.length,
      previewUrls: frameFileNames.map(
        (name) => `kbmedia://output/${encodeURIComponent(entry.name)}/${encodeURIComponent(name)}`,
      ),
      // 源集合名 = 去掉 -matte / -key 后缀（源集合可能已经被删掉）
      sourceName: entry.name.replace(/-(matte|key)$/i, ''),
    });
  }

  outputs.sort((a, b) => a.name.localeCompare(b.name));
  return outputs;
}

/**
 * 旧数据迁移：把 data/frames/ 下平铺的项目搬进 sources/ 和 outputs/ 两层。
 *
 * 老版本是 frame/ 里混着 walk、walk-matte、walk-key；新版本要求
 *   frame/sources/walk/         抽帧集合
 *   frame/outputs/walk-matte/   抠图结果
 * 不迁移的话升级后用户会以为自己的帧"不见了"。
 */
export function migrateFramesToSubfolders(): void {
  const dirs = getDataDirs();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirs.frames, { withFileTypes: true });
  } catch {
    return;
  }

  let moved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'sources' || entry.name === 'outputs') continue;

    const from = path.join(dirs.frames, entry.name);
    // 带 -matte / -key 后缀的是抠图产出，其余是抽帧集合
    const isOutput = /-(matte|key)$/i.test(entry.name);
    const to = path.join(isOutput ? dirs.frameOutputs : dirs.frameSources, entry.name);

    try {
      if (fs.existsSync(to)) continue; // 目标已存在就不动，交给用户自己处理
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved += 1;
    } catch {
      /* 单个目录搬不动（被占用/权限）就跳过，不影响其他项目 */
    }
  }
  if (moved > 0) {
    console.log(`[frames] 已把 ${moved} 个目录迁移到 sources/ 或 outputs/`);
  }
}

/** 用目录里现有的帧文件重建一份 meta（用户手滑删了 meta.json 时的兜底） */
function rebuildMeta(dir: string, folderName: string): FrameProjectMeta | null {
  let frameFiles: string[] = [];
  try {
    frameFiles = fs
      .readdirSync(dir)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
  } catch {
    return null;
  }
  if (frameFiles.length === 0) return null;

  // 从第一帧读尺寸（读不到就记 0，界面照常显示，只是没有尺寸标注）
  let width = 0;
  let height = 0;
  try {
    const first = nativeImage.createFromPath(path.join(dir, frameFiles[0]));
    if (!first.isEmpty()) {
      const size = first.getSize();
      width = size.width;
      height = size.height;
    }
  } catch {
    /* 尺寸只是展示用，读不到不影响 */
  }

  const meta: FrameProjectMeta = {
    id: folderName,
    name: folderName,
    sourceVideo: '',
    fps: 12,
    frameCount: frameFiles.length,
    width,
    height,
    createdAt: new Date().toISOString(),
    backgroundRemoved: false,
  };
  try {
    writeMeta(dir, meta);
  } catch {
    /* 写不进去（只读介质）也能正常展示，下次再试 */
  }
  return meta;
}

/** 从 dataURL 里取出二进制（只接受 PNG/JPEG） */
function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error(msg('err.frames.badData'));
  return Buffer.from(match[2].replace(/\s/g, ''), 'base64');
}

/** 把一批帧写成新项目；同名文件夹自动加后缀，绝不覆盖已有项目 */
export function saveFrameProject(input: SaveFrameProjectInput): FrameProjectView {
  const frames = Array.isArray(input.frames) ? input.frames : [];
  if (frames.length === 0) throw new Error(msg('err.frames.empty'));
  /* 一帧不构成动画：低于 2 帧没法播放、没法找循环点，直接拒绝。
     下划线开头的是内部临时集合（_preview），不受这条限制。 */
  const isInternal = String(input.name ?? '').startsWith('_');
  if (!isInternal && frames.length < 2) {
    throw new Error(msg('err.frames.tooFew'));
  }

  /* 直接写到最终位置 sources/ —— 之前这里用的是 frames 根目录，
     导致刚抽完的帧落在 frames/<id>，要等下次启动迁移才「看得见」。 */
  const root = getDataDirs().frameSources;
  const base = sanitizeFolderName(input.name || 'frames');
  const dir = path.join(root, base);

  if (isInternal) {
    /* 内部临时集合（_preview）：复用同一个目录，只清掉上一轮的帧。
       为什么不「先删目录再建」——Windows 上目录删除是延迟完成的，
       刚 rmSync 掉就 mkdir 同名目录会报 EPERM（删除挂起期间无法重建），
       抽帧一快就必现。复用目录既没有这个竞态，也省一次磁盘操作。 */
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(dir)) {
      if (!/^frame_\d+\.png$/i.test(entry) && entry !== 'meta.json') continue;
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {
        /* 文件被预览/播放器占着删不掉：同名帧后面会被覆盖写，留着不影响 */
      }
    }
  } else {
    // 同名一律报错交给用户改名，不再自动加 _2 —— 避免悄悄生成一堆 folder_2/3/4
    if (fs.existsSync(dir)) {
      throw new Error(msg('err.frames.nameExists', { name: base }));
    }
    fs.mkdirSync(dir, { recursive: true });
  }
  const id = base;

  frames.forEach((dataUrl, index) => {
    const buffer = decodeDataUrl(dataUrl);
    const fileName = `frame_${String(index).padStart(3, '0')}.png`;
    fs.writeFileSync(path.join(dir, fileName), buffer);
  });

  const meta: FrameProjectMeta = {
    id,
    name: id,
    sourceVideo: (input.sourceVideo || '').slice(0, 200),
    fps: Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 12,
    frameCount: frames.length,
    width: Math.max(1, Math.round(input.width || 1)),
    height: Math.max(1, Math.round(input.height || 1)),
    backgroundRemoved: Boolean(input.backgroundRemoved),
    createdAt: new Date().toISOString(),
  };
  writeMeta(dir, meta);
  return toView(meta);
}

/**
 * 重命名帧集合（改的是磁盘上的文件夹名）。
 *
 * 为什么必须在应用里改：直接去资源管理器把文件夹改名，文件夹里的 meta.json 还写着旧 id，
 * 下次启动界面就认不出这个集合（列表里会当成新建的空项目）。
 *
 * 重名一律报错、绝不覆盖 —— 否则会把已有的同名集合顶掉。
 */
export function renameFrameProject(id: string, nextName: string): FrameProjectView {
  const root = getDataDirs().frameSources;
  const from = path.join(root, sanitizeFolderName(id));
  if (!fs.existsSync(from)) throw new Error(msg('err.frames.setMissing', { id }));

  const raw = String(nextName ?? '').trim();
  if (!raw) throw new Error(msg('err.frames.emptyName'));
  const target = sanitizeFolderName(raw);

  if (target === path.basename(from)) {
    const same = readMeta(from);
    if (!same) throw new Error(msg('err.frames.noMeta'));
    return toView(same);
  }

  const to = path.join(root, target);
  if (fs.existsSync(to)) {
    throw new Error(msg('err.frames.nameExistsNoOverwrite', { name: target }));
  }

  fs.renameSync(from, to);

  // meta.json 里的 id / name 必须跟着改，否则 listFrameProjects 找不到它
  const meta = readMeta(to) ?? rebuildMeta(to, target);
  if (!meta) throw new Error(msg('err.frames.noFramesInSet'));
  const renamed: FrameProjectMeta = { ...meta, id: target, name: target };
  writeMeta(to, renamed);
  return toView(renamed);
}

/** 删除整个项目文件夹 */
export function removeFrameProject(id: string): void {
  const dir = projectDirOf(sanitizeFolderName(id));
  if (!dir.startsWith(getDataDirs().frames)) throw new Error(msg('err.frames.outsideDir'));
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 重命名抠图结果目录（outputs/<基名>-matte / -key）。
 *
 * 后缀是区分「模型抠图 / 传统抠图」的标记，改名时一律保留原后缀，
 * 用户只改前面的基名（就算他把 -matte 也写进去也会被剥掉再补回来）。
 * 重名直接报错、不覆盖。
 *
 * 返回改完之后的目录名（新 id）。
 */
export function renameFrameOutput(name: string, nextName: string): string {
  const dirs = getDataDirs();
  const match = /^(.*)-(matte|key)$/i.exec(String(name ?? '').trim());
  if (!match) throw new Error(msg('err.frames.notOutputDir'));

  const suffix = `-${match[2].toLowerCase()}`;
  const from = path.join(dirs.frameOutputs, path.basename(String(name).trim()));
  if (!fs.existsSync(from)) throw new Error(msg('err.frames.outputMissing', { name }));

  const raw = String(nextName ?? '').trim();
  if (!raw) throw new Error(msg('err.frames.emptyName'));
  // 用户可能把后缀一起写进来，先剥掉，最后统一补原后缀
  const base = raw.replace(/-(matte|key)$/i, '');
  const target = `${sanitizeFolderName(base)}${suffix}`;

  if (target === path.basename(from)) return target;

  const to = path.join(dirs.frameOutputs, target);
  if (fs.existsSync(to)) {
    throw new Error(msg('err.frames.nameExistsNoOverwrite', { name: target }));
  }

  fs.renameSync(from, to);
  return target;
}

/**
 * 用编辑器改完的 PNG 覆盖集合里的某一帧（原地替换，不新建文件）。
 *
 * 文件名和目录校验与删除一致 —— 避免渲染层传任意路径进来。
 */
export function writeFrameFile(id: string, fileName: string, pngBase64: string): void {
  const dir = projectDirOf(sanitizeFolderName(id));
  if (!dir.startsWith(getDataDirs().frames)) throw new Error(msg('err.frames.outsideDir'));
  if (!/^frame_\d+\.png$/i.test(fileName)) throw new Error(msg('err.frames.badFrameName', { name: fileName }));
  const target = path.join(dir, fileName);
  if (!target.startsWith(dir) || !fs.existsSync(target)) {
    throw new Error(msg('err.frames.badFramePath'));
  }

  const base64 = String(pngBase64 ?? '').replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw new Error(msg('err.frames.badData'));

  // 先写临时文件再改名：写到一半崩了也不会把原帧毁掉
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
}

/**
 * 删掉集合里的某一帧（按文件名）。
 * 用于「找循环帧」后手动剔掉多余/画崩的帧。删完同步 meta.json 的帧数。
 */
export function removeFrameFile(id: string, fileName: string): { frameCount: number } {
  const dir = projectDirOf(sanitizeFolderName(id));
  if (!dir.startsWith(getDataDirs().frames)) throw new Error(msg('err.frames.outsideDir'));
  // 只允许删 frame_*.png，防止路径穿越或被拿来删 meta.json
  if (!/^frame_\d+\.png$/i.test(fileName)) throw new Error(msg('err.frames.badFrameName', { name: fileName }));
  const target = path.join(dir, fileName);
  if (!target.startsWith(dir)) throw new Error(msg('err.frames.badFramePath'));
  if (fs.existsSync(target)) fs.unlinkSync(target);

  let frameCount = 0;
  try {
    frameCount = fs.readdirSync(dir).filter((name) => /^frame_\d+\.png$/i.test(name)).length;
  } catch {
    return { frameCount: 0 };
  }
  try {
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { frameCount?: number };
      meta.frameCount = frameCount;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
  } catch {
    /* meta 坏了不影响已经删掉的帧 */
  }
  return { frameCount };
}
