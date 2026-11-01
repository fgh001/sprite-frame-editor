import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EditableImage, FrameOutputView, FrameProjectView, KnowledgeView } from '@shared/ipc';
import { ImageEditorModal } from '../components/ImageEditorModal';
import { FramePlayerModal } from '../components/FramePlayerModal';
import { notifyDataChanged, useDataRefresh } from '../state/refresh';
import { t, useLang } from '../i18n';

/**
 * 素材库分栏：
 *   image / video  —— 素材库里的图片、视频（data/knowledge）
 *   frames         —— 原始帧动画，即抽帧出来的集合（data/frames/sources）
 *   matte          —— 抠图帧动画，即批量抠图产出（data/frames/outputs 下的 -matte / -key）
 */
type Filter = 'all' | 'image' | 'video' | 'frames' | 'matte';

interface KnowledgePageProps {
  onOpenDataDir: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function KnowledgePage({ onOpenDataDir }: KnowledgePageProps): React.JSX.Element {
  const [lang] = useLang();
  const [items, setItems] = useState<KnowledgeView[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 选中的帧集合（素材/视频与帧集合互斥选中，避免右边详情残留上一项） */
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);

  /** 文件名输入框（改名用，和 fileName 同步） */
  const [nameInput, setNameInput] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [editing, setEditing] = useState<EditableImage | null>(null);

  /** 原始帧动画（data/frames/sources） */
  const [frameProjects, setFrameProjects] = useState<FrameProjectView[]>([]);
  /** 抠图帧动画（data/frames/outputs 下的 -matte / -key） */
  const [frameOutputs, setFrameOutputs] = useState<FrameOutputView[]>([]);
  /** 正在播放预览的帧集合（null = 没打开播放窗口） */
  const [preview, setPreview] = useState<{ title: string; frameUrls: string[]; fps: number } | null>(null);
  /** 正在挑帧编辑的集合（null = 没打开帧选择弹窗） */
  const [frameEditProject, setFrameEditProject] = useState<FrameProjectView | null>(null);
  /** 从集合里挑出来、正在编辑器里改的那一帧 */
  const [editingFrame, setEditingFrame] = useState<{
    image: EditableImage;
    projectId: string;
    fileName: string;
  } | null>(null);
  /** 正在改名的帧集合 / 抠图结果（存 project.id 或 output.name，null = 没在改名） */
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  /** 改名输入框当前内容 */
  const [renameInput, setRenameInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [res, projectRes, outputRes] = await Promise.all([
      window.skeletonElf.knowledge.list(),
      window.skeletonElf.frames.list(),
      window.skeletonElf.frames.listOutputs(),
    ]);
    setLoading(false);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setItems(res.data);
    if (projectRes.ok) {
      // 下划线开头的是内部临时集合（_preview），不往列表里放
      setFrameProjects(projectRes.data.filter((project) => !project.id.startsWith('_')));
    }
    if (outputRes.ok) setFrameOutputs(outputRes.data);
  }, []);

  /* 别处（帧动画页保存新集合、批量抠图出结果）改了数据时，这一页也要刷新 */
  useDataRefresh(() => {
    void load();
  });

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const selectedFrameProject = useMemo(
    () => frameProjects.find((project) => project.id === selectedFrameId) ?? null,
    [frameProjects, selectedFrameId],
  );

  useEffect(() => {
    if (!selected) {
      setNameInput('');
      return;
    }
    setNameInput(selected.fileName);
  }, [selected]);

  const handleImport = async (): Promise<void> => {
    setMessage(null);
    const res = await window.skeletonElf.knowledge.importFiles();
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    const { imported, skippedDuplicates, skippedUnsupported } = res.data;
    if (imported === 0 && skippedDuplicates === 0 && skippedUnsupported === 0) return; // 用户取消
    const parts = [t('kb.msg.imported', lang, { count: String(imported) })];
    if (skippedDuplicates > 0) {
      parts.push(t('kb.msg.skippedDup', lang, { count: String(skippedDuplicates) }));
    }
    if (skippedUnsupported > 0) {
      parts.push(t('kb.msg.skippedUnsupported', lang, { count: String(skippedUnsupported) }));
    }
    setMessage({ kind: imported > 0 ? 'ok' : 'err', text: parts.join(lang === 'en' ? ', ' : '，') });
    await load();
    // 新素材进来：其他页面（帧动画选视频、循环视频选图）的候选列表也要刷
    notifyDataChanged();
  };

