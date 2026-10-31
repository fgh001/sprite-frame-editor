import fs from 'node:fs';
import path from 'node:path';
import type { UsageStats, UsageModelStat } from '../../shared/ipc';
import { getDataDirs } from './paths';
import { listItems } from './knowledge';

/**
 * 内置单价表（元/张），用于本地估算花费。
 * 这不是服务商账单，只是让界面上有个大致数字；价格变了直接改这里。
 */
const IMAGE_UNIT_PRICE: Record<string, number> = {
  'doubao-seedream-5-0-pro-260628': 0.3,
  'doubao-seedream-4-5-251128': 0.25,
  'doubao-seedream-4-0-250828': 0.2,
  'doubao-seedream-3-0-t2i-250415': 0.2,
  'gpt-image-1': 0.3,
};

/** 统计数据源：素材库 index.json 里 source=ai-generated 的条目 + cache/generated 下的文件 */
export function computeUsage(): UsageStats {
  const dirs = getDataDirs();
  const items = listItems().filter((item) => item.source === 'ai-generated');

  const groups = new Map<string, number>();
  for (const item of items) {
    const model = item.origin?.model ?? 'unknown';
    groups.set(model, (groups.get(model) ?? 0) + 1);
  }

  const byModel: UsageModelStat[] = [...groups.entries()]
    .map(([model, count]) => {
      const unitPrice = IMAGE_UNIT_PRICE[model];
      return {
        model,
        count,
        unitPrice,
        estimatedCost: unitPrice === undefined ? undefined : Number((unitPrice * count).toFixed(2)),
      };
    })
    .sort((a, b) => b.count - a.count);

  let cachedFiles = 0;
  const cacheDir = path.join(dirs.cache, 'generated');
  try {
    cachedFiles = fs.readdirSync(cacheDir).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).length;
  } catch {
    cachedFiles = 0;
  }

  const pricedGroups = byModel.filter((group) => group.estimatedCost !== undefined);
  const allPriced = byModel.length > 0 && pricedGroups.length === byModel.length;
  const estimatedCost = allPriced
    ? Number(pricedGroups.reduce((sum, group) => sum + (group.estimatedCost ?? 0), 0).toFixed(2))
    : null;

  return {
    knowledgeImages: items.length,
    cachedFiles,
    totalImages: items.length + cachedFiles,
    byModel,
    estimatedCost,
    note: '本地统计：素材库登记数 + 缓存目录文件数，按内置单价估算，不等于服务商账单',
  };
}
