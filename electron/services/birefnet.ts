import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeImage } from 'electron';
import * as ort from 'onnxruntime-node';
import type { AiMattingResult } from '../../shared/ipc';
import { getDataDirs } from '../core/paths';

/**
 * BiRefNet 抠图（rembg 同款模型，纯 ONNX 推理，不依赖 Python）。
 *
 * 参考官方实现（ZhengPeng7/BiRefNet、onnx-community/BiRefNet-ONNX、rembg）：
 *   - 输入 input_image: float32[1,3,S,S]，/255 + ImageNet 归一化
 *   - 输出 output_image: float32[1,1,S,S]，是 logits，必须自己 sigmoid
 *   - 官方文档明说「CPU 上推理可能会无限执行而无法完成」，1024 分辨率实测 165 秒
 *
 * 所以分辨率做成可调：512 比 1024 快约 4 倍，边缘精度略降但可用。
 * 权重优先 fp32 —— CPU 没有 fp16 算子，fp16 权重会反复 cast，反而更慢。
 */

/**
 * 可用抠图模型。全部是 ONNX、输出单通道 mask，预处理统一（stretch + ImageNet 归一化），
 * 差别只在输入边长与训练数据（动漫专用 / 通用 / 保主体）。
 */
export type MattingModelId = 'anime' | 'toonout' | 'lite' | 'ben2' | 'birefnet' | 'u2net' | 'isnet-general';

interface ModelSpec {
  id: MattingModelId;
  label: string;
  /** data/models/ 下的候选文件名 */
  files: string[];
  /** 模型固定的输入边长 */
  inputSize: number;
  /** 权重缺失时给用户的提示 */
  hint: string;
}

const MODELS: ModelSpec[] = [
  {
    // 官网 app.py 用的是 ZhengPeng7/BiRefNet 官方原版。
    // 注意精度：官方 MODEL_DTYPE 取模型原生精度（fp32），
    // fp16 版本虽然快一倍，但边缘判断会明显变糙 —— 所以 fp32 排第一。
    id: 'birefnet',
    label: 'BiRefNet 官方原版 · 官网同款（fp32 973MB，最准）',
    files: ['birefnet.onnx', 'birefnet-fp16.onnx'],
    inputSize: 1024,
    hint: 'birefnet.onnx ← https://hf-mirror.com/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx',
  },
  {
    // 实测（1024 合成图，白/紫/黑三种背景）：
    //   u2net   → 输出 0.00..1.00（已是概率），前景 22.1% / 21.9% / 22.1%，三种背景全部一致 ✓
    //   lite    → logits -21..20，sigmoid 后 22.2%，也稳定 ✓
    //   isnet-anime / isnet-general → 在紫底/黑底上输出接近 0，会把图整片抠没 ✗
    id: 'u2net',
    label: 'U2Net · 轻量备选（168MB，320 输入，很快）',
    files: ['u2net.onnx'],
    inputSize: 320,
    hint: 'u2net.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx（放到 data/models/，不用改名）',
  },
  {
    // 排第二：实测输出 logits(-21..20)，sigmoid 后分布正确，512 输入只要 1.6 秒。
    id: 'lite',
    label: 'BiRefNet_lite-512 · 备选（182MB，1.6 秒）',
    files: ['birefnet-lite-512.onnx'],
    inputSize: 512,
    hint: 'birefnet-lite-512.onnx ← https://hf-mirror.com/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx',
  },
  {
    id: 'toonout',
    label: 'ToonOut · 动漫立绘最强（469MB，慢）',
    files: ['birefnet-toonout.onnx'],
    inputSize: 1024,
    hint: 'birefnet-toonout.onnx ← https://hf-mirror.com/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout-fp16.onnx',
  },
  {
    id: 'anime',
    label: 'isnet-anime · 动漫专用（168MB，快）',
    files: ['isnet-anime.onnx', 'isnetis.onnx'],
    inputSize: 1024,
    hint: 'isnet-anime.onnx ← https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx',
  },
  {
    id: 'ben2',
    label: 'BEN2 · 主体保留最完整（208MB，需 CPU 支持 fp16，多数机器跑不了）',
    files: ['ben2.onnx'],
    inputSize: 1024,
    hint: 'ben2.onnx ← https://hf-mirror.com/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx',
  },
  {
    // rembg 的高质量通用模型
    // 实测：白底 21.1% 正常，但紫底 0.0%、黑底 0.0% —— 只适合白/浅色背景
    id: 'isnet-general',
    label: 'ISNet general-use · rembg 高质量（176MB）',
    files: ['isnet-general-use.onnx'],
    inputSize: 1024,
    hint: 'isnet-general-use.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx（放到 data/models/，不用改名）',
  },
];

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * 模型筛选顺序（默认取第一个能加载的）。
 * 实测（1024 合成图，白/紫/黑三种背景）：
 *   lite    → logits -21..20，sigmoid 后前景 22.2%，三种背景一致 ✓
 *   anime   → 输出 0.00..0.01（本身已是概率），前景 0.00%，会把图整片抠没 ✗
 * 所以 lite 排第一，anime 降级到后面备选。
 */

