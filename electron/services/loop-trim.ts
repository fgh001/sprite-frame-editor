import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { msg } from '../core/msg';

/**
 * 对磁盘上的帧目录做「找循环点 + 裁掉多余尾部帧」。
 *
 * 算法要点（解决「找错点、中间跳帧」）：
 *
 *  ① **RGB 而不是纯灰度** —— 只看亮度时，动作不同但明暗分布相近的两帧会被误判成同一帧。
 *  ② **每帧先减去自身均值** —— 消除整体曝光/光晕差异，只比"相对结构"。
 *  ③ **多帧窗口比对（W=4）** —— 这是关键。单帧相似可能只是巧合；要求循环点之后的
 *     连续 4 帧都能和开头 4 帧对上，才说明是真正回到了同一段动作，不会跳。
 *  ④ **双向验证** —— 同时检查「循环点前一帧」和「序列尾帧」是否也吻合，
 *     保证 `尾帧 → 首帧` 的速度衔接正常。
 */

const SAMPLE = 32;
/** 窗口宽度：循环点之后连续比对多少帧 */
const WINDOW = 4;

function fingerprint(absPath: string): Float32Array | null {
  const image = nativeImage.createFromPath(absPath);
  if (image.isEmpty()) return null;
  // nativeImage.resize 自带高质量缩放，比手写采样准
  const small = image.resize({ width: SAMPLE, height: SAMPLE, quality: 'good' });
  const bitmap = small.toBitmap(); // BGRA
  const pixels = SAMPLE * SAMPLE;
  if (bitmap.length < pixels * 4) return null;

  // 保留 RGB 三通道：颜色是判断"同一姿态"的重要依据
  const out = new Float32Array(pixels * 3);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < pixels; i += 1) {
    const p = i * 4;
    const b = bitmap[p];
    const g = bitmap[p + 1];
    const r = bitmap[p + 2];
    out[i] = r;
    out[pixels + i] = g;
    out[pixels * 2 + i] = b;
    sumR += r;
    sumG += g;
    sumB += b;
  }

  // 减去自身均值：整体偏亮/偏暗不该影响相似度判断
  const meanR = sumR / pixels;
  const meanG = sumG / pixels;
  const meanB = sumB / pixels;
  for (let i = 0; i < pixels; i += 1) {
    out[i] -= meanR;
    out[pixels + i] -= meanG;
    out[pixels * 2 + i] -= meanB;
  }
  return out;
}

/** 两帧指纹的均方差（已去均值，所以直接比就等价于"结构差异"） */
function diffOf(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum / n;
}

export interface TrimLoopResult {
  /** 保留下来的帧数 */
  kept: number;
  /** 删掉的帧数 */
  removed: number;
  /** 循环点所在帧的序号（1-based） */
  loopFrame: number;
  /** 和首帧的差异（越小越像） */
  score: number;
  /** 一个完整循环有多少帧（最小周期） */
  cycleLength: number;
  /** 整段里总共装了几个循环 */
  cycles: number;
}

/**
 * 在 dir 里找循环点，把该点之后的帧删掉。
 *
 * @param dryRun 只算不删，用于前端先给用户看结果
 */
