import { useEffect, useMemo, useState } from 'react';

/**
 * 帧集合播放窗口。
 *
 * 抽帧生成的帧率往往很低（1–12 fps），直接用标称帧率播会慢得看不清动作，
 * 所以这里自带速度倍率（0.25×–8×），并且支持拖动进度条逐帧查看。
 *
 * 只看不写：这个窗口不会修改任何帧，纯粹用于确认「这段动画长什么样」。
 */
export interface FramePlayerModalProps {
  /** 显示在标题栏的名字（集合名或输出目录名） */
  title: string;
  /** 帧预览地址列表（kbmedia://...） */
  frameUrls: string[];
  /** 素材标称帧率 */
  fps: number;
  onClose: () => void;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export function FramePlayerModal({ title, frameUrls, fps, onClose }: FramePlayerModalProps): React.JSX.Element {
  const [playing, setPlaying] = useState(true);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);

  const total = frameUrls.length;
  const safeIndex = total > 0 ? Math.min(index, total - 1) : 0;

  useEffect(() => {
    if (!playing || total === 0) return;
    const interval = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % total);
    }, 1000 / Math.max(1, fps) / Math.max(0.1, speed));
    return () => window.clearInterval(interval);
  }, [playing, total, fps, speed]);

  const meta = useMemo(() => {
    if (total === 0) return '';
    const effective = fps * speed;
    return `${total} 帧 · 标称 ${fps} fps · 实际 ${effective >= 10 ? Math.round(effective) : effective.toFixed(1)} fps`;
  }, [total, fps, speed]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal frame-player-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal__head">
          <h2>{title}</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal__body">
          {total === 0 ? (
            <p className="muted">这个集合里没有可播放的帧。</p>
          ) : (
            <>
              <div className="frame-player__stage frame-player__stage--modal">
                <img src={frameUrls[safeIndex]} alt={`第 ${safeIndex + 1} 帧`} />
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
                  value={safeIndex}
                  onChange={(event) => {
                    setPlaying(false);
                    setIndex(Number(event.target.value));
                  }}
                />
                <span className="field__saved">
                  第 {safeIndex + 1} / {total} 帧
                </span>
                <select
                  className="input select frame-player__speed"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  title="播放速度倍率"
                >
                  {SPEEDS.map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </div>
              <span className="field__hint">{meta}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