/** 会话按模型 id 缓存，切换模型时各自常驻 */
const sessions = new Map<MattingModelId, Promise<ort.InferenceSession>>();
const loadedPaths = new Map<MattingModelId, string>();

export function modelsDir(): string {
  const dir = path.join(getDataDirs().root, 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 找某个模型的实际文件；没有返回 null */
export function findModelFile(id: MattingModelId): string | null {
  const spec = MODELS.find((item) => item.id === id);
  if (!spec) return null;
  const dir = modelsDir();
  for (const name of spec.files) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs) && fs.statSync(abs).size > 10 * 1024 * 1024) return abs;
  }
  return null;
}

/** 列出所有模型的可用状态，界面用来渲染下拉 */
export function listMattingModels(): {
  id: MattingModelId;
  label: string;
  available: boolean;
  sizeMb: number;
  hint: string;
}[] {
  return MODELS.map((spec) => {
    const file = findModelFile(spec.id);
    return {
      id: spec.id,
      label: spec.label,
      available: Boolean(file),
      sizeMb: file ? Math.round(fs.statSync(file).size / 1024 / 1024) : 0,
      hint: spec.hint,
    };
  });
}

/** 默认模型：优先 ToonOut（动漫最强），其次 isnet-anime，最后 BiRefNet */
export function defaultMattingModel(): MattingModelId {
  for (const id of ['toonout', 'anime', 'lite', 'ben2', 'birefnet'] as MattingModelId[]) {
    if (findModelFile(id)) return id;
  }
  return 'birefnet';
}

/** 某一模型的可用状态（老接口，保留兼容） */
export function birefnetStatus(): {
  available: boolean;
  modelPath: string;
  sizeMb: number;
  variant: string;
} {
  const modelPath = findModelFile(defaultMattingModel());
  if (!modelPath) return { available: false, modelPath: '', sizeMb: 0, variant: '' };
  const sizeMb = Math.round(fs.statSync(modelPath).size / 1024 / 1024);
  const variant = path.basename(modelPath).includes('fp16') ? 'fp16' : 'fp32';
  return { available: true, modelPath, sizeMb, variant };
}

/** 懒加载会话：第一次读权重较慢，之后按模型常驻复用 */
async function getSession(id: MattingModelId): Promise<ort.InferenceSession> {
  const modelPath = findModelFile(id);
  if (!modelPath) {
    const spec = MODELS.find((item) => item.id === id);
    throw new Error(
      `没有找到 ${id} 模型。请把权重放到：\n${modelsDir()}\n下载地址：${spec?.hint ?? ''}`,
    );
  }
  const cached = sessions.get(id);
  if (cached && loadedPaths.get(id) === modelPath) return cached;

  loadedPaths.set(id, modelPath);
  const created = ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, Math.min(8, os.cpus().length - 1)),
  });
  sessions.set(id, created);
  return created;
}

