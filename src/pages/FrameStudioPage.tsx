import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameProjectView, KnowledgeView } from '@shared/ipc';
import { ImageEditorModal, type EditorKeyParams } from '../components/ImageEditorModal';
import { FramePlayerModal } from '../components/FramePlayerModal';
import { VideoCropModal } from '../components/VideoCropModal';
import { notifyDataChanged, useDataRefresh } from '../state/refresh';
import { t, useLang, type Lang } from '../i18n';

interface FrameStudioPageProps {
  onOpenModelSettings: () => void;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 取四角小块平均色，作为默认背景色 */
function detectBackground(ctx: CanvasRenderingContext2D, width: number, height: number): Rgb {
  const patch = 8;
  const corners: [number, number][] = [
    [0, 0],
    [Math.max(0, width - patch), 0],
    [0, Math.max(0, height - patch)],
    [Math.max(0, width - patch), Math.max(0, height - patch)],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const [cx, cy] of corners) {
    const data = ctx.getImageData(cx, cy, Math.min(patch, width), Math.min(patch, height)).data;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;
    }
  }
  if (count === 0) return { r: 255, g: 0, b: 255 };
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

/** 色键去背景：与目标色差在容差内的像素变透明（原地修改 ImageData） */
function keyOut(data: ImageData, target: Rgb, tolerance: number): void {
  const px = data.data;
  const limit = tolerance * tolerance * 3;
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - target.r;
    const dg = px[i + 1] - target.g;
    const db = px[i + 2] - target.b;
    if (dr * dr + dg * dg + db * db <= limit) px[i + 3] = 0;
  }
}

