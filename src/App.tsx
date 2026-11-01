import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, ThemeMode } from '@shared/ipc';
import { Sidebar, type NavKey } from './components/Sidebar';
import { AssistantPanel } from './components/AssistantPanel';
import { PipelinePage } from './pages/PipelinePage';
import { ImageStudioPage } from './pages/ImageStudioPage';
import { VideoStudioPage } from './pages/VideoStudioPage';
import { FrameStudioPage } from './pages/FrameStudioPage';
import { MatteStudioPage } from './pages/MatteStudioPage';
import { LoopTrimPage } from './pages/LoopTrimPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { SettingsPage, type SettingsTab } from './pages/SettingsPage';
import { allProgress, isBusy, subscribeBusy } from './state/busy';
import { getLang, setLang, t, useLang } from './i18n';

/** 页面标题/副标题的文案 key（三语都从这里取） */
const PAGE_META: Record<NavKey, { titleKey: string; subtitleKey: string }> = {
  pipeline: { titleKey: 'page.pipeline.title', subtitleKey: 'page.pipeline.subtitle' },
  'image-studio': { titleKey: 'page.imageStudio.title', subtitleKey: 'page.imageStudio.subtitle' },
  'video-studio': { titleKey: 'page.videoStudio.title', subtitleKey: 'page.videoStudio.subtitle' },
  'frame-studio': { titleKey: 'page.frameStudio.title', subtitleKey: 'page.frameStudio.subtitle' },
  'matte-studio': { titleKey: 'page.matteStudio.title', subtitleKey: 'page.matteStudio.subtitle' },
  'loop-trim': { titleKey: 'page.loopTrim.title', subtitleKey: 'page.loopTrim.subtitle' },
  knowledge: { titleKey: 'page.knowledge.title', subtitleKey: 'page.knowledge.subtitle' },
  settings: { titleKey: 'page.settings.title', subtitleKey: 'page.settings.subtitle' },
};

