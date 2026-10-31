import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 抽帧裁剪范围设置窗口。
 *
 * 为什么单独开窗口，而不是在页面上直接拖：
 *   - 页面上的 video 自带播放控件，覆盖层要么挡住控件、要么让出高度导致坐标算错；
 *   - 裁剪是个「要精确」的操作，需要数值输入（宽高 / 偏移）配合，页面上放不下；
 *   - 关掉窗口即结束编辑，不用管「框选模式」开没开。
 *
 * 交互：画面里拖出矩形 = 框选；右侧可以直接输入精确像素值；确定后把结果交回调用方。
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoCropModalProps {
  /** 视频 blob URL（和页面上是同一个，浏览器会复用缓存，不会重复解码整个文件） */
  videoUrl: string;
  /** 视频原始像素尺寸 */
  videoSize: { width: number; height: number };
  /** 进入窗口时已有的裁剪范围；null = 整帧 */
  initialCrop: CropRect | null;
  onCancel: () => void;
  /** 传 null 表示改回整帧 */
  onConfirm: (crop: CropRect | null) => void;
}

const MIN_SIZE = 8;

export function VideoCropModal({
  videoUrl,
  videoSize,
  initialCrop,
  onCancel,
  onConfirm,
}: VideoCropModalProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragStart = useRef<{ x0: number; y0: number } | null>(null);

  const [crop, setCrop] = useState<CropRect | null>(initialCrop);
  /** 拖动中的矩形（显示坐标，单位 px） */
  const [dragging, setDragging] = useState<CropRect | null>(null);
  /** 视频当前显示的尺寸（元数据加载后才有） */
  const [box, setBox] = useState({ width: 0, height: 0 });

  /** 视频元素 = 画面本身（CSS 里宽高自适应，没有黑边），所以用它自己的 rect 换算 */
  const measure = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const rect = video.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, Math.round(value)));

  /** 把像素坐标约束在视频范围内 */
  const normalize = (rect: CropRect): CropRect | null => {
    const w = clamp(rect.w, MIN_SIZE, videoSize.width);
    const h = clamp(rect.h, MIN_SIZE, videoSize.height);
    const x = clamp(rect.x, 0, videoSize.width - w);
    const y = clamp(rect.y, 0, videoSize.height - h);
    return { x, y, w, h };
  };

  const patch = (part: Partial<CropRect>): void => {
    const base = crop ?? { x: 0, y: 0, w: videoSize.width, h: videoSize.height };
    setCrop(normalize({ ...base, ...part }));
  };

  const handleDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    const video = videoRef.current;
    if (!video) return;
    const rect = video.getBoundingClientRect();
    dragStart.current = { x0: event.clientX - rect.left, y0: event.clientY - rect.top };
    setDragging(null);
  };

  const handleMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    const video = videoRef.current;
    if (!start || !video) return;
    const rect = video.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setDragging({
      x: Math.min(start.x0, x),
      y: Math.min(start.y0, y),
      w: Math.abs(x - start.x0),
      h: Math.abs(y - start.y0),
    });
  };

  const handleUp = (): void => {
    const start = dragStart.current;
    const video = videoRef.current;
    const drawn = dragging;
    dragStart.current = null;
    setDragging(null);
    if (!start || !video || !drawn) return;
    if (drawn.w < MIN_SIZE || drawn.h < MIN_SIZE) return;

    const rect = video.getBoundingClientRect();
    const scaleX = videoSize.width / rect.width;
    const scaleY = videoSize.height / rect.height;
    setCrop(
      normalize({
        x: drawn.x * scaleX,
        y: drawn.y * scaleY,
        w: drawn.w * scaleX,
        h: drawn.h * scaleY,
      }),
    );
  };

  /** 像素 → 画面上的百分比（窗口缩放时框跟着缩放） */
  const percentOf = (rect: CropRect | null): React.CSSProperties | null => {
    if (!rect || videoSize.width <= 0 || videoSize.height <= 0) return null;
    return {
      left: `${(rect.x / videoSize.width) * 100}%`,
      top: `${(rect.y / videoSize.height) * 100}%`,
      width: `${(rect.w / videoSize.width) * 100}%`,
      height: `${(rect.h / videoSize.height) * 100}%`,
    };
  };

  const dragStyle: React.CSSProperties | null = dragging
    ? { left: dragging.x, top: dragging.y, width: dragging.w, height: dragging.h }
    : null;

  const current = crop ?? { x: 0, y: 0, w: videoSize.width, h: videoSize.height };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal video-crop-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal__head">
          <div>
            <h2>设置抽帧裁剪范围</h2>
            <span className="field__hint">
              在画面里拖出要保留的区域，或直接在右侧输入像素值。只抽这块，帧文件会小很多。
            </span>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onCancel} title="关闭（Esc）">
            ×
          </button>
        </header>

        <div className="video-crop__body">
          <div className="video-crop__stage">
            {/* frame 紧贴视频画面：框选层的 inset:0 才和画面严丝合缝，
                百分比定位的裁剪框才不会因为 stage 的 padding 而偏移 */}
            <div className="video-crop__frame">
              <video
                ref={videoRef}
                src={videoUrl}
                className="video-crop__video"
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = Math.min(0.05, event.currentTarget.duration || 0);
                  measure();
                }}
              />

              <div
                className="crop-layer is-active"
                onMouseDown={handleDown}
                onMouseMove={handleMove}
                onMouseUp={handleUp}
                onMouseLeave={() => {
                  dragStart.current = null;
                  setDragging(null);
                }}
              >
                {crop ? (
                  <div className="crop-rect" style={percentOf(crop) ?? undefined}>
                    <span className="crop-rect__size">
                      {crop.w}×{crop.h}
                    </span>
                  </div>
                ) : null}
                {dragStyle ? <div className="crop-rect crop-rect--drawing" style={dragStyle} /> : null}
                {!crop && !dragging && box.width > 0 ? (
                  <span className="crop-layer__hint">按住鼠标拖出裁剪范围</span>
                ) : null}
              </div>
            </div>
          </div>

          <aside className="video-crop__panel">
            <div className="video-crop__row">
              <label className="field">
                <span className="field__label">宽（px）</span>
                <input
                  className="input input--num"
                  type="number"
                  min={MIN_SIZE}
                  max={videoSize.width}
                  value={current.w}
                  onChange={(event) => patch({ w: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field__label">高（px）</span>
                <input
                  className="input input--num"
                  type="number"
                  min={MIN_SIZE}
                  max={videoSize.height}
                  value={current.h}
                  onChange={(event) => patch({ h: Number(event.target.value) })}
                />
              </label>
            </div>

            <div className="video-crop__row">
              <label className="field">
                <span className="field__label">左上 X</span>
                <input
                  className="input input--num"
                  type="number"
                  min={0}
                  max={Math.max(0, videoSize.width - current.w)}
                  value={current.x}
                  onChange={(event) => patch({ x: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field__label">左上 Y</span>
                <input
                  className="input input--num"
                  type="number"
                  min={0}
                  max={Math.max(0, videoSize.height - current.h)}
                  value={current.y}
                  onChange={(event) => patch({ y: Number(event.target.value) })}
                />
              </label>
            </div>

            <div className="video-crop__quick">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setCrop({ x: 0, y: 0, w: videoSize.width, h: videoSize.height })}
              >
                整帧
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  // 居中取 3/4：大图里角色一般占中间，先给个合理起点再微调
                  const w = Math.round(videoSize.width * 0.75);
                  const h = Math.round(videoSize.height * 0.75);
                  setCrop(normalize({ x: (videoSize.width - w) / 2, y: (videoSize.height - h) / 2, w, h }));
                }}
              >
                居中 75%
              </button>
            </div>

            <span className="field__hint">
              原始尺寸 {videoSize.width}×{videoSize.height}
              {crop ? (
                <>
                  <br />
                  当前会抽 <b>
                    {crop.w}×{crop.h}
                  </b>{' '}
                  的区域
                </>
              ) : (
                <>
                  <br />
                  当前：整帧（不裁剪）
                </>
              )}
            </span>
          </aside>
        </div>

        <footer className="modal__foot">
          <span className="field__hint">裁剪只影响这次的抽帧结果，不会改原视频。</span>
          <div className="video-crop__actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="btn btn--primary" onClick={() => onConfirm(crop)}>
              确定
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