function hexOf(color: Rgb): string {
  const to = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${to(color.r)}${to(color.g)}${to(color.b)}`;
}

/**
 * 各模型在 CPU 上单张耗时（秒，实测值）。
 * 用于给用户一个「预计要等多久」的量级参考，不是精确值。
 */
const MODEL_SECONDS: Record<string, number> = {
  u2net: 2,
  u2netp: 2,
  'isnet-anime': 2,
  silueta: 2,
  'isnet-general-use': 5,
  'bria-rmbg': 10,
  'birefnet-general-lite': 20,
  'birefnet-general-fp16': 40,
  'birefnet-general': 80,
  'birefnet-portrait': 80,
  'birefnet-massive': 120,
};

/** 把秒数写成「约 1 小时 5 分钟」这种人话 */
function humanDuration(seconds: number, lang: Lang): string {
  if (seconds < 60) return t('mt.dur.sec', lang, { n: String(Math.max(1, Math.round(seconds))) });
  const minutes = seconds / 60;
  if (minutes < 60) return t('mt.dur.min', lang, { n: String(Math.round(minutes)) });
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest > 0
    ? t('mt.dur.hourMin', lang, { h: String(hours), m: String(rest) })
    : t('mt.dur.hour', lang, { h: String(hours) });
}

export function FrameStudioPage({ onOpenModelSettings }: FrameStudioPageProps): React.JSX.Element {
  const [lang] = useLang();
  const [videos, setVideos] = useState<KnowledgeView[]>([]);
  const [projects, setProjects] = useState<FrameProjectView[]>([]);
  /** 正在改名的集合 id（null = 没有在改名） */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** 改名输入框的当前内容 */
  const [renameValue, setRenameValue] = useState('');
  const [selected, setSelected] = useState<KnowledgeView | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [duration, setDuration] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [fps, setFps] = useState(12);
  /**
   * 要抽几帧（力度）。
   *
   * 为什么不用「帧率」直接算：帧率乘时长决定帧数，1 fps × 8 秒 = 9 帧，
   * 想只拿首尾两张根本做不到（最小也是 9 帧）。改成直接指定帧数，
   * 2 帧 = 只有首尾两张，要多少给多少，跟视频长短无关。
   */
  const [targetFrames, setTargetFrames] = useState(12);
  const [maxFrames, setMaxFrames] = useState(60);
  /** 抽帧前是否自动找循环点（默认关：不是所有动画都需要循环，决定权交给用户） */
  const [autoFindLoop, setAutoFindLoop] = useState(false);
  /**
   * 抽帧分类：
   *   normal —— 正常抽帧，首帧到末帧完整保留
   *   loop   —— 循环帧，抽完自动找循环点并裁掉尾部多余帧，得到能无缝接回的序列
   */
  const [captureMode, setCaptureMode] = useState<'normal' | 'loop'>('normal');

  const [frames, setFrames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** 是否正在「在帧序列里找循环点」——按钮文案要靠它，不能用进度文案做字符串匹配（换语言就失效） */
  const [scanningLoop, setScanningLoop] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 最近一次保存成功的项目 id —— 提示条上直接给个「定位文件夹」按钮 */
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);

  // 默认关闭：抽帧时不做任何处理，先拿到干净原始帧。
  // 需要去背景时再开，或用项目卡片上的「整批模型抠图 / 整批传统抠图」，参数可反复调。
  const [removeBg, setRemoveBg] = useState(false);
  const [bgColor, setBgColor] = useState<Rgb>({ r: 255, g: 0, b: 255 });
  const [tolerance, setTolerance] = useState(36);
  const [backgroundRemoved, setBackgroundRemoved] = useState(false);

  /**
   * 抽帧范围（视频像素坐标）。为空表示整帧。
   * 大分辨率视频里角色只占中间一块，只抽这一块能大幅减小文件体积。
   */
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 裁剪设置窗口是否打开（框选和精确输入都在窗口里做，页面上只显示结果） */
  const [cropModalOpen, setCropModalOpen] = useState(false);

  /* 自绘播放条的状态：原生 <video controls> 那套配色跟蓝色主题完全不搭，
     所以关掉它自己画一条（播放/进度/时间/静音/全屏）。 */
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [videoMuted, setVideoMuted] = useState(false);

  const togglePlay = (): void => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const seekTo = (seconds: number): void => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    setVideoTime(seconds);
  };

  const toggleMute = (): void => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setVideoMuted(video.muted);
  };

  const toggleFullscreen = (): void => {
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void video.requestFullscreen();
  };

  const [projectName, setProjectName] = useState('');
  const [saving, setSaving] = useState(false);
  /** 保存成功后把路径显示在按钮下面（页面上方的 notice 容易看不到） */
  const [savedPath, setSavedPath] = useState<string | null>(null);

  /** 抽帧诊断：直接显示在页面上，不用开 DevTools 就能看出卡在哪 */
  const [diag, setDiag] = useState<string[]>([]);
  /** 元数据读取超时提示：8 秒还没读到时长就提示可能是编码问题 */
  const [metaTimeout, setMetaTimeout] = useState(false);

  // 帧序列预览播放：按当前帧率循环播放抽出来的帧
  const [playing, setPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);
  /** 播放倍率：抽帧帧率往往偏低，需要加速才看得清整体动作 */
  const [playSpeed, setPlaySpeed] = useState(1);
  /** 正在播放预览的集合（null = 没打开播放窗口） */
  const [previewProject, setPreviewProject] = useState<FrameProjectView | null>(null);

  /** 正在编辑的帧序号（null = 没打开编辑器）；编辑只改内存，不落盘 */
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  /** 编辑中帧的尺寸（给编辑器用） */
  const [editingMeta, setEditingMeta] = useState<{ dataUrl: string; width: number; height: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!selected) return;
    setMetaTimeout(false);
    const timer = window.setTimeout(() => {
      // 已经读到时长就不提示了
      if (!videoRef.current || videoRef.current.duration > 0) return;
      setMetaTimeout(true);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [selected]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    // 播放速度是倍率：2x 表示比标称 fps 快一倍，方便快速看整体动作
    const interval = window.setInterval(() => {
      setPlayIndex((prev) => (prev + 1) % frames.length);
    }, 1000 / Math.max(1, fps) / Math.max(0.25, playSpeed));
    return () => window.clearInterval(interval);
  }, [playing, frames.length, fps, playSpeed]);

  // 视频改走 blob URL（与页面同源）：彻底绕开跨域，canvas 不会被污染
  const [videoUrl, setVideoUrl] = useState('');
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoFallback, setVideoFallback] = useState(false);

  useEffect(() => {
    if (!selected) {
      setVideoUrl('');
      setVideoFallback(false);
      return;
    }
    const directUrl = `kbmedia://file/${encodeURIComponent(selected.fileName)}`;
    let cancelled = false;
    let createdUrl = '';
    setVideoLoading(true);
    setVideoFallback(false);

    // 首选：走 IPC 直接拿文件字节，拼成 blob URL（同源，画布不污染，不依赖协议 CORS）
    void (async () => {
      try {
        const res = await window.skeletonElf.files.readMedia(selected.fileName);
        if (cancelled) return;
        if (res.ok) {
          const bytes = new Uint8Array(res.data.data);
          createdUrl = URL.createObjectURL(new Blob([bytes], { type: res.data.mime }));
          setVideoUrl(createdUrl);
          return;
        }
        throw new Error(res.error);
      } catch {
        if (cancelled) return;
        // 回退：直连协议（能预览，但抽帧可能因画布污染失败）
        setVideoUrl(directUrl);
        setVideoFallback(true);
      } finally {
        if (!cancelled) setVideoLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [selected]);

  const loadLibrary = useCallback(async () => {
    const res = await window.skeletonElf.knowledge.list();
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setVideos(res.data.filter((item) => item.kind === 'video'));
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await window.skeletonElf.frames.list();
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // 下划线开头的是内部临时集合（_preview），不在集合列表里露面
    setProjects(res.data.filter((project) => !project.id.startsWith('_')));
  }, []);

  useEffect(() => {
    void loadLibrary();
    void loadProjects();
  }, [loadLibrary, loadProjects]);

  /* 别处（素材库改名、批量抠图出结果等）改了数据时，这一页也要跟着刷新，
     否则切回来看到的还是旧列表。 */
  useDataRefresh(() => {
    void loadLibrary();
    void loadProjects();
  });

  /**
   * 窗口重新获得焦点时刷新帧项目列表。
   * 用户经常"打开目录 → 手动删几张图/整个文件夹 → 切回来"，
   * 不刷新的话界面上还是旧数据（帧数不对、还能点到已经没了的项目）。
   */
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') void loadProjects();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadProjects]);

  // 视频元数据就绪后重置时间范围
  const handleMeta = (): void => {
    const video = videoRef.current;
    if (!video) return;
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(total);
    setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    setStartSec(0);
    setEndSec(Number(total.toFixed(2)));
    // 抓第一帧算背景色
    const canvas = canvasRef.current;
    if (canvas && video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        setBgColor(detectBackground(ctx, canvas.width, canvas.height));
      }
    }
  };

  /**
   * 寻找循环帧：在视频里找出「和起始帧最像」的那个时间点。
   *
   * 做法：把画面降采样成 24×24 灰度指纹，扫一遍后半段，取差异最小的时刻。
   * 找到后把结束时间设成那里 —— 这样首尾帧几乎一样，循环播放不会跳。
   *
   * 为什么降采样：全分辨率比像素太慢（每帧要读回几十万字节）。
   * 24×24 已经足够判断「构图和主体位置是否一致」，扫 100 个点也就两秒。
   */
  const handleFindLoop = async (): Promise<void> => {
    const video = videoRef.current;
    if (!video) {
      setError(t('fs.err.videoNotReady', lang));
      return;
    }
    setBusy(true);
    setScanningLoop(true);
    setError(null);
    setNotice(null);
    setProgressText(t('fs.findingLoopProgress', lang));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const seek = (time: number): Promise<void> =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          video.removeEventListener('seeked', finish);
          resolve();
        };
        video.addEventListener('seeked', finish);
        try {
          video.currentTime = time;
        } catch {
          finish();
          return;
        }
        window.setTimeout(finish, 800);
      });

    try {
      if (!ctx) throw new Error(t('fs.err.noCanvas', lang));
      const SAMPLE = 24;
      const fingerprint = (): Float32Array => {
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        ctx.drawImage(video, 0, 0, SAMPLE, SAMPLE);
        const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
        const out = new Float32Array(SAMPLE * SAMPLE);
        for (let i = 0; i < out.length; i += 1) {
          out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        }
        return out;
      };

      // 首帧指纹
      await seek(startSec);
      const first = fingerprint();

      const total = duration || video.duration || 0;
      const minGap = Math.max(0.4, (endSec - startSec) * 0.3);
      const scanFrom = Math.min(total, startSec + minGap);
      const scanTo = total;
      if (scanTo - scanFrom < 0.2) throw new Error(t('fs.err.tooShort', lang));

      const steps = Math.min(100, Math.max(16, Math.round((scanTo - scanFrom) / 0.05)));
      let bestTime = scanTo;
      let bestScore = Infinity;

      for (let i = 0; i <= steps; i += 1) {
        const time = scanFrom + ((scanTo - scanFrom) * i) / steps;
        setProgressText(
          t('fs.progress.scanning', lang, {
            current: String(i + 1),
            total: String(steps + 1),
            best: bestTime.toFixed(2),
          }),
        );
        await seek(time);
        const current = fingerprint();
        let sum = 0;
        for (let k = 0; k < current.length; k += 1) {
          const diff = current[k] - first[k];
          sum += diff * diff;
        }
        const score = sum / current.length;
        if (score < bestScore) {
          bestScore = score;
          bestTime = time;
        }
      }

      setEndSec(Number(bestTime.toFixed(2)));
      setNotice(
        t('fs.msg.loopFound', lang, { time: bestTime.toFixed(2), score: bestScore.toFixed(0) }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setScanningLoop(false);
      setProgressText('');
      void seek(startSec);
    }
  };

  /**
   * 对**磁盘上已保存的集合**找循环点并裁剪。
   *
   * 先用 dryRun 算一遍，把「会裁掉几帧」告诉用户，确认后才真正删文件 ——
   * 删除不可逆，不能点一下就动手。
   */
  const handleTrimLoopInDir = async (absPath: string, name: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    setProgressText(t('fs.progress.comparing', lang));
    try {
      const preview = await window.skeletonElf.files.trimLoop(absPath, true);
      if (!preview.ok) {
        setError(preview.error);
        return;
      }
      const { kept, removed, loopFrame, score } = preview.data;
      if (removed === 0) {
        setNotice(
          t('fs.msg.loopNone', lang, {
            name,
            frames: String(kept),
            per: String(loopFrame - 1),
            score: score.toFixed(0),
          }),
        );
        return;
      }
      const ok = window.confirm(
        t('fs.confirm.trim', lang, {
          name,
          frame: String(loopFrame),
          score: score.toFixed(0),
          kept: String(kept),
          removed: String(removed),
        }),
      );
      if (!ok) return;

      setProgressText(t('fs.progress.trimming', lang));
      const done = await window.skeletonElf.files.trimLoop(absPath, false);
      if (!done.ok) {
        setError(done.error);
        return;
      }
      setNotice(
        t('fs.msg.trimDone', lang, {
          name,
          kept: String(done.data.kept),
          removed: String(done.data.removed),
        }),
      );
      void loadProjects();
    } finally {
      setBusy(false);
      setProgressText('');
    }
  };

  /**
   * 在**已抽出的帧**里找循环点，并裁掉尾部多余的帧。
   *
   * 和 handleFindLoop 的区别：那个是在视频上找（抽帧前），这个是在帧序列上找（抽帧后）。
   * 用户可能不想抽帧前就做决定 —— 先抽一批，看完再决定循环到哪一帧为止。
   */
  const handleTrimLoop = async (): Promise<void> => {
    if (frames.length < 3) {
      setError(t('fs.err.tooFewFrames', lang));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgressText(t('fs.progress.comparingSeq', lang));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    try {
      if (!ctx) throw new Error(t('fs.err.noCanvas', lang));
      const SAMPLE = 24;
      const fingerprint = async (url: string): Promise<Float32Array | null> => {
        const image = await new Promise<HTMLImageElement | null>((resolve) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => resolve(null);
          element.src = url;
        });
        if (!image) return null;
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
        const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
        const out = new Float32Array(SAMPLE * SAMPLE);
        for (let i = 0; i < out.length; i += 1) {
          out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        }
        return out;
      };

      const first = await fingerprint(frames[0]);
      if (!first) throw new Error(t('fs.err.firstFrame', lang));

      let bestIndex = frames.length - 1;
      let bestScore = Infinity;
      // 从第 3 帧开始比（前两帧和首帧太近，比了没意义）
      for (let i = 2; i < frames.length; i += 1) {
        setProgressText(
          t('fs.progress.comparingN', lang, { current: String(i + 1), total: String(frames.length) }),
        );
        const current = await fingerprint(frames[i]);
        if (!current) continue;
        let sum = 0;
        for (let k = 0; k < current.length; k += 1) {
          const diff = current[k] - first[k];
          sum += diff * diff;
        }
        const score = sum / current.length;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const removed = frames.length - (bestIndex + 1);
      if (removed <= 0) {
        setNotice(
          t('fs.msg.loopNoneFrame', lang, {
            frame: String(bestIndex + 1),
            score: bestScore.toFixed(0),
          }),
        );
        return;
      }
      setFrames(frames.slice(0, bestIndex + 1));
      setPlayIndex(0);
      setNotice(
        t('fs.msg.loopTrimmed', lang, {
          frame: String(bestIndex + 1),
          score: bestScore.toFixed(0),
          removed: String(removed),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgressText('');
    }
  };

  /** 按当前参数抽帧（浏览器端解码，不需要 ffmpeg） */
  const handleExtract = async (): Promise<void> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      setError(t('fs.err.videoNotReady', lang));
      return;
    }
    if (video.videoWidth === 0) {
      setError(t('fs.err.videoSizeNotReady', lang));
      return;
    }
    // 时长没读到就抽帧只会得到 1 帧，这里直接拦掉
    const totalDuration = Number.isFinite(video.duration) ? video.duration : 0;
    if (totalDuration <= 0) {
      setError(t('fs.err.durationNotReady', lang));
      return;
    }
    const begin = Math.max(0, Math.min(startSec, totalDuration));
    // 勾了「抽帧前自动找循环点」就先定位循环处，把结束时间往后挪好再抽
    if (autoFindLoop) {
      await handleFindLoop();
    }
    const finish = Math.min(
      totalDuration,
      Math.max(begin + 0.1, endSec > 0 ? Math.min(endSec, totalDuration) : totalDuration),
    );
    /* 双边推进抽帧：
         前半段 —— 从起点按 1/fps 向后数
         后半段 —— 从终点向内倒推
       首帧精确落在 begin、末帧精确落在 finish（最少 2 帧就是首尾各一张）。
       中间帧按「区间长度 ÷ (总帧数-1)」均分 —— 现在是直接指定帧数，
       不再由 fps 反推，所以想要几帧就是几帧。 */
    const total = Math.min(maxFrames, Math.max(2, targetFrames));
    // 相邻两帧的时间间隔：首尾锚定后把区间等分
    const stepSec = total > 1 ? (finish - begin) / (total - 1) : 0;

    setBusy(true);
    setError(null);
    setNotice(null);
    setFrames([]);
    // 重新抽帧后，上一次的「已保存」提示就不再成立
    setSavedPath(null);
    setBackgroundRemoved(false);

    canvas.width = crop ? crop.w : video.videoWidth;
    canvas.height = crop ? crop.h : video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      setBusy(false);
      setError(t('fs.err.noCanvas', lang));
      return;
    }

    const captured: string[] = [];
    const wasMuted = video.muted;
    video.muted = true;

    const logs: string[] = [];
    logs.push(
      t('fs.log.video', lang, {
        width: String(canvas.width),
        height: String(canvas.height),
        duration: totalDuration.toFixed(2),
        ready: String(video.readyState),
      }),
    );
    logs.push(
      t('fs.log.range', lang, {
        begin: begin.toFixed(2),
        finish: finish.toFixed(2),
        frames: String(total),
        fps: String(fps),
      }),
    );
    // 首尾锚定：这两行能直接看出有没有丢帧
    logs.push(
      t('fs.log.anchors', lang, {
        last: (Math.max(begin, finish - 0.001) - begin).toFixed(3),
        length: (finish - begin).toFixed(3),
      }),
    );
    setDiag([...logs]);

    // 等待某一帧 seek 就绪，返回 true 表示走了超时兜底（说明 seeked 没触发）
    const seekTo = (time: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const onSeeked = (): void => finishOnce(false);
        const finishOnce = (fallback: boolean): void => {
          if (settled) return;
          settled = true;
          video.removeEventListener('seeked', onSeeked);
          resolve(fallback);
        };
        // 已经在这个位置：不会再触发 seeked，直接用当前画面
        if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) {
          resolve(false);
          return;
        }
        video.addEventListener('seeked', onSeeked);
        try {
          video.currentTime = time;
        } catch {
          /* 某些编码在未就绪时会抛，靠超时兜底 */
        }
        // 兜底：seeked 不触发也不卡死流程，1 秒后按当前画面抓
        window.setTimeout(() => finishOnce(true), 1000);
      });

    /* 直接产出 dataURL，不再走 blob URL。
       原因：blob URL 在 Electron 里用 fetch / XHR 都可能读不回来（「读取帧数据失败」），
       而自动保存又必须拿到真实字节。720×960 的 PNG 编码一帧约 30ms，
       49 帧多花 1.5 秒，换来的是绝对可靠。 */
    const captureBlob = (): Promise<[string, string]> =>
      new Promise<[string, string]>((resolve) => {
        let done = false;
        const finishOnce = (url: string, error = ''): void => {
          if (done) return;
          done = true;
          resolve([url, error]);
        };
        try {
          const dataUrl = canvas.toDataURL('image/png');
          finishOnce(
            dataUrl.startsWith('data:image/png') ? dataUrl : '',
            t('fs.err.toDataUrl', lang),
          );
        } catch (err) {
          finishOnce('', err instanceof Error ? err.message : String(err));
        }
      });

    const startedAt = performance.now();
    let fallbackCount = 0;
    let slowestMs = 0;

    /* 循环帧模式：抽帧时顺便生成每帧的结构指纹（32×32 RGB，去均值），
       抽完直接在前端算出循环点，不用再读一遍磁盘。
       算法和「找循环帧」页一致：多帧窗口比对 + 衔接惩罚。 */
    const printCanvas = document.createElement('canvas');
    printCanvas.width = 32;
    printCanvas.height = 32;
    const printCtx = printCanvas.getContext('2d', { willReadFrequently: true });
    const prints: Float32Array[] = [];
    const makePrint = (): Float32Array | null => {
      if (!printCtx) return null;
      printCtx.clearRect(0, 0, 32, 32);
      printCtx.drawImage(canvas, 0, 0, 32, 32);
      const data = printCtx.getImageData(0, 0, 32, 32).data;
      const out = new Float32Array(32 * 32 * 3);
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let i = 0; i < 1024; i += 1) {
        const p = i * 4;
        out[i] = data[p];
        out[1024 + i] = data[p + 1];
        out[2048 + i] = data[p + 2];
        sumR += data[p];
        sumG += data[p + 1];
        sumB += data[p + 2];
      }
      for (let i = 0; i < 1024; i += 1) {
        out[i] -= sumR / 1024;
        out[1024 + i] -= sumG / 1024;
        out[2048 + i] -= sumB / 1024;
      }
      return out;
    };

    for (let index = 0; index < total; index += 1) {
      /* 双边推进，但**首尾两帧是硬锚定的**，不参与任何 clamp：
           index = 0        → 精确 begin（视频/区间的第一个画面）
           index = total-1  → 贴着 finish（末帧，只退 1ms 避免 seek 卡在 duration 不出画面）
         中间帧按 stepSec 均分，前半段从起点往后数、后半段从终点往前数，
         两边各自累积误差，避免整段统一取整导致末帧对不上。 */
      let time: number;
      if (index === 0) {
        time = begin;
      } else if (index === total - 1) {
        time = Math.max(begin, finish - 0.001);
      } else if (index < total / 2) {
        time = Math.max(begin, begin + index * stepSec);
      } else {
        time = Math.min(finish - 0.001, finish - (total - 1 - index) * stepSec);
      }
      setProgressText(
        t('fs.progress.extract', lang, { current: String(index + 1), total: String(total) }),
      );
      const frameStart = performance.now();
      const fellBack = await seekTo(time);
      if (fellBack) fallbackCount += 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (crop) {
        // 只画选中的那块区域（源矩形 → 整张画布）
        ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      if (removeBg) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        keyOut(imageData, bgColor, tolerance);
        ctx.putImageData(imageData, 0, 0);
      }
      const [url, captureError] = await captureBlob();
      if (url) captured.push(url);
      // 指纹和 captured 一一对应，用于循环模式下算循环点
      const print = makePrint();
      if (print) prints.push(print);
      const cost = Math.round(performance.now() - frameStart);
      slowestMs = Math.max(slowestMs, cost);
      // 只记录前 5 帧、失败帧和明显偏慢的帧，避免刷屏
      if (index < 5 || cost > 400 || captureError) {
        logs.push(
          t('fs.log.frame', lang, {
            n: String(index + 1),
            cost: String(cost),
            fallback: fellBack ? t('fs.log.frameFallback', lang) : '',
            error: captureError ? ` ✗ ${captureError}` : '',
          }),
        );
        setDiag([...logs]);
      }
    }

    /* 循环帧模式：在前端算循环点，把尾部多余帧裁掉。
       判定逻辑和「找循环帧」页完全一致 —— 多帧窗口（4 帧）比对 + 衔接惩罚，
       所以不会出现「单帧碰巧像首帧」导致中间跳帧的问题。 */
    const diffOf = (a: Float32Array, b: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return sum / a.length;
    };

    /* 【去重】只在循环帧模式下做。
       为什么普通抽帧不能去重：游戏特效（爆炸、刀光、冲击波）经常有
       「几帧完全一样的预备帧 / 停留帧」，那是节奏的一部分，删掉会让特效变快、
       时间轴对不上。普通抽帧必须逐帧完整保留，首尾更不能动。
       循环帧模式才需要干净序列，方便找最小周期。 */
    let keptFrames: string[] = captured;
    let keptPrints: Float32Array[] = prints;
    if (captureMode === 'loop') {
      keptFrames = [];
      keptPrints = [];
      let dropped = 0;
      for (let i = 0; i < captured.length; i += 1) {
        const cur = prints[i];
        if (keptFrames.length === 0) {
          keptFrames.push(captured[i]);
          if (cur) keptPrints.push(cur);
          continue;
        }
        const prev = keptPrints[keptPrints.length - 1];
        // 0.6 很宽松：只有几乎一模一样才丢，避免误删真实的微小动作
        if (!cur || !prev || diffOf(prev, cur) > 0.6) {
          keptFrames.push(captured[i]);
          if (cur) keptPrints.push(cur);
        } else {
          dropped += 1;
        }
      }
      if (dropped > 0) logs.push(t('fs.log.dedup', lang, { count: String(dropped) }));
    }

    let loopCut = keptFrames.length;
    if (captureMode === 'loop' && keptPrints.length >= 3) {
      const WINDOW = 4;
      // 正常相邻帧的平均差异，作为「衔接是否突兀」的参照
      let neighborSum = 0;
      for (let i = 1; i < keptPrints.length; i += 1) {
        neighborSum += diffOf(keptPrints[i - 1], keptPrints[i]);
      }
      const baseline = keptPrints.length > 1 ? neighborSum / (keptPrints.length - 1) : 0;

      let bestIndex = keptPrints.length - 1;
      let bestScore = Infinity;
      for (let i = 2; i < keptPrints.length; i += 1) {
        let windowSum = 0;
        let windowCount = 0;
        for (let k = 0; k < WINDOW && i + k < keptPrints.length; k += 1) {
          windowSum += diffOf(keptPrints[i + k], keptPrints[k]);
          windowCount += 1;
        }
        if (windowCount === 0) continue;
        const forward = windowSum / windowCount;
        // 循环点前一帧接回首帧的跳变；超过正常相邻差异的 1.5 倍才罚分
        const jump = diffOf(keptPrints[i - 1], keptPrints[0]);
        const penalty = Math.max(0, jump - baseline * 1.5) * 0.8;
        const score = forward + penalty;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      loopCut = bestIndex + 1;
      logs.push(
        `循环帧：循环点在第 ${loopCut} 帧，保留 ${loopCut} 帧，裁掉 ${
          keptFrames.length - loopCut
        } 帧（差异 ${bestScore.toFixed(2)}，相邻基准 ${baseline.toFixed(2)}）`,
      );
    }

    logs.push(
      t('fs.log.done', lang, {
        count: String(captured.length),
        seconds: ((performance.now() - startedAt) / 1000).toFixed(1),
        fallback: String(fallbackCount),
        slowest: String(slowestMs),
      }),
    );
    setDiag([...logs]);

    video.muted = wasMuted;
    video.currentTime = begin;
    // 循环模式只留到循环点为止，正常模式全保留（正常模式下 keptFrames 就是全部帧）
    const finalFrames = loopCut < keptFrames.length ? keptFrames.slice(0, loopCut) : keptFrames;
    setFrames(finalFrames);
    setPlaying(false);
    setPlayIndex(0);
    setBackgroundRemoved(removeBg);
    setProgressText('');
    setBusy(false);
    setNotice(
      t('fs.msg.extracted', lang, {
        frames: String(finalFrames.length),
        bgRemoved: removeBg ? t('fs.msg.bgRemovedPart', lang) : '',
        loopCut: captureMode === 'loop' ? t('fs.msg.loopCutPart', lang) : '',
      }),
    );
    if (!projectName) {
      setProjectName((selected?.fileName ?? 'frames').replace(/\.[^.]+$/, ''));
    }
    /* 预览帧落盘到固定的 preview 目录：每次抽帧先清空再写，只占一份空间。
       preview 里存的是最终要用的帧（已去重、循环模式已裁），不是原始 captured。 */
    void savePreviewFrames(finalFrames, removeBg);
  };

  /**
   * 把预览帧写到固定的 preview 目录（每次覆盖）。
   *
   * 为什么固定目录：抽帧时会反复调帧率试效果，如果每次都新建集合，
   * data/frames/sources 里很快就堆满废目录。固定一个 preview 反复覆盖，
   * 只有用户点「保存为集合」才真正产生新集合。
   */
  const savePreviewFrames = async (frameList: string[], removed: boolean): Promise<void> => {
    if (frameList.length === 0) return;
    try {
      // 先删掉上一轮预览（不存在也没关系）
      await window.skeletonElf.frames.remove('_preview');
      const res = await window.skeletonElf.frames.save({
        name: '_preview',
        sourceVideo: selected?.fileName ?? '',
        fps,
        width: videoSize.width,
        height: videoSize.height,
        backgroundRemoved: removed,
        frames: frameList,
      });
      if (!res.ok) {
        setError(t('fs.err.previewSaveFailed', lang, { error: res.error }));
        return;
      }
      setLastSavedId(res.data.id);
      void loadProjects();
    } catch (err) {
      setError(
        t('fs.err.previewSaveFailed', lang, {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  /**
   * 把编辑器里的去背景设置套用到全部帧。
   * 注意：这里用的是「多颜色欧氏距离」简化算法，与编辑器内的 HSL 色相优先算法略有差异，
   * 但背景是纯色时结果基本一致；精细的个别帧仍可再用编辑器单帧修。
   */
  const handleApplySettingsToAll = (params: EditorKeyParams): void => {
    if (frames.length === 0) return;
    setEditingIndex(null);
    setEditingMeta(null);
    setBusy(true);
    setNotice(null);

    void (async () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        setBusy(false);
        return;
      }
      const next: string[] = [];
      const limit = params.tolerance * params.tolerance * 3;

      for (const url of frames) {
        const image = await new Promise<HTMLImageElement | null>((resolve) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => resolve(null);
          element.src = url;
        });
        if (!image) continue;
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = data.data;

        // 亮度（与编辑器一致：100 = 不变）
        if (params.brightness !== 100) {
          const factor = params.brightness / 100;
          for (let i = 0; i < px.length; i += 4) {
            px[i] = Math.min(255, Math.round(px[i] * factor));
            px[i + 1] = Math.min(255, Math.round(px[i + 1] * factor));
            px[i + 2] = Math.min(255, Math.round(px[i + 2] * factor));
          }
        }

        // 多颜色色键
        if (params.colors.length > 0) {
          for (let i = 0; i < px.length; i += 4) {
            for (const color of params.colors) {
              const dr = px[i] - color.r;
              const dg = px[i + 1] - color.g;
              const db = px[i + 2] - color.b;
              if (dr * dr + dg * dg + db * db <= limit) {
                px[i + 3] = 0;
                break;
              }
            }
          }
        }

        // 边缘收缩：alpha 向内收 N 像素（消白边）
        if (params.edgeTrim > 0) {
          for (let pass = 0; pass < params.edgeTrim; pass += 1) {
            const alpha = new Uint8Array(canvas.width * canvas.height);
            for (let i = 0, p = 0; i < px.length; i += 4, p += 1) alpha[p] = px[i + 3];
            for (let y = 0; y < canvas.height; y += 1) {
              for (let x = 0; x < canvas.width; x += 1) {
                const index = y * canvas.width + x;
                if (alpha[index] === 0) continue;
                const left = x > 0 ? alpha[index - 1] : 0;
                const right = x < canvas.width - 1 ? alpha[index + 1] : 0;
                const up = y > 0 ? alpha[index - canvas.width] : 0;
                const down = y < canvas.height - 1 ? alpha[index + canvas.width] : 0;
                if (left === 0 || right === 0 || up === 0 || down === 0) px[index * 4 + 3] = 0;
              }
            }
          }
        }

        ctx.putImageData(data, 0, 0);
        const blobUrl = await new Promise<string>((resolve) => {
          canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : ''), 'image/png');
        });
        if (blobUrl) next.push(blobUrl);
      }

      setFrames(next);
      setBackgroundRemoved(true);
      setBusy(false);
      setNotice(
        t('fs.msg.appliedAll', lang, {
          frames: String(next.length),
          colors: String(params.colors.length),
          tolerance: String(params.tolerance),
          edge: String(params.edgeTrim),
          despill: String(params.despill),
        }),
      );
    })();
  };

  /** 对已抽出的帧重新执行去背景 / 取消去背景需要重抽，这里只做「应用去背景」 */
  const handleApplyBackground = (): void => {
    if (frames.length === 0) return;
    setBusy(true);
    setNotice(null);
    window.setTimeout(() => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        setBusy(false);
        return;
      }
      const next: string[] = [];
      const image = new Image();
      let index = 0;
      const stepFrame = (): void => {
        if (index >= frames.length) {
          setFrames(next);
          setBackgroundRemoved(true);
          setBusy(false);
          setNotice(
            t('fs.msg.keyApplied', lang, {
              count: String(next.length),
              color: hexOf(bgColor),
              tolerance: String(tolerance),
            }),
          );
          return;
        }
        image.onload = () => {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          keyOut(data, bgColor, tolerance);
          ctx.putImageData(data, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) next.push(URL.createObjectURL(blob));
            index += 1;
            stepFrame();
          }, 'image/png');
        };
        image.src = frames[index];
      };
      stepFrame();
    }, 30);
  };

  const handleSave = async (): Promise<void> => {
    if (frames.length === 0) {
      setError(t('fs.err.noFrames', lang));
      return;
    }
    /* 重名不覆盖：自动加 -2、-3 后缀，和抽帧后的自动保存行为保持一致。
       用户可能故意重抽同一个视频对比不同帧率，覆盖掉上一次的结果是灾难。 */
    const baseName = (projectName.trim() || selected?.fileName || 'frames').replace(/\.[^.]+$/, '');
    let desiredName = baseName;
    let suffix = 2;
    const taken = new Set(projects.map((project) => project.name.toLowerCase()));
    while (taken.has(desiredName.toLowerCase())) {
      desiredName = `${baseName}-${suffix}`;
      suffix += 1;
    }
    setSaving(true);
    setError(null);
    // 预览用的是 blob URL，保存时才转成 dataURL 交给主进程落盘
    const dataUrls: string[] = [];
    for (let index = 0; index < frames.length; index += 1) {
      const url = frames[index];
      if (url.startsWith('data:')) {
        dataUrls.push(url);
        continue;
      }
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(t('fs.err.convertFailed', lang)));
          reader.readAsDataURL(blob);
        });
        dataUrls.push(dataUrl);
      } catch {
        setSaving(false);
        setError(t('fs.err.frameConvertFailed', lang, { index: String(index + 1) }));
        return;
      }
    }
    const res = await window.skeletonElf.frames.save({
      // 用上面算好的 desiredName（重名时已自动加 -2/-3 后缀），否则还是会覆盖
      name: desiredName,
      sourceVideo: selected?.fileName ?? '',
      fps,
      width: videoSize.width,
      height: videoSize.height,
      backgroundRemoved,
      frames: dataUrls,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(
      t('fs.save.saved', lang, {
        count: String(res.data.frameCount),
        path: res.data.absPath,
      }),
    );
    setSavedPath(res.data.absPath);
    setProjectName('');
    // 新增了帧集合：本页列表 + 批量抠图页的集合列表都要刷新
    void loadProjects();
    notifyDataChanged();
  };

  /**
   * 手动删掉某一帧。
   * 只改内存里的 frames，同时把 _preview 重写一份保持同步；
   * 正式集合要等用户再点「保存为集合」才会带上这个改动。
   */
  const handleRemoveFrame = (index: number): void => {
    // 一帧不构成动画：低于 2 帧就没法播、没法找循环，直接拦住
    if (frames.length <= 2) {
      setError(t('fs.msg.needTwo', lang));
      return;
    }
    const next = frames.filter((_, i) => i !== index);
    setFrames(next);
    setPlaying(false);
    setPlayIndex((current) => Math.min(current, next.length - 1));
    // 帧数变了，「已保存」提示不再对应当前内容
    setSavedPath(null);
    void savePreviewFrames(next, backgroundRemoved);
  };

  const handleRemoveProject = async (id: string): Promise<void> => {
    if (!window.confirm(t('fs.confirm.removeProject', lang, { name: id }))) return;
    const res = await window.skeletonElf.frames.remove(id);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    void loadProjects();
    notifyDataChanged();
  };

  /**
   * 重命名帧集合（改的是磁盘文件夹名）。
   * 重名时后端直接报错、不覆盖，这里把错误原样弹出来。
   */
  const handleRenameProject = async (id: string): Promise<void> => {
    const next = renameValue.trim();
    if (!next || next === id) {
      setRenamingId(null);
      setRenameValue('');
      return;
    }
    const res = await window.skeletonElf.frames.rename(id, next);
    if (!res.ok) {
      setError(t('fs.rename.failed', lang, { error: res.error }));
      return;
    }
    setRenamingId(null);
    setRenameValue('');
    void loadProjects();
    // 集合名变了：批量抠图页 / 循环裁剪页里引用的旧名字也要跟着刷
    notifyDataChanged();
  };

  /**
   * 取消选中的视频。
   *
   * 不只是把 selected 置空 —— 之前抽出来的帧、预览播放、诊断信息、「已保存」提示
   * 都是围绕那个视频产生的，留着就成了「视频没选了但画面还在」，所以一起清掉。
   * 顺带删掉磁盘上的临时预览集合 _preview（它本来就不该长期存在）。
   */
  const handleClearSelection = (): void => {
    setSelected(null);
    setFrames([]);
    setPlaying(false);
    setPlayIndex(0);
    setSavedPath(null);
    setBackgroundRemoved(false);
    setDiag([]);
    setNotice(null);
    setError(null);
    setProgressText('');
    setDuration(0);
    setVideoSize({ width: 0, height: 0 });
    setStartSec(0);
    setEndSec(0);
    setProjectName('');
    // 临时预览目录删掉；失败无所谓，下次抽帧会重建
    void window.skeletonElf.frames.remove('_preview').then(() => loadProjects());
  };
  const extractedSummary = useMemo(() => {
    if (frames.length === 0) return '';
    return t('fs.summary.extracted', lang, {
      frames: String(frames.length),
      width: String(videoSize.width),
      height: String(videoSize.height),
      fps: String(fps),
    });
  }, [frames.length, videoSize, fps, lang]);

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>{t('fs.title', lang)}</h2>
            <span className="tag">{t('fs.videoCount', lang, { count: String(videos.length) })}</span>
          </div>

          <div className="field">
            <span className="field__label">{t('fs.pickVideo', lang)}</span>
            {selected ? (
              <div className="ref-strip">
                <code className="ref-strip__name" title={selected.absPath}>
                  {selected.fileName}
                </code>
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(true)}>
                  {t('fs.changeVideo', lang)}
                </button>
                {/* 取消选择：视频、已经抽出来的帧、预览播放状态一起清掉，
                    否则会出现「视频没选了，画面和预览还留在下面」 */}
                <button type="button" className="btn btn--ghost" onClick={handleClearSelection}>
                  {t('fs.clearSelection', lang)}
                </button>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(true)}>
                  {t('fs.pickVideoBtn', lang)}
                </button>
                {videos.length === 0 ? (
                  <span className="field__hint">{t('fs.noVideos', lang)}</span>
                ) : null}
              </div>
            )}
            {selected ? (
              <span className="field__hint">
                {duration > 0
                  ? t('fs.videoMeta', lang, {
                      duration: duration.toFixed(2),
                      width: String(videoSize.width),
                      height: String(videoSize.height),
                    })
                  : videoLoading
                    ? t('fs.videoLoading', lang)
                    : metaTimeout
                      ? t('fs.videoTimeout', lang)
                      : t('fs.videoInfoLoading', lang)}
              </span>
            ) : null}
            {videoFallback ? (
              <div className="banner banner--error">{t('fs.videoFallback', lang)}</div>
            ) : null}
          </div>

          {selected ? (
            <>
              <div className="frame-video-wrap">
                <video
                  ref={videoRef}
                  /* blob URL 与页面同源，不需要 crossOrigin，画到 canvas 也不会污染 */
                  src={videoUrl || undefined}
                  className="frame-video"
                  playsInline
                  /* 只预取元数据：auto 会立刻拉整个文件，选视频时会卡很久 */
                  preload="metadata"
                  onLoadedMetadata={handleMeta}
                  /* 自绘播放条靠这些事件同步状态（原生 controls 已关掉） */
                  onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
                  onPlay={() => setVideoPlaying(true)}
                  onPause={() => setVideoPlaying(false)}
                  onEnded={() => setVideoPlaying(false)}
                  onVolumeChange={(event) => setVideoMuted(event.currentTarget.muted)}
                  onError={() => {
                    const code = videoRef.current?.error?.code ?? 0;
                    const reason = t(
                      code === 1
                        ? 'fs.video.err1'
                        : code === 2
                          ? 'fs.video.err2'
                          : code === 3
                            ? 'fs.video.err3'
                            : code === 4
                              ? 'fs.video.err4'
                              : 'fs.video.errUnknown',
                      lang,
                    );
                    setError(t('fs.video.loadFailed', lang, { code: String(code), reason }));
                    setMetaTimeout(true);
                  }}
                />

                {/* 已选裁剪范围：常亮显示，纯预览不接鼠标（框选在弹窗里做） */}
                {crop && videoSize.width > 0 && videoSize.height > 0 ? (
                  <div className="crop-preview">
                    <div
                      className="crop-rect"
                      style={{
                        left: `${(crop.x / videoSize.width) * 100}%`,
                        top: `${(crop.y / videoSize.height) * 100}%`,
                        width: `${(crop.w / videoSize.width) * 100}%`,
                        height: `${(crop.h / videoSize.height) * 100}%`,
                      }}
                    >
                      <span className="crop-rect__size">
                        {crop.w}×{crop.h}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* 自绘播放条：配色走主题令牌，和原生那套深灰半透明不搭的问题一次解决 */}
              <div className="video-bar">
                <button
                  type="button"
                  className="video-bar__btn video-bar__btn--play"
                  onClick={togglePlay}
                  title={videoPlaying ? t('fs.video.pause', lang) : t('fs.video.play', lang)}
                >
                  {videoPlaying ? t('fs.video.pauseIcon', lang) : t('fs.video.playIcon', lang)}
                </button>
                <span className="video-bar__time">{videoTime.toFixed(2)}s</span>
                <input
                  className="range video-bar__range"
                  type="range"
                  min={0}
                  max={Math.max(0.01, duration || 0)}
                  step={0.01}
                  value={Math.min(videoTime, duration || 0)}
                  onChange={(event) => seekTo(Number(event.target.value))}
                  title={t('fs.video.seekTitle', lang)}
                />
                <span className="video-bar__time">{duration.toFixed(2)}s</span>
                <button
                  type="button"
                  className="video-bar__btn"
                  onClick={toggleMute}
                  title={videoMuted ? t('fs.video.unmute', lang) : t('fs.video.mute', lang)}
                >
                  {videoMuted ? '🔇' : '🔊'}
                </button>
                <button
                  type="button"
                  className="video-bar__btn"
                  onClick={toggleFullscreen}
                  title={t('fs.video.fullscreen', lang)}
                >
                  ⛶
                </button>
              </div>

              <span className="field__hint">
                可以直接播放看效果，也可以拖进度条定位后再点「从此处设为起点 / 终点」。
                <br />
                只想抽角色那一块？点下面「裁剪范围…」，在弹出的窗口里框选或输入尺寸。
                {crop ? (
                  <>
                    {' '}
                    {t('fs.cropActive', lang, { w: String(crop.w), h: String(crop.h) })}{' '}
                    <button type="button" className="link-btn" onClick={() => setCrop(null)}>
                      {t('fs.cropReset', lang)}
                    </button>
                  </>
                ) : (
                  t('fs.cropNone', lang)
                )}
              </span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setCropModalOpen(true)}>
                  {t('fs.cropOpen', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setStartSec(Number((videoRef.current?.currentTime ?? 0).toFixed(2)))}
                >
                  {t('fs.setStart', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setEndSec(Number((videoRef.current?.currentTime ?? 0).toFixed(2)))}
                >
                  {t('fs.setEnd', lang)}
                </button>
              </div>

              {cropModalOpen ? (
                <VideoCropModal
                  videoUrl={videoUrl}
                  videoSize={videoSize}
                  initialCrop={crop}
                  onCancel={() => setCropModalOpen(false)}
                  onConfirm={(next) => {
                    setCrop(next);
                    setCropModalOpen(false);
                  }}
                />
              ) : null}
            </>
          ) : null}
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          <div className="studio-params">
            <label className="field">
              <span className="field__label">
                {t('fs.startTime', lang)} <em className="field__saved">{startSec.toFixed(2)}s</em>
              </span>
              <input
                className="input"
                type="number"
                min={0}
                max={duration || 0}
                step={0.1}
                value={startSec}
                onChange={(event) => setStartSec(Math.max(0, Number(event.target.value) || 0))}
              />
            </label>
            <label className="field">
              <span className="field__label">
                {t('fs.endTime', lang)} <em className="field__saved">{endSec.toFixed(2)}s</em>
              </span>
              <input
                className="input"
                type="number"
                min={0}
                max={duration || 0}
                step={0.1}
                value={endSec}
                onChange={(event) => setEndSec(Math.max(0, Number(event.target.value) || 0))}
              />
            </label>
            <label className="field">
              <span className="field__label">
                {t('fs.targetFrames', lang)}{' '}
                <em className="field__saved">
                  {t('fs.list.frames', lang, { count: String(Math.min(maxFrames, Math.max(2, targetFrames))) })}
                </em>
              </span>
              <input
                className="range"
                type="range"
                min={2}
                max={Math.max(2, Math.min(300, maxFrames))}
                step={1}
                value={Math.min(maxFrames, Math.max(2, targetFrames))}
                onChange={(event) => setTargetFrames(Number(event.target.value))}
              />
              <span className="field__hint">{t('fs.targetHint', lang)}</span>
            </label>
            <label className="field">
              <span className="field__label">
                {t('fs.fps', lang)} <em className="field__saved">{fps} fps</em>
              </span>
              <input
                className="range"
                type="range"
                min={1}
                max={30}
                step={1}
                value={fps}
                onChange={(event) => setFps(Number(event.target.value))}
              />
              <span className="field__hint">{t('fs.fpsHint', lang)}</span>
            </label>
            <label className="field">
              <span className="field__label">
                {t('fs.maxFrames', lang)} <em className="field__saved">{maxFrames}</em>
              </span>
              <input
                className="input"
                type="number"
                min={2}
                max={300}
                value={maxFrames}
                onChange={(event) => setMaxFrames(Math.max(2, Math.min(300, Number(event.target.value) || 60)))}
              />
            </label>
          </div>

          {/* 抽帧分类：决定尾部怎么处理 —— 完整保留，还是裁到能无缝循环 */}
          <label className="field">
            <span className="field__label">{t('fs.mode', lang)}</span>
            <select
              className="input select"
              value={captureMode}
              onChange={(event) =>
                setCaptureMode(event.target.value === 'loop' ? 'loop' : 'normal')
              }
              disabled={busy}
            >
              <option value="normal">{t('fs.mode.normal', lang)}</option>
              <option value="loop">{t('fs.mode.loop', lang)}</option>
            </select>
            <span className="field__hint">
              {captureMode === 'normal' ? t('fs.mode.normalHint', lang) : t('fs.mode.loopHint', lang)}
            </span>
          </label>

          {/* 预计数量：抽帧前就知道会出多少帧，避免抽完才发现太多或太少 */}
          <div className="frame-estimate">
            <span>
              {t('fs.estimate', lang, {
                count: String(Math.min(maxFrames, Math.max(2, targetFrames))),
              })}
            </span>
            <span className="field__hint">
              {t('fs.estimateRange', lang, { seconds: (endSec - startSec).toFixed(2) })}
              {targetFrames > maxFrames
                ? t('fs.estimateCapped', lang, { max: String(maxFrames) })
                : ''}
              {Math.min(maxFrames, Math.max(2, targetFrames)) <= 2
                ? t('fs.estimateOnlyTwo', lang)
                : ''}
            </span>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoFindLoop}
              onChange={(event) => setAutoFindLoop(event.target.checked)}
              disabled={busy}
            />
            {t('fs.autoLoop', lang)}
          </label>

          <span className="field__hint">{t('fs.extractHint', lang)}</span>

          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleExtract()}
              disabled={busy || !selected}
            >
              {busy && progressText ? progressText : busy ? t('fs.extracting', lang) : t('fs.extract', lang)}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void handleFindLoop()}
              disabled={busy || !selected || autoFindLoop}
              title={t('fs.autoLoopTitle', lang)}
            >
              {scanningLoop ? t('fs.findingLoop', lang) : t('fs.findLoop', lang)}
            </button>
            {frames.length > 0 ? (
              <span className="field__hint">{t('fs.matteHint', lang)}</span>
            ) : null}
            {extractedSummary ? <span className="field__hint">{extractedSummary}</span> : null}
          </div>

          {error ? <div className="banner banner--error">{error}</div> : null}
          {notice ? (
            <div className="banner banner--ok banner--with-action">
              <span>{notice}</span>
              {lastSavedId ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void window.skeletonElf.frames.openDir(lastSavedId)}
                >
                  {t('fs.list.openDir', lang)}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 抽帧诊断：卡住时把这段截图发出来就能定位 */}
          {diag.length > 0 ? (
            <details className="frame-diag" open={busy}>
              <summary>抽帧诊断（{diag.length} 条）</summary>
              <pre>{diag.join('\n')}</pre>
            </details>
          ) : null}
        </section>

        {frames.length > 0 ? (
          <section className="card">
            <div className="card__head">
              <h2>{t('fs.preview.title', lang)}</h2>
              <span className="tag">
                {t('fs.list.frames', lang, { count: String(frames.length) })}
                {backgroundRemoved ? ` · ${t('fs.preview.bgRemoved', lang)}` : ''}
              </span>
            </div>

            {/* 播放预览：按当前 fps 循环播放，直接看动画效果 */}
            <div className="frame-player">
              <div className="frame-player__stage">
                <img
                  src={frames[Math.min(playIndex, frames.length - 1)]}
                  alt={t('fs.preview.title', lang)}
                />
              </div>
              <div className="frame-player__bar">
                <button
                  type="button"
                  className={`btn ${playing ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setPlaying((prev) => !prev)}
                >
                  {playing ? t('fs.video.pauseIcon', lang) : t('fs.video.playIcon', lang)}
                </button>
                <input
                  className="range frame-player__scrub"
                  type="range"
                  min={0}
                  max={Math.max(0, frames.length - 1)}
                  value={Math.min(playIndex, frames.length - 1)}
                  onChange={(event) => {
                    setPlaying(false);
                    setPlayIndex(Number(event.target.value));
                  }}
                />
                <span className="field__saved">
                  {t('lt.frameOf', lang, {
                    index: String(Math.min(playIndex, frames.length - 1) + 1),
                    total: String(frames.length),
                  })}{' '}
                  · {fps} fps
                </span>
                <select
                  className="input select frame-player__speed"
                  value={playSpeed}
                  onChange={(event) => setPlaySpeed(Number(event.target.value))}
                  title={t('fs.preview.speed', lang)}
                >
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                  <option value={8}>8×</option>
                </select>
              </div>
            </div>

            <div className="frame-grid">
              {frames.map((url, index) => (
                <figure
                  key={index}
                  className={`frame-item${index === playIndex ? ' is-active' : ''}`}
                >
                  <img
                    src={url}
                    alt={`frame ${index}`}
                    onClick={() => {
                      setPlaying(false);
                      setPlayIndex(index);
                    }}
                  />
                  <figcaption>
                    <span>{String(index).padStart(3, '0')}</span>
                    <button
                      type="button"
                      className="frame-item__edit"
                      title={t('fs.preview.editTitle', lang)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingIndex(index);
                        setEditingMeta({
                          dataUrl: frames[index],
                          width: videoSize.width || 1,
                          height: videoSize.height || 1,
                        });
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="frame-item__edit"
                      title={t('fs.preview.delTitle', lang)}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRemoveFrame(index);
                      }}
                    >
                      ×
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        ) : null}

        {frames.length > 0 ? (
          <section className="card">
            <div className="card__head">
              <h2>{t('fs.save.title', lang)}</h2>
            </div>
            <label className="field">
              <span className="field__label">{t('fs.save.nameLabel', lang)}</span>
              <input
                className="input"
                value={projectName}
                placeholder={t('fs.save.namePlaceholder', lang)}
                onChange={(event) => setProjectName(event.target.value)}
              />
              <span className="field__hint">{t('fs.save.hint', lang)}</span>
            </label>
            <div className="actions">
              <button
                type="button"
                className={`btn ${savedPath && !saving ? 'btn--ok' : 'btn--primary'}`}
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving
                  ? t('fs.save.saving', lang)
                  : savedPath
                    ? t('fs.save.savedBadge', lang)
                    : t('fs.save.btnCount', lang, { count: String(frames.length) })}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void window.skeletonElf.frames.openDir()}>
                {t('fs.save.openDir', lang)}
              </button>
            </div>
            {savedPath ? (
              <span className="field__hint field__hint--ok">
                {t('fs.save.saved', lang, { count: String(frames.length), path: savedPath })}
              </span>
            ) : null}
          </section>
        ) : null}
      </div>

      <div className="stack frame-sidebar">
        <section className="card">
          <div className="card__head">
            <h2>{t('fs.list.title', lang)}</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              {t('fs.refresh', lang)}
            </button>
          </div>
          {projects.length === 0 ? (
            <p className="muted">{t('fs.list.empty', lang)}</p>
          ) : (
            <div className="frame-projects">
              {projects.map((project) => (
                <div key={project.id} className="frame-project">
                  <div className="frame-project__head">
                    {renamingId === project.id ? (
                      <input
                        className="input"
                        value={renameValue}
                        autoFocus
                        placeholder={t('fs.rename.placeholder', lang)}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void handleRenameProject(project.id);
                          if (event.key === 'Escape') {
                            setRenamingId(null);
                            setRenameValue('');
                          }
                        }}
                      />
                    ) : (
                      <strong>{project.name}</strong>
                    )}
                    <span className="tag">
                      {t('fs.list.frames', lang, { count: String(project.frameFileNames.length) })}
                    </span>
                  </div>
                  <div className="frame-project__thumbs">
                    {project.frameUrls.slice(0, 6).map((url) => (
                      <img
                        key={url}
                        src={url}
                        alt={project.name}
                        /* 文件被手动删掉时不要显示成破图标，直接隐藏 */
                        onError={(event) => {
                          event.currentTarget.style.display = 'none';
                        }}
                      />
                    ))}
                  </div>
                  <span className="field__hint">
                    {project.fps} fps · {project.width}×{project.height} ·{' '}
                    {project.sourceVideo || t('fs.unknownSource', lang)}
                    {project.backgroundRemoved ? ` · ${t('fs.preview.bgRemoved', lang)}` : ''}
                  </span>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => setPreviewProject(project)}
                    >
                      {t('fs.list.play', lang)}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      title={project.absPath}
                      onClick={() => void window.skeletonElf.frames.openDir(project.id)}
                    >
                      {t('fs.list.openDir', lang)}
                    </button>
                    {renamingId === project.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => void handleRenameProject(project.id)}
                        >
                          {t('fs.rename.confirm', lang)}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            setRenamingId(null);
                            setRenameValue('');
                          }}
                        >
                          {t('fs.rename.cancel', lang)}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => {
                          setRenamingId(project.id);
                          setRenameValue(project.name);
                        }}
                        title={t('fs.rename.title', lang)}
                      >
                        {t('fs.list.rename', lang)}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger"
                      onClick={() => void handleRemoveProject(project.id)}
                    >
                      {t('fs.list.remove', lang)}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 播放预览窗口：从集合卡片点「播放预览」打开 */}
      {previewProject ? (
        <FramePlayerModal
          title={`${previewProject.name} · ${t('fs.list.frames', lang, {
            count: String(previewProject.frameFileNames.length),
          })}`}
          frameUrls={previewProject.frameUrls}
          fps={previewProject.fps}
          onClose={() => setPreviewProject(null)}
        />
      ) : null}

      {/* 视频选择弹窗 */}
      {pickerOpen ? (
        /* 必须套 modal-backdrop：它才是 position:fixed 的全屏遮罩。
           少了这层，弹窗会掉进页面底部的正常流里，用户得滚下去才看得见。 */
        <div className="modal-backdrop">
          <div className="modal">
            <header className="modal__head">
              <h2>{t('fs.picker.title', lang)}</h2>
              <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                ×
              </button>
            </header>
            <div className="modal__body">
              {videos.length === 0 ? (
                <p className="muted">{t('fs.picker.empty', lang)}</p>
              ) : (
                <div className="picker-grid">
                  {videos.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`picker-item${selected?.id === item.id ? ' is-active' : ''}`}
                      title={item.fileName}
                      onClick={() => {
                        setSelected(item);
                        setFrames([]);
                        setPickerOpen(false);
                      }}
                    >
                      {item.thumbUrl ? (
                        <img src={item.thumbUrl} alt={item.fileName} />
                      ) : (
                        <video
                          src={item.mediaUrl}
                          muted
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={(event) => {
                            const element = event.currentTarget;
                            if (element.duration > 0.2) element.currentTime = 0.1;
                          }}
                        />
                      )}
                      <span className="picker-item__name">{item.fileName}</span>
                      {selected?.id === item.id ? <span className="picker-item__badge">✓</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">{t('fs.picker.foot', lang)}</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                  {t('fs.btn.cancel', lang)}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      {/* 帧编辑：只改内存里的这一帧，点「保存」才写盘 */}
      {editingIndex !== null && editingMeta ? (
        <ImageEditorModal
          image={{
            absPath: '',
            fileName: `frame_${String(editingIndex).padStart(3, '0')}.png`,
            dataUrl: editingMeta.dataUrl,
            width: editingMeta.width,
            height: editingMeta.height,
            bytes: 0,
            backgroundColor: '',
          }}
          onClose={() => {
            setEditingIndex(null);
            setEditingMeta(null);
          }}
          onSaved={() => undefined}
          onApply={(pngDataUrl) => {
            const target = editingIndex;
            setFrames((prev) => prev.map((url, index) => (index === target ? pngDataUrl : url)));
            setEditingIndex(null);
            setEditingMeta(null);
            setNotice(
              t('fs.msg.frameUpdated', lang, {
                frame: String(target + 1),
                total: String(frames.length),
              }),
            );
          }}
        />
      ) : null}
    </div>
  );
}
