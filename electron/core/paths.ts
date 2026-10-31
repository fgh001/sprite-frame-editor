import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { DataDirs } from '../../shared/ipc';

let cachedDirs: DataDirs | null = null;

/**
 * 便携式数据根目录：
 * - 打包后：exe 同级的 data/（绿色便携，卸载/删除目录即彻底清理）
 * - 开发时：项目根目录下的 data/
 */
function resolveDataRoot(): string {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'data');
  }
  return path.join(app.getAppPath(), 'data');
}

const README = `精灵帧动画编辑器 数据目录
================================

本目录存放编辑器的全部数据，删除本目录即可彻底清理，不会在系统其他位置留下残留。

config/           配置文件（模型服务商、API Key 等）
knowledge/files/  素材库原始素材（导入的图片/视频副本）
knowledge/thumbs/ 素材库缩略图
projects/         各流程工程文件（图片 → 视频 → 帧动画）
cache/            可随时删除的缓存（视频抽帧、临时渲染结果）
logs/             运行日志
`;

function ensureReadme(root: string): void {
  const readmePath = path.join(root, 'README.txt');
  if (fs.existsSync(readmePath)) return;
  try {
    fs.writeFileSync(readmePath, README, 'utf8');
  } catch {
    /* 只读介质下忽略 */
  }
}

/** 获取（并首次创建）全部数据子目录 */
export function getDataDirs(): DataDirs {
  if (cachedDirs) return cachedDirs;

  const root = resolveDataRoot();
  const dirs: DataDirs = {
    root,
    config: path.join(root, 'config'),
    knowledge: path.join(root, 'knowledge'),
    knowledgeFiles: path.join(root, 'knowledge', 'files'),
    knowledgeThumbs: path.join(root, 'knowledge', 'thumbs'),
    knowledgeImages: path.join(root, 'knowledge', 'files', 'images'),
    knowledgeVideos: path.join(root, 'knowledge', 'files', 'videos'),
    knowledgeThumbImages: path.join(root, 'knowledge', 'thumbs', 'images'),
    knowledgeThumbVideos: path.join(root, 'knowledge', 'thumbs', 'videos'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
    projects: path.join(root, 'projects'),
    /** 帧动画根目录：下面再分 sources（抽帧集合）和 outputs（抠图结果）两层 */
    frames: path.join(root, 'frames'),
    /** 抽帧集合：data/frames/sources/<项目>/ */
    frameSources: path.join(root, 'frames', 'sources'),
    /** 抠图结果：data/frames/outputs/<项目>-matte/ */
    frameOutputs: path.join(root, 'frames', 'outputs'),
  };

  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ensureReadme(root);

  cachedDirs = dirs;
  return dirs;
}
