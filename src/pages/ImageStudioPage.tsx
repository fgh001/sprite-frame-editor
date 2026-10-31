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

// 豆包 Seedream 5.x 用档位（1K/2K）或像素值；像素需落在 921600–4624220 之间
const SIZES = ['2K', '1K', '1.5K', '2048x1024', '1024x2048', '1536x1024'];
const COUNTS = [1, 2, 3, 4];

const PROMPT_EXAMPLES = [
  '精灵族弓箭手立绘，正面站立，全身像，干净纯色背景，厚涂风格，游戏素材',
  '森林精灵法师，侧身施法姿势，半身像，柔和顶光，高细节',
];

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
      setError('还没有选择图像模型：请到「模型设置 → 图像生成」拉取模型列表并选一个，再回来生成');
      return;
    }
    if (!slot.hasKey) {
      setError('图像槽位还没有填写 API Key：请到「模型设置 → 图像生成」配置后再生成');
      return;
    }
    if (!prompt.trim()) {
      setError('先写提示词再生成');
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
    if (!tryStart('image-studio', '图像生成')) return;
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
            <h2>生成图像</h2>
            <span className={`tag ${ready ? 'tag--ok' : 'tag--warn'}`}>
              {ready ? '图像槽位已就绪' : slotEnabled ? '图像槽位未配置 Key' : '图像槽位已停用'}
            </span>
          </div>

          <div className="studio-slot">
            {slot ? (
              <>
                <span className="studio-slot__label">{preset?.label ?? slot.providerId}</span>
                <code>{slot.model || '未设置模型'}</code>
                <code className="muted">{slot.baseUrl}</code>
              </>
            ) : (
              <span className="muted">正在读取图像槽位…</span>
            )}
            <button type="button" className="btn btn--ghost" onClick={onOpenModelSettings}>
              去配置图像槽位
            </button>
          </div>

          <label className="field">
            <span className="field__label">提示词</span>
            <textarea
              className="input textarea"
              rows={5}
              value={prompt}
              placeholder={PROMPT_EXAMPLES[0]}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <span className="field__hint">
              {PROMPT_EXAMPLES.map((example) => (
                <button key={example} type="button" className="link-btn" onClick={() => setPrompt(example)}>
                  示例
                </button>
              ))}
            </span>
          </label>

          <div className="studio-params">
            <label className="field">
              <span className="field__label">尺寸</span>
              <select className="input select" value={size} onChange={(event) => setSize(event.target.value)}>
                {SIZES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">数量</span>
              <select className="input select" value={count} onChange={(event) => setCount(Number(event.target.value))}>
                {COUNTS.map((option) => (
                  <option key={option} value={option}>
                    {option} 张
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field">
            <span className="field__label">背景色（游戏素材要能干净抠图）</span>
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
                {analyzing ? '分析主体色…' : `AI 自动避让 · ${suggestion?.color ?? autoPick.color}`}
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
                  {option.label}
                </button>
              ))}
            </div>
            <span className="field__hint">
              生成时会强制「纯色背景 {effectiveBackground}，无渐变、无阴影、无地面」，出图后可直接去背景。
              {autoBackground
                ? suggestion
                  ? ` · ${suggestion.source === 'ai' ? 'AI 分析' : '回退启发式'}：${suggestion.reason}`
                  : ' · 点上面按钮可先用文本模型分析主体颜色'
                : ''}
            </span>
          </div>

          <label className="checkbox">
            <input type="checkbox" checked={saveToKnowledge} onChange={(event) => setSaveToKnowledge(event.target.checked)} />
            生成结果存入素材库（不勾选则放 <code>data/cache/generated</code>，随时可清）
          </label>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleGenerate()} disabled={generating || !ready}>
              {generating ? '生成中…（出图通常 5–30 秒）' : `生成图像${thisCost === null ? '' : `（约 ¥${thisCost}）`}`}
            </button>
            {result ? (
              <span className="hint">
                耗时 {(result.elapsedMs / 1000).toFixed(1)}s · {result.model} · 背景 {result.backgroundColor} ·{' '}
                {result.estimatedCost === null ? '单价未知' : `本次花费约 ¥${result.estimatedCost}`}
              </span>
            ) : null}
            <div className="actions__end">
              <button type="button" className="btn btn--ghost" onClick={() => void openDir('knowledge')}>
                打开素材库目录
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void openDir('cache')}>
                打开生成目录
              </button>
            </div>
          </div>

          {error ? <div className="banner banner--error">{error}</div> : null}
          {notice ? <div className="banner banner--ok">{notice}</div> : null}
        </section>

        {result ? (
          <section className="card">
            <div className="card__head">
              <h2>本次结果（{result.images.length} 张）</h2>
              <span className="hint">{result.images[0]?.inKnowledge ? '已存入素材库' : '仅在缓存目录'}</span>
            </div>
            <div className="studio-grid">
              {result.images.map((image) => (
                <figure className="studio-item" key={image.id}>
                  {image.thumbDataUrl ? (
                    <img src={image.thumbDataUrl} alt={image.fileName} />
                  ) : (
                    <div className="studio-item__placeholder">无法预览</div>
                  )}
                  <figcaption>
                    <span>
                      {image.width}×{image.height} · {formatBytes(image.bytes)}
                    </span>
                    <code title={image.absPath}>{image.fileName}</code>
                    <span className={`tag ${image.inKnowledge ? 'tag--ok' : 'tag--warn'}`}>
                      {image.inKnowledge ? '已入库' : '未入库'}
                    </span>
                    <div className="studio-item__actions">
                      <button type="button" className="btn btn--ghost" onClick={() => void startEdit(image.absPath)}>
                        编辑 / 去背景
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={() => void reveal(image.absPath)}>
                        定位文件
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
            <h3>还没有本次生成结果</h3>
            <p className="muted">
              之前生成的图在 <code>data/cache/generated</code>（未入库）或 <code>data/knowledge/files</code>（已入库），点上方
              「打开生成目录 / 打开素材库目录」就能看到。
            </p>
            <div className="actions">
              <button type="button" className="btn btn--ghost" onClick={() => void openDir('cache')}>
                打开生成目录
              </button>
            </div>
          </section>
        )}
      </div>

      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>额度与消耗</h2>
            <button type="button" className="btn btn--ghost" onClick={() => void loadUsage()} disabled={usageLoading}>
              {usageLoading ? '统计中…' : '刷新'}
            </button>
          </div>

          <div className="balance-body">
            <div className="balance-line">
              <div className="balance-line__total">
                <span className="balance-line__currency">单价</span>
                <strong>{unitPrice === undefined ? '—' : `¥${unitPrice}`}</strong>
                <span className="balance-line__currency">/ 张</span>
              </div>
              <div className="balance-line__detail">
                <span>{slot?.model ?? '未配置模型'}</span>
                {unitPrice === undefined ? <span>该模型未收录单价</span> : null}
              </div>
            </div>

            <div className="balance-extra">
              <div>
                <span>累计生成</span>
                <strong>{usage ? `${usage.totalImages} 张` : '—'}</strong>
              </div>
              <div>
                <span>已入库</span>
                <strong>{usage ? usage.knowledgeImages : '—'}</strong>
              </div>
              <div>
                <span>估算花费</span>
                <strong>{usage && usage.estimatedCost !== null ? `¥${usage.estimatedCost}` : '—'}</strong>
              </div>
            </div>

            <div className="balance-foot">
              <span>{usage ? usage.note : '正在统计…'}</span>
            </div>
          </div>

          <p className="muted balance-note">
            豆包 / 火山方舟没有公开的余额接口，账户余额只能看控制台：
            <a href={ARK_CONSOLE_URL} target="_blank" rel="noreferrer">
              打开方舟控制台
            </a>
            。这里的数字是本地统计（不额外发请求），文本模型（DeepSeek）的余额在「模型设置」页。
          </p>

          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={onOpenModelSettings}>
              去模型设置看文本模型余额
            </button>
          </div>
        </section>

        <section className="card card--hint">
          <h3>生成的东西存哪</h3>
          <p className="muted">
            勾选「存入素材库」时：原图写入 <code>data/knowledge/files</code>，缩略图写入 <code>data/knowledge/thumbs</code>，并在{' '}
            <code>knowledge/index.json</code> 里登记（含来源模型与提示词）。
          </p>
          <p className="muted">服务商返回的临时 URL 24 小时后失效，所以生成后会立刻下载落盘，不依赖外链。</p>
        </section>

        <section className="card card--hint">
          <h3>编辑与去背景</h3>
          <p className="muted">
            点结果图上的「编辑 / 去背景」会打开像素编辑器：从画布四边泛洪，只扣掉与边缘连通的背景（主体内部同色不会被误删），
            还能微调容差与亮度。应用后保存为新 PNG（原图不覆盖）并登记进素材库。
          </p>
        </section>
      </div>

      {editing ? (
        <ImageEditorModal
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(`已保存编辑结果：${saved.fileName}（${saved.width}×${saved.height}），已登记进素材库`);
            void loadUsage();
          }}
        />
      ) : null}
    </div>
  );
}
