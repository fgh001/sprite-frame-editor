import { useEffect, useState } from 'react';
import { allProgress, busySnapshot, subscribeBusy, type BusyKey } from '../state/busy';
import { t, useLang } from '../i18n';
import logoUrl from '../assets/logo.png';

export type NavKey =
  | 'pipeline'
  | 'image-studio'
  | 'video-studio'
  | 'frame-studio'
  | 'matte-studio'
  | 'loop-trim'
  | 'knowledge'
  | 'settings';

interface NavItem {
  key: NavKey;
  /** 文案 key，用 t() 取（侧边栏是外壳的一部分，三语都要有） */
  labelKey: string;
  hintKey: string;
  /** 该页是否已经真正实现 */
  ready: boolean;
}

const GROUPS: { titleKey: string; items: NavItem[] }[] = [
  {
    titleKey: 'nav.group.workspace',
    items: [
      { key: 'pipeline', labelKey: 'nav.pipeline', hintKey: 'nav.pipeline.hint', ready: true },
      { key: 'image-studio', labelKey: 'nav.imageStudio', hintKey: 'nav.imageStudio.hint', ready: true },
      { key: 'video-studio', labelKey: 'nav.videoStudio', hintKey: 'nav.videoStudio.hint', ready: true },
      { key: 'frame-studio', labelKey: 'nav.frameStudio', hintKey: 'nav.frameStudio.hint', ready: true },
      { key: 'matte-studio', labelKey: 'nav.matteStudio', hintKey: 'nav.matteStudio.hint', ready: true },
      { key: 'loop-trim', labelKey: 'nav.loopTrim', hintKey: 'nav.loopTrim.hint', ready: true },
      { key: 'knowledge', labelKey: 'nav.knowledge', hintKey: 'nav.knowledge.hint', ready: true },
    ],
  },
  {
    titleKey: 'nav.group.system',
    items: [{ key: 'settings', labelKey: 'nav.settings', hintKey: 'nav.settings.hint', ready: true }],
  },
];

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
  dataDir?: string;
  onOpenDataDir: () => void;
}

export function Sidebar({ active, onSelect, dataDir, onOpenDataDir }: SidebarProps): React.JSX.Element {
  const [lang] = useLang();
  // 哪些页面有长任务在跑（生图 / 生成视频 / 批量抠图），在导航上转圈提示
  const [busyKeys, setBusyKeys] = useState<BusyKey[]>(() => busySnapshot());
  const [progressMap, setProgressMap] = useState<Record<string, number | null>>(() => allProgress());
  useEffect(() => {
    const sync = (): void => {
      setBusyKeys(busySnapshot());
      setProgressMap(allProgress());
    };
    const unsubscribe = subscribeBusy(sync);
    sync();
    return unsubscribe;
  }, []);
  const isRunning = (key: NavKey): boolean => busyKeys.includes(key as BusyKey);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        {/* 应用头像：打包进 bundle 的固定图片，不支持运行时替换 */}
        <img className="sidebar__logo" src={logoUrl} alt={t('app.name', lang)} />
        <div>
          <strong>{t('app.name', lang)}</strong>
          <span>{t('app.tagline', lang)}</span>
        </div>
      </div>

      <nav className="sidebar__nav" aria-label={t('sidebar.nav.label', lang)}>
        {GROUPS.map((group) => (
          <div className="sidebar__group" key={group.titleKey}>
            <div className="sidebar__group-title">{t(group.titleKey, lang)}</div>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-current={active === item.key ? 'page' : undefined}
                className={`sidebar__item${active === item.key ? ' is-active' : ''}`}
                onClick={() => onSelect(item.key)}
              >
                <span className="sidebar__item-label">
                  {isRunning(item.key) ? <i className="sidebar__spinner" aria-hidden="true" /> : null}
                  {t(item.labelKey, lang)}
                  {isRunning(item.key) && progressMap[item.key] !== null && progressMap[item.key] !== undefined
                    ? <em className="sidebar__percent">{progressMap[item.key]}%</em>
                    : null}
                  {item.ready ? null : <em className="tag tag--pending">{t('nav.todo', lang)}</em>}
                </span>
                <span className="sidebar__item-hint">{t(item.hintKey, lang)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__footer-title">{t('sidebar.dataDir', lang)}</div>
        <div className="sidebar__path" title={dataDir}>
          {dataDir ?? t('sidebar.reading', lang)}
        </div>
        <button type="button" className="btn btn--ghost btn--block" onClick={onOpenDataDir} disabled={!dataDir}>
          {t('sidebar.openDataDir', lang)}
        </button>
      </div>
    </aside>
  );
}