  /**
   * 重命名素材文件（改的是磁盘上的真实文件名，缩略图不受影响）。
   * 重名时后端直接报错、不覆盖，这里把错误原样显示出来。
   */
  const handleRename = async (): Promise<void> => {
    if (!selected) return;
    const next = nameInput.trim();
    if (!next || next === selected.fileName) return;
    const res = await window.skeletonElf.knowledge.rename(selected.id, next);
    if (!res.ok) {
      setMessage({ kind: 'err', text: t('kb.msg.renameFailed', lang, { error: res.error }) });
      return;
    }
    setItems((prev) => prev.map((item) => (item.id === res.data.id ? res.data : item)));
    setNameInput(res.data.fileName);
    setMessage({ kind: 'ok', text: t('kb.msg.renamed', lang, { name: res.data.fileName }) });
    // 文件名变了：其他页面引用的旧名字要跟着刷新
    notifyDataChanged();
  };

  /** 重命名帧集合（改磁盘文件夹名，meta.json 一起更新；重名报错不覆盖） */
  const handleRenameFrameProject = async (id: string): Promise<void> => {
    const next = renameInput.trim();
    if (!next || next === id) {
      setRenamingKey(null);
      setRenameInput('');
      return;
    }
    const res = await window.skeletonElf.frames.rename(id, next);
    if (!res.ok) {
      setMessage({ kind: 'err', text: t('kb.msg.renameFailed', lang, { error: res.error }) });
      return;
    }
    setRenamingKey(null);
    setRenameInput('');
    setMessage({ kind: 'ok', text: t('kb.msg.renamed', lang, { name: res.data.name }) });
    await load();
    notifyDataChanged();
  };

  /** 重命名抠图结果目录（-matte / -key 后缀自动保留；重名报错不覆盖） */
  const handleRenameFrameOutput = async (name: string): Promise<void> => {
    const next = renameInput.trim();
    if (!next) {
      setRenamingKey(null);
      setRenameInput('');
      return;
    }
    const res = await window.skeletonElf.frames.renameOutput(name, next);
    if (!res.ok) {
      setMessage({ kind: 'err', text: t('kb.msg.renameFailed', lang, { error: res.error }) });
      return;
    }
    setRenamingKey(null);
    setRenameInput('');
    setMessage({ kind: 'ok', text: t('kb.msg.renamed', lang, { name: res.data }) });
    await load();
    notifyDataChanged();
  };

  /** 删除帧集合（整目录删掉，源文件无副本，删了就没了） */
  const handleRemoveFrameProject = async (id: string, name: string, count: number): Promise<void> => {
    const confirmText = [
      t('kb.confirm.removeProjectTitle', lang, { name }),
      '',
      t('kb.confirm.removeSetBody', lang, { count: String(count) }),
    ].join('\n');
    if (!window.confirm(confirmText)) return;
    const res = await window.skeletonElf.frames.remove(id);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setMessage({ kind: 'ok', text: t('kb.msg.removed', lang) });
    await load();
    notifyDataChanged();
  };

  /** 删除抠图结果目录（源抽帧集合不受影响） */
  const handleRemoveFrameOutput = async (name: string, count: number): Promise<void> => {
    const confirmText = [
      t('kb.confirm.removeOutputTitle', lang, { name }),
      '',
      t('kb.confirm.removeSetBody', lang, { count: String(count) }),
      t('kb.confirm.removeSetSource', lang),
    ].join('\n');
    if (!window.confirm(confirmText)) return;
    const res = await window.skeletonElf.frames.remove(name);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setMessage({ kind: 'ok', text: t('kb.msg.removed', lang) });
    await load();
    notifyDataChanged();
  };

  const handleRemove = async (): Promise<void> => {
    if (!selected) return;
    const confirmText = [
      `${t('kb.confirm.removeTitle', lang, { name: selected.fileName })}`,
      '',
      t('kb.confirm.removeBody1', lang),
      t('kb.confirm.removeBody2', lang),
    ].join('\n');
    if (!window.confirm(confirmText)) return;
    const res = await window.skeletonElf.knowledge.remove(selected.id);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setSelectedId(null);
    setMessage({ kind: 'ok', text: t('kb.msg.removed', lang) });
    await load();
    notifyDataChanged();
  };

