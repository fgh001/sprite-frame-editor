import { useCallback, useEffect, useRef, useState } from 'react';
import type { FrameOutputView, FrameProjectView } from '@shared/ipc';
import { notifyDataChanged, useDataRefresh } from '../state/refresh';
import { t, useLang } from '../i18n';

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
  const [lang] = useLang();
  const [projects, setProjects] = useState<FrameProjectView[]>([]);
  /** 抠图结果（outputs 下的目录），和抽帧集合并列供选择 */
  const [outputs, setOutputs] = useState<FrameOutputView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /**
   * 用户是否手动点过「取消选择」。
   * loadProjects 在没有选中项时会自动选第一个集合（首次进页面很方便），
   * 但用户主动取消后不该再被自动选回去，所以用这个标记挡住。
   */
  const userClearedRef = useRef(false);
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
      // 用户主动取消过就不再自动选，否则「取消选择」会被下一次刷新顶掉
      if (current === null && userClearedRef.current) return null;
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

  /* 帧动画页 / 批量抠图页改了集合或产出后，这里的候选列表也要刷新 */
  useDataRefresh(() => {
    void loadProjects();
  });

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
    // 少于 2 帧就不成动画了，直接拦住
    if (total <= 2) {
      setError(t('lt.msg.needTwo', lang));
      return;
    }
    // URL 形如 kbmedia://output/<id>/frame_005.png
    const fileName = url.split('/').pop() ?? '';
    if (!/^frame_\d+\.png$/i.test(fileName)) {
      setError(t('lt.msg.badName', lang, { url }));
      return;
    }
    const res = await window.skeletonElf.frames.removeFrame(selectedKey, fileName);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // 帧序号全变了，之前的循环点结论作废
    setCandidate(null);
    setNotice(t('lt.msg.removed', lang, { name: fileName, frames: String(res.data.frameCount) }));
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
        setNotice(searchPrefer === 0 ? t('lt.msg.noLoopHead', lang) : t('lt.msg.noLoopNarrow', lang));
      } else {
        setIndex(res.data.loopFrame - 1);
        setPlaying(false);
        setNotice(
          t('lt.msg.found', lang, {
            frame: String(res.data.loopFrame),
            score: res.data.score.toFixed(0),
            kept: String(res.data.kept),
            removed: String(res.data.removed),
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async (): Promise<void> => {
    if (!selectedPath || !candidate) return;
    if (candidate.removed === 0) {
      setNotice(t('lt.msg.nothingToTrim', lang));
      return;
    }
    const ok = window.confirm(
      t('lt.confirm.apply', lang, {
        name: selectedLabel,
        kept: String(candidate.kept),
        removed: String(candidate.removed),
      }),
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
        t('lt.msg.applied', lang, {
          kept: String(res.data.kept),
          removed: String(res.data.removed),
        }),
      );
      setCandidate(null);
      setIndex(0);
      void loadProjects();
      // 帧被删掉了：素材库的帧动画栏、帧动画页的帧数都要跟着刷新
      notifyDataChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-layout settings-layout--single">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>{t('lt.title', lang)}</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadProjects()}>
              {t('lt.refresh', lang)}
            </button>
          </div>
          <p className="muted">{t('lt.intro', lang)}</p>

          <div className="field">
            <span className="field__label">{t('lt.currentSet', lang)}</span>
            <div className="ref-strip">
              <code className="ref-strip__name">
                {selectedPath
                  ? t('lt.setMeta', lang, {
                      name: selectedLabel,
                      frames: String(total),
                      fps: String(fps),
                    })
                  : t('lt.notSelected', lang)}
              </code>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
              >
                {t('lt.changeSet', lang)}
              </button>
              {/* 取消选择：不然选错了只能重启应用，或者把那个集合文件夹删掉 */}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  userClearedRef.current = true;
                  setSelectedKey(null);
                  setCandidate(null);
                  setPlaying(false);
                  setIndex(0);
                }}
                disabled={busy || !selectedKey}
              >
                {t('lt.clearSelection', lang)}
              </button>
            </div>
          </div>

          {total > 0 ? (
            <>
              <div className="frame-player">
                <div className="frame-player__stage">
                  <img src={frameUrls[Math.min(index, total - 1)]} alt={t('lt.preview', lang)} />
                </div>
                <div className="frame-player__bar">
                  <button
                    type="button"
                    className={`btn ${playing ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={() => setPlaying((prev) => !prev)}
                  >
                    {playing ? t('lt.pause', lang) : t('lt.play', lang)}
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
                    {t('lt.frameOf', lang, {
                      index: String(Math.min(index, total - 1) + 1),
                      total: String(total),
                    })}
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
                    {t('lt.loopMarked', lang, { frame: String(candidate.loopFrame) })}
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
                        title={t('lt.deleteFrameTitle', lang)}
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(t('lt.deleteFrameConfirm', lang, { index: String(frameIndex) }))) {
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
                    {t('lt.findHint', lang, { total: String(total) })}
                  </span>

                  {/* 算出循环数之后，可以按倍数缩小：4 个循环 → 1 个 */}
                  {candidate && candidate.cycles > 1 ? (
                    <label className="field">
                      <span className="field__label">{t('lt.keepCycles', lang)}</span>
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
                              {t('lt.keepCyclesOption', lang, {
                                count: String(count),
                                frames: String(candidate.cycleLength * count),
                              })}
                              {count === candidate.cycles ? t('lt.keepCyclesAll', lang) : ''}
                            </option>
                          ),
                        )}
                      </select>
                      <span className="field__hint">
                        {t('lt.keepCyclesHint', lang, {
                          cycles: String(candidate.cycles),
                          len: String(candidate.cycleLength),
                        })}
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
                      {busy ? t('lt.detecting', lang) : t('lt.detect', lang)}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void handleDetect(60)}
                      disabled={busy || total < 3}
                    >
                      {t('lt.detectNarrow', lang)}
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => void handleApply()}
                      disabled={busy || !candidate || candidate.removed === 0}
                    >
                      {t('lt.apply', lang)}
                    </button>
                  </div>

                  {candidate ? (
                    <span className="field__hint">
                      {t('lt.result', lang, {
                        frame: String(candidate.loopFrame),
                        kept: String(candidate.kept),
                        removed: String(candidate.removed),
                        score: candidate.score.toFixed(1),
                      })}
                    </span>
                  ) : null}
                </>
            </>
          ) : (
            <p className="muted">{t('lt.empty', lang)}</p>
          )}

          {error ? <div className="banner banner--error">{error}</div> : null}
          {notice ? <div className="banner banner--ok">{notice}</div> : null}
        </section>
      </div>

      {pickerOpen ? (
        <div className="modal-backdrop">
          <div className="modal">
            <header className="modal__head">
              <h2>{t('lt.picker.title', lang)}</h2>
              <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                ×
              </button>
            </header>
            <div className="modal__body">
              {/* 两栏并列：左边抽帧集合（sources），右边抠图结果（outputs） */}
              <div className="loop-picker">
                <div className="loop-picker__col">
                  <div className="card__head">
                    <h3>{t('lt.picker.sources', lang)}</h3>
                    <span className="tag">
                      {t('lt.picker.count', lang, { count: String(projects.length) })}
                    </span>
                  </div>
                  {projects.length === 0 ? (
                    <p className="muted">{t('lt.picker.noSources', lang)}</p>
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
                            userClearedRef.current = false;
                            setSelectedKey(item.id);
                            setPickerOpen(false);
                          }}
                        >
                          <div className="frame-project__head">
                            <strong>{item.name}</strong>
                            <span className="tag">
                              {t('lt.frames', lang, { count: String(item.frameFileNames.length) })}
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
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="loop-picker__col">
                  <div className="card__head">
                    <h3>{t('lt.picker.outputs', lang)}</h3>
                    <span className="tag">
                      {t('lt.picker.count', lang, { count: String(outputs.length) })}
                    </span>
                  </div>
                  {outputs.length === 0 ? (
                    <p className="muted">{t('lt.picker.noOutputs', lang)}</p>
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
                            userClearedRef.current = false;
                            setSelectedKey(item.name);
                            setPickerOpen(false);
                          }}
                        >
                          <div className="frame-project__head">
                            <strong>{item.name}</strong>
                            <span className="tag">
                              {item.kind === 'matte' ? t('lt.kind.model', lang) : t('lt.kind.key', lang)}
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
                            {t('lt.outMeta', lang, {
                              frames: String(item.frameCount),
                              source: item.sourceName,
                            })}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <footer className="modal__foot">
              <span className="field__hint">{t('lt.picker.foot', lang)}</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(false)}>
                  {t('lt.btn.cancel', lang)}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
