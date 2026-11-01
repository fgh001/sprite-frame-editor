import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BalanceInfo, ModelInfo, SaveSlotInput, SlotKey, SlotSettingsView, TestResult, UsageStats } from '@shared/ipc';
import { getProviderPreset, presetsFor, type ProviderId } from '@shared/providers';
import { t, useLang } from '../i18n';

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
  const [lang] = useLang();
  /** 槽位显示名走三语字典 */
  const slotLabel = (slot: SlotKey): string =>
    slot === 'chat'
      ? t('ms.slot.chat', lang)
      : slot === 'image'
        ? t('ms.slot.image', lang)
        : t('ms.slot.video', lang);
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
      const go = window.confirm(t('ms.confirmSwitch', lang));
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
      setToast({ kind: 'err', text: t('ms.err.switchFailed', lang, { error: result.error }) });
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
    setToast({
      kind: 'ok',
      text: t('ms.msg.saved', lang, {
        provider: t(preset.labelKey, lang),
        path: result.data.configPath,
      }),
    });
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
    const requirement = preset.requiresKey ? t('ms.required', lang) : t('ms.optional', lang);
    if (preset.requiresKey && !activeKeyEntry) {
      setToast({
        kind: 'err',
        text: t('ms.err.noKeyForList', lang, { provider: t(preset.labelKey, lang), requirement }),
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
    if (result.data.length === 0) setToast({ kind: 'err', text: t('ms.err.emptyList', lang) });
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
    setToast({
      kind: 'ok',
      text: enabled
        ? t('ms.enabled', lang, { slot: slotLabel(activeSlot) })
        : t('ms.disabled', lang, { slot: slotLabel(activeSlot) }),
    });
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
    setToast({
      kind: 'ok',
      text: t('ms.api.clearOk', lang, { label: t(preset.labelKey, lang) }),
    });
  };

  if (loadError) {
    return <div className="banner banner--error">{t('ms.loadError', lang, { error: loadError })}</div>;
  }
  if (!views || !forms || !view || !form) {
    return <div className="card">{t('ms.loading', lang)}</div>;
  }

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
                    const go = window.confirm(
                      t('ms.confirm.switchSlot', lang, { current: slotLabel(activeSlot) }),
                    );
                    if (!go) return;
                  }
                  setActiveSlot(slot);
                  setToast(null);
                  setTestResult(null);
                  setModels([]);
                }}
              >
                {slotLabel(slot)}
                <span className={`dot${views[slot].keyEntries.length > 0 ? ' dot--ok' : ''}`} />
              </button>
            ))}
          </div>

          {/* 三个槽位分别能干什么、不能干什么 —— 抠图最容易混淆，这里说清楚 */}
          <div className="banner banner--info">
            <b>{t('ms.roles.title', lang)}</b>
            <ul className="slot-roles">
              <li>
                <b>{t('ms.slot.chat', lang)}</b>
                {t('ms.roles.chat', lang)}
              </li>
              <li>
                <b>{t('ms.slot.image', lang)}</b>
                {t('ms.roles.image', lang)}
              </li>
              <li>
                <b>{t('ms.slot.video', lang)}</b>
                {t('ms.roles.video', lang)}
              </li>
              <li>{t('ms.roles.matting', lang)}</li>
            </ul>
          </div>

          <label className="checkbox slot-enable">
            <input
              type="checkbox"
              checked={view.enabled}
              onChange={(event) => void handleToggleEnabled(event.target.checked)}
            />
            {t('ms.enable', lang, { slot: slotLabel(activeSlot) })}
            {view.enabled ? null : <span className="hint">{t('ms.enabledHint', lang)}</span>}
          </label>

          {/* 提示：接入任何模型只需要三样东西 —— URL、Key、模型名 */}
          <p className="muted">{t('ms.api.threeThings', lang)}</p>
        </section>

        <section className="card" style={view.enabled ? undefined : { display: 'none' }}>
          <h2>{t('ms.api.title', lang)}</h2>

          {/* 服务商只作为「快速填入 URL」的预设，不再是必选项 */}
          <div className="field">
            <span className="field__label">{t('ms.provider.preset', lang)}</span>
            <select
              className="input select"
              value={form.providerId}
              onChange={(event) => void handleProviderChange(event.target.value as ProviderId)}
            >
              {presetsFor(activeSlot).map((option) => (
                <option key={option.id} value={option.id}>
                  {t(option.labelKey, lang)}
                  {option.baseUrl ? ` · ${option.baseUrl}` : ''}
                </option>
              ))}
            </select>
            <span className="field__hint">
              {preset.baseUrl ? t('ms.provider.presetHint', lang) : t('ms.provider.customHint', lang)}
            </span>
          </div>

          <label className="field">
            <span className="field__label">Base URL</span>
            <input
              className="input"
              value={form.baseUrl}
              spellCheck={false}
              placeholder={t('ms.api.baseUrlPlaceholder', lang)}
              onChange={(event) => patchForm({ baseUrl: event.target.value })}
            />
          </label>

          <div className="field">
            <span className="field__label">
              {t('ms.api.keyLabel', lang, { label: t(preset.labelKey, lang) })}
              {activeKeyEntry ? null : (
                <em className="field__saved field__saved--empty">{t('ms.api.notConfigured', lang)}</em>
              )}
            </span>

            {activeKeyEntry ? (
              // 已保存：用只读展示块顶替输入框，避免误以为要重新填
              <div className="key-box">
                <div className="key-box__value">
                  <code>{activeKeyEntry.keyMask}</code>
                  <span className={`tag ${activeKeyEntry.keyStorage === 'encrypted' ? 'tag--ok' : 'tag--warn'}`}>
                    {activeKeyEntry.keyStorage === 'encrypted'
                      ? t('ms.api.storageEncrypted', lang)
                      : t('ms.api.storagePlain', lang)}
                  </span>
                </div>
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => setConfirmClearKey(true)}>
                  {t('ms.api.deleteKey', lang)}
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
                  placeholder={t('ms.api.keyPlaceholder', lang)}
                  onChange={(event) => patchForm({ apiKeyInput: event.target.value, keyDirty: true })}
                />
                <button type="button" className="btn btn--ghost" onClick={() => patchForm({ showKey: !form.showKey })}>
                  {form.showKey ? t('ms.api.hide', lang) : t('ms.api.show', lang)}
                </button>
              </div>
            )}

            {confirmClearKey ? (
              <div className="key-confirm">
                <span className="key-confirm__text">{t('ms.api.confirmDelete', lang)}</span>
                <div className="key-confirm__actions">
                  <button type="button" className="btn btn--danger" onClick={() => void handleClearKey()}>
                    {t('ms.api.confirmYes', lang)}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmClearKey(false)}>
                    {t('ms.btn.cancel', lang)}
                  </button>
                </div>
              </div>
            ) : null}

            <span className="field__hint">{t('ms.api.keyHint', lang)}</span>
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
                      setToast({
                        kind: 'ok',
                        text: t('ms.api.reuseOk', lang, { slot: slotLabel(copySourceSlot) }),
                      });
                    })();
                  }}
                >
                  {t('ms.api.reuse', lang, {
                    slot: slotLabel(copySourceSlot),
                    provider: t(preset.labelKey, lang),
                  })}
                </button>
              </div>
            ) : null}
          </div>

          <div className="field">
            <span className="field__label">
              {t('ms.model.label', lang, { slot: slotLabel(activeSlot) })}
              {models.length > 0 ? (
                <em className="field__saved">
                  {t('ms.model.pulled', lang, { count: String(models.length) })}
                </em>
              ) : null}
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
                {!form.model ? <option value="">{t('ms.model.pickFirst', lang)}</option> : null}
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
                {busy === 'models'
                  ? t('ms.model.pulling', lang)
                  : models.length > 0
                    ? t('ms.model.refresh', lang)
                    : t('ms.model.pull', lang)}
              </button>
            </div>
            <span className="field__hint">{t('ms.model.hint', lang)}</span>
          </div>

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => void handleSave()} disabled={busy === 'save'}>
              {busy === 'save' ? t('ms.btn.saving', lang) : t('ms.btn.save', lang)}
            </button>
            <button type="button" className="btn" onClick={() => void handleTest()} disabled={busy === 'test'}>
              {busy === 'test' ? t('ms.btn.testing', lang) : t('ms.btn.test', lang)}
            </button>
            {dirty ? (
              <span className="hint hint--warn">{t('ms.dirty', lang)}</span>
            ) : (
              <span className="hint">{t('ms.clean', lang)}</span>
            )}
          </div>

          {toast ? <div className={`banner banner--${toast.kind}`}>{toast.text}</div> : null}
          {testResult ? <div className="banner banner--ok">{testResult.message}</div> : null}
        </section>
      </div>

      <div className="stack">
        {activeSlot === 'chat' ? (
          <section className="card">
            <div className="card__head">
              <h2>{supportsBalance ? t('ms.balance.title', lang) : t('ms.usage.title', lang)}</h2>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void (supportsBalance ? refreshBalance() : refreshUsage())}
                disabled={supportsBalance ? balanceLoading || !view.hasKey : usageLoading}
              >
                {supportsBalance
                  ? balanceLoading
                    ? t('ms.balance.querying', lang)
                    : t('ms.balance.refresh', lang)
                  : usageLoading
                    ? t('ms.usage.loading', lang)
                    : t('ms.usage.refresh', lang)}
              </button>
            </div>

            <div className="balance-note">
              {supportsBalance ? t('ms.balance.supported', lang) : t('ms.balance.unsupported', lang)}
            </div>

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
                          {line.granted !== undefined ? (
                            <span>{t('ms.balance.granted', lang, { value: line.granted })}</span>
                          ) : null}
                          {line.toppedUp !== undefined ? (
                            <span>{t('ms.balance.toppedUp', lang, { value: line.toppedUp })}</span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    <div className="balance-foot">
                      <span className={`tag ${balance.available ? 'tag--ok' : 'tag--warn'}`}>
                        {balance.available
                          ? t('ms.balance.available', lang)
                          : t('ms.balance.unavailable', lang)}
                      </span>
                      <span>{t('ms.balance.updated', lang, { time: formatTime(balance.fetchedAt) })}</span>
                    </div>
                    {balance.message ? <div className="balance-note">{balance.message}</div> : null}
                  </div>
                ) : null}
                {!balance && !balanceError && !balanceLoading ? (
                  <div className="balance-note">
                    {view.hasKey
                      ? t('ms.balance.hintRefresh', lang)
                      : t('ms.balance.hintSaveKey', lang)}
                  </div>
                ) : null}
              </>
            ) : null}

            {usage ? (
              <div className="balance-body">
                <div className="balance-line">
                  <div className="balance-line__total">
                    <span className="balance-line__currency">{t('ms.usage.generated', lang)}</span>
                    <strong>{usage.totalImages}</strong>
                    <span className="balance-line__currency">{t('ms.usage.unit', lang)}</span>
                  </div>
                  <div className="balance-line__detail">
                    <span>{t('ms.usage.inLib', lang, { count: String(usage.knowledgeImages) })}</span>
                    <span>{t('ms.usage.cached', lang, { count: String(usage.cachedFiles) })}</span>
                    <span>
                      {usage.estimatedCost === null
                        ? t('ms.usage.noCost', lang)
                        : t('ms.usage.cost', lang, { value: String(usage.estimatedCost) })}
                    </span>
                  </div>
                </div>
                {usage.byModel.length > 0 ? (
                  <div className="balance-extra">
                    {usage.byModel.map((stat) => (
                      <div key={stat.model}>
                        <span title={stat.model}>{stat.model}</span>
                        <strong>
                          {stat.count} {t('ms.usage.unit', lang)}
                          {stat.unitPrice === undefined
                            ? ''
                            : t('ms.usage.perImage', lang, { price: String(stat.unitPrice) })}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="balance-foot">
                  <span>{t('app.usage.note', lang)}</span>
                </div>
              </div>
            ) : null}

            {!supportsBalance ? (
              <p className="muted balance-note">{t('ms.usage.note', lang)}</p>
            ) : null}
          </section>
        ) : (
          <section className="card card--hint">
            <h3>{t('ms.slotHint.title', lang, { slot: slotLabel(activeSlot) })}</h3>
            <p className="muted">{t('ms.slotHint.body', lang)}</p>
          </section>
        )}

        <section className="card card--hint">
          <h3>{t('ms.key.title', lang)}</h3>
          <p className="muted">{t('ms.key.body', lang, { path: view.configPath })}</p>
        </section>
      </div>
    </div>
  );
}
