import { useCallback, useEffect, useState } from 'react';
import type {
  GenerateLoopVideoResult,
  KnowledgeView,
  LoopVideoProgress,
  SlotSettingsView,
} from '@shared/ipc';
import { getProviderPreset } from '@shared/providers';
import { setBusy as markBusy, tryStart } from '../state/busy';
import { notifyDataChanged, useDataRefresh } from '../state/refresh';
import { getLang, t, useLang } from '../i18n';

interface VideoStudioPageProps {
  onOpenModelSettings: () => void;
}

const DEFAULT_PROMPT_KEY = 'vd.defaultPrompt';
const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12];
const RESOLUTIONS: { value: '480p' | '720p' | '1080p'; labelKey: string }[] = [
  { value: '480p', labelKey: 'vd.res.fast' },
  { value: '720p', labelKey: 'vd.res.recommended' },
  { value: '1080p', labelKey: 'vd.res.slow' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function VideoStudioPage({ onOpenModelSettings }: VideoStudioPageProps): React.JSX.Element {
  const [lang] = useLang();
  const [slot, setSlot] = useState<SlotSettingsView | null>(null);
  const [images, setImages] = useState<KnowledgeView[]>([]);
  const [selected, setSelected] = useState<KnowledgeView | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);

  const [prompt, setPrompt] = useState(() => t(DEFAULT_PROMPT_KEY, getLang()));
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

  /* 素材库导入/改名/删除图片后，这里的候选图列表要刷新；
     在设置页保存/删除视频槽位的 Key 后，槽位状态也要刷新（否则一直显示配置前的样子）。 */
  useDataRefresh(() => {
    void loadImages();
    void (async () => {
      const slots = await window.skeletonElf.settings.getSlots();
      if (slots.ok) setSlot(slots.data.find((item) => item.slot === 'video') ?? null);
    })();
  });

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
      setError(t('vd.err.noModel2', lang));
      return;
    }
    if (!ready) {
      setError(t('vd.err.slotNotReady', lang));
      return;
    }
    if (!selected) {
      setError(t('vd.err.noImage2', lang));
      return;
    }
    if (!tryStart('video-studio', t('busy.label.videoStudio', lang))) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ stage: 'submitting', message: t('vd.preparing', lang) });

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
    // 新视频进了素材库：素材库页、帧动画页的视频列表都要刷新
    notifyDataChanged();
  };

  // AI 优化提示词：只回填输入框，绝不自动触发生成
  const handleOptimize = async (): Promise<void> => {
    setOptimizing(true);
    setOptimizeNote(null);
    const res = await window.skeletonElf.prompts.optimize(prompt, 'video');
    setOptimizing(false);
    if (!res.ok) {
      setOptimizeNote(t('vd.optimize.failed', lang, { error: res.error }));
      return;
    }
    setPrompt(res.data.prompt);
    setOptimizeNote(t('vd.optimize.done', lang));
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
            <h2>{t('vd.title', lang)}</h2>
            <span className={`tag ${ready ? 'tag--ok' : 'tag--warn'}`}>
              {ready
                ? t('vd.slot.ready', lang)
                : slotEnabled
                  ? t('vd.slot.noKey', lang)
                  : t('vd.slot.disabled', lang)}
            </span>
          </div>
          <p className="muted">{t('vd.intro', lang)}</p>

          <div className="studio-slot">
            {slot ? (
              <>
                <span className="studio-slot__label">
                  {preset ? t(preset.labelKey, lang) : slot.providerId}
                </span>
                <code>{slot.model || t('vd.slot.noModel', lang)}</code>
              </>
            ) : (
              <span className="muted">{t('vd.slot.loading', lang)}</span>
            )}
            <button type="button" className="btn btn--ghost" onClick={onOpenModelSettings}>
              {t('vd.slot.configure', lang)}
            </button>
          </div>

          <div className="field">
            <span className="field__label">
              {t('vd.pick.label', lang)}
              <em className="field__saved">
                {t('vd.pick.count', lang, { count: String(images.length) })}
              </em>
            </span>
            {loadingImages ? <span className="field__hint">{t('vd.pick.loading', lang)}</span> : null}

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
                  {t('vd.btn.changeImage', lang)}
                </button>
                {/* 取消选择：不然选错了只能重启应用，或者把素材库里的图删掉 */}
                <button type="button" className="btn btn--ghost" onClick={() => setSelected(null)}>
                  {t('vd.btn.clearSelection', lang)}
                </button>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setImagePickerOpen(true)}>
                  {t('vd.btn.pickImage', lang)}
                </button>
                {images.length === 0 && !loadingImages ? (
                  <span className="field__hint">{t('vd.hint.noImages', lang)}</span>
                ) : null}
              </div>
            )}
          </div>

          <div className="field">
            <span className="field__label">{t('vd.mode', lang)}</span>
            <div className="bg-swatches">
              <button
                type="button"
                className={`bg-chip${mode === 'direct' ? ' is-active' : ''}`}
                onClick={() => setMode('direct')}
              >
                {t('vd.mode.direct', lang)}
              </button>
              <button
                type="button"
                className={`bg-chip${mode === 'reference' ? ' is-active' : ''}`}
                onClick={() => setMode('reference')}
              >
                {t('vd.mode.reference', lang)}
              </button>
            </div>
            <span className="field__hint">
              {mode === 'direct' ? t('vd.mode.directHint', lang) : t('vd.mode.referenceHint', lang)}
            </span>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={lockBackground}
              onChange={(event) => setLockBackground(event.target.checked)}
            />
            {t('vd.lockBackground', lang)}
          </label>

          {mode === 'reference' ? (
            <div className="field">
              <span className="field__label">
                {t('vd.refs.label', lang)}{' '}
                <em className="field__saved">
                  {t('vd.refs.selected', lang, { count: String(referenceIds.length) })}
                </em>
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
                      title={t('vd.refs.removeTitle', lang, { name: item.fileName })}
                      onClick={() => toggleReference(item.id)}
                    >
                      {item.thumbUrl ? <img src={item.thumbUrl} alt={item.fileName} /> : <span>?</span>}
                      <span className="ref-chip__x">×</span>
                    </button>
                  ))}
                <button type="button" className="btn btn--ghost" onClick={() => setPickerOpen(true)}>
                  {t('vd.btn.pickRef', lang)}
                </button>
              </div>
              <span className="field__hint">{t('vd.refs.hint', lang)}</span>
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">{t('vd.prompt.label', lang)}</span>
            <textarea
              className="input textarea"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <span className="field__hint">{t('vd.prompt.hint', lang)}</span>
          </label>

          <div className="actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void handleOptimize()}
              disabled={optimizing || busy}
            >
              {optimizing ? t('vd.btn.optimizing', lang) : t('vd.btn.optimize', lang)}
            </button>
            <span className="field__hint">{t('vd.optimize.hint', lang)}</span>
          </div>
          {optimizeNote ? <div className="banner banner--ok">{optimizeNote}</div> : null}

          <div className="studio-params">
            <label className="field">
              <span className="field__label">{t('vd.duration', lang)}</span>
              <select className="input select" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {DURATIONS.map((value) => (
                  <option key={value} value={value}>
                    {t('vd.seconds', lang, { count: String(value) })}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{t('vd.resolution', lang)}</span>
              <select
                className="input select"
                value={resolution}
                onChange={(event) => setResolution(event.target.value as '480p' | '720p' | '1080p')}
              >
                {RESOLUTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey, lang)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleGenerate()} disabled={busy || !ready}>
              {busy ? t('vd.btn.generating', lang) : t('vd.btn.generate', lang)}
            </button>
            {selected ? (
              <span className="hint">{t('vd.selected', lang, { name: selected.fileName })}</span>
            ) : (
              <span className="hint hint--warn">{t('vd.notSelected', lang)}</span>
            )}
          </div>

          {progress ? (
            <div className={`banner ${progress.stage === 'failed' ? 'banner--error' : 'banner--ok'}`}>
              {progress.message}
              {progress.taskId ? t('vd.taskId', lang, { id: progress.taskId }) : ''}
            </div>
          ) : null}
          {error ? <div className="banner banner--error">{error}</div> : null}
        </section>

        {result ? (
          <section className="card">
            <div className="card__head">
              <h2>{t('vd.result.title', lang)}</h2>
              <span className="hint">
                {t('vd.result.meta', lang, {
                  res: result.resolution,
                  sec: String(result.durationSeconds),
                  size: formatBytes(result.bytes),
                  elapsed: (result.elapsedMs / 1000).toFixed(1),
                })}
              </span>
            </div>
            <video className="kb-detail__preview" src={resultUrl} controls autoPlay loop muted preload="metadata" />
            <div className="actions">
              <button type="button" className="btn btn--ghost" onClick={() => void window.skeletonElf.files.reveal(result.absPath)}>
                {t('vd.btn.reveal', lang)}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void window.skeletonElf.files.openDir('knowledge')}>
                {t('vd.btn.openLib', lang)}
              </button>
              <span className="hint">{t('vd.result.saved', lang, { name: result.fileName })}</span>
            </div>
          </section>
        ) : null}
      </div>

      <div className="stack">
        <section className="card card--hint">
          <h3>{t('vd.why.title', lang)}</h3>
          <p className="muted">{t('vd.why.body', lang)}</p>
        </section>
        <section className="card card--hint">
          <h3>{t('vd.prereq.title', lang)}</h3>
          <p className="muted">
            {t('vd.prereq.body', lang)
              .split('\n')
              .map((line, index) => (
                <span key={line}>
                  {index > 0 ? <br /> : null}
                  {line}
                </span>
              ))}
          </p>
        </section>
      </div>

      {/* 主图选择弹窗：点一下即选定并关闭 */}
      {imagePickerOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setImagePickerOpen(false)}>
          <div className="modal modal--picker" onClick={(event) => event.stopPropagation()}>
            <header className="modal__head">
              <h2>{t('vd.picker.imageTitle', lang)}</h2>
              <span className="tag">
                {t('vd.pick.count', lang, { count: String(images.length) })}
              </span>
            </header>
            <div className="modal__body">
              {images.length === 0 ? (
                <p className="muted">{t('vd.picker.empty', lang)}</p>
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
                      {item.thumbUrl ? (
                        <img src={item.thumbUrl} alt={item.fileName} />
                      ) : (
                        <span>{t('vd.noThumb', lang)}</span>
                      )}
                      {selected?.id === item.id ? <span className="picker-item__badge">✓</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">{t('vd.picker.foot', lang)}</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setImagePickerOpen(false)}>
                  {t('vd.btn.cancel', lang)}
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
              <h2>{t('vd.picker.refTitle', lang)}</h2>
              <span className="tag">
                {t('vd.refs.selected', lang, { count: String(referenceIds.length) })}
              </span>
            </header>
            <div className="modal__body">
              {images.length === 0 ? (
                <p className="muted">{t('vd.picker.empty', lang)}</p>
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
                        {item.thumbUrl ? (
                          <img src={item.thumbUrl} alt={item.fileName} />
                        ) : (
                          <span>{t('vd.noThumb', lang)}</span>
                        )}
                        {picked ? <span className="picker-item__badge">{referenceIds.indexOf(item.id) + 1}</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <footer className="modal__foot">
              <span className="field__hint">{t('vd.picker.refFoot', lang)}</span>
              <div className="actions">
                <button type="button" className="btn btn--ghost" onClick={() => setReferenceIds([])}>
                  {t('vd.btn.clear', lang)}
                </button>
                <button type="button" className="btn btn--primary" onClick={() => setPickerOpen(false)}>
                  {t('vd.btn.done', lang)}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
