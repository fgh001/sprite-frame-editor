import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavKey } from '../components/Sidebar';
import { useDataRefresh } from '../state/refresh';
import { t, useLang } from '../i18n';

/**
 * 生成流水线总览。
 *
 * 定位：不是「另做一套流程」，而是把五个已经能用的页面串成一条路径 ——
 * 每一格都能单独点进去用（只做抠图、只找循环帧都行），
 * 卡片上的数字是真实扫盘结果，能让用户一眼看到「已经走到哪一步」。
 */

interface Stage {
  index: number;
  nav: NavKey;
  title: string;
  detail: string;
  /** 这一步会产出什么 */
  output: string;
  /** 当前已有多少产出；null = 还没开始 */
  status: string | null;
}

interface Snapshot {
  images: number;
  videos: number;
  frameSets: number;
  frameCount: number;
  outputSets: number;
  outputFrames: number;
}

const EMPTY: Snapshot = {
  images: 0,
  videos: 0,
  frameSets: 0,
  frameCount: 0,
  outputSets: 0,
  outputFrames: 0,
};

interface PipelinePageProps {
  onNavigate: (key: NavKey) => void;
  /** 跳到设置页的指定分栏（语言 / 模型） */
  onOpenSettings?: (tab: 'models' | 'language') => void;
}

export function PipelinePage({ onNavigate, onOpenSettings }: PipelinePageProps): React.JSX.Element {
  const [lang] = useLang();
  const [stats, setStats] = useState<Snapshot | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [knowledge, projects, outputs] = await Promise.all([
      window.skeletonElf.knowledge.list(),
      window.skeletonElf.frames.list(),
      window.skeletonElf.frames.listOutputs(),
    ]);
    const items = knowledge.ok ? knowledge.data : [];
    const sets = projects.ok ? projects.data : [];
    const outs = outputs.ok ? outputs.data : [];
    setStats({
      images: items.filter((item) => item.kind === 'image').length,
      videos: items.filter((item) => item.kind === 'video').length,
      frameSets: sets.length,
      frameCount: sets.reduce((sum, item) => sum + item.frameCount, 0),
      outputSets: outs.length,
      outputFrames: outs.reduce((sum, item) => sum + item.frameCount, 0),
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* 总览上的数字是扫盘统计：任何页面改了数据都要重算一遍 */
  useDataRefresh(() => {
    void load();
  });

  const snapshot = stats ?? EMPTY;

  const stages = useMemo<Stage[]>(
    () => [
      {
        index: 1,
        nav: 'image-studio',
        title: t('pl.stage1.title', lang),
        detail: t('pl.stage1.detail', lang),
        output: t('pl.stage1.output', lang),
        status:
          snapshot.images > 0
            ? t('pl.count.images', lang, { count: String(snapshot.images) })
            : null,
      },
      {
        index: 2,
        nav: 'video-studio',
        title: t('pl.stage2.title', lang),
        detail: t('pl.stage2.detail', lang),
        output: t('pl.stage2.output', lang),
        status:
          snapshot.videos > 0
            ? t('pl.count.videos', lang, { count: String(snapshot.videos) })
            : null,
      },
      {
        index: 3,
        nav: 'frame-studio',
        title: t('pl.stage3.title', lang),
        detail: t('pl.stage3.detail', lang),
        output: t('pl.stage3.output', lang),
        status:
          snapshot.frameSets > 0
            ? t('pl.count.frames', lang, {
                sets: String(snapshot.frameSets),
                frames: String(snapshot.frameCount),
              })
            : null,
      },
      {
        index: 4,
        nav: 'matte-studio',
        title: t('pl.stage4.title', lang),
        detail: t('pl.stage4.detail', lang),
        output: t('pl.stage4.output', lang),
        status:
          snapshot.outputSets > 0
            ? t('pl.count.outputs', lang, {
                sets: String(snapshot.outputSets),
                frames: String(snapshot.outputFrames),
              })
            : null,
      },
      {
        index: 5,
        nav: 'loop-trim',
        title: t('pl.stage5.title', lang),
        detail: t('pl.stage5.detail', lang),
        output: t('pl.stage5.output', lang),
        status: null,
      },
    ],
    [snapshot, lang],
  );

  /* 根据已有数据推荐下一步，省得用户自己判断该点哪儿 */
  const next = useMemo<{ nav: NavKey; label: string }>(() => {
    if (snapshot.images === 0 && snapshot.videos === 0) {
      return { nav: 'image-studio', label: t('pl.next.images', lang) };
    }
    if (snapshot.videos === 0) return { nav: 'video-studio', label: t('pl.next.videos', lang) };
    if (snapshot.frameSets === 0) return { nav: 'frame-studio', label: t('pl.next.frames', lang) };
    if (snapshot.outputSets === 0) return { nav: 'matte-studio', label: t('pl.next.outputs', lang) };
    return { nav: 'loop-trim', label: t('pl.next.trim', lang) };
  }, [snapshot, lang]);

  const cells: { label: string; value: string }[] = [
    { label: t('pl.stat.images', lang), value: stats ? String(snapshot.images) : '—' },
    { label: t('pl.stat.videos', lang), value: stats ? String(snapshot.videos) : '—' },
    {
      label: t('pl.stat.frames', lang),
      value: stats
        ? snapshot.frameSets > 0
          ? t('pl.stat.frameValue', lang, {
              sets: String(snapshot.frameSets),
              frames: String(snapshot.frameCount),
            })
          : '0'
        : '—',
    },
    {
      label: t('pl.stat.outputs', lang),
      value: stats
        ? snapshot.outputSets > 0
          ? t('pl.stat.frameValue', lang, {
              sets: String(snapshot.outputSets),
              frames: String(snapshot.outputFrames),
            })
          : '0'
        : '—',
    },
  ];

  return (
    <div className="stack">
      <section className="card pipeline-hero">
        <div className="pipeline-hero__text">
          <h2>{t('pl.hero.title', lang)}</h2>
          <p className="muted">{t('pl.hero.body', lang)}</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => onNavigate(next.nav)}>
          {t('pl.next', lang, { label: next.label })}
        </button>
      </section>

      {/* 快速定位：直接跳到设置页的对应分栏，不用先去侧边栏找「设置」 */}
      <section className="card">
        <div className="card__head">
          <h2>{t('pipeline.quick.jump', lang)}</h2>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={() => onOpenSettings?.('language')}>
            {t('pipeline.quick.language', lang)}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => onOpenSettings?.('models')}>
            {t('pipeline.quick.models', lang)}
          </button>
        </div>
      </section>

      <section className="card pipeline-stats">
        {cells.map((cell) => (
          <div className="pipeline-stat" key={cell.label}>
            <span className="pipeline-stat__value">{cell.value}</span>
            <span className="pipeline-stat__label">{cell.label}</span>
          </div>
        ))}
      </section>

      <div className="stage-grid">
        {stages.map((stage) => (
          <button
            key={stage.index}
            type="button"
            className="card stage-card stage-card--link"
            onClick={() => onNavigate(stage.nav)}
          >
            <div className="stage-card__head">
              <span className="stage-card__index">{stage.index}</span>
              <h3>{stage.title}</h3>
              {stage.status === null ? (
                <span className="tag tag--pending">{t('pl.pending', lang)}</span>
              ) : (
                <span className="tag tag--ok">{stage.status}</span>
              )}
            </div>
            <p className="muted">{stage.detail}</p>
            <div className="stage-card__export">{t('pl.output', lang, { value: stage.output })}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