interface PreprocessResult {
  data: Float32Array;
  width: number;
  height: number;
  size: number;
  padX: number;
  padY: number;
  scaledW: number;
  scaledH: number;
}

/**
 * 位图 → NCHW float32 张量。
 *
 * 用**直接拉伸**（stretch，X/Y 各用独立比例）而不是 letterbox：
 *   - isnet-anime（skytnt/anime-seg）训练时是 `img.resize((1024,1024))`
 *   - BiRefNet 训练时是 `transforms.Resize((1024,1024))`（default_to_square）
 * 两个模型看到的都是被拉伸的图。喂带灰边的 letterbox 属于分布外输入，
 * 长图（如 1584×2816）灰边会占到 40% 以上，模型会把灰边当背景，主体判断直接乱掉。
 */
function toInputTensor(pngBuffer: Buffer, size: number): PreprocessResult {
  const image = nativeImage.createFromBuffer(pngBuffer);
  if (image.isEmpty()) throw new Error('图片解码失败');
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  if (bitmap.length < width * height * 4) throw new Error('位图数据不完整');

  const plane = size * size;
  const data = new Float32Array(3 * plane);
  const at = (x: number, y: number, channel: number): number => bitmap[(y * width + x) * 4 + channel];

  for (let y = 0; y < size; y += 1) {
    const sy = ((y + 0.5) * height) / size - 0.5;
    const sy0 = Math.min(height - 1, Math.max(0, Math.floor(sy)));
    const sy1 = Math.min(height - 1, sy0 + 1);
    const fy = Math.min(1, Math.max(0, sy - sy0));

    for (let x = 0; x < size; x += 1) {
      const sx = ((x + 0.5) * width) / size - 0.5;
      const sx0 = Math.min(width - 1, Math.max(0, Math.floor(sx)));
      const sx1 = Math.min(width - 1, sx0 + 1);
      const fx = Math.min(1, Math.max(0, sx - sx0));

      const index = y * size + x;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = at(sx0, sy0, channel) * (1 - fx) + at(sx1, sy0, channel) * fx;
        const bottom = at(sx0, sy1, channel) * (1 - fx) + at(sx1, sy1, channel) * fx;
        const value = (top * (1 - fy) + bottom * fy) / 255;
        // 位图是 BGRA：channel 0=B, 1=G, 2=R；张量按 RGB 排列
        const rgbIndex = channel === 0 ? 2 : channel === 1 ? 1 : 0;
        data[rgbIndex * plane + index] = (value - MEAN[rgbIndex]) / STD[rgbIndex];
      }
    }
  }

  // stretch 后 mask 与画布一一对应，padding 恒为 0
  return { data, width, height, size, padX: 0, padY: 0, scaledW: size, scaledH: size };
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/**
 * IEEE 754 半精度(float16) → 单精度(float32)。
 * fp16 导出的 ONNX 模型输出类型是 float16，onnxruntime 给的是 Uint16 视图，
 * 直接当 Float32Array 读会得到全 0 —— 这就是「模型把图抠没」的真凶之一。
 */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024); // 非规格化数
  if (exp === 0x1f) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

export interface BirefnetOptions {
  /** 前景阈值 0.1–0.9，越低保留越多 */
  threshold?: number;
  /** 边缘羽化遍数 0–4 */
  feather?: number;
  /** 用哪个模型，默认动漫专用（缺失时退化到 BiRefNet） */
  model?: MattingModelId;
}

/**
 * AI 去背景：返回带 alpha 的 PNG dataURL。
 * 边缘额外做「反合成」—— 用背景色把混进边缘的背景色减掉（消除紫边/绿边）。
 */
