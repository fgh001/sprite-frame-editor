import { useState } from 'react';
import { LANGS, setLang, t, useLang, type Lang } from '../i18n';
import { ModelSettingsPage } from './ModelSettingsPage';

interface SettingsPageProps {
  /** 从流水线的快速定位进来时，直接打开对应分栏 */
  initialTab?: SettingsTab;
  /** 模型设置页面的未保存提醒，透传给外层 */
  onDirtyChange?: (dirty: boolean) => void;
  registerSave?: (save: () => Promise<boolean>) => void;
}

export type SettingsTab = 'models' | 'language';

/**
 * 设置页：把「模型设置」和「语言设置」收到同一个入口下。
 *
 * 为什么合并：模型配置和界面语言都属于「装完先调一次」的东西，
 * 侧边栏各占一行太占地方，合并后流水线页也能一键跳到对应分栏。
 */
export function SettingsPage({
  initialTab = 'models',
  onDirtyChange,
  registerSave,
}: SettingsPageProps): React.JSX.Element {
  const [lang] = useLang();
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div className="settings-layout settings-layout--single">
      <div className="stack">
        <section className="card">
          <div className="kb-filters">
            {(
              [
                ['models', t('settings.tab.models', lang)],
                ['language', t('settings.tab.language', lang)],
              ] as [SettingsTab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`slot-tab${tab === value ? ' is-active' : ''}`}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {tab === 'models' ? (
          // 模型设置原样嵌进来，它自己的未保存提醒继续透传给外层
          <ModelSettingsPage onDirtyChange={onDirtyChange} registerSave={registerSave} />
        ) : (
          <LanguageSection />
        )}
      </div>
    </div>
  );
}

/** 语言设置：切换后立即生效，并写入 data/config/ui.json */
function LanguageSection(): React.JSX.Element {
  const [lang, applyLocal] = useLang();
  const [notice, setNotice] = useState<string | null>(null);

  const choose = async (next: Lang): Promise<void> => {
    applyLocal(next);
    const res = await window.skeletonElf.ui.setLang(next);
    const name = LANGS.find((item) => item.value === next)?.label ?? next;
    setNotice(res.ok ? t('settings.language.saved', next, { name }) : res.error);
  };

  return (
    <section className="card">
      <h2>{t('settings.language.title', lang)}</h2>
      <p className="field__hint">{t('settings.language.hint', lang)}</p>

      <div className="kb-filters">
        {LANGS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`slot-tab${lang === item.value ? ' is-active' : ''}`}
            onClick={() => void choose(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className="field__hint">
        {t('settings.language.current', lang)}：<b>{LANGS.find((item) => item.value === lang)?.label}</b>
      </p>

      {notice ? <div className="banner banner--ok">{notice}</div> : null}
    </section>
  );
}
