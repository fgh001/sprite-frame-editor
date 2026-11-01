import { getLang, t } from '../i18n';

/**
 * 全局任务状态（极简 store）。
 *
 * 为什么需要：生图 / 生成视频 / 批量抠图都是长任务，用户可能切到别的页面继续干活。
 * 侧边栏要显示「哪个页面的任务还在跑」，但侧边栏和那些页面是兄弟组件，
 * 没有共同的 Context 层 —— 用一个模块级的小 store + 订阅就够了，不用引状态库。
 */

export type BusyKey = 'image-studio' | 'video-studio' | 'matte-studio';

const running = new Set<BusyKey>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 标记某页面的长任务开始（on=true）或结束（on=false） */
export function setBusy(key: BusyKey, on: boolean): void {
  const had = running.has(key);
  if (on && !had) {
    running.add(key);
    emit();
  } else if (!on && had) {
    running.delete(key);
    emit();
  }
}

/** 某个页面是否有任务在跑 */
export function isBusy(key: BusyKey): boolean {
  return running.has(key);
}

/** 订阅变化，返回取消订阅函数 */
export function subscribeBusy(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 当前所有在跑的任务（给侧边栏做一次性快照用） */
export function busySnapshot(): BusyKey[] {
  return Array.from(running);
}

/* ---------- 进度上报（只有批量抠图有明确总数，其他留空） ---------- */

const progress = new Map<BusyKey, { done: number; total: number }>();

/** 更新某个任务的进度，侧边栏会显示百分比 */
export function setProgress(key: BusyKey, done: number, total: number): void {
  if (!running.has(key)) return;
  progress.set(key, { done, total });
  emit();
}

/** 取某个任务的进度快照（0–100，没有就返回 null） */
export function progressSnapshot(key: BusyKey): number | null {
  const item = progress.get(key);
  if (!item || item.total <= 0) return null;
  return Math.min(100, Math.round((item.done / item.total) * 100));
}

/** 侧边栏一次性拿全部：key → 百分比（没进度就是 null） */
export function allProgress(): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of running) out[key] = progressSnapshot(key);
  return out;
}

/**
 * 任务之间的资源冲突规则。
 *
 * 为什么这么定：
 *   - 生图和生视频都走豆包同一个 API Key，并发容易撞限流
 *   - 批量抠图是 rembg 多进程 CPU 密集，和生图/生视频同跑会互相拖慢
 *   - 同类型之间靠按钮 disabled 挡住，不用在这里管
 */
const CONFLICT: Record<BusyKey, { key: BusyKey; labelKey: string; reasonKey: string }[]> = {
  'image-studio': [
    { key: 'video-studio', labelKey: 'busy.label.videoStudio', reasonKey: 'busy.reason.key' },
    { key: 'matte-studio', labelKey: 'busy.label.matteStudio', reasonKey: 'busy.reason.matteCpu' },
  ],
  'video-studio': [
    { key: 'image-studio', labelKey: 'busy.label.imageStudio', reasonKey: 'busy.reason.key' },
    { key: 'matte-studio', labelKey: 'busy.label.matteStudio', reasonKey: 'busy.reason.matteCpu' },
  ],
  'matte-studio': [
    { key: 'image-studio', labelKey: 'busy.label.imageStudio', reasonKey: 'busy.reason.matteImage' },
    { key: 'video-studio', labelKey: 'busy.label.videoStudio', reasonKey: 'busy.reason.matteVideo' },
  ],
};

/**
 * 尝试开始一个长任务。
 * 如果和正在跑的任务资源冲突，先弹窗问用户；用户点取消就返回 false。
 *
 * @param label 当前任务的显示名，用在弹窗里
 */
export function tryStart(key: BusyKey, label: string): boolean {
  const clashes = CONFLICT[key].filter((item) => running.has(item.key));
  if (clashes.length > 0) {
    const lang = getLang();
    const detail = clashes
      .map((item) =>
        t('busy.confirm.detail', lang, { label: t(item.labelKey, lang), reason: t(item.reasonKey, lang) }),
      )
      .join('\n');
    const ok = window.confirm(t('busy.confirm.body', lang, { detail, label }));
    if (!ok) return false;
  }
  setBusy(key, true);
  return true;
}
