import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditableImage, GeneratedImage } from '@shared/ipc';
import { FEATURE_AI_MATTING } from '@shared/features';
import { t, useLang } from '../i18n';

interface ImageEditorModalProps {
  image: EditableImage;
  onClose: () => void;
  onSaved: (saved: GeneratedImage) => void;
  /**
   * 只要结果、不落盘（用于编辑内存里的帧动画）。
   * 提供后「应用并存入素材库」按钮会变成「应用到帧」，不会写任何文件。
   */
  onApply?: (pngDataUrl: string) => void;
  /**
   * 把当前编辑器的去背景设置套用到全部帧（帧动画用）。
   * 提供后编辑器底部会出现「应用这些设置到全部帧」按钮。
   */
  onApplyAll?: (params: EditorKeyParams) => void;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * 油漆桶填充（原地修改 ImageData）。
 *   mode='connected' → 从点击处做 4 邻域洪水填充，只填连通的一片
 *   mode='global'    → 全图扫描，与点击色相近的像素全部填
 * 判定用的是「点击处的原始颜色」，每个像素只处理一次，不会因为刚填的颜色而扩散失控。
 */
function applyFill(
  image: ImageData,
  startX: number,
  startY: number,
  color: Rgb,
  alpha: number,
  mode: 'connected' | 'global',
  tolerance: number,
): void {
  const { width, height, data } = image;
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;

  const startIndex = (startY * width + startX) * 4;
  const targetR = data[startIndex];
  const targetG = data[startIndex + 1];
  const targetB = data[startIndex + 2];
  const limit = tolerance * tolerance * 3;

  const matches = (i: number): boolean => {
    const dr = data[i] - targetR;
    const dg = data[i + 1] - targetG;
    const db = data[i + 2] - targetB;
    return dr * dr + dg * dg + db * db <= limit;
  };

  const paint = (i: number): void => {
    if (alpha >= 255) {
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = 255;
      return;
    }
    const a = alpha / 255;
    data[i] = Math.round(data[i] * (1 - a) + color.r * a);
    data[i + 1] = Math.round(data[i + 1] * (1 - a) + color.g * a);
    data[i + 2] = Math.round(data[i + 2] * (1 - a) + color.b * a);
    data[i + 3] = Math.max(data[i + 3], alpha);
  };

  if (mode === 'global') {
    for (let i = 0; i < data.length; i += 4) {
      if (matches(i)) paint(i);
    }
    return;
  }

  // 连通模式：显式栈 BFS，避免大图递归爆栈
  const visited = new Uint8Array(width * height);
  const stack: number[] = [startY * width + startX];
  visited[startY * width + startX] = 1;

  while (stack.length > 0) {
    const point = stack.pop() as number;
    const index = point * 4;
    if (!matches(index)) continue;
    paint(index);

    const x = point % width;
    const y = (point - x) / width;
    const push = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const next = ny * width + nx;
      if (visited[next]) return;
      visited[next] = 1;
      stack.push(next);
    };
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
}

/** 编辑器里「去背景相关」的可复用参数：用于一键套用到全部帧 */
export interface EditorKeyParams {
  colors: Rgb[];
  removeMode: 'global' | 'connected';
  tolerance: number;
  edgeTrim: number;
  despill: number;
  brightness: number;
}

const MIN_ZOOM = 0.1;
/** 像素级抠图需要看清单个像素，所以放到 32 倍 */
const MAX_ZOOM = 32;
/** 到这个倍率才画像素网格，低倍率画了会糊成一片 */
const GRID_MIN_ZOOM = 4;
/** 放大观察窗取样范围（16×16 像素） */
const SAMPLE_SIZE = 16;

/** 取四角小块的平均色，作为「要去除的颜色」初值 */
function detectBackground(data: ImageData): Rgb {
  const { width, height, data: px } = data;
  const patch = 6;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  const corners: [number, number][] = [
    [0, 0],
    [width - patch, 0],
    [0, height - patch],
    [width - patch, height - patch],
  ];

  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + patch && y < height; y += 1) {
      for (let x = cx; x < cx + patch && x < width; x += 1) {
        if (x < 0 || y < 0) continue;
        const i = (y * width + x) * 4;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
        count += 1;
      }
    }
  }

  if (count === 0) return { r: 255, g: 255, b: 255 };
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / delta + 2) * 60;
  else h = ((rn - gn) / delta + 4) * 60;

  return { h, s, l };
}

/**
 * 人眼感知接近度的近似：
 * 色相（hue）占主导，饱和度次之，亮度几乎不参与 —— 这样「深紫 vs 亮洋红」算同色，
 * 而「浅灰 vs 洋红」算不同色，避免 RGB 欧氏距离把角色浅色部位一起删掉。
 * 返回值量级 0–400，与容差 0–100 的映射保持同一尺度。
 */
function hslDistance(a: Hsl, b: Hsl): number {
  let dh = Math.abs(a.h - b.h);
  if (dh > 180) dh = 360 - dh;
  // 颜色越灰，色相越不可靠，权重按两者饱和度的较小值衰减
  const hueWeight = Math.min(a.s, b.s);
  const dhTerm = (dh / 180) * 360 * hueWeight;
  const dsTerm = Math.abs(a.s - b.s) * 140;
  const dlTerm = Math.abs(a.l - b.l) * 120;
  return Math.sqrt(dhTerm * dhTerm + dsTerm * dsTerm + dlTerm * dlTerm);
}

