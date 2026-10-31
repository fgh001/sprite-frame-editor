import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EditableImage, KnowledgeView } from '@shared/ipc';
import { ImageEditorModal } from '../components/ImageEditorModal';

type Filter = 'all' | 'image' | 'video';

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
  const [items, setItems] = useState<KnowledgeView[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [tagInput, setTagInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [editing, setEditing] = useState<EditableImage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await window.skeletonElf.knowledge.list();
    setLoading(false);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setItems(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  useEffect(() => {
    if (!selected) {
      setTagInput('');
      setNoteInput('');
      return;
    }
    setTagInput(selected.tags.join(', '));
    setNoteInput(selected.note);
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
    const parts = [`导入 ${imported} 个`];
    if (skippedDuplicates > 0) parts.push(`跳过重复 ${skippedDuplicates} 个`);
    if (skippedUnsupported > 0) parts.push(`跳过不支持 ${skippedUnsupported} 个`);
    setMessage({ kind: imported > 0 ? 'ok' : 'err', text: parts.join('，') });
    await load();
  };

  const applyUpdate = async (patch: { tags?: string[]; note?: string; asReference?: boolean }): Promise<void> => {
    if (!selected) return;
    setSaving(true);
    const res = await window.skeletonElf.knowledge.update({ id: selected.id, ...patch });
    setSaving(false);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setItems((prev) => prev.map((item) => (item.id === res.data.id ? res.data : item)));
  };

  const handleSaveMeta = async (): Promise<void> => {
    await applyUpdate({
      tags: tagInput
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      note: noteInput,
    });
    setMessage({ kind: 'ok', text: '已保存标签与备注' });
  };

  const handleRemove = async (): Promise<void> => {
    if (!selected) return;
    const confirmText = [
      `确定从素材库删除「${selected.fileName}」？`,
      '',
      '只会删除素材库里的副本（data/knowledge/files 下的文件）与缩略图。',
      '你电脑上的原始文件不受影响。',
    ].join('\n');
    if (!window.confirm(confirmText)) return;
    const res = await window.skeletonElf.knowledge.remove(selected.id);
    if (!res.ok) {
      setMessage({ kind: 'err', text: res.error });
      return;
    }
    setSelectedId(null);
    setMessage({ kind: 'ok', text: '已删除' });
    await load();
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

  const visible = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (!key) return true;
      return (
        item.fileName.toLowerCase().includes(key) ||
        item.note.toLowerCase().includes(key) ||
        item.tags.some((tag) => tag.toLowerCase().includes(key))
      );
    });
  }, [items, filter, keyword]);

  const counts = useMemo(
    () => ({
      all: items.length,
      image: items.filter((item) => item.kind === 'image').length,
      video: items.filter((item) => item.kind === 'video').length,
      reference: items.filter((item) => item.asReference).length,
    }),
    [items],
  );

  return (
    <div className="settings-layout">
      <div className="stack">
        <section className="card">
          <div className="card__head">
            <h2>素材库（{counts.all} 个素材）</h2>
          </div>

          <div className="kb-toolbar">
            <div className="kb-filters">
              {(
                [
                  ['all', `全部 ${counts.all}`],
                  ['image', `图片 ${counts.image}`],
                  ['video', `视频 ${counts.video}`],
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
              placeholder="搜索文件名 / 标签 / 备注"
              onChange={(event) => setKeyword(event.target.value)}
            />
            <div className="kb-toolbar__actions">
              <button type="button" className="btn btn--primary" onClick={() => void handleImport()}>
                导入图片 / 视频
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
                {loading ? '刷新中…' : '刷新'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={onOpenDataDir}>
                打开数据目录
              </button>
            </div>
          </div>

          <p className="field__hint">
            已标记为参考素材：{counts.reference} 个 · 导入是<b>拷贝</b>：会复制一份到项目目录{' '}
            <code>data/knowledge/files</code> 并按内容去重，你原文件的位置和内容都不变
          </p>

          {message ? <div className={`banner banner--${message.kind}`}>{message.text}</div> : null}

          {visible.length === 0 ? (
            <div className="kb-empty">
              <p className="muted">
                {items.length === 0
                  ? '还没有素材。点右上角「导入图片 / 视频」，把散落在其他文件夹的参考图、设定图、参考视频压进来。'
                  : '当前筛选条件下没有素材。'}
              </p>
            </div>
          ) : (
            <div className="studio-grid">
              {visible.map((item) => (
                <figure
                  key={item.id}
                  className={`studio-item kb-card${selectedId === item.id ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.kind === 'video' ? (
                    <video className="kb-card__media" src={item.mediaUrl} muted preload="metadata" />
                  ) : item.thumbUrl ? (
                    <img src={item.thumbUrl} alt={item.fileName} />
                  ) : (
                    <div className="studio-item__placeholder">无缩略图</div>
                  )}
                  <figcaption>
                    <span>
                      {item.kind === 'video' ? '视频' : '图片'}
                      {item.width && item.height ? ` · ${item.width}×${item.height}` : ''} · {formatBytes(item.bytes)}
                    </span>
                    <span className={`tag ${item.source === 'ai-generated' ? 'tag--ok' : ''}`}>
                      {item.source === 'ai-generated' ? 'AI 生成' : '外部导入'}
                    </span>
                    {item.asReference ? <span className="tag tag--warn">AI 参考</span> : null}
                    {item.tags.length > 0 ? <code>{item.tags.join(' · ')}</code> : null}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="stack">
        <section className="card">
          <h2>素材详情</h2>
          {selected ? (
            <>
              {selected.kind === 'image' && selected.thumbUrl ? (
                <img className="kb-detail__preview" src={selected.thumbUrl} alt={selected.fileName} />
              ) : null}
              {selected.kind === 'video' ? (
                <video className="kb-detail__preview" src={selected.mediaUrl} controls preload="metadata" />
              ) : null}

              <div className="balance-extra">
                <div>
                  <span>类型</span>
                  <strong>{selected.kind === 'video' ? '视频' : '图片'}</strong>
                </div>
                <div>
                  <span>大小</span>
                  <strong>{formatBytes(selected.bytes)}</strong>
                </div>
                <div>
                  <span>尺寸</span>
                  <strong>{selected.width && selected.height ? `${selected.width}×${selected.height}` : '—'}</strong>
                </div>
              </div>

              <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                {selected.fileName} · {formatDate(selected.createdAt)}
                {selected.origin?.model ? ` · 模型 ${selected.origin.model}` : ''}
              </p>

              <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                素材库副本：<code>{selected.absPath}</code>
              </p>
              {selected.importedFrom ? (
                <p className="field__hint" style={{ wordBreak: 'break-all' }}>
                  原始位置（不受删除影响）：<code>{selected.importedFrom}</code>
                </p>
              ) : null}

              <label className="field">
                <span className="field__label">标签（逗号或空格分隔）</span>
                <input
                  className="input"
                  value={tagInput}
                  placeholder="例如：立绘, 精灵, 厚涂"
                  onChange={(event) => setTagInput(event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">备注</span>
                <input
                  className="input"
                  value={noteInput}
                  placeholder="例如：这张用来约束画风"
                  onChange={(event) => setNoteInput(event.target.value)}
                />
              </label>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.asReference}
                  onChange={(event) => void applyUpdate({ asReference: event.target.checked })}
                />
                作为 AI 生成时的参考素材
              </label>

              <div className="actions">
                <button type="button" className="btn btn--primary" onClick={() => void handleSaveMeta()} disabled={saving}>
                  {saving ? '保存中…' : '保存标签与备注'}
                </button>
                {selected.kind === 'image' ? (
                  <button type="button" className="btn btn--ghost" onClick={() => void handleEdit()}>
                    编辑 / 去背景
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    void window.skeletonElf.files.reveal(selected.absPath);
                  }}
                >
                  定位文件
                </button>
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => void handleRemove()}>
                  删除
                </button>
              </div>

              {selected.origin?.prompt ? (
                <p className="muted field__hint">生成提示词：{selected.origin.prompt}</p>
              ) : null}
            </>
          ) : (
            <p className="muted">在左侧点选一个素材，这里会显示它的详情、标签与参考设置。</p>
          )}
        </section>
      </div>

      {editing ? (
        <ImageEditorModal
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setMessage({ kind: 'ok', text: `已保存编辑结果：${saved.fileName}` });
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
