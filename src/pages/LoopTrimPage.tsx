import { useCallback, useEffect, useRef, useState } from 'react';
import type { FrameOutputView, FrameProjectView } from '@shared/ipc';

/**
 * 找循环帧（独立页面）。
 *
 * 为什么单独一页：循环裁剪是不可逆操作（直接删文件），塞在列表按钮里
 * 容易误点。这里强制走「选集合 → 调范围 → 看预览 → 确认覆盖」的流程。
 *
 * 滑杆「循环范围」：值越大，搜索起点越靠后，选出的循环点也越靠后 ——
 * 短循环（比如 8 帧的呼吸动画）用小值，长循环（20+ 帧的走路）用大值。
 *
 * 资源释放：离开页面 / 关闭播放时 clearInterval，不留下定时器。
 */

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

interface Candidate {
  kept: number;
  removed: number;
  loopFrame: number;
  score: number;
  /** 一个完整循环有多少帧（最小周期） */
  cycleLength: number;
  /** 整段里总共装了几个循环 */
  cycles: number;
}

export function LoopTrimPage(): React.JSX.Element {
  const [projects, setProjects] = useState<FrameProjectView[]>([]);
  /** 抠图结果（outputs 下的目录），和抽帧集合并列供选择 */
  const [outputs, setOutputs] = useState<FrameOutputView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** 搜索起点偏好：0 = 从头扫全部帧，60 = 只从靠后位置找（「缩小范围再找」用） */
  const [prefer, setPrefer] = useState(0);
  /** 保留几个循环；0 = 全部（只裁掉不完整的尾巴） */
  const [keepCycles, setKeepCycles] = useState(0);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    // 两份数据并行取：抽帧集合（sources）和抠图结果（outputs）都能当输入
    const [projectRes, outputRes] = await Promise.all([
      window.skeletonElf.frames.list(),
      window.skeletonElf.frames.listOutputs(),
    ]);
    if (!projectRes.ok) {
      setError(projectRes.error);
      return;
    }
    const list = projectRes.data.filter((item) => item.frameFileNames.length > 0);
    const outs = outputRes.ok ? outputRes.data : [];
    setProjects(list);
    setOutputs(outs);
    setSelectedKey((current) => {
      const exists =
        current !== null &&
        (list.some((item) => item.id === current) || outs.some((item) => item.name === current));
      if (exists) return current;
      return list[0]?.id ?? outs[0]?.name ?? null;
    });
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /* 选中项可能是抽帧集合（projects）也可能是抠图结果（outputs），
     统一成同一组字段，后面的播放和裁剪只认 absPath。 */
  const sourceItem = projects.find((item) => item.id === selectedKey) ?? null;
  const outputItem = outputs.find((item) => item.name === selectedKey) ?? null;
  const selected = sourceItem ?? outputItem ?? null;
  const selectedPath = selected?.absPath ?? null;
  const selectedLabel = selected?.name ?? '';
  const frameUrls =
    (sourceItem?.frameUrls ?? outputItem?.previewUrls ?? []) as string[];
  const fps = sourceItem?.fps ?? 12;
  const total = frameUrls.length;

  /**
   * 手动删掉一帧。
   * 找循环帧之后常有个别帧是多余的（或者画崩了），直接从集合里剔掉。
   */
  const handleRemoveFrame = async (url: string): Promise<void> => {
    if (!selectedKey) return;
    if (total <= 1) {
      setError('至少留一帧，不能全删空');
      return;
    }
    // URL 形如 kbmedia://output/<id>/frame_005.png
    const fileName = url.split('/').pop() ?? '';
    if (!/^frame_\d+\.png$/i.test(fileName)) {
      setError(`拿不到帧文件名：${url}`);
      return;
    }
    const res = await window.skeletonElf.frames.removeFrame(selectedKey, fileName);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // 帧序号全变了，之前的循环点结论作废
    setCandidate(null);
    setNotice(`已删掉 ${fileName}，现在剩 ${res.data.frameCount} 帧。`);
    void loadProjects();
  };

  /** 播放：离开页面或暂停时一定要清掉定时器，否则会留下空转的 interval */
  useEffect(() => {
    if (!playing || total === 0) return;
    const interval = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % total);
    }, 1000 / Math.max(1, fps) / Math.max(0.1, speed));
    timerRef.current = interval;
    return () => {
      window.clearInterval(interval);
      timerRef.current = null;
    };
  }, [playing, total, fps, speed]);

  // 组件卸载时兜底清理（路由切走的极端情况）
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  // 换集合：重置播放位置和候选结果
  useEffect(() => {
    setIndex(0);
    setCandidate(null);
    setNotice(null);
    setError(null);
  }, [selectedKey]);

  const handleDetect = async (searchPrefer: number): Promise<void> => {
    if (!selectedPath) return;
    setPrefer(searchPrefer);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await window.skeletonElf.files.trimLoop(
        selectedPath,
        true,
        searchPrefer,
        keepCycles > 0 ? keepCycles : undefined,
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCandidate(res.data);
      if (res.data.removed === 0) {
        setNotice(
          searchPrefer === 0
            ? '全部帧里没找到能接回首帧的位置。试试点「缩小范围再找」。'
            : '缩到靠后位置还是没找到。也许这段动作本身不是循环，或者末尾缺一帧。',
        );
      } else {
        setIndex(res.data.loopFrame - 1);
        setPlaying(false);
        setNotice(
          `找到循环点在帧 ${res.data.loopFrame}（差异 ${res.data.score.toFixed(0)}），` +
            `将保留 ${res.data.kept} 帧、裁掉 ${res.data.removed} 帧。`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async (): Promise<void> => {
    if (!selectedPath || !candidate) return;
    if (candidate.removed === 0) {
      setNotice('没有需要裁的帧，不用执行。');
      return;
    }
    const ok = window.confirm(
      `将把「${selectedLabel}」覆盖为前 ${candidate.kept} 帧。\n\n` +
        `删除 ${candidate.removed} 帧，操作不可恢复。\n确定继续吗？`,
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await window.skeletonElf.files.trimLoop(
        selectedPath,
        false,
        prefer,
        keepCycles > 0 ? keepCycles : undefined,
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(
        `已覆盖：保留 ${res.data.kept} 帧，删掉 ${res.data.removed} 帧。首尾衔接，循环不会跳。`,
      );
      setCandidate(null);
      setIndex(0);
      void loadProjects();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-layout settings-layout--single">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>找循环帧</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              刷新
            </button>
          </div>
          <p className="muted">
            自动找出「和第一帧最像」的那一帧作为循环点，把后面的多余帧裁掉。
            确认后会**直接覆盖**当前集合，删除不可恢复。
          </p>

          <div className="field">
            <span className="field__label">当前集合</span>
            <div className="ref-strip">
              <code className="ref-strip__name">
                {selectedPath ? `${selectedLabel} · ${total} 帧 · ${fps} fps` : '还没有选'}
              </code>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
              >
                更换集合
              </button>
            </div>
          </div>

          {total > 0 ? (
            <>
              <div className="frame-player">
                <div className="frame-player__stage">
                  <img src={frameUrls[Math.min(index, total - 1)]} alt="预览" />
                </div>
                <div className="frame-player__bar">
                  <button
                    type="button"
                    className={`btn ${playing ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={() => setPlaying((prev) => !prev)}
                  >
                    {playing ? '⏸ 暂停' : '▶ 播放'}
                  </button>
                  <input
                    className="range frame-player__scrub"
                    type="range"
                    min={0}
                    max={Math.max(0, total - 1)}
                    value={Math.min(index, total - 1)}
                    onChange={(event) => {
                      setPlaying(false);
                      setIndex(Number(event.target.value));
                    }}
                  />
                  <span className="field__saved">
                    第 {Math.min(index, total - 1) + 1} / {total} 帧
                  </span>
                  <select
                    className="input select frame-player__speed"
                    value={speed}
                    onChange={(event) => setSpeed(Number(event.target.value))}
                  >
                    {SPEEDS.map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </div>
                {candidate && candidate.removed > 0 ? (
                  <span className="field__hint">
                    循环点已标出（第 {candidate.loopFrame} 帧），拖动进度条可以对比它和首帧。
                  </span>
                ) : null}
              </div>

              {/* 逐帧列表：点图切换预览，× 直接删掉这一帧 */}
              <div className="frame-grid">
                {frameUrls.map((url, frameIndex) => (
                  <figure
                    key={url}
                    className={`frame-item${frameIndex === index ? ' is-active' : ''}`}
                  >
                    <img
                      src={url}
                      alt={`frame ${frameIndex}`}
                      onClick={() => {
                        setPlaying(false);
                        setIndex(frameIndex);
                      }}
                    />
                    <figcaption>
                      <span>{String(frameIndex).padStart(3, '0')}</span>
                      <button
                        type="button"
                        className="frame-item__edit"
                        title="删掉这一帧（直接从磁盘删除，不可恢复）"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            window.confirm(`确定删掉第 ${frameIndex} 帧？删除不可恢复。`)
                          ) {
                            void handleRemoveFrame(url);
                          }
                        }}
                      >
                        ×
                      </button>
                    </figcaption>
                  </figure>
                ))}
              </div>

                <>
                  <span className="field__hint">
                    在全部 {total} 帧里找「和第一帧接得上」的位置，同时算出有几个完整循环。
                  </span>

                  {/* 算出循环数之后，可以按倍数缩小：4 个循环 → 1 个 */}
                  {candidate && candidate.cycles > 1 ? (
                    <label className="field">
                      <span className="field__label">保留几个循环</span>
                      <select
                        className="input select"
                        value={keepCycles || candidate.cycles}
                        onChange={(event) => {
                          setKeepCycles(Number(event.target.value));
                          void handleDetect(prefer);
                        }}
                        disabled={busy}
                      >
                        {Array.from({ length: candidate.cycles }, (_, i) => candidate.cycles - i).map(
                          (count) => (
                            <option key={count} value={count}>
                              {count} 个循环（{candidate.cycleLength * count} 帧）
                              {count === candidate.cycles ? ' · 全部' : ''}
                            </option>
                          ),
                        )}
                      </select>
                      <span className="field__hint">
                        一共 {candidate.cycles} 个循环，每个 {candidate.cycleLength} 帧。
                        选 1 个就是把整段缩成单次循环。
                      </span>
                    </label>
                  ) : null}

                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void handleDetect(0)}
                      disabled={busy || total < 3}
                    >
                      {busy ? '计算中…' : '找循环帧'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void handleDetect(60)}
                      disabled={busy || total < 3}
                    >
                      缩小范围再找
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => void handleApply()}
                      disabled={busy || !candidate || candidate.removed === 0}
                    >
                      确认裁剪并覆盖
                    </button>
                  </div>

                  {candidate ? (
                    <span className="field__hint">
                      循环点在第 <b>{candidate.loopFrame}</b> 帧 · 保留{' '}
                      <b>{candidate.kept}</b> 帧 · 裁掉 <b>{candidate.removed}</b> 帧 ·
                      差异 {candidate.score.toFixed(1)}
                    </span>
                  ) : null}
                </>
            </>
          ) : (
            <p className="muted">还没有帧集合。先去「帧动画」页抽帧。</p>
          )}

          {error ? <div className="banner banner--error">{error}</div> : null}
          {notice ? <div className="banner banner--ok">{notice}</div> : null}
        </section>
      </div>

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
              {/* 两栏并列：左边抽帧集合（sources），右边抠图结果（outputs） */}
              <div className="loop-picker">
                <div className="loop-picker__col">
                  <div className="card__head">
                    <h3>抽帧集合</h3>
                    <span className="tag">{projects.length} 个</span>
                  </div>
                  {projects.length === 0 ? (
                    <p className="muted">还没有抽帧集合。</p>
                  ) : (
                    <div className="frame-projects">
                      {projects.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`frame-project frame-project--pick${
                            item.id === selectedKey ? ' is-active' : ''
                          }`}
                          onClick={() => {
                            setSelectedKey(item.id);
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
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="loop-picker__col">
                  <div className="card__head">
                    <h3>抠图集合</h3>
                    <span className="tag">{outputs.length} 个</span>
                  </div>
                  {outputs.length === 0 ? (
                    <p className="muted">还没有抠图结果。去「批量抠图」页跑一次。</p>
                  ) : (
                    <div className="frame-projects">
                      {outputs.map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          className={`frame-project frame-project--pick${
                            item.name === selectedKey ? ' is-active' : ''
                          }`}
                          onClick={() => {
                            setSelectedKey(item.name);
                            setPickerOpen(false);
                          }}
                        >
                          <div className="frame-project__head">
                            <strong>{item.name}</strong>
                            <span className="tag">
                              {item.kind === 'matte' ? '模型' : '传统'}
                            </span>
                          </div>
                          <div className="frame-project__thumbs">
                            {item.previewUrls.slice(0, 6).map((url) => (
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
                            {item.frameCount} 帧 · 来自 {item.sourceName}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
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
    </div>
  );
}
