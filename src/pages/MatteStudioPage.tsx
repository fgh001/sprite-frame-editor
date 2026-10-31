import { useCallback, useEffect, useRef, useState } from 'react';
import type { FrameOutputView, FrameProjectView } from '@shared/ipc';
import { FramePlayerModal } from '../components/FramePlayerModal';
import { setBusy, setProgress, tryStart } from '../state/busy';

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

function humanDuration(seconds: number): string {
  if (seconds < 60) return `约 ${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `约 ${Math.round(minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest > 0 ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}

/** 下拉里的候选模型；实际可用性由 localModels（扫 data/models）决定 */
const MODEL_OPTIONS: { name: string; note: string }[] = [
  { name: 'u2net', note: '2 秒/张（快，推荐先试）' },
  { name: 'isnet-general-use', note: '5 秒/张' },
  { name: 'isnet-anime', note: '2 秒/张（动漫专用）' },
  { name: 'birefnet-fp16', note: '40 秒/张（半精度）' },
  { name: 'birefnet-lite-512', note: '20 秒/张（轻量）' },
  { name: 'birefnet-toonout', note: '80 秒/张（卡通）' },
  { name: 'birefnet-general', note: '80 秒/张（官网同款）' },
  { name: 'bria-rmbg', note: '10 秒/张' },
  { name: 'ben2', note: '80 秒/张' },
];

export function MatteStudioPage(): React.JSX.Element {
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
  /** 集合选择弹窗（下拉框看不出缩略图，改成弹窗） */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 正在播放预览的抠图结果（null = 没打开播放窗口） */
  const [previewOutput, setPreviewOutput] = useState<{
    title: string;
    frameUrls: string[];
    fps: number;
  } | null>(null);

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
      if (current && list.some((item) => item.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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
      setError('先选一个帧集合');
      return;
    }
    if (!tryStart('matte-studio', '批量抠图')) return;
    if (!tryStart('matte-studio', '批量抠图')) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    setPercent(0);
    setProgressText('正在加载模型（首次约 30 秒）…');
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
        setError(res.error);
        return;
      }
      const { total, elapsedMs, errors, outDir } = res.data;
      setNotice(
        `已抠 ${total} 帧，用时 ${humanDuration(elapsedMs / 1000)}${
          errors.length > 0 ? `（${errors.length} 张失败）` : ''
        }。输出：${outDir}`,
      );
      void loadProjects();
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
        setNotice(`${name}：第 ${loopFrame} 帧就是最后一帧，没有多余帧需要裁。差异 ${score.toFixed(0)}`);
        return;
      }
      const ok = window.confirm(
        `「${name}」找到循环点在帧 ${loopFrame}（与首帧差异 ${score.toFixed(0)}）。\n\n` +
          `将保留前 ${kept} 帧，删除后面 ${removed} 帧。\n删除后无法恢复，确定继续吗？`,
      );
      if (!ok) return;

      const done = await window.skeletonElf.files.trimLoop(absPath, false);
      if (!done.ok) {
        setError(done.error);
        return;
      }
      setNotice(
        `${name}：已保留 ${done.data.kept} 帧，删掉 ${done.data.removed} 帧。首尾衔接，循环不会跳。`,
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
      `确定删除「${dirName}」？\n\n会连同里面的 ${count} 帧一起删除，无法恢复。\n（源抽帧集合不受影响）`,
    );
    if (!ok) return;
    setError(null);
    setNotice(null);
    const res = await window.skeletonElf.frames.remove(dirName);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(`已删除「${dirName}」。`);
    void loadProjects();
  };

  const handleCancel = async (): Promise<void> => {
    const jobId = jobRef.current;
    if (!jobId) return;
    const res = await window.skeletonElf.files.rembgCancel(jobId);
    setNotice(
      res.ok && res.data.cancelled
        ? '已强制结束。已经处理完的帧保留在输出目录里。'
        : '任务已经结束，没有需要停止的进程。',
    );
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
      setKeyHint(`已从第一帧取到背景色 rgb(${res.data.r}, ${res.data.g}, ${res.data.b})`);
    } else {
      setKeyHint(`自动取色失败（${res.error}），请手动选背景色`);
    }
  };

  /** 传统抠图：颜色键控，输出到「<目录>-key」 */
  const handleKeyStart = async (): Promise<void> => {
    if (!selected) {
      setError('先选一个帧集合');
      return;
    }
    if (!tryStart('matte-studio', '批量抠图')) return;
    if (!tryStart('matte-studio', '批量抠图')) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    setPercent(0);
    setProgressText('正在处理…');
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
        `已抠 ${total} 帧，用时 ${humanDuration(elapsedMs / 1000)}${
          skipped.length > 0 ? `（${skipped.length} 张失败）` : ''
        }。输出：${outDir}`,
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
            <h2>批量抠图</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              刷新
            </button>
          </div>
          <p className="muted">
            模型会自己识别前景，<b>不需要设背景色或容差</b>。结果输出到同级 <code>-matte</code> 目录，
            原帧不动。
          </p>

          {/* 集合用弹窗选：下拉框一多就没法看缩略图，分不清是哪段动画 */}
          <div className="field">
            <span className="field__label">当前集合</span>
            <div className="ref-strip">
              <code className="ref-strip__name">
                {selected ? `${selected.name} · ${selected.frameFileNames.length} 帧` : '还没有选'}
              </code>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPickerOpen(true)}
                disabled={running}
              >
                更换集合
              </button>
            </div>
          </div>

          <label className="field">
            <span className="field__label">抠图方式</span>
            <select
              className="input select"
              value={mode}
              onChange={(event) =>
                void handleModeChange(event.target.value === 'key' ? 'key' : 'model')
              }
              disabled={running}
            >
              <option value="model">模型（自动识别前景，推荐）</option>
              <option value="key">传统（颜色键控，需设背景色）</option>
            </select>
          </label>

          {mode === 'model' ? (
            <>
              <label className="field">
                <span className="field__label">模型</span>
                <select
                  className="input select"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={running}
                >
                  {/* 本地已有的排前面并标「已就绪」；没下载的标出来，避免误点触发下载 */}
                  {MODEL_OPTIONS.filter((item) => localModels.includes(item.name)).map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} · {item.note} · 已就绪
                    </option>
                  ))}
                  {MODEL_OPTIONS.filter((item) => !localModels.includes(item.name)).map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} · {item.note} · 未下载
                    </option>
                  ))}
                </select>
                {missingModel ? (
                  <span className="field__hint field__hint--warn">
                    {model} 本地还没下载，点开始会先去 GitHub 拉权重（网络不好会 30 秒超时）。
                    建议选带「已就绪」的模型。
                  </span>
                ) : null}
              </label>

              <label className="field">
                <span className="field__label">并行进程</span>
                <select
                  className="input select"
                  value={workers}
                  onChange={(event) => setWorkers(Number(event.target.value))}
                  disabled={running}
                >
                  <option value={1}>1 个（不并行，最省内存）</option>
                  <option value={2}>2 个</option>
                  <option value={3}>3 个（内存要够）</option>
                </select>
              </label>

              <span className="field__hint">
                预计 <b>{frameCount > 0 ? humanDuration(estimate) : '—'}</b>
                {frameCount > 0 ? (
                  <>
                    {' '}
                    （{frameCount} 帧 × {MODEL_SECONDS[model] ?? 10} 秒 ÷ {workers} + 加载 30 秒）
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <>
              <span className="field__hint">
                背景色要和角色主色拉开距离 —— 角色大面积是紫色就别用紫背景。
                {keyHint ? (
                  <>
                    <br />
                    {keyHint}
                  </>
                ) : null}
              </span>

              <div className="input-row">
                <label className="field">
                  <span className="field__label">背景色</span>
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
                    容差 <em className="field__saved">{keyTolerance}</em>
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
                  <span className="field__label">模式</span>
                  <select
                    className="input select"
                    value={keyMode}
                    onChange={(event) =>
                      setKeyMode(event.target.value === 'global' ? 'global' : 'connected')
                    }
                    disabled={running}
                  >
                    <option value="connected">仅连通背景（保护角色内部同色）</option>
                    <option value="global">全局删除（夹缝也删，可能挖到角色）</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">
                    边缘去除 <em className="field__saved">{keyEdgeTrim}px</em>
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

              <span className="field__hint">
                传统抠图是纯 CPU 像素运算，几十帧通常几秒跑完，不需要进度条。
              </span>
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
                      强制结束
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
                    ? `开始抠这 ${frameCount} 帧`
                    : `用传统方式抠这 ${frameCount} 帧`
                  : '开始抠图'}
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
            <h2>抠图结果</h2>
            <span className="tag">{outputs.length} 个</span>
          </div>
          {outputs.length === 0 ? (
            <p className="muted">
              还没有抠图结果。左边选好集合和方式，点「开始」跑一次，产出会出现在这里。
            </p>
          ) : (
            <div className="frame-projects">
              {outputs.map((output) => (
                <div key={output.absPath} className="frame-project">
                  <div className="frame-project__head">
                    <strong>{output.name}/</strong>
                    <span className="tag">{output.kind === 'matte' ? '模型' : '传统'}</span>
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
                    {output.frameCount} 帧 · 来自 {output.sourceName}
                  </span>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() =>
                        setPreviewOutput({
                          title: `${output.name} · ${output.frameCount} 帧`,
                          // 预览图最多只有 6 张，播放要完整序列：按 output 目录拼全部地址
                          frameUrls: output.previewUrls,
                          fps: 12,
                        })
                      }
                    >
                      播放预览
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      title={output.absPath}
                      onClick={() => void window.skeletonElf.frames.openDir(output.name)}
                    >
                      定位文件夹
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger"
                      disabled={running}
                      onClick={() => void handleRemoveOutput(output.name, output.frameCount)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              刷新
            </button>
            <span className="field__hint">
              手动去文件夹删了东西？点刷新重新扫一遍。
            </span>
          </div>
        </section>
      </div>

      {/* 集合选择弹窗：带缩略图，比下拉框好认 */}
      {pickerOpen ? (
        <div className="modal-backdrop">
          <div className="modal">
            <header className="modal__head">
              <h2>选择帧集合</h2>
              <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                ×
              </button>
            </header>
            <div className="modal__body">
              {projects.length === 0 ? (
                <p className="muted">还没有帧集合。先去「帧动画」页抽帧。</p>
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
                          setSelectedId(item.id);
                          setPickerOpen(false);
                        }}
                      >
                        <div className="frame-project__head">
                          <strong>{item.name}</strong>
                          <span className="tag">{item.frameFileNames.length} 帧</span>
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
                            ? ` · 已有${item.outputs.map((o) => (o.kind === 'matte' ? '模型' : '传统')).join('/')}结果`
                            : ''}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">点一个集合即选定</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                  取消
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
