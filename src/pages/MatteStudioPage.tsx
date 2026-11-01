import { useCallback, useEffect, useRef, useState } from 'react';
import type { FrameOutputView, FrameProjectView } from '@shared/ipc';
import { FramePlayerModal } from '../components/FramePlayerModal';
import { setBusy, setProgress, tryStart } from '../state/busy';
import { notifyDataChanged, useDataRefresh } from '../state/refresh';
import { t, useLang, type Lang } from '../i18n';

/**
 * 批量抠图页（独立页面）。
 *
 * 为什么单独一页：批量操作有模型选择、并行数、进度、强制结束，塞进帧动画页会把那边的
 * UI 挤乱。这里只管「挑一个帧集合 → 挑模型 → 跑」，结果是输出到同级目录的副本。
 *
 * 注意：**模型抠图不需要任何颜色参数**。模型自己会识别前景，背景色/容差是「传统抠图」
 * 才需要的东西，两者不混在一起。
 */

/** 各模型在 CPU 上单张耗时（秒），用于预估总时间 */
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

/**
 * 打包版内置的模型（和 scripts/prune-models.mjs 的白名单一致）。
 * 下拉里这几个标「打包内置」并高亮；其余只用于开发时对比测试，发布包里没有。
 */
export const SHIPPED_MODELS = new Set([
  'u2net',
  'isnet-general-use',
  'birefnet-general-lite',
  'birefnet-general',
]);

/** 下拉里的候选模型；实际可用性由 localModels（扫 data/models）决定 */
const MODEL_OPTIONS: { name: string; noteKey: string }[] = [
  { name: 'u2net', noteKey: 'mt.note.u2net' },
  { name: 'birefnet-general-lite', noteKey: 'mt.note.birefnetLite' },
  { name: 'birefnet-general', noteKey: 'mt.note.birefnetGeneral' },
  { name: 'isnet-general-use', noteKey: 'mt.note.isnet' },
  { name: 'isnet-anime', noteKey: 'mt.note.isnetAnime' },
  { name: 'birefnet-fp16', noteKey: 'mt.note.birefnetFp16' },
  { name: 'birefnet-lite-512', noteKey: 'mt.note.birefnetLite512' },
  { name: 'birefnet-toonout', noteKey: 'mt.note.birefnetToonout' },
  { name: 'bria-rmbg', noteKey: 'mt.note.briaRmbg' },
  { name: 'ben2', noteKey: 'mt.note.ben2' },
];