export function ImageEditorModal({
  image,
  onClose,
  onSaved,
  onApply,
  onApplyAll,
}: ImageEditorModalProps): React.JSX.Element {
  const [lang] = useLang();
  const sourceRef = useRef<ImageData | null>(null);
  /** 源图逐像素 HSL 缓存（图片加载时算一次，滑杆拖动时复用） */
  const hslRef = useRef<{ h: Float32Array; s: Float32Array; l: Float32Array; width: number; height: number } | null>(
    null,
  );
  const stageRef = useRef<HTMLDivElement | null>(null);

  // 视图状态：zoom + 平移量（用 ref 镜像一份，避免滚轮/拖拽时闭包取到旧值）
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  // 放大观察窗（放大镜）：鼠标所在像素的 16×16 邻域，像素级放大显示
  const [magnifier, setMagnifier] = useState<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 要去除的颜色列表：打开时自动取背景色作为第 1 个
  const [colors, setColors] = useState<Rgb[]>([{ r: 255, g: 255, b: 255 }]);
  // 魔棒点选：点图片哪里，就删掉与那里连通的一片（不受其他颜色干扰）
  const [marks, setMarks] = useState<{ x: number; y: number }[]>([]);
  // 默认不启用任何去背景：打开编辑器先看到原图，由用户自己选 AI 还是颜色抠图
  const [removeBg, setRemoveBg] = useState(false);
  // global = 全局（夹缝里的背景也能去掉，但会挖掉角色内部的同色部位）
  // connected = 仅连通背景（从四边泛洪，保护被主体包围的同色区域）
  // 默认用 connected：紫背景 + 紫发/紫衣的场景下，global 会把角色挖空，
  // 看起来就像「头发和手臂被吃掉一块」。
  const [removeMode, setRemoveMode] = useState<'global' | 'connected'>('connected');
  // 容差 × 7 = RGB 距离阈值（0–441）。20 约等于距离 140：
  // 足以删掉背景的浅紫（约 128），又保住角色身上的紫（约 164）。
  const [tolerance, setTolerance] = useState(20);
  /** 边缘去除：对不透明像素做 N 次收缩，消掉抗锯齿白边 */
  const [edgeTrim, setEdgeTrim] = useState(1);
  /**
   * 去溢色已从界面移除（实测对紫边无效，反而让边缘发灰）。
   * 固定为 0 = 不做颜色反推，保留原始颜色，不再引入副作用。
   */
  const [despill] = useState(0);
  const [brightness, setBrightness] = useState(100);

  /* ---------------- 撤销 / 重做（Ctrl+Z / Ctrl+Y） ---------------- */
  interface EditorState {
    colors: Rgb[];
    marks: { x: number; y: number }[];
    removeBg: boolean;
    removeMode: 'global' | 'connected';
    tolerance: number;
    edgeTrim: number;
    despill: number;
    brightness: number;
    manualMask: Uint8Array | null;
  }
  const undoStackRef = useRef<EditorState[]>([]);
  const redoStackRef = useRef<EditorState[]>([]);
  // 用计数触发重渲染，让撤销/重做按钮的 disabled 状态跟着变
  const [, setHistoryTick] = useState(0);
  const skipHistoryRef = useRef(false);

  const captureState = (): EditorState => ({
    colors: colors.map((color) => ({ ...color })),
    marks: marks.map((mark) => ({ ...mark })),
    removeBg,
    removeMode,
    tolerance,
    edgeTrim,
    despill,
    brightness,
    manualMask: manualMaskRef.current ? new Uint8Array(manualMaskRef.current) : null,
  });

  /** 在「会改变结果」的动作前调用，把当前状态压进撤销栈 */
  const pushHistory = (): void => {
    if (skipHistoryRef.current) return;
    undoStackRef.current.push(captureState());
    if (undoStackRef.current.length > 60) undoStackRef.current.shift();
    redoStackRef.current = [];
    setHistoryTick((tick) => tick + 1);
  };

  const restoreState = (state: EditorState): void => {
    skipHistoryRef.current = true;
    setColors(state.colors);
    setMarks(state.marks);
    setRemoveBg(state.removeBg);
    setRemoveMode(state.removeMode);
    setTolerance(state.tolerance);
    setEdgeTrim(state.edgeTrim);
    setBrightness(state.brightness);
    manualMaskRef.current = state.manualMask ? new Uint8Array(state.manualMask) : manualMaskRef.current;
    setHasManual(Boolean(state.manualMask?.some((value) => value === 1)));
    skipHistoryRef.current = false;
    setHistoryTick((tick) => tick + 1);
  };

  const undo = useCallback((): void => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(captureState());
    restoreState(previous);
  }, [colors, marks, removeBg, removeMode, tolerance, edgeTrim, despill, brightness]);

  const redo = useCallback((): void => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(captureState());
    restoreState(next);
  }, [colors, marks, removeBg, removeMode, tolerance, edgeTrim, despill, brightness]);

  // 手动橡皮擦：直接在画布上涂抹擦除（与「选颜色删除」是两条独立通道）
  const [eraserOn, setEraserOn] = useState(false);
  const [brushSize, setBrushSize] = useState(14);
  const erasingRef = useRef(false);
  /** 笔刷光标圈：相对画布容器的屏幕坐标，用来在画面上画出「擦多大一块」 */
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number } | null>(null);
  /** 手擦遮罩：1 = 被手擦过，重算时强制透明 */
  const manualMaskRef = useRef<Uint8Array | null>(null);
  const [hasManual, setHasManual] = useState(false);

  /* 油漆桶填充：点哪填哪，可选连通（洪水填充）或全局（所有相似色） */
  const [fillOn, setFillOn] = useState(false);
  const [fillColor, setFillColor] = useState<Rgb>({ r: 255, g: 255, b: 255 });
  const [fillAlpha, setFillAlpha] = useState(255);
  const [fillMode, setFillMode] = useState<'connected' | 'global'>('connected');
  const [fillTolerance, setFillTolerance] = useState(24);
  /** 填充操作记录：重算（拖滑杆等）后按顺序重放，保证填充不会丢 */
  const fillOpsRef = useRef<
    { x: number; y: number; color: Rgb; alpha: number; mode: 'connected' | 'global'; tolerance: number }[]
  >([]);
  const [fillCount, setFillCount] = useState(0);

  /** 预览画布：直接画在 DOM canvas 上，手擦才能实时生效（也省掉 PNG 编码） */
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPreview, setHasPreview] = useState(false);
  // AI 抠图（本地语义分割模型）
  const [aiResult, setAiResult] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsed, setAiElapsed] = useState(0);
  const [aiError, setAiError] = useState<string | null>(null);
  /** 用 AI 的前景判定保护主体：颜色接近背景、但 AI 认为是角色的像素不删 */
  const [aiProtect, setAiProtect] = useState(true);
  const aiMaskRef = useRef<{ alpha: Uint8Array; width: number; height: number } | null>(null);

  /** rembg 就绪探测结果（pyshim 目录里的 Python + rembg 是否可用） */
  const [birefnetReady, setBirefnetReady] = useState<boolean | null>(null);
  /** 抠图模型：直接传给官方 rembg 的 new_session(model) */
  const [rembgModel, setRembgModel] = useState('birefnet-general');
  /** alpha matting：rembg 的边缘细化，慢但更细 */
  const [alphaMatting, setAlphaMatting] = useState(false);
  /** 关闭 RGB 去污染（默认关，即**执行**去污染，修掉黑边） */
  const [noDecontaminate, setNoDecontaminate] = useState(false);


  /* 双背景差值抠图：需要「黑底图 + 白底图」两张对齐的图，数学上精确解出 alpha */
  const [dualPartner, setDualPartner] = useState<{ dataUrl: string; label: string } | null>(null);
  /* ---------------- 两栏抠图：本地模型 / 传统 ---------------- */
  type MattingTab = 'local' | 'classic';
  const [activeTab, setActiveTab] = useState<MattingTab>('local');
  /** 原图快照（打开时保存一次），用于「恢复原图」 */
  const originalSnapshotRef = useRef<string>('');
  /** 每个 tab 最后一次生成的结果，用于「恢复上次结果」 */
  const lastResultRef = useRef<Partial<Record<MattingTab, string>>>({});
  const [, setSnapshotTick] = useState(0);

  /** 把某个 dataURL 画回预览画布 */
  const applySnapshot = (dataUrl: string): void => {
    const previewCanvas = previewCanvasRef.current;
    if (!previewCanvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = previewCanvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
    };
    img.src = dataUrl;
  };

  const rememberResult = (tab: MattingTab, dataUrl: string): void => {
    lastResultRef.current[tab] = dataUrl;
    setSnapshotTick((tick) => tick + 1);
  };

  // 打开编辑器时问一次 BiRefNet 权重在不在
  useEffect(() => {
    let cancelled = false;
    void window.skeletonElf.files.birefnetStatus().then((res) => {
      if (cancelled) return;
      setBirefnetReady(Boolean(res.ok && res.data.available));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setView = useCallback((nextZoom: number, nextPan: { x: number; y: number }) => {
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }, []);

  /** 以 anchor（相对视口的坐标）为不动点缩放；不传则用视口中心 */
  const zoomAt = useCallback(
    (requested: number, anchorX?: number, anchorY?: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      const ax = anchorX ?? (rect ? rect.width / 2 : 0);
      const ay = anchorY ?? (rect ? rect.height / 2 : 0);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(requested.toFixed(3))));
      const prev = zoomRef.current;
      if (Math.abs(next - prev) < 0.0001) return;
      const ratio = next / prev;
      const current = panRef.current;
      setView(next, { x: ax - (ax - current.x) * ratio, y: ay - (ay - current.y) * ratio });
    },
    [setView],
  );

  /** 适应窗口：整张图居中显示 */
  const fitToStage = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !image.width || !image.height) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / image.width, rect.height / image.height, 1);
    const next = Math.max(MIN_ZOOM, Number(scale.toFixed(3)));
    setView(next, { x: (rect.width - image.width * next) / 2, y: (rect.height - image.height * next) / 2 });
  }, [image.width, image.height, setView]);

  // 解码原图到 ImageData，供后续纯像素处理（只做一次）
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setLoadError(t('ie.err.canvasCtx', lang));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      sourceRef.current = data;

      // 预计算整张图的 HSL：拖动滑杆时只做距离比较，不再逐像素调用 rgbToHsl
      const count = data.width * data.height;
      const hueArr = new Float32Array(count);
      const satArr = new Float32Array(count);
      const lumArr = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        const offset = i * 4;
        const hsl = rgbToHsl(data.data[offset], data.data[offset + 1], data.data[offset + 2]);
        hueArr[i] = hsl.h;
        satArr[i] = hsl.s;
        lumArr[i] = hsl.l;
      }
      hslRef.current = { h: hueArr, s: satArr, l: lumArr, width: data.width, height: data.height };
      // 手擦遮罩随图重建（换图时旧的手擦不沿用）
      manualMaskRef.current = new Uint8Array(count);
      setHasManual(false);

      // 只准备一个背景色候选（用户勾「启用颜色抠图」时立刻可用），但不自动应用
      setColors([detectBackground(data)]);
      // 保存原图快照，供「恢复原图」使用
      originalSnapshotRef.current = image.dataUrl;
      setReady(true);
    };
    img.onerror = () => setLoadError(t('ie.err.imageDecode', lang));
    img.src = image.dataUrl;
    return () => {
      cancelled = true;
    };
  }, [image.dataUrl]);

  const apply = useCallback(() => {
    const src = sourceRef.current;
    if (!src) return;

    const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    const px = out.data;
    // RGB 欧氏距离最大是 √(255²×3) ≈ 441。容差 0–63 直接 1:1 映射到 0–441，
    // 这样「容差 32」就真的等于「距离 224」，滑杆刻度与实际色差一一对应。
    const threshold = tolerance * 7;
    const feather = Math.max(threshold * 0.6, 1);
    const bright = brightness / 100;

    const width = src.width;
    const height = src.height;

    // 预先把「要去除的颜色」转成 HSL；源图的逐像素 HSL 用加载时算好的缓存
    const paletteHsl = colors.map((color) => rgbToHsl(color.r, color.g, color.b));
    const cache = hslRef.current;
    const useCache = cache !== null && cache.width === width && cache.height === height;
    const hueArr = useCache ? cache.h : null;
    const satArr = useCache ? cache.s : null;
    const lumArr = useCache ? cache.l : null;

    // 与颜色列表里最接近的色差 —— 用 RGB 欧氏距离，不用 HSL。
    //
    // 为什么不用 HSL：紫背景 #FF00FF（L=0.50）和紫发 #8B008B（L=0.27）色相完全相同，
    // HSL 距离算出来只有 27（明度差 × 120），远小于阈值 → **角色被当成背景删掉**；
    // 反过来把阈值调小又删不掉背景的浅紫部分。同色相场景 HSL 无解。
    //
    // RGB 距离下：紫背景 vs 紫发 = 164，紫背景 vs 浅紫 #FF80FF = 128。
    // 阈值落在 130~160 之间就既能删浅紫背景、又保住紫发。
    const nearestDistance = (p: number): number => {
      const r = src.data[p];
      const g = src.data[p + 1];
      const b = src.data[p + 2];
      let best = Number.POSITIVE_INFINITY;
      for (let k = 0; k < colors.length; k += 1) {
        const color = colors[k];
        const dr = r - color.r;
        const dg = g - color.g;
        const db = b - color.b;
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);
        if (distance < best) best = distance;
      }
      return best;
    };
    // 分类阈值：按文档要求，颜色只用来「分类」，不直接当透明度。
    //   distance ≤ strictBg      → 确定背景（alpha = 0）
    //   distance ≥ threshold     → 确定前景（alpha = 255，颜色不动）
    //   中间                     → 边缘带，交给投影 matting 估 alpha
    const strictBg = threshold * 0.55;
    const isDefiniteBg = (p: number): boolean => nearestDistance(p) <= strictBg;
    const matches = (p: number): boolean => nearestDistance(p) <= strictBg;

    // AI 保护：AI 认为是角色的像素（alpha 高）即使颜色接近背景也不删
    const mask = aiProtect && aiMaskRef.current && aiMaskRef.current.width === width && aiMaskRef.current.height === height
      ? aiMaskRef.current.alpha
      : null;
    const aiSaysForeground = (index: number): boolean => (mask ? mask[index] > 128 : false);

    const removed = new Uint8Array(width * height);

    if (removeBg && removeMode === 'global') {
      // 全局：整张图里所有接近选中颜色的像素都删（含夹缝）
      for (let index = 0; index < width * height; index += 1) {
        if (!matches(index * 4)) continue;
        if (aiSaysForeground(index)) continue;
        removed[index] = 1;
      }
    }

    if (removeBg && removeMode === 'connected') {
      // 仅连通背景：从画布四边向内泛洪，保护主体内部同色部位
      const visited = new Uint8Array(width * height);
      const stack: number[] = [];
      for (let x = 0; x < width; x += 1) {
        stack.push(x, (height - 1) * width + x);
      }
      for (let y = 0; y < height; y += 1) {
        stack.push(y * width, y * width + width - 1);
      }

      while (stack.length > 0) {
        const index = stack.pop() as number;
        if (index < 0 || index >= width * height || visited[index]) continue;
        visited[index] = 1;

        const p = index * 4;
        if (!matches(p)) continue;
        if (aiSaysForeground(index)) continue;

        removed[index] = 1;
        const x = index % width;
        const y = (index - x) / width;
        if (x > 0) stack.push(index - 1);
        if (x < width - 1) stack.push(index + 1);
        if (y > 0) stack.push(index - width);
        if (y < height - 1) stack.push(index + width);
      }
    }

    // 魔棒点选：以点击点的颜色为参照，只删它所在的那片连通区域（不影响别处同色部位）
    for (const mark of marks) {
      const seed = mark.y * width + mark.x;
      if (seed < 0 || seed >= width * height) continue;
      const seedColor = { r: src.data[seed * 4], g: src.data[seed * 4 + 1], b: src.data[seed * 4 + 2] };
      const visited = new Uint8Array(width * height);
      const stack: number[] = [seed];

      while (stack.length > 0) {
        const index = stack.pop() as number;
        if (index < 0 || index >= width * height || visited[index]) continue;
        visited[index] = 1;

        const p = index * 4;
        const dr = src.data[p] - seedColor.r;
        const dg = src.data[p + 1] - seedColor.g;
        const db = src.data[p + 2] - seedColor.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > threshold) continue;

        removed[index] = 1;
        const x = index % width;
        const y = (index - x) / width;
        if (x > 0) stack.push(index - 1);
        if (x < width - 1) stack.push(index + 1);
        if (y > 0) stack.push(index - width);
        if (y < height - 1) stack.push(index + width);
      }
    }

    /* ============================================================
       按文档重写：颜色只做分类，alpha 由「投影 Matting」估计
       ============================================================

       像素构成：C = αF + (1−α)B

       分类（颜色距离 d）：
         d ≤ strictBg  → 确定背景，α = 0
         d ≥ threshold → 确定前景，α = 1，颜色一律不动
         中间          → 边缘带，用投影法估 α

       边缘带的投影 Matting（传统 matting 的核心，不需要深度模型）：
         在邻域里分别取「确定前景」平均色 F_local 和「确定背景」平均色 B_local，
         把观测色 C 投影到 B_local → F_local 这条线上：
             α = (C − B_local)·(F_local − B_local) / |F_local − B_local|²
         反推真实前景色：
             F = B_local + (C − B_local) / α
       这样得到的是「覆盖率」而不是「颜色有多像背景」，
       细发丝和手臂边缘这类结构不会被一刀切掉。
    ============================================================ */
    const SEARCH_RADIUS = 4;
    const classMap = new Uint8Array(width * height); // 0=背景 1=前景 2=边缘

    if (!removeBg) {
      // 没启用颜色抠图 → 全部当作前景，像素原样保留（打开编辑器时就是原图）
      classMap.fill(1);
    } else {
      for (let index = 0; index < width * height; index += 1) {
        if (removed[index] === 1) {
          classMap[index] = 0;
          continue;
        }
        const distance = nearestDistance(index * 4);
        if (distance <= strictBg) classMap[index] = 0;
        else if (distance >= threshold) classMap[index] = 1;
        else classMap[index] = 2;
      }
    }

    for (let index = 0; index < width * height; index += 1) {
      const p = index * 4;
      const kind = classMap[index];

      // ── 确定背景 ──
      if (kind === 0) {
        px[p] = 0;
        px[p + 1] = 0;
        px[p + 2] = 0;
        px[p + 3] = 0;
        continue;
      }

      // ── 确定前景：主体内部颜色完全不动；只有「紧贴背景的那一圈」做 despill ──
      if (kind === 1) {
        // 关键：保留原图的 alpha，不要强制 255。
        // 强制 255 会把已经透明的像素变回不透明，露出透明区隐藏的 RGB（通常是黑），
        // 表现为「保存后重新打开出现黑色背景」。
        px[p + 3] = src.data[p + 3];

        // 边缘 despill：这类像素 alpha 是 1，反推公式无效（F = (C−0)/1 = C），
        // 但它们的 RGB 里物理上仍混着背景色（抗锯齿），绿幕背景下就是紫边。
        // 做法：把「背景色占优的通道」向「非占优通道」的水平压回去。
        if (despill > 0 && colors.length > 0) {
          const x0 = index % width;
          const y0 = (index - x0) / width;
          let touchesBg = false;
          for (let dy = -1; dy <= 1 && !touchesBg; dy += 1) {
            const ny = y0 + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x0 + dx;
              if (nx < 0 || nx >= width) continue;
              if (classMap[ny * width + nx] === 0) {
                touchesBg = true;
                break;
              }
            }
          }

          if (touchesBg) {
            const strength = Math.max(0, Math.min(1, despill / 100));
            const bg = colors[0];
            const bgMax = Math.max(bg.r, bg.g, bg.b);
            const leading = [bg.r >= bgMax * 0.9, bg.g >= bgMax * 0.9, bg.b >= bgMax * 0.9];
            const others = [px[p], px[p + 1], px[p + 2]].filter((_, i) => !leading[i]);
            // 非占优通道的最高值当作「紫色应该被压到的上限」
            const limit = others.length > 0 ? Math.max(...others) : 128;
            for (let c = 0; c < 3; c += 1) {
              if (!leading[c]) continue;
              const value = px[p + c];
              if (value > limit) {
                px[p + c] = Math.round(value - (value - limit) * strength);
              }
            }
          }
        }

        if (bright !== 1) {
          px[p] = Math.min(255, px[p] * bright);
          px[p + 1] = Math.min(255, px[p + 1] * bright);
          px[p + 2] = Math.min(255, px[p + 2] * bright);
        }
        continue;
      }

      // ── 边缘带：投影 matting ──
      const x = index % width;
      const y = (index - x) / width;
      let fr = 0;
      let fg2 = 0;
      let fb = 0;
      let fn = 0;
      let br = 0;
      let bg2 = 0;
      let bb = 0;
      let bn = 0;

      for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const ni = ny * width + nx;
          const np = ni * 4;
          if (classMap[ni] === 1) {
            fr += src.data[np];
            fg2 += src.data[np + 1];
            fb += src.data[np + 2];
            fn += 1;
          } else if (classMap[ni] === 0) {
            br += src.data[np];
            bg2 += src.data[np + 1];
            bb += src.data[np + 2];
            bn += 1;
          }
        }
      }

      if (fn === 0 || bn === 0) {
        // 邻域里缺前景或背景样本 → 无法可靠估计，保持半透明但不改颜色
        px[p + 3] = 128;
        continue;
      }

      const fR = fr / fn;
      const fG = fg2 / fn;
      const fB = fb / fn;
      const bR2 = br / bn;
      const bG2 = bg2 / bn;
      const bB2 = bb / bn;

      // 前景-背景色差向量
      const dR = fR - bR2;
      const dG = fG - bG2;
      const dB = fB - bB2;
      const denom = dR * dR + dG * dG + dB * dB;

      const cR = src.data[p];
      const cG = src.data[p + 1];
      const cB = src.data[p + 2];

      let alpha: number;
      if (denom < 1) {
        // 前景背景色太接近，投影不可靠 → 按颜色距离线性给个 alpha
        const distance = nearestDistance(p);
        alpha = Math.max(0, Math.min(1, (distance - strictBg) / Math.max(1, threshold - strictBg)));
      } else {
        // 投影：把 C 投影到 B→F 的连线上
        alpha = ((cR - bR2) * dR + (cG - bG2) * dG + (cB - bB2) * dB) / denom;
        alpha = Math.max(0, Math.min(1, alpha));
      }

      // 去污染强度：0 时保留原色，1 时完全反推
      const strength = Math.max(0, Math.min(1, despill / 100));
      let outR = cR;
      let outG = cG;
      let outB = cB;
      // 低 alpha 不反推（1/α 会放大噪声），只在中高 alpha 区修颜色
      if (alpha >= 0.25 && alpha < 0.995 && strength > 0) {
        const solvedR = bR2 + (cR - bR2) / alpha;
        const solvedG = bG2 + (cG - bG2) / alpha;
        const solvedB = bB2 + (cB - bB2) / alpha;
        outR = cR * (1 - strength) + solvedR * strength;
        outG = cG * (1 - strength) + solvedG * strength;
        outB = cB * (1 - strength) + solvedB * strength;
      }

      px[p] = Math.max(0, Math.min(255, Math.round(outR)));
      px[p + 1] = Math.max(0, Math.min(255, Math.round(outG)));
      px[p + 2] = Math.max(0, Math.min(255, Math.round(outB)));
      px[p + 3] = Math.round(alpha * 255);

      if (bright !== 1) {
        px[p] = Math.min(255, px[p] * bright);
        px[p + 1] = Math.min(255, px[p + 1] * bright);
        px[p + 2] = Math.min(255, px[p + 2] * bright);
      }
    }

    // 边缘去除：把紧贴透明区的像素也吃掉 N 层，消掉抗锯齿白边
    if (removeBg && edgeTrim > 0) {
      for (let pass = 0; pass < edgeTrim; pass += 1) {
        const snapshot = new Uint8ClampedArray(px);
        for (let index = 0; index < width * height; index += 1) {
          const p = index * 4;
          if (snapshot[p + 3] === 0) continue;
          const x = index % width;
          const y = (index - x) / width;
          const nearTransparent =
            (x > 0 && snapshot[(index - 1) * 4 + 3] === 0) ||
            (x < width - 1 && snapshot[(index + 1) * 4 + 3] === 0) ||
            (y > 0 && snapshot[(index - width) * 4 + 3] === 0) ||
            (y < height - 1 && snapshot[(index + width) * 4 + 3] === 0);
          if (nearTransparent) px[p + 3] = 0;
        }
      }
    }

    // 手擦遮罩：手擦过的像素强制透明（与颜色/泛洪的结果叠加）
    const manual = manualMaskRef.current;
    if (manual && manual.length === width * height) {
      for (let index = 0; index < width * height; index += 1) {
        if (manual[index]) px[index * 4 + 3] = 0;
      }
    }

    // 直接画在页面上的 canvas 里：手擦能实时反映，也省掉 PNG 编码
    const canvas = previewCanvasRef.current ?? document.createElement('canvas');
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, width, height);
      ctx.putImageData(out, 0, 0);
    }
    previewCanvasRef.current = canvas;
    setHasPreview(true);
  }, [colors, marks, tolerance, brightness, removeBg, removeMode, edgeTrim, despill, aiProtect]);

  useEffect(() => {
    if (!ready) return;
    // 拖动滑杆时合并高频调用：60ms 内的连续改动只算最后那一次
    const timer = window.setTimeout(() => {
      apply();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [ready, apply]);

  // 首次就绪后适应窗口
  useEffect(() => {
    if (ready) fitToStage();
  }, [ready, fitToStage]);

  // 打开编辑器时锁住外部页面滚动，避免滚轮缩放把外层栏一起滚了
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // 撤销 / 重做快捷键：Ctrl+Z 撤销，Ctrl+Y 或 Ctrl+Shift+Z 重做
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  // 滚轮缩放：非 passive 监听 + 阻止冒泡，确保只缩放画布、不滚动任何外层容器
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = stage.getBoundingClientRect();
      zoomAt(
        zoomRef.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /**
   * 油漆桶填充。两种模式：
   *   connected —— 从点击处 4 邻域洪水填充，只填连通的一片
   *   global    —— 全图扫描，与点击色相近的像素都填
   * 结果写进预览画布，同时记进 fillOpsRef，重算后自动重放。
   */
  const fillAt = (x: number, y: number): void => {
    const canvas = previewCanvasRef.current;
    const src = sourceRef.current;
    if (!canvas || !src) return;
    if (x < 0 || y < 0 || x >= src.width || y >= src.height) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFill(image, x, y, fillColor, fillAlpha, fillMode, fillTolerance);
    ctx.putImageData(image, 0, 0);
    fillOpsRef.current.push({
      x,
      y,
      color: { ...fillColor },
      alpha: fillAlpha,
      mode: fillMode,
      tolerance: fillTolerance,
    });
    setFillCount(fillOpsRef.current.length);
  };

  const clearFills = (): void => {
    fillOpsRef.current = [];
    setFillCount(0);
    apply();
  };

  const pickColor = (event: React.MouseEvent<HTMLElement>): void => {
    // 本地模型抠图栏：点击画布不取色（那栏只做模型推理，避免误加颜色）
    if (activeTab === 'local') return;
    // 油漆桶开启时，点击 = 填充
    if (fillOn) {
      const canvas = previewCanvasRef.current;
      const src = sourceRef.current;
      if (!canvas || !src) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      fillAt(
        Math.round(((event.clientX - rect.left) / rect.width) * src.width),
        Math.round(((event.clientY - rect.top) / rect.height) * src.height),
      );
      return;
    }
    // 橡皮擦模式下点击 = 擦除，不要顺带改颜色列表
    if (eraserOn) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    pushHistory();
    const src = sourceRef.current;
    if (!src) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * src.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * src.height);

    // 取样范围 7×7：把点周围出现最多的几种颜色一起加进来，
    // 避免 AI 出图背景有轻微渐变/噪点时，同色区域只删了一部分
    const radius = 3;
    const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();
    for (let yy = Math.max(0, y - radius); yy <= Math.min(src.height - 1, y + radius); yy += 1) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(src.width - 1, x + radius); xx += 1) {
        const p = (yy * src.width + xx) * 4;
        const r = src.data[p];
        const g = src.data[p + 1];
        const b = src.data[p + 2];
        const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.count += 1;
        else buckets.set(key, { r, g, b, count: 1 });
      }
    }
    const samples = [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map(({ r, g, b }) => ({ r, g, b }));

    // 点哪里就删哪里（魔棒）：加入该种子点；同时把这些取样色记进列表
    setMarks((prev) => [...prev, { x, y }]);
    setColors((prev) => {
      const next = [...prev];
      for (const color of samples) {
        const exists = next.some(
          (item) => Math.abs(item.r - color.r) <= 6 && Math.abs(item.g - color.g) <= 6 && Math.abs(item.b - color.b) <= 6,
        );
        if (!exists) next.push(color);
      }
      return next.slice(0, 24);
    });
  };

  /** 手动橡皮擦：把鼠标位置的圆形区域擦成透明，并写入遮罩（重算时保持擦除） */
  const eraseStroke = (event: { clientX: number; clientY: number }): void => {
    const canvas = previewCanvasRef.current;
    const mask = manualMaskRef.current;
    const src = sourceRef.current;
    if (!canvas || !mask || !src) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.round(((event.clientX - rect.left) / rect.width) * src.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * src.height);
    if (x < 0 || y < 0 || x >= src.width || y >= src.height) return;

    const radius = Math.max(1, Math.round(brushSize / 2));
    for (let yy = y - radius; yy <= y + radius; yy += 1) {
      if (yy < 0 || yy >= src.height) continue;
      for (let xx = x - radius; xx <= x + radius; xx += 1) {
        if (xx < 0 || xx >= src.width) continue;
        const dx = xx - x;
        const dy = yy - y;
        if (dx * dx + dy * dy > radius * radius) continue;
        mask[yy * src.width + xx] = 1;
      }
    }
    setHasManual(true);

    // 只改这一小块：立刻看到擦除效果，不重算整张图
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const left = Math.max(0, x - radius);
    const top = Math.max(0, y - radius);
    const w = Math.min(radius * 2 + 1, src.width - left);
    const h = Math.min(radius * 2 + 1, src.height - top);
    if (w <= 0 || h <= 0) return;
    const patch = ctx.getImageData(left, top, w, h);
    for (let yy = 0; yy < h; yy += 1) {
      for (let xx = 0; xx < w; xx += 1) {
        const dx = left + xx - x;
        const dy = top + yy - y;
        if (dx * dx + dy * dy > radius * radius) continue;
        patch.data[(yy * w + xx) * 4 + 3] = 0;
      }
    }
    ctx.putImageData(patch, left, top);
  };

  /** 清除所有手擦痕迹 */
  const clearManual = (): void => {
    pushHistory();
    manualMaskRef.current?.fill(0);
    setHasManual(false);
    apply();
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return;
    // 橡皮擦模式下左键 = 涂抹擦除，不平移画布
    if (eraserOn && event.button === 0) {
      pushHistory();
      erasingRef.current = true;
      eraseStroke(event);
      return;
    }
    dragRef.current = {
      sx: event.clientX,
      sy: event.clientY,
      px: panRef.current.x,
      py: panRef.current.y,
      moved: false,
    };
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    // 笔刷光标圈：橡皮擦开启时跟着鼠标走，直观显示「会擦多大一块」
    if (eraserOn) {
      const stage = stageRef.current;
      if (stage) {
        const stageRect = stage.getBoundingClientRect();
        setBrushCursor({ x: event.clientX - stageRect.left, y: event.clientY - stageRect.top });
      }
    } else if (brushCursor) {
      setBrushCursor(null);
    }

    // 橡皮擦按住拖动：持续擦除
    if (erasingRef.current && eraserOn) {
      eraseStroke(event);
      return;
    }

    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.sx;
      const dy = event.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) setView(zoomRef.current, { x: drag.px + dx, y: drag.py + dy });
      return;
    }

    // 放大观察窗：按图片像素坐标去重，避免高频重渲染
    const imgEl = imageRef.current;
    if (!imgEl) return;
    const rect = imgEl.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) {
      setMagnifier(null);
      return;
    }
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * image.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * image.height);
    setMagnifier((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  };

  const handleMouseUp = (): void => {
    erasingRef.current = false;
    suppressClickRef.current = Boolean(dragRef.current?.moved);
    dragRef.current = null;
  };

  // 绘制放大观察窗内容：previewCanvas 上取 16×16 邻域，等倍放大到 144×144
  useEffect(() => {
    const canvas = magCanvasRef.current;
    const src = previewCanvasRef.current;
    if (!canvas || !src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const zoomFactor = canvas.width / SAMPLE_SIZE;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!magnifier) return;
    ctx.drawImage(
      src,
      magnifier.x - SAMPLE_SIZE / 2,
      magnifier.y - SAMPLE_SIZE / 2,
      SAMPLE_SIZE,
      SAMPLE_SIZE,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    // 中心像素十字准星
    const center = (SAMPLE_SIZE / 2) * zoomFactor;
    ctx.strokeStyle = 'rgba(79, 124, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(center, center, zoomFactor, zoomFactor);
  }, [magnifier, hasPreview]);

  /** 把 AI 抠图结果（dataURL）画到预览画布上 */
  const applyAiPreview = (dataUrl: string): void => {
    const previewCanvas = previewCanvasRef.current;
    if (!previewCanvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = previewCanvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
    };
    img.src = dataUrl;
  };

  /**
   * lumakey 细节恢复：BiRefNet 给的是「语义上的主体」，它对发丝、薄纱、半透明边缘的
   * 置信度天然偏低（常被压到 0.2 以下），看起来就是细节被吃掉了。
   *
   * 但背景是纯色，所以亮度是个可靠的旁证：
   *   像素亮度离背景亮度越远 → 越可能是主体的细节
   *   像素亮度和背景亮度几乎一样 → 确实是背景
   *
   * 做法（保守）：
   *   1. 四角采样估计背景亮度
   *   2. 只处理模型 alpha < 0.95 的像素（主体内部完全不动）
   *   3. 亮度差超过 MIN_DIFF 才补偿，且只提升不降低 —— 主体判定仍以模型为准
   */
  const refineLumaKeyWithDetail = async (dataUrl: string): Promise<string> => {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error(t('ie.err.decodeFailed', lang)));
        el.src = dataUrl;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w === 0 || h === 0) return dataUrl;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return dataUrl;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);

      // ① 四角采样估计背景亮度
      const S = Math.min(12, Math.floor(Math.min(w, h) / 8));
      let bgSum = 0;
      let n = 0;
      for (const corner of [
        [0, 0],
        [w - S, 0],
        [0, h - S],
        [w - S, h - S],
      ]) {
        const ox = corner[0];
        const oy = corner[1];
        for (let y = oy; y < oy + S; y += 1) {
          for (let x = ox; x < ox + S; x += 1) {
            const i = (y * w + x) * 4;
            bgSum += 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
            n += 1;
          }
        }
      }
      if (n === 0) return dataUrl;
      const bgLuma = bgSum / n;

      const MIN_DIFF = 10; // 亮度差低于此视为噪声（JPG 伪影级别）
      const GAIN = 0.55; // 补偿力度：0 = 不补，1 = 完全按亮度差给 alpha
      let recovered = 0;

      for (let i = 0; i < imageData.data.length; i += 4) {
        const a = imageData.data[i + 3] / 255;
        if (a >= 0.95) continue; // 模型已确认是主体，完全不动

        const luma =
          0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
        const diff = Math.abs(luma - bgLuma);
        if (diff <= MIN_DIFF) continue; // 和背景亮度一致 → 确实是背景

        // 亮度差越大越像主体；按 GAIN 限制幅度，避免把纯背景噪声也捞回来
        const lumaAlpha = Math.min(1, diff / 140) * GAIN;
        const next = Math.max(a, lumaAlpha);
        if (next > a + 0.004) {
          imageData.data[i + 3] = Math.round(Math.min(1, next) * 255);
          recovered += 1;
        }
      }

      /* ── 边缘 RGB 去污染（decontaminate）──
         模型给的 alpha 可能已经对了，但边缘那圈像素的 RGB 是「角色 + 背景」的混合色：
         黑背景上就是一圈黑边。只修 alpha 不改 RGB，边框上的黑色就会一直留着。
         做法：对半透明像素，用它周围「完全不透明」的像素颜色替换 RGB，alpha 保持不变。 */
      let fixed = 0;
      const R = 4; // 搜索半径
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          const a = imageData.data[i + 3];
          if (a === 0 || a >= 245) continue; // 全透明 / 全不透明都不用动

          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          let cnt = 0;
          for (let dy = -R; dy <= R; dy += 1) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -R; dx <= R; dx += 1) {
              const nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              const ni = (ny * w + nx) * 4;
              if (imageData.data[ni + 3] < 245) continue; // 只取实心前景
              sumR += imageData.data[ni];
              sumG += imageData.data[ni + 1];
              sumB += imageData.data[ni + 2];
              cnt += 1;
            }
          }
          if (cnt === 0) continue; // 附近没有实心前景，保留原色

          imageData.data[i] = Math.round(sumR / cnt);
          imageData.data[i + 1] = Math.round(sumG / cnt);
          imageData.data[i + 2] = Math.round(sumB / cnt);
          fixed += 1;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      console.log(
        '[lumakey] 背景亮度 ' +
          bgLuma.toFixed(1) +
          ' · 恢复细节像素 ' +
          recovered +
          ' · 边缘去污染 ' +
          fixed,
      );
      return canvas.toDataURL('image/png');
    } catch (err) {
      console.warn('[lumakey] 精修失败，返回原始结果', err);
      return dataUrl;
    }
  };

  // AI 一键抠图：本地 ONNX 语义分割，与颜色无关
  // 走官方 rembg（Python 子进程）：模型/预处理/后处理全由 rembg 负责，和官网一致
  const handleAiMatting = async (): Promise<void> => {
    setAiBusy(true);
    setAiError(null);
    // 帧动画里的帧没有磁盘路径，传 dataUrl 让主进程先落临时文件
    const source = image.absPath || image.dataUrl;
    const res = await window.skeletonElf.files.rembgRemove(source, {
      model: rembgModel,
      alphaMatting,
      noDecontaminate,
    });
    setAiBusy(false);
    if (!res.ok) {
      setAiError(res.error);
      return;
    }
    /* 直接用模型输出，等同官网 app.py：
         preds = birefnet(input)[-1].sigmoid()  →  resize  →  putalpha(mask)
       之前这里接了 lumakey 补细节 + 边缘 RGB 去污染，都是官网没有的额外加工，
       实测会把干净的结果改糙（补出来的像素偏灰、去污染会改变边缘颜色）。
       保留函数定义以便需要时再开启，默认不调用。 */
    const refinedUrl = res.data.dataUrl;
    setAiResult(refinedUrl);
    setAiElapsed(res.data.elapsedMs);
    rememberResult('local', refinedUrl);

    applyAiPreview(refinedUrl);

    // 把 AI 结果的 alpha 通道存成 mask，供「保护主体」使用
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(t('ie.err.aiDecode', lang)));
        img.src = refinedUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const alpha = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3];
        aiMaskRef.current = { alpha, width: canvas.width, height: canvas.height };
      }
    } catch {
      aiMaskRef.current = null;
    }
  };

  const handleSave = async (): Promise<void> => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !hasPreview) return;
    setSaving(true);
    setSaveError(null);
    // 画布内容就是最终结果，保存时才编码成 PNG（编码大图较慢，只做一次）
    const pngBase64 = canvas.toDataURL('image/png');

    // 帧动画模式：只把结果交回去，不写任何文件
    if (onApply) {
      setSaving(false);
      onApply(pngBase64);
      return;
    }

    const result = await window.skeletonElf.files.saveEdited({
      sourceAbsPath: image.absPath,
      pngBase64,
      note: note.trim(),
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    onSaved(result.data);
  };

  const sizeLabel = useMemo(() => `${image.width}×${image.height}`, [image.width, image.height]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header className="modal__head">
          <div>
            <h2>{t('ie.title', lang)}</h2>
            <p className="muted">
              {image.fileName} · {sizeLabel}
            </p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('kb.btn.cancel', lang)}
          </button>
        </header>

        <div className="modal__body">
          <div className="editor-stage-wrap">
            <div className="editor-toolbar">
              <button type="button" className="btn btn--ghost" onClick={() => zoomAt(zoomRef.current - 0.25)}>
                －
              </button>
              <span className="hint">{Math.round(zoom * 100)}%</span>
              <button type="button" className="btn btn--ghost" onClick={() => zoomAt(zoomRef.current + 0.25)}>
                ＋
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => zoomAt(1)}>
                100%
              </button>
              <button type="button" className="btn btn--ghost" onClick={fitToStage}>
                {t('ie.fit', lang)}
              </button>
              <span className="editor-toolbar__sep" />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={undo}
                disabled={undoStackRef.current.length === 0}
                title={t('ie.undoTitle', lang)}
              >
                {t('ie.undo', lang)}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={redo}
                disabled={redoStackRef.current.length === 0}
                title={t('ie.redoTitle', lang)}
              >
                {t('ie.redo', lang)}
              </button>
              <span className="field__hint">{t('ie.zoomHint', lang)}</span>
              {/* 验收用：把结果合成到不同背景，紫边/黑边/白边一眼可见 */}
              <span className="editor-checkbg">
                <span>{t('ie.check.label', lang)}</span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const s = stageRef.current;
                    if (s) s.style.background = '';
                  }}
                  title={t('ie.check.checkerTitle', lang)}
                >
                  {t('ie.check.checker', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const s = stageRef.current;
                    if (s) s.style.background = '#ffffff';
                  }}
                  title={t('ie.check.whiteTitle', lang)}
                >
                  {t('ie.check.white', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const s = stageRef.current;
                    if (s) s.style.background = '#000000';
                  }}
                  title={t('ie.check.blackTitle', lang)}
                >
                  {t('ie.check.black', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const s = stageRef.current;
                    if (s) s.style.background = '#808080';
                  }}
                  title={t('ie.check.grayTitle', lang)}
                >
                  {t('ie.check.gray', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const s = stageRef.current;
                    if (s) s.style.background = '#00b140';
                  }}
                  title={t('ie.check.greenTitle', lang)}
                >
                  {t('ie.check.green', lang)}
                </button>
              </span>
            </div>
            <div
              className="editor-stage"
              ref={stageRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => {
                handleMouseUp();
                setMagnifier(null);
                setBrushCursor(null);
              }}
            >
              {loadError ? <div className="banner banner--error">{loadError}</div> : null}
              {ready ? (
                <div
                  className="editor-stage__canvas"
                  style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                >
                  <canvas
                    ref={(node) => {
                      previewCanvasRef.current = node;
                      imageRef.current = node;
                    }}
                    className={`editor-stage__image${eraserOn ? ' is-eraser' : ''}`}
                    width={image.width}
                    height={image.height}
                    onClick={pickColor}
                    style={{ width: `${image.width}px` }}
                  />
                  {/* 高倍率下的像素网格：1px 在原图坐标系里，跟着 scale 一起放大 */}
                  {zoom >= GRID_MIN_ZOOM ? (
                    <div
                      className="editor-stage__grid"
                      style={{
                        width: `${image.width}px`,
                        height: `${image.height}px`,
                        backgroundSize: '1px 1px',
                      }}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="editor-stage__placeholder">{t('ie.decoding', lang)}</div>
              )}

              {/* 笔刷光标圈：按当前缩放在画面上显示实际擦除范围 */}
              {eraserOn && brushCursor ? (
                <div
                  className="editor-brush-cursor"
                  style={{
                    left: brushCursor.x - (brushSize * zoom) / 2,
                    top: brushCursor.y - (brushSize * zoom) / 2,
                    width: brushSize * zoom,
                    height: brushSize * zoom,
                  }}
                />
              ) : null}

              {/* 放大观察窗：显示鼠标所在像素的 16×16 邻域，方便像素级修边 */}
              {ready ? (
                <div className="editor-magnifier">
                  <canvas ref={magCanvasRef} width={144} height={144} />
                  <span className="editor-magnifier__meta">
                    {magnifier
                      ? `${magnifier.x}, ${magnifier.y}`
                      : t('ie.magnifier.move', lang)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="editor-panel">
            {/* 三栏切换：三个模块互不干扰，可来回切 */}
            <div className="editor-tabs">
              <button
                type="button"
                className={`editor-tab${activeTab === 'local' ? ' is-active' : ''}`}
                onClick={() => setActiveTab('local')}
              >
                {t('ie.tab.local', lang)}
              </button>
              <button
                type="button"
                className={`editor-tab${activeTab === 'classic' ? ' is-active' : ''}`}
                onClick={() => setActiveTab('classic')}
              >
                {t('ie.tab.classic', lang)}
              </button>
            </div>

            {/* 每个 tab 都有的恢复按钮 */}
            <div className="actions editor-restore">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  if (originalSnapshotRef.current) applySnapshot(originalSnapshotRef.current);
                }}
                disabled={!originalSnapshotRef.current}
                title={t('ie.restore.originalTitle', lang)}
              >
                {t('ie.restore.original', lang)}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  const last = lastResultRef.current[activeTab];
                  if (last) applySnapshot(last);
                }}
                disabled={!lastResultRef.current[activeTab]}
                title={t('ie.restore.lastTitle', lang)}
              >
                {t('ie.restore.last', lang)}
              </button>
            </div>

            {/* 手动橡皮擦：三个模块共用，点哪擦哪 */}
            <div className="field">
              <span className="field__label">
                {t('ie.eraser.title', lang)}
                <em className="field__saved">
                  {eraserOn ? t('ie.eraser.on', lang) : t('ie.eraser.off', lang)}
                </em>
              </span>
              <div className="actions">
                <button
                  type="button"
                  className={`btn ${eraserOn ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setEraserOn((prev) => !prev)}
                >
                  {eraserOn ? t('ie.eraser.toggleOn', lang) : t('ie.eraser.toggleOff', lang)}
                </button>
                <button type="button" className="btn btn--ghost" onClick={clearManual} disabled={!hasManual}>
                  {t('ie.eraser.clear', lang)}
                </button>
              </div>
              <label className="field">
                <span className="field__label">
                  {t('ie.eraser.size', lang)} <em className="field__saved">{brushSize}px</em>
                </span>
                <div className="brush-row">
                  {/* 笔刷大小可视化：按比例显示粗细 */}
                  <span className="brush-preview">
                    <span
                      className="brush-preview__dot"
                      style={{
                        width: Math.max(2, brushSize / 2),
                        height: Math.max(2, brushSize / 2),
                      }}
                    />
                  </span>
                  <input
                    className="input-range"
                    type="range"
                    min={2}
                    max={80}
                    value={brushSize}
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                  />
                </div>
              </label>
              <span className="field__hint">{t('ie.eraser.hint', lang)}</span>
            </div>

            {/* ===== 栏 1：本地模型抠图 ===== */}
            <div
              className="field"
              style={activeTab === 'local' && FEATURE_AI_MATTING ? undefined : { display: 'none' }}
            >
              <span className="field__label">{t('ie.local.label', lang)}</span>
              <span className="field__hint">
                {t('ie.local.hint', lang)}
                {birefnetReady === false ? (
                  <>
                    <br />
                    {t('ie.local.missing', lang)}
                  </>
                ) : null}
              </span>

              <label className="field">
                <span className="field__label">{t('mt.model', lang)}</span>
                <select
                  className="input select"
                  value={rembgModel}
                  onChange={(event) => setRembgModel(event.target.value)}
                  disabled={aiBusy}
                >
                  {/* ★ = 打包版内置（scripts/prune-models.mjs 白名单）；其余是开发对比用的测试模型 */}
                  <option value="birefnet-general" className="opt-shipped">
                    ★ birefnet-general · {t('mt.model.shipped', lang)}
                  </option>
                  <option value="birefnet-general-lite" className="opt-shipped">
                    ★ birefnet-general-lite · {t('mt.model.shipped', lang)}
                  </option>
                  <option value="u2net" className="opt-shipped">
                    ★ u2net · {t('mt.model.shipped', lang)}
                  </option>
                  <option value="isnet-general-use" className="opt-shipped">
                    ★ isnet-general-use · {t('mt.model.shipped', lang)}
                  </option>
                  <option value="isnet-anime" className="opt-testonly">
                    isnet-anime · {t('mt.model.dev', lang)}
                  </option>
                  <option value="birefnet-portrait" className="opt-testonly">
                    birefnet-portrait · {t('mt.model.dev', lang)}
                  </option>
                  <option value="birefnet-massive" className="opt-testonly">
                    birefnet-massive · {t('mt.model.dev', lang)}
                  </option>
                  <option value="bria-rmbg" className="opt-testonly">
                    bria-rmbg · {t('mt.model.dev', lang)}
                  </option>
                  <option value="silueta" className="opt-testonly">
                    silueta · {t('mt.model.dev', lang)}
                  </option>
                  <option value="u2netp" className="opt-testonly">
                    u2netp · {t('mt.model.dev', lang)}
                  </option>
                </select>
              </label>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={alphaMatting}
                  onChange={(event) => setAlphaMatting(event.target.checked)}
                  disabled={aiBusy}
                />
                {t('ie.local.alphaMatting', lang)}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={!noDecontaminate}
                  onChange={(event) => setNoDecontaminate(!event.target.checked)}
                  disabled={aiBusy}
                />
                {t('ie.local.decontaminate', lang)}
              </label>

              <div className="actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleAiMatting()}
                  disabled={aiBusy}
                >
                  {aiBusy ? t('ie.local.running', lang) : t('ie.local.run', lang)}
                </button>
                {aiResult ? (
                  <button type="button" className="btn btn--ghost" onClick={() => applyAiPreview(aiResult)}>
                    {t('ie.local.restoreAi', lang)}
                  </button>
                ) : null}
              </div>
              <span className="field__hint">
                {t('ie.local.hint2', lang)}
                {aiElapsed > 0 ? t('ie.local.lastElapsed', lang, { seconds: (aiElapsed / 1000).toFixed(1) }) : ''}
              </span>
              {aiError ? <div className="banner banner--error">{aiError}</div> : null}
              {aiResult ? (
                <label className="checkbox">
                  <input type="checkbox" checked={aiProtect} onChange={(event) => setAiProtect(event.target.checked)} />
                  {t('ie.local.protect', lang)}
                </label>
              ) : null}
            </div>

            {/* ===== 栏 2：传统颜色抠图 ===== */}
            <details className="editor-group" style={activeTab === 'classic' ? undefined : { display: 'none' }} open={activeTab === 'classic'}>
              <summary>
                {t('ie.classic.summary', lang)} · <em>{t('ie.classic.summaryHint', lang)}</em>
              </summary>
              <label className="checkbox">
                <input type="checkbox" checked={removeBg} onChange={(event) => setRemoveBg(event.target.checked)} />
                {t('ie.classic.enable', lang)}
              </label>

              <div className="field">
                <span className="field__label">{t('ie.classic.scope', lang)}</span>
              <div className="bg-swatches">
                <button
                  type="button"
                  className={`bg-chip${removeMode === 'global' ? ' is-active' : ''}`}
                  disabled={!removeBg}
                  onClick={() => {
                    pushHistory();
                    setRemoveMode('global');
                  }}
                >
                  {t('ie.classic.global', lang)}
                </button>
                <button
                  type="button"
                  className={`bg-chip${removeMode === 'connected' ? ' is-active' : ''}`}
                  disabled={!removeBg}
                  onClick={() => {
                    pushHistory();
                    setRemoveMode('connected');
                  }}
                >
                  {t('ie.classic.connected', lang)}
                </button>
              </div>
              <span className="field__hint">{t('ie.classic.scopeHint', lang)}</span>
            </div>

            <div className="field">
              <span className="field__label">
                {t('ie.classic.tolerance', lang)}
                <em className="field__saved">{tolerance}</em>
              </span>
              <div className="input-row">
                <input
                  className="range"
                  type="range"
                  min={1}
                  max={60}
                  value={tolerance}
                  disabled={!removeBg}
                  onPointerDown={() => pushHistory()}
                  onChange={(event) => setTolerance(Number(event.target.value))}
                />
                <input
                  className="input input--num"
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={tolerance}
                  disabled={!removeBg}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    setTolerance(Math.min(60, Math.max(1, Math.round(next))));
                  }}
                />
              </div>
              <span className="field__hint">{t('ie.classic.toleranceHint', lang)}</span>
            </div>

            <div className="field">
              <span className="field__label">
                {t('ie.classic.edgeTrim', lang)}
                <em className="field__saved">{edgeTrim} px</em>
              </span>
              <div className="input-row">
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={4}
                  value={edgeTrim}
                  disabled={!removeBg}
                  onPointerDown={() => pushHistory()}
                  onChange={(event) => setEdgeTrim(Number(event.target.value))}
                />
                <input
                  className="input input--num"
                  type="number"
                  min={0}
                  max={4}
                  step={1}
                  value={edgeTrim}
                  disabled={!removeBg}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    setEdgeTrim(Math.min(4, Math.max(0, Math.round(next))));
                  }}
                />
              </div>
              <span className="field__hint">{t('ie.classic.edgeTrimHint', lang)}</span>
            </div>

            <div className="field">
              <span className="field__label">
                {t('ie.classic.colors', lang)}{' '}
                <em className="field__saved">
                  {t('ie.classic.colorCount', lang, { count: String(colors.length) })}
                </em>
              </span>
              <span className="field__hint">{t('ie.classic.colorsHint', lang)}</span>
              <div className="bg-swatches">
                {colors.map((color, index) => (
                  <button
                    key={`${color.r}-${color.g}-${color.b}-${index}`}
                    type="button"
                    className="bg-chip"
                    title={t('ie.classic.removeColor', lang)}
                    onClick={() => {
                      pushHistory();
                      setColors((prev) => prev.filter((_, i) => i !== index));
                    }}
                  >
                    <span className="bg-chip__dot" style={{ background: `rgb(${color.r}, ${color.g}, ${color.b})` }} />×
                  </button>
                ))}
                {colors.length === 0 ? (
                  <span className="field__hint">{t('ie.classic.colorsEmpty', lang)}</span>
                ) : null}
              </div>
              <span className="field__hint">{t('ie.classic.colorsHint2', lang)}</span>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    pushHistory();
                    const src = sourceRef.current;
                    if (src) setColors([detectBackground(src)]);
                  }}
                >
                  {t('ie.classic.recapture', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--danger"
                  onClick={() => {
                    pushHistory();
                    setColors([]);
                  }}
                  disabled={colors.length === 0}
                >
                  {t('ie.classic.clearAll', lang)}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">
                {t('ie.wand.title', lang)}{' '}
                <em className="field__saved">
                  {t('ie.wand.count', lang, { count: String(marks.length) })}
                </em>
              </span>
              <span className="field__hint">{t('ie.wand.hint', lang)}</span>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setMarks((prev) => prev.slice(0, -1))}
                  disabled={marks.length === 0}
                >
                  {t('ie.wand.undo', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--danger"
                  onClick={() => setMarks([])}
                  disabled={marks.length === 0}
                >
                  {t('ie.wand.clear', lang)}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">
                {t('ie.classic.brightness', lang)}
                <em className="field__saved">{brightness}%</em>
              </span>
              <div className="input-row">
                <input
                  className="range"
                  type="range"
                  min={50}
                  max={150}
                  value={brightness}
                  onPointerDown={() => pushHistory()}
                  onChange={(event) => setBrightness(Number(event.target.value))}
                />
                <input
                  className="input input--num"
                  type="number"
                  min={50}
                  max={150}
                  step={1}
                  value={brightness}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isFinite(next)) return;
                    setBrightness(Math.min(150, Math.max(50, Math.round(next))));
                  }}
                />
              </div>
            </div>

            <div className="actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setRemoveBg(true);
                  setTolerance(14);
                  setEdgeTrim(1);
                  setBrightness(100);
                  setRemoveMode('global');
                  setMarks([]);
                  const src = sourceRef.current;
                  if (src) setColors([detectBackground(src)]);
                }}
              >
                {t('ie.classic.reset', lang)}
              </button>
            </div>
            </details>

            <label className="field">
              <span className="field__label">{t('ie.note.label', lang)}</span>
              <input
                className="input"
                value={note}
                placeholder={t('ie.note.placeholder', lang)}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>

            {saveError ? <div className="banner banner--error">{saveError}</div> : null}

            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleSave()}
                disabled={saving || !hasPreview}
              >
                {saving
                  ? t('ie.save.saving', lang)
                  : onApply
                    ? t('ie.save.applyFrame', lang)
                    : t('ie.save.applyLibrary', lang)}
              </button>
            </div>
            <p className="muted editor-tip">
              {onApply ? t('ie.save.hintFrame', lang) : t('ie.save.hintNew', lang)}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
