import { useEffect, useState } from 'react';
import { allProgress, busySnapshot, subscribeBusy, type BusyKey } from '../state/busy';
import logoUrl from '../assets/logo.png';

export type NavKey =
  | 'pipeline'
  | 'image-studio'
  | 'video-studio'
  | 'frame-studio'
  | 'matte-studio'
  | 'loop-trim'
  | 'knowledge'
  | 'model-settings';

interface NavItem {
  key: NavKey;
  label: string;
  hint: string;
  /** 该页是否已经真正实现 */
  ready: boolean;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '工作流',
    items: [
      { key: 'pipeline', label: '生成流水线', hint: '总览 · 五步各自独立', ready: true },
      { key: 'image-studio', label: '图像生成', hint: '文生图 / 生成素材入库', ready: true },
      { key: 'video-studio', label: '循环视频', hint: '图片 → 无缝循环视频', ready: true },
      { key: 'frame-studio', label: '帧动画', hint: '视频抽帧 → 帧序列', ready: true },
      { key: 'matte-studio', label: '批量抠图', hint: '整个帧集合一键去背景', ready: true },
      { key: 'loop-trim', label: '找循环帧', hint: '自动裁掉循环点之后的多余帧', ready: true },
      { key: 'knowledge', label: '素材库', hint: '图片 / 视频 / AI 参考', ready: true },
    ],
  },
  {
    title: '设置',
    items: [{ key: 'model-settings', label: '模型设置', hint: '服务商 / 能力槽位 / 余额', ready: true }],
  },
];

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
  dataDir?: string;
  onOpenDataDir: () => void;
}

export function Sidebar({ active, onSelect, dataDir, onOpenDataDir }: SidebarProps): React.JSX.Element {
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
        <img className="sidebar__logo" src={logoUrl} alt="精灵帧动画编辑器" />
        <div>
          <strong>精灵帧动画编辑器</strong>
          <span>视频 → 帧动画 → 帧序列</span>
        </div>
      </div>

      <nav className="sidebar__nav" aria-label="主导航">
        {GROUPS.map((group) => (
          <div className="sidebar__group" key={group.title}>
            <div className="sidebar__group-title">{group.title}</div>
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
                  {item.label}
                  {isRunning(item.key) && progressMap[item.key] !== null && progressMap[item.key] !== undefined
                    ? <em className="sidebar__percent">{progressMap[item.key]}%</em>
                    : null}
                  {item.ready ? null : <em className="tag tag--pending">待实现</em>}
                </span>
                <span className="sidebar__item-hint">{item.hint}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__footer-title">数据目录（便携）</div>
        <div className="sidebar__path" title={dataDir}>
          {dataDir ?? '正在读取…'}
        </div>
        <button type="button" className="btn btn--ghost btn--block" onClick={onOpenDataDir} disabled={!dataDir}>
          打开数据目录
        </button>
      </div>
    </aside>
  );
}