export function trimLoopInDirectory(
  dir: string,
  dryRun = false,
  /**
   * 搜索位置偏好 0–100：
   *   0   → 从第 2 帧就开始扫，循环点可能很靠前（短片段的循环）
   *   100 → 只在尾部 30% 里找，循环点会更靠后（长段落才回到起点）
   * 用户通过滑杆调这个值，值越大越偏向「循环更长」。
   */
  prefer = 0,
  /** 是否迭代缩小到「一个来回」的短循环（默认开） */
  shrink = true,
  /**
   * 保留几个循环：不传 = 全部保留（只裁掉不完整的尾巴）；
   * 传 1 就是「4 个循环缩成 1 个」。
   */
  keepCycles?: number,
): TrimLoopResult {
  if (!fs.existsSync(dir)) throw new Error(msg('err.frames.dirMissing', { dir }));

  const names = fs
    .readdirSync(dir)
    .filter((name) => /^frame_\d+\.png$/i.test(name))
    .sort();
  if (names.length < 3) throw new Error(msg('err.frames.tooFewLoop'));

  // 一次把所有帧读成指纹，避免后面反复解码同一帧（窗口比对要重复用到开头几帧）
  const prints: (Float32Array | null)[] = names.map((name) => fingerprint(path.join(dir, name)));
  if (!prints[0]) throw new Error(msg('err.frames.badFirstFrame'));

  // 把 0–100 的偏好换算成搜索起点：偏好越大，起点越靠后（最多到 70% 处）
  const ratio = Math.max(0, Math.min(100, prefer)) / 100;
  const searchFrom = Math.max(2, Math.floor(2 + (names.length - 3) * ratio * 0.7));

  /* 基准：正常相邻帧之间的平均差异。
     循环处如果只是"单帧像首帧"但前后速度不连续，跳变会明显大于这个基准 —— 用它做参照。 */
  let neighborSum = 0;
  let neighborCount = 0;
  for (let i = 1; i < names.length; i += 1) {
    const a = prints[i - 1];
    const b = prints[i];
    if (!a || !b) continue;
    neighborSum += diffOf(a, b);
    neighborCount += 1;
  }
  const neighborBaseline = neighborCount > 0 ? neighborSum / neighborCount : 0;

  /** 在 [from, to) 里找最佳循环点；返回 null 表示这一段没有可用帧 */
  const findBest = (from: number, to: number): { index: number; score: number } | null => {
    let best: { index: number; score: number } | null = null;
    for (let i = from; i < to; i += 1) {
      const head = prints[i];
      if (!head) continue;

      /* 多帧窗口：以 i 为循环点，往后连续 WINDOW 帧都应该和开头 1、2、3… 帧对上。
         只看单帧的话，一个偶然相似的姿态就会骗过算法 —— 这就是之前"中间跳帧"的来源。 */
      let windowSum = 0;
      let windowCount = 0;
      for (let k = 0; k < WINDOW && i + k < names.length; k += 1) {
        const frameAtLoop = prints[i + k];
        const frameAtStart = prints[k];
        if (!frameAtLoop || !frameAtStart) continue;
        windowSum += diffOf(frameAtLoop, frameAtStart);
        windowCount += 1;
      }
      if (windowCount === 0) continue;
      const windowScore = windowSum / windowCount;

      /* 衔接检查：循环点前一帧接回首帧的跳变，不该比普通相邻帧大太多。
         超了就罚分，避免选到"看着像但其实动作没走完"的位置。 */
      const prev = i > 0 ? prints[i - 1] : null;
      const jump = prev && prints[0] ? diffOf(prev, prints[0]) : 0;
      const jumpPenalty = Math.max(0, jump - neighborBaseline) * 0.5;

      const score = windowScore + jumpPenalty;
      if (!best || score < best.score) best = { index: i, score };
    }
    return best;
  };

  // 第一轮：在整个可搜索范围里找
  let best = findBest(searchFrom, names.length);
  if (!best) {
    // 兜底：至少保留全部帧
    best = { index: names.length - 1, score: Infinity };
  }
  let bestIndex = best.index;
  let bestScore = best.score;

  /* 迭代缩小：一段动画里常常装了不止一个来回（比如 18 帧其实是 2 个 9 帧的循环）。
     已经在尾部找到大循环后，再往前面找更短的循环点：
     只要分数不比当前差太多（1.4 倍以内），就收下更短的 —— 这样得到的是「一个来回」。
     会一直缩到不能再缩为止。 */
  if (shrink) {
    let improved = true;
    while (improved && bestIndex > 4) {
      improved = false;
      const shorter = findBest(searchFrom, bestIndex);
      if (!shorter) break;
      // 太短了就停（周期少于 4 帧的循环没意义）
      if (shorter.index < 4) break;
      if (shorter.score <= bestScore * 1.4 + 0.5) {
        bestIndex = shorter.index;
        bestScore = shorter.score;
        improved = true;
      }
    }
  }

  /* 周期长度就是 bestIndex 本身，不是 bestIndex + 1：
     bestIndex 是「和首帧最像的那一帧」的下标，它和第 0 帧是同一个状态，
     所以中间隔着的 0..bestIndex-1 这 bestIndex 帧才是一个完整循环。
     写成 +1 会让保留的帧多出一帧 —— 那一帧和首帧重复，循环播放时卡一下。 */
  const cycleLength = Math.max(3, bestIndex);
  const cycles = Math.max(1, Math.floor(names.length / cycleLength));
  // keepCycles 不传就全留；传了就只留前 N 个循环
  const wantCycles =
    keepCycles === undefined ? cycles : Math.max(1, Math.min(cycles, Math.floor(keepCycles)));
  const kept = Math.min(names.length, cycleLength * wantCycles);
  const removed = names.length - kept;
  const result: TrimLoopResult = {
    kept,
    removed,
    /* 循环点 = 一个周期之后的那一帧（1-based），与保留多少循环无关。
       比如周期 8 帧时，第 9 帧才回到起点。 */
    loopFrame: cycleLength + 1,
    score: bestScore,
    cycleLength,
    cycles,
  };

  if (dryRun || removed === 0) return result;

  // 删掉循环点之后的帧
  for (let i = kept; i < names.length; i += 1) {
    try {
      fs.unlinkSync(path.join(dir, names[i]));
    } catch {
      /* 单个删不掉就跳过 */
    }
  }

  // 同步更新 meta.json 里的帧数（找不到就忽略，界面会自己重扫）
  try {
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { frameCount?: number };
      meta.frameCount = kept;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
  } catch {
    /* meta 坏了不影响已删除的帧 */
  }

  return result;
}

/** 这个目录里有多少帧（用于判断按钮是否可用） */
export function countFrames(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => /^frame_\d+\.png$/i.test(name)).length;
  } catch {
    return 0;
  }
}