  const handleEdit = async (): Promise<void> => {
    if (!selected || selected.kind !== 'image') return;
    const res = await window.skeletonElf.files.readImage(selected.absPath);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setEditing(res.data);
  };

  /** 打开帧集合里的某一帧：读成 dataURL 交给图片编辑器 */
  const openFrameEditor = async (project: FrameProjectView, fileName: string): Promise<void> => {
    const res = await window.skeletonElf.files.readImage(`${project.absPath}/${fileName}`);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setFrameEditProject(null);
    setEditingFrame({ image: res.data, projectId: project.id, fileName });
  };

  /** 编辑器里点「应用到这一帧」：把 PNG 写回磁盘上的那一帧 */
  const handleFrameApply = async (pngDataUrl: string): Promise<void> => {
    if (!editingFrame) return;
    const { projectId, fileName } = editingFrame;
    const res = await window.skeletonElf.frames.writeFrame(projectId, fileName, pngDataUrl);
    setEditingFrame(null);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setMessage({ kind: 'ok', text: t('kb.msg.frameSaved', lang, { name: fileName }) });
    await load();
    notifyDataChanged();
  };

  const visible = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (!key) return true;
      return item.fileName.toLowerCase().includes(key);
    });
  }, [items, filter, keyword]);

  const counts = useMemo(
    () => ({
      all: items.length,
      image: items.filter((item) => item.kind === 'image').length,
      video: items.filter((item) => item.kind === 'video').length,
      frames: frameProjects.length,
      matte: frameOutputs.length,
    }),
    [items, frameProjects, frameOutputs],
  );

  /** 原始帧动画的搜索过滤（按集合名 / 来源视频） */
  const visibleProjects = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return frameProjects;
    return frameProjects.filter(
      (project) =>
        project.name.toLowerCase().includes(key) || project.sourceVideo.toLowerCase().includes(key),
    );
  }, [frameProjects, keyword]);

  /** 抠图帧动画的搜索过滤（按目录名 / 源集合名） */
  const visibleOutputs = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return frameOutputs;
    return frameOutputs.filter(
      (output) =>
        output.name.toLowerCase().includes(key) || output.sourceName.toLowerCase().includes(key),
    );
  }, [frameOutputs, keyword]);

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>{t('kb.title', lang, { count: String(counts.all) })}</h2>
          </div>

          <div className="kb-toolbar">
            <div className="kb-filters">
              {(
                [
                  ['all', t('kb.filter.all', lang, { count: String(counts.all) })],
                  ['image', t('kb.filter.image', lang, { count: String(counts.image) })],
                  ['video', t('kb.filter.video', lang, { count: String(counts.video) })],
                  ['frames', t('kb.filter.frames', lang, { count: String(counts.frames) })],
                  ['matte', t('kb.filter.matte', lang, { count: String(counts.matte) })],
                ] as [Filter, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`slot-tab${filter === value ? ' is-active' : ''}`}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              className="input kb-search"
              value={keyword}
              placeholder={t('kb.search', lang)}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <div className="kb-toolbar__actions">
              <button type="button" className="btn btn--primary" onClick={() => void handleImport()}>
                {t('kb.import', lang)}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
                {loading ? t('kb.refreshing', lang) : t('kb.refresh', lang)}
              </button>
              <button type="button" className="btn btn--ghost" onClick={onOpenDataDir}>
                {t('kb.openDataDir', lang)}
              </button>
            </div>
          </div>

          {message ? <div className={`banner banner--${message.kind}`}>{message.text}</div> : null}

          {/* 原始帧动画：抽帧出来的集合（data/frames/sources） */}
          {filter === 'frames' ? (
            visibleProjects.length === 0 ? (
              <div className="kb-empty">
                <p className="muted">{t('kb.empty.frames', lang)}</p>
              </div>
            ) : (
              <div className="studio-grid">
                {visibleProjects.map((project) => (
                  <figure
                    key={project.id}
                    className={`studio-item kb-card${selectedFrameId === project.id ? ' is-active' : ''}`}
                    onClick={() => {
                      setSelectedFrameId(project.id);
                      setSelectedId(null);
                    }}
                  >
                    <div className="kb-frame-thumbs">
                      {project.frameUrls.slice(0, 4).map((url) => (
                        <img key={url} src={url} alt={project.name} />
                      ))}
                    </div>
                    <figcaption>
                      {renamingKey === project.id ? (
                        <div className="actions">
                          <input
                            className="input"
                            value={renameInput}
                            autoFocus
                            placeholder={t('kb.rename.project.placeholder', lang)}
                            onChange={(event) => setRenameInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void handleRenameFrameProject(project.id);
                              if (event.key === 'Escape') {
                                setRenamingKey(null);
                                setRenameInput('');
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <strong className="kb-frame-name" title={project.absPath}>
                          {project.name}
                        </strong>
                      )}
                      <span>
                        {t('kb.frames.meta', lang, {
                          count: String(project.frameFileNames.length),
                          width: String(project.width),
                          height: String(project.height),
                          fps: String(project.fps),
                        })}
                      </span>
                      {project.sourceVideo ? <code>{project.sourceVideo}</code> : null}
                      <div className="actions">
                        {renamingKey === project.id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--primary"
                              onClick={() => void handleRenameFrameProject(project.id)}
                            >
                              {t('kb.btn.renameConfirm', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => {
                                setRenamingKey(null);
                                setRenameInput('');
                              }}
                            >
                              {t('kb.btn.cancel', lang)}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() =>
                                setPreview({
                                  title: `${project.name} · ${t('kb.frames.count', lang, {
                                    count: String(project.frameFileNames.length),
                                  })}`,
                                  frameUrls: project.frameUrls,
                                  fps: project.fps,
                                })
                              }
                            >
                              {t('kb.btn.preview', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              title={project.absPath}
                              onClick={() => void window.skeletonElf.frames.openDir(project.id)}
                            >
                              {t('kb.btn.openDir', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              title={t('kb.title.editFrames', lang)}
                              onClick={() => setFrameEditProject(project)}
                            >
                              {t('kb.btn.editFrames', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              title={t('kb.title.renameProject', lang)}
                              onClick={() => {
                                setRenamingKey(project.id);
                                setRenameInput(project.name);
                              }}
                            >
                              {t('kb.btn.rename', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--danger"
                              onClick={() =>
                                void handleRemoveFrameProject(
                                  project.id,
                                  project.name,
                                  project.frameFileNames.length,
                                )
                              }
                            >
                              {t('kb.btn.remove', lang)}
                            </button>
                          </>
                        )}
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )
          ) : filter === 'matte' ? (
            /* 抠图帧动画：批量抠图的产出（data/frames/outputs） */
            visibleOutputs.length === 0 ? (
              <div className="kb-empty">
                <p className="muted">{t('kb.empty.matte', lang)}</p>
              </div>
            ) : (
              <div className="studio-grid">
                {visibleOutputs.map((output) => (
                  <figure key={output.name} className="studio-item kb-card">
                    <div className="kb-frame-thumbs">
                      {output.previewUrls.slice(0, 4).map((url) => (
                        <img key={url} src={url} alt={output.name} />
                      ))}
                    </div>
                    <figcaption>
                      {renamingKey === output.name ? (
                        <div className="actions">
                          <input
                            className="input"
                            value={renameInput}
                            autoFocus
                            placeholder={t('kb.rename.output.placeholder', lang)}
                            onChange={(event) => setRenameInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void handleRenameFrameOutput(output.name);
                              if (event.key === 'Escape') {
                                setRenamingKey(null);
                                setRenameInput('');
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <strong className="kb-frame-name" title={output.absPath}>
                          {output.name}
                        </strong>
                      )}
                      <span>
                        {t('kb.matte.summary', lang, {
                          count: String(output.frameCount),
                          kind:
                            output.kind === 'matte'
                              ? t('kb.matte.kind.model', lang)
                              : t('kb.matte.kind.key', lang),
                          source: output.sourceName,
                        })}
                      </span>
                      <div className="actions">
                        {renamingKey === output.name ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--primary"
                              onClick={() => void handleRenameFrameOutput(output.name)}
                            >
                              {t('kb.btn.renameConfirm', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => {
                                setRenamingKey(null);
                                setRenameInput('');
                              }}
                            >
                              {t('kb.btn.cancel', lang)}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() =>
                                setPreview({
                                  title: `${output.name} · ${t('kb.frames.count', lang, {
                                    count: String(output.frameCount),
                                  })}`,
                                  frameUrls: output.previewUrls,
                                  fps: 12,
                                })
                              }
                            >
                              {t('kb.btn.preview', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              title={output.absPath}
                              onClick={() => void window.skeletonElf.frames.openDir(output.name)}
                            >
                              {t('kb.btn.openDir', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              title={t('kb.title.renameOutput', lang)}
                              onClick={() => {
                                setRenamingKey(output.name);
                                setRenameInput(output.name.replace(/-(matte|key)$/i, ''));
                              }}
                            >
                              {t('kb.btn.rename', lang)}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--danger"
                              onClick={() => void handleRemoveFrameOutput(output.name, output.frameCount)}
                            >
                              {t('kb.btn.remove', lang)}
                            </button>
                          </>
                        )}
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )
          ) : visible.length === 0 ? (
            <div className="kb-empty">
              <p className="muted">
                {items.length === 0 ? t('kb.empty.items', lang) : t('kb.empty.filtered', lang)}
              </p>
            </div>
          ) : (
            <div className="studio-grid">
              {visible.map((item) => (
                <figure
                  key={item.id}
                  className={`studio-item kb-card${selectedId === item.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setSelectedId(item.id);
                    setSelectedFrameId(null);
                  }}
                >
                  {item.kind === 'video' ? (
                    <video className="kb-card__media" src={item.mediaUrl} muted preload="metadata" />
                  ) : item.thumbUrl ? (
                    <img src={item.thumbUrl} alt={item.fileName} />
                  ) : (
                    <div className="studio-item__placeholder">{t('kb.noThumb', lang)}</div>
                  )}
                  <figcaption>
                    <span>
                      {item.kind === 'video' ? t('kb.type.video', lang) : t('kb.type.image', lang)}
                      {item.width && item.height ? ` · ${item.width}×${item.height}` : ''} · {formatBytes(item.bytes)}
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="stack">
        <section className="card">
          <h2>{t('kb.detail.title', lang)}</h2>
          {!selected && selectedFrameProject ? (
            <>
              {selectedFrameProject.frameUrls.length > 0 ? (
                <img
                  className="kb-detail__preview"
                  src={selectedFrameProject.frameUrls[0]}
                  alt={selectedFrameProject.name}
                />
              ) : null}

              <div className="balance-extra">
                <div>
                  <span>{t('kb.detail.type', lang)}</span>
                  <strong>{t('kb.type.frames', lang)}</strong>
                </div>
                <div>
                  <span>{t('kb.detail.frames', lang)}</span>
                  <strong>{selectedFrameProject.frameFileNames.length}</strong>
                </div>
                <div>
                  <span>{t('kb.detail.dimensions', lang)}</span>
                  <strong>
                    {selectedFrameProject.width && selectedFrameProject.height
                      ? `${selectedFrameProject.width}×${selectedFrameProject.height}`
                      : '—'}
                  </strong>
                </div>
              </div>

              <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                {selectedFrameProject.name} · {selectedFrameProject.fps} fps
                {selectedFrameProject.sourceVideo ? ` · ${selectedFrameProject.sourceVideo}` : ''}
              </p>

              <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                {t('kb.detail.copy', lang)}
                <code>{selectedFrameProject.absPath}</code>
              </p>

              <div className="actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setFrameEditProject(selectedFrameProject)}
                >
                  {t('kb.btn.editFrames', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() =>
                    setPreview({
                      title: selectedFrameProject.name,
                      frameUrls: selectedFrameProject.frameUrls,
                      fps: selectedFrameProject.fps,
                    })
                  }
                >
                  {t('kb.btn.preview', lang)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void window.skeletonElf.frames.openDir(selectedFrameProject.id)}
                >
                  {t('kb.btn.openDir', lang)}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setSelectedFrameId(null)}>
                  {t('kb.btn.clearSelection', lang)}
                </button>
              </div>
            </>
          ) : selected ? (
            <>
              {selected.kind === 'image' && selected.thumbUrl ? (
                <img className="kb-detail__preview" src={selected.thumbUrl} alt={selected.fileName} />
              ) : null}
              {selected.kind === 'video' ? (
                <video className="kb-detail__preview" src={selected.mediaUrl} controls preload="metadata" />
              ) : null}

              <div className="balance-extra">
                <div>
                  <span>{t('kb.detail.type', lang)}</span>
                  <strong>
                    {selected.kind === 'video' ? t('kb.type.video', lang) : t('kb.type.image', lang)}
                  </strong>
                </div>
                <div>
                  <span>{t('kb.detail.size', lang)}</span>
                  <strong>{formatBytes(selected.bytes)}</strong>
                </div>
                <div>
                  <span>{t('kb.detail.dimensions', lang)}</span>
                  <strong>{selected.width && selected.height ? `${selected.width}×${selected.height}` : '—'}</strong>
                </div>
              </div>

              <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                {selected.fileName} · {formatDate(selected.createdAt)}
              </p>

              <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                {t('kb.detail.copy', lang)}
                <code>{selected.absPath}</code>
              </p>

              {/* 改名：直接改磁盘上的真实文件名，索引会一起更新；
                  已有同名文件时后端报错、不覆盖。
                  用 div 不用 label —— label 包着 input 时点击会触发 label 激活，
                  把刚拖出来的文字选区取消掉（表现为「鼠标选不中、Ctrl+A 也没反应」）。 */}
              <div className="field">
                <span className="field__label">{t('kb.field.fileName', lang)}</span>
                <div className="actions">
                  <input
                    className="input"
                    value={nameInput}
                    placeholder={t('kb.field.fileName.placeholder', lang)}
                    onChange={(event) => setNameInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRename();
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void handleRename()}
                    disabled={!nameInput.trim() || nameInput.trim() === selected.fileName}
                    title={t('kb.title.renameFile', lang)}
                  >
                    {t('kb.btn.rename', lang)}
                  </button>
                </div>
                <span className="field__hint">{t('kb.field.renameHint', lang)}</span>
              </div>

              <div className="actions">
                {selected.kind === 'image' ? (
                  <button type="button" className="btn btn--ghost" onClick={() => void handleEdit()}>
                    {t('kb.btn.edit', lang)}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    void window.skeletonElf.files.reveal(selected.absPath);
                  }}
                >
                  {t('kb.btn.reveal', lang)}
                </button>
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => void handleRemove()}>
                  {t('kb.btn.remove', lang)}
                </button>
                {/* 取消选中：右侧回到「点选一个素材」的空状态 */}
                <button type="button" className="btn btn--ghost" onClick={() => setSelectedId(null)}>
                  {t('kb.btn.clearSelection', lang)}
                </button>
              </div>
            </>
          ) : (
            <p className="muted">{t('kb.hint.selectItem', lang)}</p>
          )}
        </section>
      </div>

      {/* 帧集合逐帧编辑：先挑一帧 */}
      {frameEditProject ? (
        <div className="modal-backdrop" onClick={() => setFrameEditProject(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal__head">
              <h3>{t('kb.btn.editFrames', lang)} · {frameEditProject.name}</h3>
              <button type="button" className="btn btn--ghost" onClick={() => setFrameEditProject(null)}>
                {t('kb.btn.cancel', lang)}
              </button>
            </div>
            <p className="field__hint">{t('kb.editFrames.hint', lang)}</p>
            {frameEditProject.frameUrls.length === 0 ? (
              <p className="muted">{t('kb.editFrames.missing', lang)}</p>
            ) : (
              <div className="frame-pick-grid">
                {frameEditProject.frameUrls.map((url, index) => {
                  const fileName = frameEditProject.frameFileNames[index] ?? '';
                  return (
                    <button
                      type="button"
                      key={fileName || index}
                      className="frame-pick"
                      title={fileName}
                      onClick={() => void openFrameEditor(frameEditProject, fileName)}
                    >
                      <img src={url} alt={fileName} />
                      <span className="frame-pick__no">{index + 1}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* 编辑帧集合里的单帧：保存直接写回磁盘，不进素材库 */}
      {editingFrame ? (
        <ImageEditorModal
          image={editingFrame.image}
          onClose={() => setEditingFrame(null)}
          onApply={(pngDataUrl) => void handleFrameApply(pngDataUrl)}
        />
      ) : null}

      {editing ? (
        <ImageEditorModal
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setMessage({ kind: 'ok', text: t('kb.msg.savedEdit', lang, { name: saved.fileName }) });
            void load();
            notifyDataChanged();
          }}
        />
      ) : null}

      {/* 帧集合 / 抠图结果的播放预览（从两个新分栏点「播放预览」打开） */}
      {preview ? (
        <FramePlayerModal
          title={preview.title}
          frameUrls={preview.frameUrls}
          fps={preview.fps}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
