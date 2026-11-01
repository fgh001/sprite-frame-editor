import fs from 'node:fs';
import path from 'node:path';
import type { UsageStats, UsageModelStat } from '../../shared/ipc';
import { getDataDirs } from './paths';
import { listItems } from './knowledge';
import { msg } from './msg';

/**
 * 统计数据源：素材库里所有图片 + cache/generated 下的文件。
 *
 * 注意：没有索引了，无法区分「AI 生成」和「手动导入」，也无法按模型分组，
 * 所以只统计张数，单价/估算花费给不出（byModel 为空、estimatedCost 为 null）。
 */
export function computeUsage(): UsageStats {
  const dirs = getDataDirs();
  const items = listItems().filter((item) => item.kind === 'image');

  // 没有模型信息可分，统一记成一个 unknown 组，只报张数
  const byModel: UsageModelStat[] =
    items.length > 0
      ? [{ model: 'unknown', count: items.length, unitPrice: undefined, estimatedCost: undefined }]
      : [];
  const estimatedCost: number | null = null;

  let cachedFiles = 0;
  const cacheDir = path.join(dirs.cache, 'generated');
  try {
    cachedFiles = fs.readdirSync(cacheDir).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).length;
  } catch {
    cachedFiles = 0;
  }

  return {
    knowledgeImages: items.length,
    cachedFiles,
    totalImages: items.length + cachedFiles,
    byModel,
    estimatedCost,
    note: msg('app.usage.note'),
  };
}