export async function removeBackgroundBirefnet(
  absPath: string,
  options: BirefnetOptions = {},
): Promise<AiMattingResult> {
  const startedAt = Date.now();
  const buffer = fs.readFileSync(absPath);
  if (buffer.length === 0) throw new Error('图片为空');

  const modelId: MattingModelId = MODELS.some((spec) => spec.id === options.model)
    ? (options.model as MattingModelId)
    : defaultMattingModel();
  // 每个模型有自己固定的输入边长（lite-512 是 512，其余 1024）
  const spec = MODELS.find((item) => item.id === modelId);
  const size = spec?.inputSize ?? 1024;

  const session = await getSession(modelId);
  const { data, width, height, padX, padY, scaledW, scaledH } = toInputTensor(buffer, size);

  const feeds: Record<string, ort.Tensor> = {};
  const inputName = session.inputNames[0] ?? 'input_image';
  feeds[inputName] = new ort.Tensor('float32', data, [1, 3, size, size]);

  const inferStart = Date.now();
  const results = await session.run(feeds);
  const inferMs = Date.now() - inferStart;

  /* 取哪个输出？官网 app.py 是：
       preds = birefnet(input_images)[-1].sigmoid()
     即「最后一个」= 最终融合输出。ONNX 里它叫 output_image；
     而 outputNames[0] 可能是个中间层（尺寸/通道都不对），用它抠出来会乱。
     所以优先按名字找 output_image，找不到才退回最后一个。 */
  const names = session.outputNames;
  const outputName = names.includes('output_image')
    ? 'output_image'
    : (names[names.length - 1] ?? 'output_image');
  const tensor = results[outputName];
  if (!tensor) throw new Error('模型没有输出');

  console.log(
    `[matting] 可选输出 [${names.join(', ')}] → 采用 ${outputName} type=${tensor.type} dims=${JSON.stringify(tensor.dims)}`,
  );

  // 关键：fp16 模型的输出类型是 float16，用 `as Float32Array` 强转会把
  // 2 个字节当一个 float32 读 → 得到一堆 0 / 垃圾值 → 最终 alpha 全是 0（图被抠没）。
  // 必须先按真实类型转换。
  let logits: Float32Array;
  if (tensor.type === 'float32') {
    logits = tensor.data as Float32Array;
  } else if (tensor.type === 'float16') {
    // onnxruntime 对 float16 输出给的是 Uint8 视图，先按字节重解释成 uint16 再转 float
    const bytes = tensor.data as unknown as Uint8Array;
    const count = Math.floor(bytes.length / 2);
    logits = new Float32Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i += 1) {
      logits[i] = halfToFloat(view.getUint16(i * 2, true));
    }
  } else {
    // 其它类型（int64 等）按普通数值读，避免崩溃
    logits = Float32Array.from(tensor.data as ArrayLike<number>);
  }

  const threshold = Math.min(0.99, Math.max(0, options.threshold ?? 0.02));
  // 羽化默认 0：官网 app.py 从不做模糊，直接 putalpha(mask)。
  // 之前默认 1 是「3×3 均值模糊一遍」，边角会被糊掉一层，看起来就不如官网锐利。
  const feather = Math.min(4, Math.max(0, options.feather ?? 0));

  // 不同来源的 ONNX 导出不一致：有的输出原始 logits（约 -30..21），
  // 有的已内置 sigmoid（0..1）。无条件再 sigmoid 会把后者的结果压成「全前景」
  // —— isnet-anime / ToonOut 就是这么被搞坏的（100% 不透明）。
  // 先看值域：全在 [0,1] 内就直接当概率用。
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (let i = 0; i < logits.length; i += 1) {
    if (logits[i] < rawMin) rawMin = logits[i];
    if (logits[i] > rawMax) rawMax = logits[i];
  }
  const alreadyProbability = rawMin >= -0.001 && rawMax <= 1.001;
  console.log(
    `[matting] ${modelId} ${size}px 输出 ${rawMin.toFixed(2)}..${rawMax.toFixed(2)} → ${alreadyProbability ? '内置 sigmoid' : '自己 sigmoid'}`,
  );

  let mask = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = alreadyProbability ? logits[i] : sigmoid(logits[i]);
  }

  /* 注意：这里刻意不做值域拉伸。
     官网 app.py 就是 preds[-1].sigmoid() 之后直接当 alpha 用，没有 min-max。
     rembg 的 (pred-min)/(max-min) 是它自己的选择，但对 BiRefNet 来说多余 ——
     BiRefNet 的 logits 本来就能到 -32..23，sigmoid 之后分布已经很完整，
     再拉一次反而会把噪点放大成半透明脏边。 */

  // 兜底诊断：统计一下模型到底认出了多少前景。
  // 有些图（纯白/纯紫背景、或已经抠过的透明 PNG）会让模型输出「全背景」，
  // 直接返回就是一张空图 —— 与其给用户空图，不如显式报错说明原因。
  {
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < mask.length; i += 1) {
      sum += mask[i];
      if (mask[i] > 0.5) bright += 1;
    }
    const meanAlpha = sum / mask.length;
    const foregroundRatio = bright / mask.length;
    console.log(
      `[matting] 平均 alpha ${meanAlpha.toFixed(3)} · 前景占比 ${(foregroundRatio * 100).toFixed(1)}%`,
    );

    if (foregroundRatio < 0.005) {
      throw new Error(
        `模型没认出主体（前景占比仅 ${(foregroundRatio * 100).toFixed(2)}%），结果会是一张全透明的空图。` +
          '常见原因：① 背景是纯白/纯色，当前模型对它不敏感 —— 换「isnet-anime」或「ToonOut」再试；' +
          '② 这张图本身已经是抠好的透明 PNG；③ 主体在画面里太小。',
      );
    }
  }

  // 羽化：3×3 均值模糊若干遍，消除硬二值的锯齿
  for (let pass = 0; pass < feather; pass += 1) {
    const next = new Float32Array(mask.length);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= size) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= size) continue;
            sum += mask[ny * size + nx];
            count += 1;
          }
        }
        next[y * size + x] = sum / count;
      }
    }
    mask = next;
  }

  const source = nativeImage.createFromBuffer(buffer);
  const srcBitmap = source.toBitmap(); // BGRA
  const out = Buffer.from(srcBitmap);

  // 四角平均色当背景色，用于边缘反合成
  let bgB = 0;
  let bgG = 0;
  let bgR = 0;
  let bgCount = 0;
  const patch = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) / 20)));
  const corners: [number, number][] = [
    [0, 0],
    [Math.max(0, width - patch), 0],
    [0, Math.max(0, height - patch)],
    [Math.max(0, width - patch), Math.max(0, height - patch)],
  ];
  for (const [cx, cy] of corners) {
    for (let yy = cy; yy < Math.min(height, cy + patch); yy += 1) {
      for (let xx = cx; xx < Math.min(width, cx + patch); xx += 1) {
        const offset = (yy * width + xx) * 4;
        bgB += srcBitmap[offset];
        bgG += srcBitmap[offset + 1];
        bgR += srcBitmap[offset + 2];
        bgCount += 1;
      }
    }
  }
  if (bgCount > 0) {
    bgB /= bgCount;
    bgG /= bgCount;
    bgR /= bgCount;
  }

  const clamp255 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

  /** 原图分辨率的 alpha 图，第二遍做颜色净化时要用邻居判断是否在边缘 */
  const alphaMap = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 原图坐标 → mask 坐标（只在 letterbox 有效区内采样，灰边不参与）
      const mx = padX + ((x + 0.5) * scaledW) / Math.max(1, width) - 0.5;
      const my = padY + ((y + 0.5) * scaledH) / Math.max(1, height) - 0.5;
      const x0 = Math.min(size - 1, Math.max(0, Math.floor(mx)));
      const y0 = Math.min(size - 1, Math.max(0, Math.floor(my)));
      const x1 = Math.min(size - 1, x0 + 1);
      const y1 = Math.min(size - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, mx - x0));
      const fy = Math.min(1, Math.max(0, my - y0));

      const value =
        mask[y0 * size + x0] * (1 - fx) * (1 - fy) +
        mask[y0 * size + x1] * fx * (1 - fy) +
        mask[y1 * size + x0] * (1 - fx) * fy +
        mask[y1 * size + x1] * fx * fy;

      // 阈值 + 软边过渡带
      let alpha = value;
      if (value < threshold) alpha = 0;
      else if (value < threshold + 0.15) alpha = ((value - threshold) / 0.15) * value;

      const offset = (y * width + x) * 4;
      out[offset + 3] = clamp255(alpha * 255);
      alphaMap[y * width + x] = alpha;
    }
  }

  // 第二遍：颜色净化（Color Decontamination）。
  // 模型只给 alpha，边缘像素的 RGB 里仍混着背景紫色，必须显式处理。分两种情况：
  //   ① 半透明像素（alpha < 0.995）→ 反合成，数学上精确减掉背景成分
  //   ② 不透明但紧贴透明区的前景像素（alpha = 1）→ 洋红/紫背景 despill
  // 之前只做 ①，而模型输出几乎是硬二值（半透明像素只占 0.4%），所以紫边几乎没被处理。
  const DESPILL_RADIUS = 2;
  const isMagentaBg = bgR > 100 && bgB > 100 && bgG < bgR * 0.75 && bgG < bgB * 0.75;
  let despilledCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const alpha = alphaMap[index];
      if (alpha < 0.02) continue;
      const offset = index * 4;

      if (alpha < 0.995) {
        // ① 反合成：pixel = fg*a + bg*(1-a) → fg = (pixel - bg*(1-a)) / a
        const inv = 1 - alpha;
        out[offset] = clamp255((srcBitmap[offset] - bgB * inv) / alpha);
        out[offset + 1] = clamp255((srcBitmap[offset + 1] - bgG * inv) / alpha);
        out[offset + 2] = clamp255((srcBitmap[offset + 2] - bgR * inv) / alpha);
        continue;
      }

      // ② 判断是否紧贴透明区（距背景 DESPILL_RADIUS 像素内）
      let nearEdge = false;
      for (let dy = -DESPILL_RADIUS; dy <= DESPILL_RADIUS && !nearEdge; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -DESPILL_RADIUS; dx <= DESPILL_RADIUS; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (alphaMap[ny * width + nx] < 0.5) {
            nearEdge = true;
            break;
          }
        }
      }
      if (!nearEdge) continue;

      // 洋红/紫背景：G 通道被压低，把 G 提回到 min(R,B) 就能中和掉紫色
      if (isMagentaBg) {
        const r = out[offset + 2];
        const g = out[offset + 1];
        const b = out[offset];
        const target = Math.min(r, b);
        if (g < target) {
          out[offset + 1] = clamp255(target);
          despilledCount += 1;
        }
      } else {
        // 通用情况：把这个像素里超出非背景通道的部分压回去（简单 despill）
        const bgMax = Math.max(bgB, bgG, bgR);
        if (bgMax > 0) {
          const dominance = Math.max(out[offset], out[offset + 1], out[offset + 2]) - Math.min(out[offset], out[offset + 1], out[offset + 2]);
          if (dominance > 40) {
            const excess = Math.round(Math.min(dominance, bgMax) * 0.5);
            if (bgB >= bgMax) out[offset] = clamp255(out[offset] - excess);
            if (bgG >= bgMax) out[offset + 1] = clamp255(out[offset + 1] - excess);
            if (bgR >= bgMax) out[offset + 2] = clamp255(out[offset + 2] - excess);
            despilledCount += 1;
          }
        }
      }
    }
  }

  console.log(
    `[birefnet] ${size}px 推理 ${inferMs}ms，总计 ${Date.now() - startedAt}ms，边缘净化 ${despilledCount} 像素（背景色 rgb(${bgR.toFixed(0)},${bgG.toFixed(0)},${bgB.toFixed(0)}）${isMagentaBg ? '洋红模式' : '通用模式'}）`,
  );

  const outImage = nativeImage.createFromBitmap(out, { width, height });
  const png = outImage.toPNG();
  if (png.length === 0) throw new Error('抠图结果为空');

  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width,
    height,
    bytes: png.length,
    elapsedMs: Date.now() - startedAt,
  };
}
