import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BackgroundSuggestion,
  EditableImage,
  GenerateImageResult,
  SlotSettingsView,
  UsageStats,
} from '@shared/ipc';
import { BACKGROUND_PRESETS, pickAutoBackground, unitPriceOf } from '@shared/pricing';
import { getProviderPreset } from '@shared/providers';
import { ImageEditorModal } from '../components/ImageEditorModal';
import { setBusy, tryStart } from '../state/busy';
import { t, useLang } from '../i18n';

// 豆包 Seedream 5.x 用档位（1K/2K）或像素值；像素需落在 921600–4624220 之间
const SIZES = ['2K', '1K', '1.5K', '2048x1024', '1024x2048', '1536x1024'];
const COUNTS = [1, 2, 3, 4];

const PROMPT_EXAMPLE_KEYS = ['im.example1', 'im.example2'];

const ARK_CONSOLE_URL = 'https://console.volcengine.com/ark/region:cn-beijing/overview';

interface ImageStudioPageProps {
  onOpenModelSettings: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function ImageStudioPage({ onOpenModelSettings }: ImageStudioPageProps): React.JSX.Element {
  const [lang] = useLang();
  const [slot, setSlot] = useState<SlotSettingsView | null>(null);

  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState(SIZES[0]);
  const [count, setCount] = useState(1);
  const [saveToKnowledge, setSaveToKnowledge] = useState(true);

  // 背景色：默认由文本模型分析主体色后自动避让，也可手动指定纯色
  const [autoBackground, setAutoBackground] = useState(true);
  const [manualBackground, setManualBackground] = useState(BACKGROUND_PRESETS[2].color);
  const autoPick = useMemo(() => pickAutoBackground(prompt), [prompt]);
  const [suggestion, setSuggestion] = useState<BackgroundSuggestion | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const effectiveBackground = autoBackground ? (suggestion?.color ?? autoPick.color) : manualBackground;

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateImageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<EditableImage | null>(null);
  const [editingError, setEditingError] = useState<string | null>(null);

  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    const res = await window.skeletonElf.ai.usage();
    setUsageLoading(false);
    if (res.ok) setUsage(res.data);
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await window.skeletonElf.settings.getSlots();
      if (!res.ok) return;
      const found = res.data.find((item) => item.slot === 'image');
      if (found) setSlot(found);
    })();
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const preset = slot ? getProviderPreset(slot.providerId) : null;
  const slotEnabled = slot ? slot.enabled !== false : true;
  const ready = slotEnabled && (Boolean(slot?.hasKey) || preset?.requiresKey === false);
  const unitPrice = slot ? unitPriceOf(slot.model) : undefined;
  const thisCost = unitPrice === undefined ? null : Number((unitPrice * count).toFixed(2));

  // 让文本模型分析主体主色，选出对比最大的纯色背景
  const analyzeBackground = useCallback(async (): Promise<BackgroundSuggestion | null> => {
    if (!prompt.trim()) return null;
    setAnalyzing(true);
    const res = await window.skeletonElf.ai.suggestBackground(prompt);
    setAnalyzing(false);
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    setSuggestion(res.data);
    return res.data;
  }, [prompt]);

  const handleGenerate = async (): Promise<void> => {
    if (!slot?.model) {
      setError(t('im.err.noModel', lang));
      return;
    }
    if (!slot.hasKey) {
      setError(t('im.err.noKey', lang));
      return;
    }
    if (!prompt.trim()) {
      setError(t('im.err.noPrompt', lang));
      return;
    }
    setError(null);
    setNotice(null);

    // 自动模式：生成前先让文本模型分析主体颜色（失败则回退关键词启发式）
    let background = effectiveBackground;
    if (autoBackground) {
      const picked = suggestion ?? (await analyzeBackground());
      background = picked?.color ?? autoPick.color;
    }

    // 和正在跑的其它长任务冲突时先问用户，他点取消就什么都不做
    if (!tryStart('image-studio', t('im.busyLabel', lang))) return;
    setGenerating(true);
    setResult(null);
    const res = await window.skeletonElf.ai.generateImage({
      prompt,
      size,
      count,
      saveToKnowledge,
      backgroundColor: background,
    });
    setGenerating(false);
    setBusy('image-studio', false);
    if (res.ok) {
      setResult(res.data);
      void loadUsage();
    } else setError(res.error);
  };

  const openDir = async (kind: 'knowledge' | 'cache'): Promise<void> => {
    const res = await window.skeletonElf.files.openDir(kind);
    if (!res.ok) setError(res.error);
  };

  const reveal = async (absPath: string): Promise<void> => {
    const res = await window.skeletonElf.files.reveal(absPath);
    if (!res.ok) setError(res.error);
  };

  const startEdit = async (absPath: string): Promise<void> => {
    setEditingError(null);
    const res = await window.skeletonElf.files.readImage(absPath);
    if (!res.ok) {
      setEditingError(res.error);
      return;
    }
    setEditing(res.data);
  };

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>{t('im.title', lang)}</h2>
            <span className={`tag ${ready ? 'tag--ok' : 'tag--warn'}`}>
              {ready
                ? t('im.slot.ready', lang)
                : slotEnabled
                  ? t('im.slot.noKey', lang)
                  : t('im.slot.disabled', lang)}
            </span>
          </div>

          <div className="studio-slot">
            {slot ? (
              <>
                <span className="studio-slot__label">
                  {preset ? t(preset.labelKey, lang) : slot.providerId}
                </span>
                <code>{slot.model || t('im.slot.noModel', lang)}</code>
                <code className="muted">{slot.baseUrl}</code>
              </>
            ) : (
              <span className="muted">{t('im.slot.loading', lang)}</span>
            )}
            <button type="button" className="btn btn--ghost" onClick={onOpenModelSettings}>
              {t('im.slot.configure', lang)}
            </button>
          </div>

          <label className="field">
            <span className="field__label">{t('im.prompt', lang)}</span>
            <textarea
              className="input textarea"
              rows={5}
              value={prompt}
              placeholder={t(PROMPT_EXAMPLE_KEYS[0], lang)}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <span className="field__hint">
              {PROMPT_EXAMPLE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className="link-btn"
                  onClick={() => setPrompt(t(key, lang))}
                >
                  {t('im.example', lang)}
                </button>
              ))}
            </span>
          </label>

          <div className="studio-params">
            <label className="field">
              <span className="field__label">{t('im.size', lang)}</span>
              <select className="input select" value={size} onChange={(event) => setSize(event.target.value)}>
                {SIZES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">{t('im.count', lang)}</span>
              <select className="input select" value={count} onChange={(event) => setCount(Number(event.target.value))}>
                {COUNTS.map((option) => (
                  <option key={option} value={option}>
                    {t('im.countUnit', lang, { count: String(option) })}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field">
            <span className="field__label">{t('im.bg', lang)}</span>
            <div className="bg-swatches">
              <button
                type="button"
                className={`bg-chip${autoBackground ? ' is-active' : ''}`}
                onClick={() => {
                  setAutoBackground(true);
                  void analyzeBackground();
                }}
                disabled={analyzing}
              >
                {analyzing
                  ? t('im.bg.analyzing', lang)
                  : t('im.bg.auto', lang, { color: suggestion?.color ?? autoPick.color })}
              </button>
              {BACKGROUND_PRESETS.map((option) => (
                <button
                  key={option.color}
                  type="button"
                  className={`bg-chip${!autoBackground && manualBackground === option.color ? ' is-active' : ''}`}
                  onClick={() => {
                    setAutoBackground(false);
                    setManualBackground(option.color);
                  }}
                >
                  <span className="bg-chip__dot" style={{ background: option.color }} />
                  {t(option.labelKey, lang)}
                </button>
              ))}
            </div>
            <span className="field__hint">
              {t('im.bg.hint', lang, { color: effectiveBackground })}
              {autoBackground
                ? suggestion
                  ? t('im.bg.reason', lang, {
                      source:
                        suggestion.source === 'ai'
                          ? t('im.bg.sourceAI', lang)
                          : t('im.bg.sourceHeuristic', lang),
                      reason: suggestion.reason,
                    })
                  : t('im.bg.tip', lang)
                : ''}
            </span>
          </div>

          <label className="checkbox">
            <input type="checkbox" checked={saveToKnowledge} onChange={(event) => setSaveToKnowledge(event.target.checked)} />
            {t('im.saveToKnowledge', lang)}
          </label>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleGenerate()} disabled={generating || !ready}>
              {generating
                ? t('im.btn.generating', lang)
                : thisCost === null
                  ? t('im.btn.generate', lang)
                  : t('im.btn.generateCost', lang, { cost: String(thisCost) })}
            </button>
            {result ? (
              <span className="hint">
                {t('im.result.meta', lang, {
                  elapsed: (result.elapsedMs / 1000).toFixed(1),
                  model: result.model,
                  bg: result.backgroundColor,
                  cost:
                    result.estimatedCost === null
                      ? t('im.result.noPrice', lang)
                      : t('im.result.cost', lang, { cost: String(result.estimatedCost) }),
                })}
              </span>
            ) : null}
            <div className="actions__end">
              <button type="button" className="btn btn--ghost" onClick={() => void openDir('knowledge')}>
                {t('im.btn.openKnowledge', lang)}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void openDir('cache')}>
                {t('im.btn.openCache', lang)}
              </button>
            </div>
          </div>

          {error ? <div className="banner banner--error">{error}</div> : null}
          {notice ? <div className="banner banner--ok">{notice}</div> : null}
        </section>

        {result ? (
          <section className="card">
            <div className="card__head">
              <h2>{t('im.results.title', lang, { count: String(result.images.length) })}</h2>
              <span className="hint">
                {result.images[0]?.inKnowledge
                  ? t('im.results.inLib', lang)
                  : t('im.results.cacheOnly', lang)}
              </span>
            </div>
            <div className="studio-grid">
              {result.images.map((image) => (
                <figure className="studio-item" key={image.id}>
                  {image.thumbDataUrl ? (
                    <img src={image.thumbDataUrl} alt={image.fileName} />
                  ) : (
                    <div className="studio-item__placeholder">{t('im.noPreview', lang)}</div>
                  )}
                  <figcaption>
                    <span>
                      {image.width}×{image.height} · {formatBytes(image.bytes)}
                    </span>
                    <code title={image.absPath}>{image.fileName}</code>
                    <span className={`tag ${image.inKnowledge ? 'tag--ok' : 'tag--warn'}`}>
                      {image.inKnowledge ? t('im.inLib', lang) : t('im.notInLib', lang)}
                    </span>
                    <div className="studio-item__actions">
                      <button type="button" className="btn btn--ghost" onClick={() => void startEdit(image.absPath)}>
                        {t('im.btn.edit', lang)}
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={() => void reveal(image.absPath)}>
                        {t('im.btn.reveal', lang)}
                      </button>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
            {editingError ? <div className="banner banner--error">{editingError}</div> : null}
          </section>
        ) : (
          <section className="card card--hint">
            <h3>{t('im.empty.title', lang)}</h3>
            <p className="muted">{t('im.empty.body', lang)}</p>
            <div className="actions">
              <button type="button" className="btn btn--ghost" onClick={() => void openDir('cache')}>
                {t('im.btn.openCache', lang)}
              </button>
            </div>
          </section>
        )}
      </div>

      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>{t('im.usage.title', lang)}</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadUsage()} disabled={usageLoading}>
              {usageLoading ? t('im.usage.loading', lang) : t('im.usage.refresh', lang)}
            </button>
          </div>

          <div className="balance-body">
            <div className="balance-line">
              <div className="balance-line__total">
                <span className="balance-line__currency">{t('im.usage.unitPrice', lang)}</span>
                <strong>{unitPrice === undefined ? '—' : `¥${unitPrice}`}</strong>
                <span className="balance-line__currency">{t('im.usage.perImage', lang)}</span>
              </div>
              <div className="balance-line__detail">
                <span>{slot?.model ?? t('im.usage.noModel', lang)}</span>
                {unitPrice === undefined ? <span>{t('im.usage.noPrice', lang)}</span> : null}
              </div>
            </div>

            <div className="balance-extra">
              <div>
                <span>{t('im.usage.total', lang)}</span>
                <strong>
                  {usage ? t('im.usage.totalUnit', lang, { count: String(usage.totalImages) }) : '—'}
                </strong>
              </div>
              <div>
                <span>{t('im.usage.inLib', lang)}</span>
                <strong>{usage ? usage.knowledgeImages : '—'}</strong>
              </div>
              <div>
                <span>{t('im.usage.cost', lang)}</span>
                <strong>{usage && usage.estimatedCost !== null ? `¥${usage.estimatedCost}` : '—'}</strong>
              </div>
            </div>

            <div className="balance-foot">
              <span>{usage ? usage.note : t('im.usage.counting', lang)}</span>
            </div>
          </div>

          <p className="muted balance-note">
            {t('im.usage.noteHead', lang)}
            <a href={ARK_CONSOLE_URL} target="_blank" rel="noreferrer">
              {t('im.usage.console', lang)}
            </a>
            {t('im.usage.noteTail', lang)}
          </p>

          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={onOpenModelSettings}>
              {t('im.usage.gotoModels', lang)}
            </button>
          </div>
        </section>

        <section className="card card--hint">
          <h3>{t('im.storage.title', lang)}</h3>
          <p className="muted">{t('im.storage.body1', lang)}</p>
          <p className="muted">{t('im.storage.body2', lang)}</p>
        </section>

        <section className="card card--hint">
          <h3>{t('im.edit.title', lang)}</h3>
          <p className="muted">{t('im.edit.body', lang)}</p>
        </section>
      </div>

      {editing ? (
        <ImageEditorModal
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(
              t('im.msg.savedEdit', lang, {
                name: saved.fileName,
                w: String(saved.width),
                h: String(saved.height),
              }),
            );
            void loadUsage();
          }}
        />
      ) : null}
    </div>
  );
}
