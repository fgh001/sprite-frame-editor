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
import { ModelSettingsPage } from './pages/ModelSettingsPage';
import { KnowledgePage } from './pages/KnowledgePage';

const PAGE_META: Record<NavKey, { title: string; subtitle: string }> = {
  pipeline: { title: '生成流水线', subtitle: '图片 → 循环视频 → 2D 帧动画，每个阶段都能单独导出' },
  'image-studio': { title: '图像生成', subtitle: '纯色背景出图，结果可存入素材库，作为后续阶段的输入' },
  'video-studio': { title: '循环视频', subtitle: '图片 → 无缝循环视频（首帧=尾帧），可直接作为下一阶段输入' },
  'frame-studio': { title: '帧动画', subtitle: '视频抽帧 → 帧序列（一个项目一个文件夹），本地处理、不消耗 API' },
  'matte-studio': { title: '批量抠图', subtitle: '整个帧集合一键去背景 —— 模型自己识别前景，不需要颜色参数' },
  'loop-trim': { title: '找循环帧', subtitle: '自动找出与首帧最接近的一帧作为循环点，裁掉后面的多余帧' },
  knowledge: { title: '素材库', subtitle: '把散落在各处的图片 / 视频压进本地素材库，作为 AI 生成的参考素材' },
  'model-settings': { title: '模型设置', subtitle: '按能力槽位接入大模型：文本 / 图像 / 视频各自独立配置' },
};

export function App(): React.JSX.Element {
  const [active, setActive] = useState<NavKey>('image-studio');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  /** 模型设置页是否有未保存改动（切页前要提醒） */
  const [settingsDirty, setSettingsDirty] = useState(false);
  /** AI 助手面板是否展开（顶栏按钮和面板自己的收起按钮共用） */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const settingsSaveRef = useRef<(() => Promise<boolean>) | null>(null);

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
      if (active === 'model-settings' && settingsDirty) {
        const save = window.confirm('模型设置有未保存的改动。\n\n确定 = 先保存再离开；取消 = 留在本页');
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
    [active, settingsDirty],
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

  // 启动时应用保存过的主题
  useEffect(() => {
    void (async () => {
      const result = await window.skeletonElf.ui.getTheme();
      if (!result.ok) return;
      setTheme(result.data);
      document.documentElement.dataset.theme = result.data;
    })();
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
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <div className="app-header__meta">
            <button
              type="button"
              className={`theme-toggle${assistantOpen ? ' is-active' : ''}`}
              onClick={() => setAssistantOpen((open) => !open)}
              title="AI 助手（Ctrl+K）"
              aria-pressed={assistantOpen}
            >
              AI 助手
            </button>
            <button type="button" className="theme-toggle" onClick={toggleTheme} title="切换深色 / 浅色">
              {theme === 'dark' ? '🌙 深色' : '☀️ 浅色'}
            </button>
            <span className="badge">v{appInfo?.version ?? '—'}</span>
          </div>
        </header>

        {headerError ? <div className="banner banner--error">{headerError}</div> : null}

        <div className="app-content">
          {/* 有长任务的三个页面：挂载一次后就保留，切页只是 display:none。
              这样生图/生成视频/批量抠图跑到一半切到别处，任务不会被打断。 */}
          <div style={{ display: active === 'image-studio' ? undefined : 'none' }}>
            {visited.has('image-studio') ? (
              <ImageStudioPage onOpenModelSettings={() => navigate('model-settings')} />
            ) : null}
          </div>
          <div style={{ display: active === 'video-studio' ? undefined : 'none' }}>
            {visited.has('video-studio') ? (
              <VideoStudioPage onOpenModelSettings={() => navigate('model-settings')} />
            ) : null}
          </div>
          <div style={{ display: active === 'matte-studio' ? undefined : 'none' }}>
            {visited.has('matte-studio') ? <MatteStudioPage /> : null}
          </div>
          {/* 帧动画也要保留挂载：抽帧是前端 async 循环，组件一卸载，
              虽然循环还在跑（白烧 CPU），但 setFrames 打在已卸载的组件上，结果直接丢。 */}
          <div style={{ display: active === 'frame-studio' ? undefined : 'none' }}>
            {visited.has('frame-studio') ? (
              <FrameStudioPage onOpenModelSettings={() => navigate('model-settings')} />
            ) : null}
          </div>
          {active === 'pipeline' ? <PipelinePage onNavigate={navigate} /> : null}
          {active === 'loop-trim' ? <LoopTrimPage /> : null}
          {active === 'knowledge' ? <KnowledgePage onOpenDataDir={openDataDir} /> : null}
          {active === 'model-settings' ? (
            <ModelSettingsPage
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
