import { useCallback, useEffect, useState } from 'react';
import type {
  GenerateLoopVideoResult,
  KnowledgeView,
  LoopVideoProgress,
  SlotSettingsView,
} from '@shared/ipc';
import { getProviderPreset } from '@shared/providers';
import { setBusy as markBusy, tryStart } from '../state/busy';

interface VideoStudioPageProps {
  onOpenModelSettings: () => void;
}

const DEFAULT_PROMPT = '角色轻微呼吸，衣摆与发丝自然摆动，镜头固定，动作首尾衔接无缝循环';
const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12];
const RESOLUTIONS: { value: '480p' | '720p' | '1080p'; label: string }[] = [
  { value: '480p', label: '480p（最快）' },
  { value: '720p', label: '720p（推荐）' },
  { value: '1080p', label: '1080p（最慢）' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function VideoStudioPage({ onOpenModelSettings }: VideoStudioPageProps): React.JSX.Element {
  const [slot, setSlot] = useState<SlotSettingsView | null>(null);
  const [images, setImages] = useState<KnowledgeView[]>([]);
  const [selected, setSelected] = useState<KnowledgeView | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState<'480p' | '720p' | '1080p'>('720p');

  /** direct = 首尾帧循环；reference = 用素材库图片做参考生成 */
  const [mode, setMode] = useState<'direct' | 'reference'>('direct');
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [lockBackground, setLockBackground] = useState(true);
  /** 参考图选择弹窗（列表太长，单独弹窗看） */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 主图选择弹窗（同样单独看，避免页面被网格撑长） */
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeNote, setOptimizeNote] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<LoopVideoProgress | null>(null);
  const [result, setResult] = useState<GenerateLoopVideoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadImages = useCallback(async () => {
    setLoadingImages(true);
    const res = await window.skeletonElf.knowledge.list();
    setLoadingImages(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setImages(res.data.filter((item) => item.kind === 'image'));
  }, []);

  useEffect(() => {
    void (async () => {
      const slots = await window.skeletonElf.settings.getSlots();
      if (slots.ok) setSlot(slots.data.find((item) => item.slot === 'video') ?? null);
    })();
    void loadImages();
  }, [loadImages]);

  // 订阅主进程推送的进度
  useEffect(() => {
    const unsubscribe = window.skeletonElf.video.onProgress((next) => setProgress(next));
    return unsubscribe;
  }, []);

  const preset = slot ? getProviderPreset(slot.providerId) : null;
  const slotEnabled = slot ? slot.enabled !== false : true;
  const ready = slotEnabled && Boolean(slot?.hasKey);

  const handleGenerate = async (): Promise<void> => {
    if (!slot?.model) {
      setError('还没有选择视频模型：请到「模型设置 → 视频生成」拉取模型列表并选一个（如 doubao-seedance-2-5-260628），再回来生成');
      return;
    }
    if (!ready) {
      setError('视频槽位还没配置好（可能已停用或没填 API Key）：请到「模型设置 → 视频生成」检查');
      return;
    }
    if (!selected) {
      setError('先在上面选一张图片');
      return;
    }
    if (!tryStart('video-studio', '循环视频')) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ stage: 'submitting', message: '准备中…' });

    const res = await window.skeletonElf.video.generateLoop({
      imageAbsPath: selected.absPath,
      prompt,
      duration,
      resolution,
      mode,
      referenceImagePaths:
        mode === 'reference'
          ? images.filter((item) => referenceIds.includes(item.id)).map((item) => item.absPath)
          : [],
      lockBackground,
    });
    markBusy('video-studio', false);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      setProgress({ stage: 'failed', message: res.error });
      return;
    }
    setResult(res.data);
    void loadImages();
  };

  // AI 优化提示词：只回填输入框，绝不自动触发生成
  const handleOptimize = async (): Promise<void> => {
    setOptimizing(true);
    setOptimizeNote(null);
    const res = await window.skeletonElf.prompts.optimize(prompt, 'video');
    setOptimizing(false);
    if (!res.ok) {
      setOptimizeNote(`优化失败：${res.error}`);
      return;
    }
    setPrompt(res.data.prompt);
    setOptimizeNote('已回填优化后的提示词，确认满意再点「生成循环视频」');
  };

  const toggleReference = (id: string): void => {
    setReferenceIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(0, 4)));
  };

  const resultUrl = result ? `kbmedia://file/${encodeURIComponent(result.fileName)}` : '';

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>图片 → 循环视频</h2>
            <span className={`tag ${ready ? 'tag--ok' : 'tag--warn'}`}>
              {ready ? '视频槽位已就绪' : slotEnabled ? '视频槽位未配置 Key' : '视频槽位已停用'}
            </span>
          </div>
          <p className="muted">
            用豆包 Seedance 的「首帧 + 尾帧」模式：把同一张图同时当作首尾帧，生成的视频天然无缝循环，
            适合做精灵图的待机 / 呼吸动画。
          </p>

          <div className="studio-slot">
            {slot ? (
              <>
                <span className="studio-slot__label">{preset?.label ?? slot.providerId}</span>
                <code>{slot.model || '未设置模型'}</code>
              </>
            ) : (
              <span className="muted">正在读取视频槽位…</span>
            )}
            <button type="button" className="btn btn--ghost" onClick={onOpenModelSettings}>
              去配置视频槽位
            </button>
          </div>

          <div className="field">
            <span className="field__label">
              选择图片（来自素材库）
              <em className="field__saved">{images.length} 张可选</em>
            </span>
            {loadingImages ? <span className="field__hint">正在读取素材库…</span> : null}

            {/* 主图也只占一行：已选小缩略图 + 按钮，完整列表在弹窗里选 */}
            {selected ? (
              <div className="ref-strip">
                <span className="ref-chip ref-chip--static" title={selected.fileName}>
                  {selected.thumbUrl ? <img src={selected.thumbUrl} alt={selected.fileName} /> : <span>?</span>}
                </span>
                <code className="ref-strip__name" title={selected.absPath}>
                  {selected.fileName}
                </code>
                <button type="button" className="btn btn--ghost" onClick={() => setImagePickerOpen(true)}>
                  更换图片
                </button>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setImagePickerOpen(true)}>
                  选择图片
                </button>
                {images.length === 0 && !loadingImages ? (
                  <span className="field__hint">
                    素材库还没有图片。先去「图像生成」出一张，或到「素材库」导入现成图片。
                  </span>
                ) : null}
              </div>
            )}
          </div>

          <div className="field">
            <span className="field__label">生成方式</span>
            <div className="bg-swatches">
              <button
                type="button"
                className={`bg-chip${mode === 'direct' ? ' is-active' : ''}`}
                onClick={() => setMode('direct')}
              >
                直接生成（首尾帧循环）
              </button>
              <button
                type="button"
                className={`bg-chip${mode === 'reference' ? ' is-active' : ''}`}
                onClick={() => setMode('reference')}
              >
                参考素材生成
              </button>
            </div>
            <span className="field__hint">
              {mode === 'direct'
                ? '首帧和尾帧用同一张图，生成结果天然无缝循环 —— 要循环动画就选这个。'
                : '用素材库里的图片当「动作参考」（最多 4 张）：只学动作节奏与姿态，不改你的角色美术；需要支持多模态参考的模型（Seedance 2.0+）。'}
            </span>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={lockBackground}
              onChange={(event) => setLockBackground(event.target.checked)}
            />
            锁定纯色背景（提示词里强制「背景颜色/亮度/平整度不变、不新增地面道具光斑」）
          </label>

          {mode === 'reference' ? (
            <div className="field">
              <span className="field__label">
                参考图 <em className="field__saved">已选 {referenceIds.length} / 4</em>
              </span>

              {/* 已选的参考图只用一条小缩略图展示，完整列表在弹窗里选，避免页面被撑长 */}
              <div className="ref-strip">
                {images
                  .filter((item) => referenceIds.includes(item.id))
                  .map((item) => (
                    <button
                      key={`picked-${item.id}`}
                      type="button"
                      className="ref-chip"
                      title={`${item.fileName}（点击移除）`}
                      onClick={() => toggleReference(item.id)}
                    >
                      {item.thumbUrl ? <img src={item.thumbUrl} alt={item.fileName} /> : <span>?</span>}
                      <span className="ref-chip__x">×</span>
                    </button>
                  ))}
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(true)}>
                  选择参考图
                </button>
              </div>
              <span className="field__hint">
                点缩略图可移除；参考视频需要公网 URL（当前未接入对象存储，暂只支持图片）。
              </span>
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">动作描述（可改）</span>
            <textarea
              className="input textarea"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <span className="field__hint">描述越具体，动作越可控；留空会用默认的「轻微呼吸 + 摆动」。</span>
          </label>

          <div className="actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void handleOptimize()}
              disabled={optimizing || busy}
            >
              {optimizing ? 'AI 优化中…' : 'AI 优化提示词'}
            </button>
            <span className="field__hint">只把优化结果填回输入框，不会自动发送；你确认后再点生成。</span>
          </div>
          {optimizeNote ? <div className="banner banner--ok">{optimizeNote}</div> : null}

          <div className="studio-params">
            <label className="field">
              <span className="field__label">时长</span>
              <select className="input select" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {DURATIONS.map((value) => (
                  <option key={value} value={value}>
                    {value} 秒
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">分辨率</span>
              <select
                className="input select"
                value={resolution}
                onChange={(event) => setResolution(event.target.value as '480p' | '720p' | '1080p')}
              >
                {RESOLUTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleGenerate()} disabled={busy || !ready}>
              {busy ? '生成中…' : '生成循环视频'}
            </button>
            {selected ? <span className="hint">已选：{selected.fileName}</span> : <span className="hint hint--warn">还没选图</span>}
          </div>

          {progress ? (
            <div className={`banner ${progress.stage === 'failed' ? 'banner--error' : 'banner--ok'}`}>
              {progress.message}
              {progress.taskId ? ` · 任务 ${progress.taskId}` : ''}
            </div>
          ) : null}
          {error ? <div className="banner banner--error">{error}</div> : null}
        </section>

        {result ? (
          <section className="card">
            <div className="card__head">
              <h2>生成结果</h2>
              <span className="hint">
                {result.resolution} · {result.durationSeconds}s · {formatBytes(result.bytes)} · 耗时{' '}
                {(result.elapsedMs / 1000).toFixed(1)}s
              </span>
            </div>
            <video className="kb-detail__preview" src={resultUrl} controls autoPlay loop muted preload="metadata" />
            <div className="actions">
              <button type="button" className="btn btn--ghost" onClick={() => void window.skeletonElf.files.reveal(result.absPath)}>
                定位文件
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void window.skeletonElf.files.openDir('knowledge')}>
                打开素材库目录
              </button>
              <span className="hint">已存入素材库（{result.fileName}）</span>
            </div>
          </section>
        ) : null}
      </div>

      <div className="stack">
        <section className="card card--hint">
          <h3>为什么这样能循环</h3>
          <p className="muted">
            首帧和尾帧都传同一张图，模型会把动作从起始姿态带回起始姿态 —— 首尾帧完全一致，
            循环播放时没有跳帧。视频生成是异步任务：提交后要排队 + 渲染，通常 <b>1–5 分钟</b>。
          </p>
        </section>
        <section className="card card--hint">
          <h3>前置条件</h3>
          <p className="muted">
            1. 在「模型设置 → 视频生成」填好 Key（豆包那把 key 可以复用，但 <b>Seedance 模型要在方舟控制台单独开通</b>）。<br />
            2. 图片建议已去背景（透明背景），这样后续做帧动画时不用再抠一遍。
          </p>
        </section>
      </div>

      {/* 主图选择弹窗：点一下即选定并关闭 */}
      {imagePickerOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setImagePickerOpen(false)}>
          <div className="modal modal--picker" onClick={(event) => event.stopPropagation()}>
            <header className="modal__head">
              <h2>选择图片</h2>
              <span className="tag">{images.length} 张可选</span>
            </header>
            <div className="modal__body">
              {images.length === 0 ? (
                <p className="muted">素材库里还没有图片，先去「图像生成」出图或导入图片。</p>
              ) : (
                <div className="picker-grid">
                  {images.map((item) => (
                    <button
                      key={`main-${item.id}`}
                      type="button"
                      className={`picker-item${selected?.id === item.id ? ' is-active' : ''}`}
                      title={item.fileName}
                      onClick={() => {
                        setSelected(item);
                        setImagePickerOpen(false);
                      }}
                    >
                      {item.thumbUrl ? <img src={item.thumbUrl} alt={item.fileName} /> : <span>无缩略图</span>}
                      {selected?.id === item.id ? <span className="picker-item__badge">✓</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">点图片即选定</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setImagePickerOpen(false)}>
                  取消
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      {pickerOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPickerOpen(false)}>
          <div className="modal modal--picker" onClick={(event) => event.stopPropagation()}>
            <header className="modal__head">
              <h2>选择参考图</h2>
              <span className="tag">已选 {referenceIds.length} / 4</span>
            </header>
            <div className="modal__body">
              {images.length === 0 ? (
                <p className="muted">素材库里还没有图片，先去「图像生成」出图或导入图片。</p>
              ) : (
                <div className="picker-grid">
                  {images.map((item) => {
                    const picked = referenceIds.includes(item.id);
                    return (
                      <button
                        key={`pick-${item.id}`}
                        type="button"
                        className={`picker-item${picked ? ' is-active' : ''}`}
                        onClick={() => toggleReference(item.id)}
                        title={item.fileName}
                      >
                        {item.thumbUrl ? <img src={item.thumbUrl} alt={item.fileName} /> : <span>无缩略图</span>}
                        {picked ? <span className="picker-item__badge">{referenceIds.indexOf(item.id) + 1}</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">最多 4 张，点图选中 / 取消</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setReferenceIds([])}>
                  清空
                </button>
                <button type="button" className="btn btn--primary" onClick={() => setPickerOpen(false)}>
                  完成
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