export function App(): React.JSX.Element {
  const [active, setActive] = useState<NavKey>('image-studio');
  const [lang] = useLang();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  /** 设置页当前打开的分栏（从流水线快速定位过来时会指定） */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('models');
  /** 模型设置页是否有未保存改动（切页前要提醒） */
  const [settingsDirty, setSettingsDirty] = useState(false);
  /** AI 助手面板是否展开（顶栏按钮和面板自己的收起按钮共用） */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const settingsSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  /** 批量抠图是否在跑（跑的时候顶部挂一条全局提示，告诉用户为什么会卡） */
  const [matteBusy, setMatteBusy] = useState(() => isBusy('matte-studio'));
  /** 抠图进度百分比（null = 还没有明确总数） */
  const [mattePercent, setMattePercent] = useState<number | null>(
    () => allProgress()['matte-studio'] ?? null,
  );

  // 订阅长任务状态：批量抠图开跑 / 结束时更新顶部横幅
  useEffect(() => {
    const sync = (): void => {
      setMatteBusy(isBusy('matte-studio'));
      setMattePercent(allProgress()['matte-studio'] ?? null);
    };
    sync();
    return subscribeBusy(sync);
  }, []);

  // Ctrl+K / Cmd+K 快速开合 AI 助手
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setAssistantOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 切页：若模型设置有未保存改动，先询问是否保存 */
  const navigate = useCallback(
    (next: NavKey) => {
      if (next === active) return;
      if (active === 'settings' && settingsDirty) {
        const save = window.confirm(t('app.unsavedModels', lang));
        if (!save) return;
        void (async () => {
          const ok = await settingsSaveRef.current?.();
          if (ok === false) return; // 保存失败就不离开，让用户看到错误
          setActive(next);
        })();
        return;
      }
      setActive(next);
    },
    [active, settingsDirty, lang],
  );

  /* 记录访问过的页面：有长任务的页面（生图/生成视频/抠图）一旦挂载就不再卸载，
     切页只是 display:none —— 否则 async 请求回来时组件已经没了，任务白跑。 */
  const [visited, setVisited] = useState<Set<NavKey>>(() => new Set<NavKey>([active]));
  useEffect(() => {
    setVisited((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  useEffect(() => {
    void (async () => {
      const result = await window.skeletonElf.app.info();
      if (result.ok) setAppInfo(result.data);
      else setHeaderError(result.error);
    })();
  }, []);

  /* 窗口标题：index.html 里写的是英文占位，真正显示的名字跟着界面语言走。
     不设的话，HTML 的 <title> 会盖掉 BrowserWindow 那边的三语标题。 */
  useEffect(() => {
    document.title = t('app.name', lang);
  }, [lang]);

  // 启动时应用保存过的主题
  useEffect(() => {
    void (async () => {
      const result = await window.skeletonElf.ui.getTheme();
      if (!result.ok) return;
      setTheme(result.data);
      document.documentElement.dataset.theme = result.data;
    })();
  }, []);

  // 启动时应用保存过的界面语言
  useEffect(() => {
    void (async () => {
      const result = await window.skeletonElf.ui.getLang();
      if (result.ok) setLang(result.data);
      else setLang(getLang());
    })();
  }, []);

  /** 从流水线等入口跳到设置页的指定分栏 */
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setActive('settings');
  }, []);

  const toggleTheme = useCallback(() => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    void window.skeletonElf.ui.setTheme(next);
  }, [theme]);

  const openDataDir = useCallback(() => {
    void (async () => {
      const result = await window.skeletonElf.app.openDataDir();
      if (!result.ok) setHeaderError(result.error);
    })();
  }, []);

  const meta = PAGE_META[active];

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={navigate} dataDir={appInfo?.dataDir} onOpenDataDir={openDataDir} />
      <main className="app-main">
        <header className="app-header">
          <div>
            <h1>{t(meta.titleKey, lang)}</h1>
            <p>{t(meta.subtitleKey, lang)}</p>
          </div>
          <div className="app-header__meta">
            <button
              type="button"
              className={`theme-toggle${assistantOpen ? ' is-active' : ''}`}
              onClick={() => setAssistantOpen((open) => !open)}
              title={`${t('header.assistant', lang)}（Ctrl+K）`}
              aria-pressed={assistantOpen}
            >
              {t('header.assistant', lang)}
            </button>
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              title={t('header.theme.toggle', lang)}
            >
              {theme === 'dark' ? t('header.theme.dark', lang) : t('header.theme.light', lang)}
            </button>
            <span className="badge">v{appInfo?.version ?? '—'}</span>
          </div>
        </header>

        {headerError ? <div className="banner banner--error">{headerError}</div> : null}

        {/* 批量抠图期间的全屏提示条：抠图吃满 CPU，其他页面会明显卡
            （已经给它降了进程优先级，但用户仍需要知道「现在不是点不动，是它在忙」） */}
        {matteBusy ? (
          <div className="global-busy">
            <strong>
              {mattePercent !== null
                ? t('busy.matte.title.pct', lang, { percent: String(mattePercent) })
                : t('busy.matte.title', lang)}
            </strong>
            <span>{t('busy.matte.body', lang)}</span>
            {active !== 'matte-studio' ? (
              <button type="button" className="btn btn--ghost" onClick={() => navigate('matte-studio')}>
                {t('busy.matte.back', lang)}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="app-content">
          {/* 有长任务的三个页面：挂载一次后就保留，切页只是 display:none。
              这样生图/生成视频/批量抠图跑到一半切到别处，任务不会被打断。 */}
          <div style={{ display: active === 'image-studio' ? undefined : 'none' }}>
            {visited.has('image-studio') ? (
              <ImageStudioPage onOpenModelSettings={() => navigate('settings')} />
            ) : null}
          </div>
          <div style={{ display: active === 'video-studio' ? undefined : 'none' }}>
            {visited.has('video-studio') ? (
              <VideoStudioPage onOpenModelSettings={() => navigate('settings')} />
            ) : null}
          </div>
          <div style={{ display: active === 'matte-studio' ? undefined : 'none' }}>
            {visited.has('matte-studio') ? <MatteStudioPage /> : null}
          </div>
          {/* 帧动画也要保留挂载：抽帧是前端 async 循环，组件一卸载，
              虽然循环还在跑（白烧 CPU），但 setFrames 打在已卸载的组件上，结果直接丢。 */}
          <div style={{ display: active === 'frame-studio' ? undefined : 'none' }}>
            {visited.has('frame-studio') ? (
              <FrameStudioPage onOpenModelSettings={() => navigate('settings')} />
            ) : null}
          </div>
          {active === 'pipeline' ? (
            <PipelinePage onNavigate={navigate} onOpenSettings={openSettings} />
          ) : null}
          {active === 'loop-trim' ? <LoopTrimPage /> : null}
          {active === 'knowledge' ? <KnowledgePage onOpenDataDir={openDataDir} /> : null}
          {active === 'settings' ? (
            <SettingsPage
              initialTab={settingsTab}
              onDirtyChange={setSettingsDirty}
              registerSave={(save) => {
                settingsSaveRef.current = save;
              }}
            />
          ) : null}
        </div>
      </main>

      <AssistantPanel open={assistantOpen} onOpenChange={setAssistantOpen} />
    </div>
  );
}