export function MatteStudioPage(): React.JSX.Element {
  const [lang] = useLang();
  const [projects, setProjects] = useState<FrameProjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [model, setModel] = useState('u2net');
  /** 本地已下载的模型；没下载的选了一跑就去 GitHub 拉，网络差直接超时 */
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [workers, setWorkers] = useState(1);
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);
  /** 用户是否手动点过「取消选择」—— 取消后不再被自动选回第一个集合 */
  const userClearedRef = useRef(false);
  /** 本轮任务是否被用户手动停止（避免停止后又被「已抠 N 帧」的成功提示盖掉） */
  const cancelledRef = useRef(false);
  /** 集合选择弹窗（下拉框看不出缩略图，改成弹窗） */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 正在播放预览的抠图结果（null = 没打开播放窗口） */
  const [previewOutput, setPreviewOutput] = useState<{
    title: string;
    frameUrls: string[];
    fps: number;
  } | null>(null);
  /** 右边结果列表里正在改名的目录名（null = 没在改名） */
  const [renamingOutput, setRenamingOutput] = useState<string | null>(null);
  /** 改名输入框当前内容（只填基名，-matte / -key 后缀后端会自动补） */
  const [renameOutputValue, setRenameOutputValue] = useState('');

  /* 顶部提示只保留几秒就自动消失。
     不这么做的话，上一次操作的记号（比如「已删除『xxx』」）会一直挂在界面上，
     强制结束或开始新任务时看着像本次操作的反馈，很容易误读。 */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /**
   * 抠图方式：
   *   model —— 官方 rembg，模型自己识别前景，**不需要任何颜色参数**
   *   key   —— 传统颜色键控，必须告诉它背景色和容差
   */
  const [mode, setMode] = useState<'model' | 'key'>('model');
  /** 传统抠图参数（只在 mode==='key' 时显示） */
  const [keyColor, setKeyColor] = useState({ r: 255, g: 0, b: 255 });
  const [keyTolerance, setKeyTolerance] = useState(20);
  const [keyMode, setKeyMode] = useState<'global' | 'connected'>('connected');
  const [keyEdgeTrim, setKeyEdgeTrim] = useState(0);
  const [keyHint, setKeyHint] = useState<string | null>(null);

  /** 抠图结果：独立扫 outputs/，不依赖源集合是否还在 */
  const [outputs, setOutputs] = useState<FrameOutputView[]>([]);

  const loadProjects = useCallback(async (): Promise<void> => {
    // 两个列表分开取：源集合（选谁去抠）和抠图结果（产出），互不影响
    const [projectRes, outputRes] = await Promise.all([
      window.skeletonElf.frames.list(),
      window.skeletonElf.frames.listOutputs(),
    ]);
    if (!projectRes.ok) {
      setError(projectRes.error);
      return;
    }
    if (outputRes.ok) {
      setOutputs(outputRes.data);
    }
    const list = projectRes.data.filter((item) => item.frameFileNames.length > 0);
    setProjects(list);
    setSelectedId((current) => {
      // 用户主动「取消选择」后不再自动选第一个，否则下次刷新又会被选回去
      if (current === null && userClearedRef.current) return null;
      if (current && list.some((item) => item.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /* 帧动画页新增/改名/删除集合后，这一页的集合列表也要跟着刷 */
  useDataRefresh(() => {
    void loadProjects();
  });

  // 查一下本地有哪些模型可用，下拉里把没下载的标出来
  useEffect(() => {
    void (async () => {
      const res = await window.skeletonElf.files.rembgModels();
      if (res.ok) setLocalModels(res.data.map((item) => item.name));
    })();
  }, []);

  // 从别处（帧动画页）切回来时刷新，用户可能刚抽完帧或删了目录
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

  const selected = projects.find((item) => item.id === selectedId) ?? null;
  const frameCount = selected?.frameFileNames.length ?? 0;
  /** 选中的模型本地没有 → 运行时会触发下载 */
  const missingModel = localModels.length > 0 && !localModels.includes(model);
  const estimate = Math.round(
    ((MODEL_SECONDS[model] ?? 10) * Math.max(1, frameCount)) / Math.max(1, workers) + 30,
  );

  const handleStart = async (): Promise<void> => {
    if (!selected) {
      setError(t('mt.msg.noSelection', lang));
      return;
    }
    if (!tryStart('matte-studio', t('mt.title', lang))) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    cancelledRef.current = false;
    // 开跑前先关掉正在播放的预览：抠图会占满 CPU，预览跟着卡顿，一起停掉更清爽
    setPreviewOutput(null);
    setPercent(0);
    setProgressText(t('mt.msg.loadingModel', lang));
    const jobId = `${selected.id}-${Date.now()}`;
    jobRef.current = jobId;

    const off = window.skeletonElf.files.onRembgBatchProgress((progress) => {
      setProgressText(`${progress.done} / ${progress.total} · ${progress.file}`);
      setPercent(progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0);
      // 同步到侧边栏：切到别的页面也能看到「批量抠图 60%」
      setProgress('matte-studio', progress.done, progress.total);
    });

    try {
      const res = await window.skeletonElf.files.rembgBatch(
        selected.absPath,
        { model, noDecontaminate: false, workers },
        jobId,
      );
      if (!res.ok) {
        // 手动停止时进程被杀，后端会以失败返回；这时不要当错误弹出来
        if (!cancelledRef.current) setError(res.error);
        return;
      }
      const { total, elapsedMs, errors, outDir } = res.data;
      if (!cancelledRef.current) {
        setNotice(
          t('mt.msg.done', lang, {
            frames: String(total),
            time: humanDuration(elapsedMs / 1000, lang),
            failed:
              errors.length > 0 ? t('mt.msg.failed', lang, { count: String(errors.length) }) : '',
            dir: outDir,
          }),
        );
      }
      void loadProjects();
      // 新的抠图结果出来了：素材库的「抠图帧动画」栏、循环裁剪页都要刷新
      notifyDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      off();
      jobRef.current = null;
      setRunning(false);
      setBusy('matte-studio', false);
      setProgressText('');
      setPercent(0);
    }
  };

  /**
   * 对抠图结果目录找循环点并裁剪。
   * 先 dryRun 让用户看会裁几帧，确认后才真删 —— 和帧动画页的行为一致。
   */
  const handleTrimLoopInDir = async (absPath: string, name: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setRunning(true);
    try {
      const preview = await window.skeletonElf.files.trimLoop(absPath, true);
      if (!preview.ok) {
        setError(preview.error);
        return;
      }
      const { kept, removed, loopFrame, score } = preview.data;
      if (removed === 0) {
        setNotice(
          t('mt.msg.loopNone', lang, {
            name,
            frame: String(loopFrame),
            score: score.toFixed(0),
          }),
        );
        return;
      }
      const ok = window.confirm(
        t('mt.confirm.loopTitle', lang, {
          name,
          frame: String(loopFrame),
          score: score.toFixed(0),
          kept: String(kept),
          removed: String(removed),
        }),
      );
      if (!ok) return;

      const done = await window.skeletonElf.files.trimLoop(absPath, false);
      if (!done.ok) {
        setError(done.error);
        return;
      }
      setNotice(
        t('mt.msg.loopDone', lang, {
          name,
          kept: String(done.data.kept),
          removed: String(done.data.removed),
        }),
      );
      void loadProjects();
    } finally {
      setRunning(false);
      setBusy('matte-studio', false);
    }
  };

  /**
   * 删除一个抠图结果目录。
   * 直接复用 frames.remove —— 它走 projectDirOf，带 -matte / -key 后缀
   * 会自动定位到 frames/outputs/ 下。
   */
  const handleRemoveOutput = async (dirName: string, count: number): Promise<void> => {
    const ok = window.confirm(
      t('mt.confirm.removeOutput', lang, { name: dirName, count: String(count) }),
    );
    if (!ok) return;
    setError(null);
    setNotice(null);
    const res = await window.skeletonElf.frames.remove(dirName);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(t('mt.msg.removed', lang, { name: dirName }));
    void loadProjects();
  };

  /**
   * 重命名抠图结果目录（右边列表用）。
   * -matte / -key 后缀由后端自动保留，用户只改基名；重名直接报错不覆盖。
   */
  const handleRenameOutput = async (dirName: string): Promise<void> => {
    const next = renameOutputValue.trim();
    if (!next) {
      setRenamingOutput(null);
      setRenameOutputValue('');
      return;
    }
    setError(null);
    setNotice(null);
    const res = await window.skeletonElf.frames.renameOutput(dirName, next);
    if (!res.ok) {
      setError(t('mt.msg.renameFailed', lang, { error: res.error }));
      return;
    }
    setRenamingOutput(null);
    setRenameOutputValue('');
    setNotice(t('mt.msg.renamed', lang, { name: res.data }));
    void loadProjects();
    notifyDataChanged();
  };

  const handleCancel = async (): Promise<void> => {
    // 先清掉上一次操作的提示，避免「已删除『xxx』」这种旧记号被误当成取消的结果
    setNotice(null);
    setError(null);
    const jobId = jobRef.current;
    if (!jobId) {
      setNotice(t('mt.msg.noTask', lang));
      return;
    }
    cancelledRef.current = true;
    const res = await window.skeletonElf.files.rembgCancel(jobId);
    setNotice(res.ok && res.data.cancelled ? t('mt.msg.stopped', lang) : t('mt.msg.alreadyDone', lang));
  };

  /** 切到传统抠图时自动从第一帧取背景色，省得用户自己量 */
  const handleModeChange = async (next: 'model' | 'key'): Promise<void> => {
    setMode(next);
    setError(null);
    setKeyHint(null);
    if (next !== 'key' || !selected) return;
    const res = await window.skeletonElf.files.sampleFrameBackground(selected.absPath);
    if (res.ok) {
      setKeyColor(res.data);
      setKeyHint(
        t('mt.key.picked', lang, {
          r: String(res.data.r),
          g: String(res.data.g),
          b: String(res.data.b),
        }),
      );
    } else {
      setKeyHint(t('mt.key.failed', lang, { error: res.error }));
    }
  };

  /** 传统抠图：颜色键控，输出到「<目录>-key」 */
  const handleKeyStart = async (): Promise<void> => {
    if (!selected) {
      setError(t('mt.msg.noSelection', lang));
      return;
    }
    if (!tryStart('matte-studio', t('mt.title', lang))) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    setPercent(0);
    setProgressText(t('mt.msg.processing', lang));
    try {
      const res = await window.skeletonElf.files.batchKeyOut(selected.absPath, {
        colors: [keyColor],
        tolerance: keyTolerance,
        mode: keyMode,
        edgeTrim: keyEdgeTrim,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const { total, elapsedMs, skipped, outDir } = res.data;
      setNotice(
        t('mt.msg.keyDone', lang, {
          frames: String(total),
          time: humanDuration(elapsedMs / 1000, lang),
          failed:
            skipped.length > 0 ? t('mt.msg.failed', lang, { count: String(skipped.length) }) : '',
          dir: outDir,
        }),
      );
    } finally {
      setRunning(false);
      setBusy('matte-studio', false);
      setProgressText('');
      setPercent(0);
    }
  };

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>{t('mt.title', lang)}</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              {t('mt.refresh', lang)}
            </button>
          </div>
          <p className="muted">{t('mt.intro', lang)}</p>

          {/* 集合用弹窗选：下拉框一多就没法看缩略图，分不清是哪段动画 */}
          <div className="field">
            <span className="field__label">{t('mt.currentSet', lang)}</span>
            <div className="ref-strip">
              <code className="ref-strip__name">
                {selected
                  ? `${selected.name} · ${t('mt.picker.frames', lang, {
                      count: String(selected.frameFileNames.length),
                    })}`
                  : t('mt.notSelected', lang)}
              </code>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPickerOpen(true)}
                disabled={running}
              >
                {t('mt.changeSet', lang)}
              </button>
              {/* 取消选择：不然选错了只能重启应用，或者把那个帧集合文件夹删掉。
                  顺带清掉上一次操作的提示，免得「已删除『xxx』」留在界面上。 */}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  userClearedRef.current = true;
                  setSelectedId(null);
                  setNotice(null);
                  setError(null);
                  setPreviewOutput(null);
                  setPercent(0);
                  setProgressText('');
                }}
                disabled={running || !selected}
              >
                {t('mt.clearSelection', lang)}
              </button>
            </div>
          </div>

          <label className="field">
            <span className="field__label">{t('mt.method', lang)}</span>
            <select
              className="input select"
              value={mode}
              onChange={(event) =>
                void handleModeChange(event.target.value === 'key' ? 'key' : 'model')
              }
              disabled={running}
            >
              <option value="model">{t('mt.method.model', lang)}</option>
              <option value="key">{t('mt.method.key', lang)}</option>
            </select>
          </label>

          {mode === 'model' ? (
            <>
              <label className="field">
                <span className="field__label">{t('mt.model', lang)}</span>
                <select
                  className="input select"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={running}
                >
                  {/* 打包内置的 3 个排最前并标「打包内置」（下拉里 ★ + 绿色，见 theme.css）；
                      其余是开发对比用的测试模型，标「仅开发」并置灰。
                      另外按本地是否已下载分两段，避免误点触发几百 MB 下载。 */}
                  {MODEL_OPTIONS.filter((item) => localModels.includes(item.name)).map((item) => (
                    <option
                      key={item.name}
                      value={item.name}
                      className={SHIPPED_MODELS.has(item.name) ? 'opt-shipped' : 'opt-testonly'}
                    >
                      {SHIPPED_MODELS.has(item.name) ? '★ ' : ''}
                      {item.name} · {t(item.noteKey, lang)} · {t('mt.model.ready', lang)}
                      {SHIPPED_MODELS.has(item.name) ? ` · ${t('mt.model.shipped', lang)}` : ` · ${t('mt.model.dev', lang)}`}
                    </option>
                  ))}
                  {MODEL_OPTIONS.filter((item) => !localModels.includes(item.name)).map((item) => (
                    <option
                      key={item.name}
                      value={item.name}
                      className={SHIPPED_MODELS.has(item.name) ? 'opt-shipped' : 'opt-testonly'}
                    >
                      {SHIPPED_MODELS.has(item.name) ? '★ ' : ''}
                      {item.name} · {t(item.noteKey, lang)} · {t('mt.model.missing', lang)}
                    </option>
                  ))}
                </select>
                {missingModel ? (
                  <span className="field__hint field__hint--warn">
                    {t('mt.model.missingHint', lang, { model })}
                  </span>
                ) : null}
              </label>

              <label className="field">
                <span className="field__label">{t('mt.workers', lang)}</span>
                <select
                  className="input select"
                  value={workers}
                  onChange={(event) => setWorkers(Number(event.target.value))}
                  disabled={running}
                >
                  <option value={1}>{t('mt.workers.1', lang)}</option>
                  <option value={2}>{t('mt.workers.2', lang)}</option>
                  <option value={3}>{t('mt.workers.3', lang)}</option>
                </select>
                <span className="field__hint field__hint--warn">{t('mt.workers.hint', lang)}</span>
              </label>

              <span className="field__hint">
                {frameCount > 0
                  ? t('mt.estimate', lang, {
                      time: humanDuration(estimate, lang),
                      frames: String(frameCount),
                      seconds: String(MODEL_SECONDS[model] ?? 10),
                      workers: String(workers),
                    })
                  : t('mt.estimate', lang, {
                      time: '—',
                      frames: '0',
                      seconds: String(MODEL_SECONDS[model] ?? 10),
                      workers: String(workers),
                    })}
              </span>
            </>
          ) : (
            <>
              <span className="field__hint">
                {t('mt.key.intro', lang)}
                {keyHint ? (
                  <>
                    <br />
                    {keyHint}
                  </>
                ) : null}
              </span>

              <div className="input-row">
                <label className="field">
                  <span className="field__label">{t('mt.key.color', lang)}</span>
                  <span className="input-row">
                    <input
                      type="color"
                      value={`#${[keyColor.r, keyColor.g, keyColor.b]
                        .map((v) => v.toString(16).padStart(2, '0'))
                        .join('')}`}
                      onChange={(event) => {
                        const hex = event.target.value;
                        setKeyColor({
                          r: parseInt(hex.slice(1, 3), 16),
                          g: parseInt(hex.slice(3, 5), 16),
                          b: parseInt(hex.slice(5, 7), 16),
                        });
                      }}
                      disabled={running}
                    />
                    <span className="field__hint">
                      rgb({keyColor.r}, {keyColor.g}, {keyColor.b})
                    </span>
                  </span>
                </label>
                <label className="field">
                  <span className="field__label">
                    {t('mt.key.tolerance', lang)} <em className="field__saved">{keyTolerance}</em>
                  </span>
                  <input
                    className="range"
                    type="range"
                    min={5}
                    max={60}
                    value={keyTolerance}
                    onChange={(event) => setKeyTolerance(Number(event.target.value))}
                    disabled={running}
                  />
                </label>
              </div>

              <div className="input-row">
                <label className="field">
                  <span className="field__label">{t('mt.key.mode', lang)}</span>
                  <select
                    className="input select"
                    value={keyMode}
                    onChange={(event) =>
                      setKeyMode(event.target.value === 'global' ? 'global' : 'connected')
                    }
                    disabled={running}
                  >
                    <option value="connected">{t('mt.key.mode.connected', lang)}</option>
                    <option value="global">{t('mt.key.mode.global', lang)}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">
                    {t('mt.key.edgeTrim', lang)} <em className="field__saved">{keyEdgeTrim}px</em>
                  </span>
                  <input
                    className="range"
                    type="range"
                    min={0}
                    max={3}
                    value={keyEdgeTrim}
                    onChange={(event) => setKeyEdgeTrim(Number(event.target.value))}
                    disabled={running}
                  />
                </label>
              </div>

              <span className="field__hint">{t('mt.key.hint', lang)}</span>
            </>
          )}

          {running ? (
            <>
              {mode === 'model' ? (
                <>
                  <div className="frame-progress">
                    <div className="frame-progress__bar" style={{ width: `${percent}%` }} />
                  </div>
                  <span className="field__hint">
                    {percent}% · {progressText}
                  </span>
                  <div className="actions">
                    <button type="button" className="btn btn--danger" onClick={() => void handleCancel()}>
                      {t('mt.forceStop', lang)}
                    </button>
                  </div>
                </>
              ) : (
                <span className="field__hint">{progressText}</span>
              )}
            </>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!selected || frameCount === 0}
                onClick={() => void (mode === 'model' ? handleStart() : handleKeyStart())}
              >
                {frameCount > 0
                  ? mode === 'model'
                    ? t('mt.start', lang, { frames: String(frameCount) })
                    : t('mt.startKey', lang, { frames: String(frameCount) })
                  : t('mt.startPlain', lang)}
              </button>
            </div>
          )}

          {error ? <div className="banner banner--error">{error}</div> : null}
          {notice ? <div className="banner banner--ok">{notice}</div> : null}
        </section>
      </div>

      {/* 右栏：所有抠图产出（跨集合），不局限于当前选中的那个 */}
      <div className="stack frame-sidebar">
        <section className="card">
          <div className="card__head">
            <h2>{t('mt.outputs.title', lang)}</h2>
            <span className="tag">{t('mt.outputs.count', lang, { count: String(outputs.length) })}</span>
          </div>
          {outputs.length === 0 ? (
            <p className="muted">{t('mt.outputs.empty', lang)}</p>
          ) : (
            <div className="frame-projects">
              {outputs.map((output) => (
                <div key={output.absPath} className="frame-project">
                  <div className="frame-project__head">
                    {renamingOutput === output.name ? (
                      <input
                        className="input"
                        value={renameOutputValue}
                        autoFocus
                        placeholder={t('mt.rename.placeholder', lang)}
                        onChange={(event) => setRenameOutputValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void handleRenameOutput(output.name);
                          if (event.key === 'Escape') {
                            setRenamingOutput(null);
                            setRenameOutputValue('');
                          }
                        }}
                      />
                    ) : (
                      <strong>{output.name}/</strong>
                    )}
                    <span className="tag">
                      {output.kind === 'matte' ? t('mt.kind.model', lang) : t('mt.kind.key', lang)}
                    </span>
                  </div>
                  <div className="frame-project__thumbs">
                    {/* 列表只显示前 6 张，完整序列留给播放窗口 */}
                    {output.previewUrls.slice(0, 6).map((url) => (
                      <img
                        key={url}
                        src={url}
                        alt={output.name}
                        onError={(event) => {
                          event.currentTarget.style.display = 'none';
                        }}
                      />
                    ))}
                  </div>
                  <span className="field__hint">
                    {t('mt.outputs.meta', lang, {
                      frames: String(output.frameCount),
                      source: output.sourceName,
                    })}
                  </span>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={running}
                      title={running ? t('mt.previewBusy', lang) : undefined}
                      onClick={() =>
                        setPreviewOutput({
                          title: `${output.name} · ${t('mt.picker.frames', lang, {
                            count: String(output.frameCount),
                          })}`,
                          // 预览图最多只有 6 张，播放要完整序列：按 output 目录拼全部地址
                          frameUrls: output.previewUrls,
                          fps: 12,
                        })
                      }
                    >
                      {t('mt.btn.preview', lang)}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      title={output.absPath}
                      disabled={running}
                      onClick={() => void window.skeletonElf.frames.openDir(output.name)}
                    >
                      {t('mt.btn.openDir', lang)}
                    </button>
                    {renamingOutput === output.name ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => void handleRenameOutput(output.name)}
                        >
                          {t('mt.btn.renameConfirm', lang)}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            setRenamingOutput(null);
                            setRenameOutputValue('');
                          }}
                        >
                          {t('mt.btn.cancel', lang)}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={running}
                        title={t('mt.rename.title', lang)}
                        onClick={() => {
                          setRenamingOutput(output.name);
                          // 输入框里只放基名，后缀由后端补回去
                          setRenameOutputValue(output.name.replace(/-(matte|key)$/i, ''));
                        }}
                      >
                        {t('mt.btn.rename', lang)}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger"
                      disabled={running}
                      onClick={() => void handleRemoveOutput(output.name, output.frameCount)}
                    >
                      {t('mt.btn.remove', lang)}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              {t('mt.refresh', lang)}
            </button>
            <span className="field__hint">{t('mt.refreshHint', lang)}</span>
          </div>
        </section>
      </div>

      {/* 集合选择弹窗：带缩略图，比下拉框好认 */}
      {pickerOpen ? (
        <div className="modal-backdrop">
          <div className="modal">
            <header className="modal__head">
              <h2>{t('mt.picker.title', lang)}</h2>
              <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                ×
              </button>
            </header>
            <div className="modal__body">
              {projects.length === 0 ? (
                <p className="muted">{t('mt.picker.empty', lang)}</p>
              ) : (
                <div className="frame-projects">
                  {projects.map((item) => (
                    <div
                      key={item.id}
                      className={`frame-project frame-project--pick${
                        item.id === selectedId ? ' is-active' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="frame-project__pick-area"
                        onClick={() => {
                          userClearedRef.current = false;
                          setSelectedId(item.id);
                          setPickerOpen(false);
                        }}
                      >
                        <div className="frame-project__head">
                          <strong>{item.name}</strong>
                          <span className="tag">
                            {t('mt.picker.frames', lang, { count: String(item.frameFileNames.length) })}
                          </span>
                        </div>
                        <div className="frame-project__thumbs">
                          {item.frameUrls.slice(0, 6).map((url) => (
                            <img
                              key={url}
                              src={url}
                              alt={item.name}
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                          ))}
                        </div>
                        <span className="field__hint">
                          {item.fps} fps · {item.width}×{item.height}
                          {item.outputs.length > 0
                            ? ` · ${t('mt.picker.hasOutput', lang, {
                                list: item.outputs
                                  .map((o) =>
                                    o.kind === 'matte' ? t('mt.kind.model', lang) : t('mt.kind.key', lang),
                                  )
                                  .join('/'),
                              })}`
                            : ''}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">{t('mt.picker.foot', lang)}</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                  {t('mt.btn.cancel', lang)}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      {/* 播放预览：抠图结果的完整帧序列 */}
      {previewOutput ? (
        <FramePlayerModal
          title={previewOutput.title}
          frameUrls={previewOutput.frameUrls}
          fps={previewOutput.fps}
          onClose={() => setPreviewOutput(null)}
        />
      ) : null}
    </div>
  );
}
