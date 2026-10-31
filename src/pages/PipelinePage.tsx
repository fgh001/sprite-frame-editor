import { useEffect, useMemo, useState } from 'react';
import type { NavKey } from '../components/Sidebar';

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
}

export function PipelinePage({ onNavigate }: PipelinePageProps): React.JSX.Element {
  const [stats, setStats] = useState<Snapshot | null>(null);

  useEffect(() => {
    void (async () => {
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
    })();
  }, []);

  const snapshot = stats ?? EMPTY;

  const stages = useMemo<Stage[]>(
    () => [
      {
        index: 1,
        nav: 'image-studio',
        title: '图像生成',
        detail: '文生图出素材，默认纯色背景 —— 后面抠图能干净很多。',
        output: '图片（PNG，可选自动入库）',
        status: snapshot.images > 0 ? `${snapshot.images} 张` : null,
      },
      {
        index: 2,
        nav: 'video-studio',
        title: '循环视频',
        detail: '把一张图变成首尾相接的循环短片，镜头、光效、衣摆动起来。',
        output: '视频（mp4 / webm，首帧 = 尾帧）',
        status: snapshot.videos > 0 ? `${snapshot.videos} 个` : null,
      },
      {
        index: 3,
        nav: 'frame-studio',
        title: '抽帧 → 帧序列',
        detail: '视频按帧率拆成 PNG 序列，一个集合一个文件夹，本地处理不花钱。',
        output: '帧集合（frame_000.png …）',
        status:
          snapshot.frameSets > 0 ? `${snapshot.frameSets} 个集合 · ${snapshot.frameCount} 帧` : null,
      },
      {
        index: 4,
        nav: 'matte-studio',
        title: '批量抠图',
        detail: '整组帧一键去背景，模型自己识别主体，不用逐个调颜色参数。',
        output: '抠图结果（独立目录，不动原帧）',
        status:
          snapshot.outputSets > 0 ? `${snapshot.outputSets} 组 · ${snapshot.outputFrames} 帧` : null,
      },
      {
        index: 5,
        nav: 'loop-trim',
        title: '找循环帧',
        detail: '自动找出和首帧最接近的一帧当循环点，裁掉后面多余的部分。',
        output: '裁剪后的帧序列（可播放预览）',
        status: null,
      },
    ],
    [snapshot],
  );

  /* 根据已有数据推荐下一步，省得用户自己判断该点哪儿 */
  const next = useMemo<{ nav: NavKey; label: string }>(() => {
    if (snapshot.images === 0 && snapshot.videos === 0) {
      return { nav: 'image-studio', label: '先生成第一张素材' };
    }
    if (snapshot.videos === 0) return { nav: 'video-studio', label: '把它做成循环视频' };
    if (snapshot.frameSets === 0) return { nav: 'frame-studio', label: '把视频抽成帧序列' };
    if (snapshot.outputSets === 0) return { nav: 'matte-studio', label: '给这组帧抠图' };
    return { nav: 'loop-trim', label: '找出循环帧、裁掉多余部分' };
  }, [snapshot]);

  const cells: { label: string; value: string }[] = [
    { label: '素材图片', value: stats ? String(snapshot.images) : '—' },
    { label: '视频', value: stats ? String(snapshot.videos) : '—' },
    {
      label: '帧集合',
      value: stats ? (snapshot.frameSets > 0 ? `${snapshot.frameSets} / ${snapshot.frameCount} 帧` : '0') : '—',
    },
    {
      label: '抠图结果',
      value: stats ? (snapshot.outputSets > 0 ? `${snapshot.outputSets} / ${snapshot.outputFrames} 帧` : '0') : '—',
    },
  ];

  return (
    <div className="stack">
      <section className="card pipeline-hero">
        <div className="pipeline-hero__text">
          <h2>一条流水线，五步各自独立</h2>
          <p className="muted">
            每一格都能单独用：只想抠图、只想找循环帧都行。所有文件都在本地 <code>data/</code> 目录里，随时能整个搬走。
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => onNavigate(next.nav)}>
          下一步：{next.label} →
        </button>
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
                <span className="tag tag--pending">未开始</span>
              ) : (
                <span className="tag tag--ok">{stage.status}</span>
              )}
            </div>
            <p className="muted">{stage.detail}</p>
            <div className="stage-card__export">产出：{stage.output}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
