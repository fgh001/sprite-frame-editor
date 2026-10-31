import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BalanceInfo, ModelInfo, SaveSlotInput, SlotKey, SlotSettingsView, TestResult, UsageStats } from '@shared/ipc';
import { CAPABILITY_LABELS, describeBalanceSupport, getProviderPreset, presetsFor, type ProviderId } from '@shared/providers';

const SLOTS: SlotKey[] = ['chat', 'image', 'video'];

interface SlotForm {
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  apiKeyInput: string;
  keyDirty: boolean;
  showKey: boolean;
}

type SlotForms = Record<SlotKey, SlotForm>;

function emptyForm(view: SlotSettingsView): SlotForm {
  return {
    providerId: view.providerId,
    baseUrl: view.baseUrl,
    model: view.model,
    apiKeyInput: '',
    keyDirty: false,
    showKey: false,
  };
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

interface ModelSettingsPageProps {
  /** 把「是否有未保存的修改」上报给外层，用于切页/关窗口时提醒 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 把保存动作交给外层，便于「离开前先保存」 */
  registerSave?: (save: () => Promise<boolean>) => void;
}

export function ModelSettingsPage({ onDirtyChange, registerSave }: ModelSettingsPageProps = {}): React.JSX.Element {
  const [views, setViews] = useState<Record<SlotKey, SlotSettingsView> | null>(null);
  const [forms, setForms] = useState<SlotForms | null>(null);
  const [activeSlot, setActiveSlot] = useState<SlotKey>('chat');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** 删除 Key 的二次确认（删除不可恢复，必须显式确认） */
  const [confirmClearKey, setConfirmClearKey] = useState(false);

  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const result = await window.skeletonElf.settings.getSlots();
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      const nextViews = {} as Record<SlotKey, SlotSettingsView>;
      const nextForms = {} as SlotForms;
      for (const view of result.data) {
        nextViews[view.slot] = view;
        nextForms[view.slot] = emptyForm(view);
      }
      setViews(nextViews);
      setForms(nextForms);
    })();
  }, []);

  const refreshBalance = useCallback(async () => {
    setBalanceLoading(true);
    setBalanceError(null);
    const result = await window.skeletonElf.ai.balance();
    setBalanceLoading(false);
    if (result.ok) setBalance(result.data);
    else {
      setBalance(null);
      setBalanceError(result.error);
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    const result = await window.skeletonElf.ai.usage();
    setUsageLoading(false);
    if (result.ok) setUsage(result.data);
  }, []);

  const chatHasKey = views?.chat.hasKey ?? false;

  useEffect(() => {
    if (!chatHasKey) return;
    void refreshUsage();
  }, [chatHasKey, refreshUsage]);

  const view = views?.[activeSlot];
  const form = forms?.[activeSlot];
  const preset = useMemo(() => getProviderPreset(form?.providerId ?? 'custom'), [form?.providerId]);

  // 切换槽位或服务商时，收起上一个服务商的删除确认
  useEffect(() => {
    setConfirmClearKey(false);
  }, [activeSlot, form?.providerId]);

  // Key 按服务商分别存储：当前表单选中的服务商有没有 Key，看它自己那条记录
  const activeKeyEntry = useMemo(
    () => view?.keyEntries.find((entry) => entry.providerId === form?.providerId),
    [view, form?.providerId],
  );

  // 当前服务商这个槽位没 Key，但别的槽位有 → 可以一键复用
  const copySourceSlot = useMemo(() => {
    if (!views || !form) return null;
    if (views[activeSlot]?.keyEntries.some((entry) => entry.providerId === form.providerId)) return null;
    for (const slot of SLOTS) {
      if (slot === activeSlot) continue;
      if (views[slot]?.keyEntries.some((entry) => entry.providerId === form.providerId)) return slot;
    }
    return null;
  }, [views, form, activeSlot]);

  /* 「未保存」只算真正改过的参数。
     单纯切换服务商不算：切换时会把 Base URL / 模型换成该服务商记住的值，
     若拿它跟「另一个服务商」的保存值比较必然不等，于是每点一次就误报「有未保存改动」。
     基准取「当前选中的服务商自己的保存值」，没有记录时取它的预设默认值（切换时填入的也是这个）。 */
  const baseline = useMemo(() => {
    if (!view || !form) return null;
    if (form.providerId === view.providerId) {
      return { baseUrl: view.baseUrl, model: view.model };
    }
    const endpoint = view.endpoints.find((entry) => entry.providerId === form.providerId);
    if (endpoint) return { baseUrl: endpoint.baseUrl, model: endpoint.model };
    const fallback = getProviderPreset(form.providerId);
    return { baseUrl: fallback.baseUrl, model: fallback.models[activeSlot] };
  }, [view, form, activeSlot]);

  const dirty = useMemo(() => {
    if (!form || !baseline) return false;
    return form.keyDirty || form.baseUrl !== baseline.baseUrl || form.model !== baseline.model;
  }, [form, baseline]);

  // 把「有未保存修改」和「保存动作」交给外层：切页/关窗口时外层据此提醒并可代为保存
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    registerSave?.(handleSave);
  });

  // 关窗口时若有未保存修改，先弹系统确认，避免改了一半直接丢
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const patchForm = (patch: Partial<SlotForm>): void => {
    setForms((prev) => (prev ? { ...prev, [activeSlot]: { ...prev[activeSlot], ...patch } } : prev));
  };

  const applyView = (next: SlotSettingsView): void => {
    setViews((prev) => (prev ? { ...prev, [next.slot]: next } : prev));
    setForms((prev) => (prev ? { ...prev, [next.slot]: emptyForm(next) } : prev));
  };

  const handleProviderChange = async (id: ProviderId): Promise<void> => {
    if (!forms || !view) return;
    const current = forms[activeSlot];
    if (id === current.providerId) return;

    // 只有真的改过参数才需要确认；仅切换服务商不打扰
    if (dirty) {
      const go = window.confirm('当前服务商的改动还没保存，切过去会丢失。\n\n确定 = 放弃改动并切换；取消 = 留在当前服务商');
      if (!go) return;
    }

    const nextPreset = getProviderPreset(id);
    // 切回某个服务商时恢复它上次用的 Base URL / 模型；Key 由该服务商自己的记录决定
    const savedEndpoint = view.endpoints.find((endpoint) => endpoint.providerId === id);
    const nextForm: SlotForm = {
      ...current,
      providerId: id,
      baseUrl: savedEndpoint?.baseUrl || nextPreset.baseUrl || '',
      model: savedEndpoint?.model || nextPreset.models[activeSlot] || '',
      apiKeyInput: '',
      keyDirty: false,
    };
    setForms({ ...forms, [activeSlot]: nextForm });
    setTestResult(null);
    setModels([]);
    setToast(null);

    /* 切换服务商本身就是「选择生效」，所以静默落盘：
       否则用户切过去不点保存，界面显示的是新服务商、实际配置还是旧的，下次进来又变回去。
       只写 providerId + 该服务商记住的端点，不带 apiKey（Key 永远由各服务商自己的记录决定）。 */
    setBusy('save');
    const result = await window.skeletonElf.settings.saveSlot({
      slot: activeSlot,
      providerId: id,
      baseUrl: nextForm.baseUrl,
      model: nextForm.model,
    });
    setBusy(null);
    if (!result.ok) {
      // 落盘失败就回滚表单，别让界面显示一个没生效的服务商
      setForms((prev) => (prev ? { ...prev, [activeSlot]: current } : prev));
      setToast({ kind: 'err', text: `切换服务商失败：${result.error}` });
      return;
    }
    applyView(result.data);
    if (activeSlot === 'chat' && nextPreset.balance !== 'none') void refreshBalance();
  };

  const handleSave = async (): Promise<boolean> => {
    if (!form) return false;
    setBusy('save');
    setToast(null);
    const input: SaveSlotInput = {
      slot: activeSlot,
      providerId: form.providerId,
      baseUrl: form.baseUrl,
      model: form.model,
      ...(form.keyDirty ? { apiKey: form.apiKeyInput } : {}),
    };
    const result = await window.skeletonElf.settings.saveSlot(input);
    setBusy(null);
    if (!result.ok) {
      setToast({ kind: 'err', text: result.error });
      return false;
    }
    applyView(result.data);
    setToast({ kind: 'ok', text: `已保存（${preset.label}）：${result.data.configPath}` });
    if (activeSlot === 'chat' && preset.balance !== 'none') void refreshBalance();
    return true;
  };

  const handleTest = async (): Promise<void> => {
    setBusy('test');
    setTestResult(null);
    setToast(null);
    const result = await window.skeletonElf.ai.test(activeSlot);
    setBusy(null);
    if (result.ok) setTestResult(result.data);
    else setToast({ kind: 'err', text: result.error });
  };

  const handleLoadModels = async (): Promise<void> => {
    setToast(null);

    // 前置检查：没 Key 就拉取，服务端只会回一个含糊的 401，用户不知道要先存 Key。
    // 这里直接拦住并说清楚下一步怎么做。
    const requirement = preset.requiresKey ? '必填' : '可选';
    if (preset.requiresKey && !activeKeyEntry) {
      setToast({
        kind: 'err',
        text: `还没有保存 API Key。请先在上面粘贴 ${preset.label} 的 Key 并点「保存」，再用「拉取模型列表」——模型接口需要鉴权（这个服务商 Key ${requirement}）。`,
      });
      return;
    }

    setBusy('models');
    const result = await window.skeletonElf.ai.models(activeSlot);
    setBusy(null);
    if (!result.ok) {
      setToast({ kind: 'err', text: result.error });
      return;
    }
    setModels(result.data);
    if (result.data.length === 0) setToast({ kind: 'err', text: '接口没有返回任何模型（部分平台不开放 /models）' });
    else if (form && !form.model) patchForm({ model: result.data[0].id });
  };

  // 启用 / 停用当前槽位：停用后配置隐藏，也不会被调用
  const handleToggleEnabled = async (enabled: boolean): Promise<void> => {
    const result = await window.skeletonElf.settings.setSlotEnabled(activeSlot, enabled);
    if (!result.ok) {
      setToast({ kind: 'err', text: result.error });
      return;
    }
    setViews((prev) => (prev ? { ...prev, [result.data.slot]: result.data } : prev));
    setToast({ kind: 'ok', text: enabled ? `已启用「${CAPABILITY_LABELS[activeSlot]}」槽位` : `已停用「${CAPABILITY_LABELS[activeSlot]}」槽位` });
  };

  const handleClearKey = async (): Promise<void> => {
    // 只清当前服务商那一把，其他服务商的 Key 原样保留
    const cleared = await window.skeletonElf.settings.clearSlotKey(activeSlot, form?.providerId);
    setConfirmClearKey(false);
    if (!cleared.ok) {
      setToast({ kind: 'err', text: cleared.error });
      return;
    }
    applyView(cleared.data);
    setToast({ kind: 'ok', text: `已删除 ${preset.label} 的本地 API Key（其他服务商的 Key 未受影响）` });
  };

  if (loadError) return <div className="banner banner--error">读取设置失败：{loadError}</div>;
  if (!views || !forms || !view || !form) return <div className="card">正在读取设置…</div>;

  const supportsBalance = preset.balance !== 'none';

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="slot-tabs">
            {SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                className={`slot-tab${activeSlot === slot ? ' is-active' : ''}`}
                onClick={() => {
                  if (slot !== activeSlot && dirty) {
                    const go = window.confirm('当前「' + CAPABILITY_LABELS[activeSlot] + '」的改动还没保存，切换后会丢失。\n\n确定 = 放弃改动并切换；取消 = 留在本页');
                    if (!go) return;
                  }
                  setActiveSlot(slot);
                  setToast(null);
                  setTestResult(null);
                  setModels([]);
                }}
              >
                {CAPABILITY_LABELS[slot]}
                <span className={`dot${views[slot].keyEntries.length > 0 ? ' dot--ok' : ''}`} />
              </button>
            ))}
          </div>

          {/* 三个槽位分别能干什么、不能干什么 —— 抠图最容易混淆，这里说清楚 */}
          <div className="banner banner--info">
            <b>各槽位的分工（别选错）</b>
            <ul className="slot-roles">
              <li>
                <b>文本 / 推理</b>：写提示词、右侧 AI 助手问答。<b>纯文本模型看不到图</b>
                （DeepSeek 这类）。
              </li>
              <li>
                <b>图像</b>：<b>生成</b>图片（Seedream / gpt-image）。它只会画，<b>不能分析图片</b>，
                所以【不能拿来抠图】。
              </li>
              <li>
                <b>视频</b>：图生视频（Seedance）。
              </li>
              <li>
                <b>AI 抠图（编辑器里的「AI 抠图」栏）</b>需要的是<b>支持图像输入的视觉模型</b>：
                豆包 <code>doubao-seed-1-6</code>、GPT-4o、Qwen-VL 这类<b>多模态</b>模型。
                普通文本模型和图像生成模型都不行。
              </li>
            </ul>
          </div>

          <label className="checkbox slot-enable">
            <input
              type="checkbox"
              checked={view.enabled}
              onChange={(event) => void handleToggleEnabled(event.target.checked)}
            />
            使用「{CAPABILITY_LABELS[activeSlot]}」槽位
            {view.enabled ? null : <span className="hint">（已停用，配置已隐藏，也不会被调用）</span>}
          </label>

          {view.enabled ? (
            <>
              <div className="field">
                <span className="field__label">服务商</span>
                <select
                  className="input select"
                  value={form.providerId}
                  onChange={(event) => void handleProviderChange(event.target.value as ProviderId)}
                >
                  {presetsFor(activeSlot).map((option) => {
                    const saved = view.keyEntries.some((entry) => entry.providerId === option.id);
                    return (
                      <option key={option.id} value={option.id}>
                        {option.label}
                        {saved ? ' · 已存 Key' : ''}
                      </option>
                    );
                  })}
                </select>
                <span className="field__hint">
                  {activeKeyEntry
                    ? `${preset.label} 已经有保存的 Key，切换过去可以直接用。`
                    : `${preset.label} 还没有 Key，切换后需要粘贴并保存。`}
                </span>
              </div>
            </>
          ) : null}
        </section>

        <section className="card" style={view.enabled ? undefined : { display: 'none' }}>
          <h2>接口与密钥</h2>

          <label className="field">
            <span className="field__label">Base URL</span>
            <input
              className="input"
              value={form.baseUrl}
              spellCheck={false}
              placeholder="例如 https://ark.cn-beijing.volces.com/api/v3"
              onChange={(event) => patchForm({ baseUrl: event.target.value })}
            />
          </label>

          <div className="field">
            <span className="field__label">
              {preset.label} 的 API Key
              {activeKeyEntry ? null : <em className="field__saved field__saved--empty">未配置</em>}
            </span>

            {activeKeyEntry ? (
              // 已保存：用只读展示块顶替输入框，避免误以为要重新填
              <div className="key-box">
                <div className="key-box__value">
                  <code>{activeKeyEntry.keyMask}</code>
                  <span className={`tag ${activeKeyEntry.keyStorage === 'encrypted' ? 'tag--ok' : 'tag--warn'}`}>
                    {activeKeyEntry.keyStorage === 'encrypted' ? '系统加密' : '明文回退'}
                  </span>
                </div>
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => setConfirmClearKey(true)}>
                  删除 API Key
                </button>
              </div>
            ) : (
              <div className="input-row">
                <input
                  className="input"
                  type={form.showKey ? 'text' : 'password'}
                  value={form.apiKeyInput}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="粘贴该服务商的 API Key"
                  onChange={(event) => patchForm({ apiKeyInput: event.target.value, keyDirty: true })}
                />
                <button type="button" className="btn btn--ghost" onClick={() => patchForm({ showKey: !form.showKey })}>
                  {form.showKey ? '隐藏' : '显示'}
                </button>
              </div>
            )}

            {confirmClearKey ? (
              <div className="key-confirm">
                <span className="key-confirm__text">
                  删除后无法恢复，需要重新粘贴 Key 才能继续用该服务商。确定删除？
                </span>
                <div className="key-confirm__actions">
                  <button type="button" className="btn btn--danger" onClick={() => void handleClearKey()}>
                    确认删除
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmClearKey(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : null}

            <span className="field__hint">
              每个服务商的 Key 分开保存：给豆包填过 Key 后切回 DeepSeek，看到的仍是 DeepSeek 自己那把。要换 Key
              就先删除，再粘贴新的。
            </span>
            {copySourceSlot ? (
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    void (async () => {
                      const res = await window.skeletonElf.settings.copySlotKey(
                        copySourceSlot,
                        activeSlot,
                        form.providerId,
                      );
                      if (!res.ok) {
                        setToast({ kind: 'err', text: res.error });
                        return;
                      }
                      applyView(res.data);
                      setToast({ kind: 'ok', text: `已复用「${CAPABILITY_LABELS[copySourceSlot]}」槽位的 Key` });
                    })();
                  }}
                >
                  复用「{CAPABILITY_LABELS[copySourceSlot]}」槽位的 {preset.label} Key
                </button>
              </div>
            ) : null}
          </div>

          <div className="field">
            <span className="field__label">
              {CAPABILITY_LABELS[activeSlot]}模型
              {models.length > 0 ? <em className="field__saved">已拉取 {models.length} 个</em> : null}
            </span>
            <div className="input-row">
              <select
                className="input select"
                value={form.model}
                onChange={(event) => patchForm({ model: event.target.value })}
              >
                {/* 当前值原样保留（哪怕还没拉取），不加多余后缀，避免看着乱 */}
                {form.model && !models.some((model) => model.id === form.model) ? (
                  <option value={form.model}>{form.model}</option>
                ) : null}
                {!form.model ? <option value="">请先拉取模型列表再选择</option> : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void handleLoadModels()}
                disabled={busy === 'models'}
              >
                {busy === 'models' ? '拉取中…' : models.length > 0 ? '刷新列表' : '拉取模型列表'}
              </button>
            </div>
            <span className="field__hint">模型从列表里选择，避免手打错名字。先保存 Key，再点「拉取模型列表」。</span>
          </div>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleSave()} disabled={busy === 'save'}>
              {busy === 'save' ? '保存中…' : '保存设置'}
            </button>
            <button type="button" className="btn" onClick={() => void handleTest()} disabled={busy === 'test'}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            {dirty ? <span className="hint hint--warn">有未保存的修改</span> : <span className="hint">已是最新</span>}
          </div>

          {toast ? <div className={`banner banner--${toast.kind}`}>{toast.text}</div> : null}
          {testResult ? <div className="banner banner--ok">{testResult.message}</div> : null}
        </section>
      </div>

      <div className="stack">
        {activeSlot === 'chat' ? (
          <section className="card">
            <div className="card__head">
              <h2>{supportsBalance ? '账户余额' : '用量与消耗'}</h2>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void (supportsBalance ? refreshBalance() : refreshUsage())}
                disabled={supportsBalance ? balanceLoading || !view.hasKey : usageLoading}
              >
                {supportsBalance ? (balanceLoading ? '查询中…' : '刷新余额') : usageLoading ? '统计中…' : '刷新用量'}
              </button>
            </div>

            <div className="balance-note">{describeBalanceSupport(preset.balance)}</div>

            {supportsBalance ? (
              <>
                {balanceError ? <div className="banner banner--error">{balanceError}</div> : null}
                {balance && balance.supported ? (
                  <div className="balance-body">
                    {balance.lines.map((line) => (
                      <div className="balance-line" key={`${line.currency}-${line.total}`}>
                        <div className="balance-line__total">
                          <span className="balance-line__currency">{line.currency}</span>
                          <strong>{line.total}</strong>
                        </div>
                        <div className="balance-line__detail">
                          {line.granted !== undefined ? <span>赠送 / 代金券 {line.granted}</span> : null}
                          {line.toppedUp !== undefined ? <span>充值 / 现金 {line.toppedUp}</span> : null}
                        </div>
                      </div>
                    ))}
                    <div className="balance-foot">
                      <span className={`tag ${balance.available ? 'tag--ok' : 'tag--warn'}`}>
                        {balance.available ? '账户可用' : '余额不足或账户不可用'}
                      </span>
                      <span>更新于 {formatTime(balance.fetchedAt)}</span>
                    </div>
                    {balance.message ? <div className="balance-note">{balance.message}</div> : null}
                  </div>
                ) : null}
                {!balance && !balanceError && !balanceLoading ? (
                  <div className="balance-note">{view.hasKey ? '点击右上角「刷新余额」查询' : '保存 API Key 后即可查询余额'}</div>
                ) : null}
              </>
            ) : null}

            {usage ? (
              <div className="balance-body">
                <div className="balance-line">
                  <div className="balance-line__total">
                    <span className="balance-line__currency">已生成</span>
                    <strong>{usage.totalImages}</strong>
                    <span className="balance-line__currency">张</span>
                  </div>
                  <div className="balance-line__detail">
                    <span>已入库 {usage.knowledgeImages}</span>
                    <span>缓存未入库 {usage.cachedFiles}</span>
                    <span>{usage.estimatedCost === null ? '估算花费：单价未知' : `估算花费 ¥${usage.estimatedCost}`}</span>
                  </div>
                </div>
                {usage.byModel.length > 0 ? (
                  <div className="balance-extra">
                    {usage.byModel.map((stat) => (
                      <div key={stat.model}>
                        <span title={stat.model}>{stat.model}</span>
                        <strong>
                          {stat.count} 张{stat.unitPrice === undefined ? '' : ` · ¥${stat.unitPrice}/张`}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="balance-foot">
                  <span>{usage.note}</span>
                </div>
              </div>
            ) : null}

            {!supportsBalance ? (
              <p className="muted balance-note">
                豆包 / 火山方舟没有公开的余额查询 API（余额只能在控制台看），所以这里显示的是本地统计的生成量与估算花费。
              </p>
            ) : null}
          </section>
        ) : (
          <section className="card card--hint">
            <h3>{CAPABILITY_LABELS[activeSlot]}槽位</h3>
            <p className="muted">
              这个槽位与文本槽位互相独立，可以填不同服务商、不同 Key。图像生成会读取这里的配置，结果自动落盘到
              <code>data/knowledge/files</code>（勾选存入素材库时）或 <code>data/cache/generated</code>。
            </p>
          </section>
        )}

        <section className="card card--hint">
          <h3>Key 存在哪</h3>
          <p className="muted">
            所有槽位配置都保存在 <code>{view.configPath}</code>；Key 按「槽位 × 服务商」分别保存并加密，渲染层只显示掩码。
          </p>
        </section>
      </div>
    </div>
  );
}
