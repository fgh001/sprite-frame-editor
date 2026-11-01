import { useEffect, useRef, useState } from 'react';
import type { AssistantMessage } from '@shared/ipc';
import { t, useLang } from '../i18n';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

interface AssistantPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 右侧 AI 助手（问答窗口）：走「文本 / 推理」槽位同一个模型。
 * 历史由前端维护，每次整段发过去（后端会截取最近 20 条）。
 *
 * 开关状态由 App 持有 —— 顶栏的「AI 助手」按钮和这里的收起按钮共用同一个状态，
 * 这样不管面板是开是关，用户都有一个显眼的入口。
 */
export function AssistantPanel({ open, onOpenChange }: AssistantPanelProps): React.JSX.Element {
  const [lang] = useLang();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  // 新消息后滚到底
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries, busy]);

  // 展开后自动聚焦输入框
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatEntry[] = [...entries, { role: 'user', content: text }];
    setEntries(next);
    setInput('');
    setBusy(true);

    const payload: AssistantMessage[] = next
      .filter((entry) => !entry.error)
      .map((entry) => ({ role: entry.role, content: entry.content }));
    const res = await window.skeletonElf.assistant.chat(payload);
    setBusy(false);
    if (!res.ok) {
      setEntries((prev) => [...prev, { role: 'assistant', content: res.error, error: true }]);
      return;
    }
    setModel(res.data.model);
    setEntries((prev) => [...prev, { role: 'assistant', content: res.data.reply }]);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="assistant-rail"
        onClick={() => onOpenChange(true)}
        title={t('ap.openTitle', lang)}
      >
        <span className="assistant-rail__hint">{t('ap.title', lang)}</span>
      </button>
    );
  }

  return (
    <aside className="assistant">
      <header className="assistant__head">
        <div>
          <strong>{t('ap.title', lang)}</strong>
          <span className="assistant__model">{model || t('ap.modelFallback', lang)}</span>
        </div>
        <div className="assistant__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setEntries([])}
            disabled={entries.length === 0 || busy}
          >
            {t('ap.clear', lang)}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onOpenChange(false)}
            title={t('ap.collapseTitle', lang)}
          >
            ›
          </button>
        </div>
      </header>

      <div className="assistant__list" ref={listRef}>
        {entries.length === 0 ? (
          <p className="muted assistant__empty">
            {t('ap.empty', lang)
              .split('\n')
              .map((line, index) => (
                <span key={line}>
                  {index > 0 ? <br /> : null}
                  {line}
                </span>
              ))}
          </p>
        ) : (
          entries.map((entry, index) => (
            <div
              key={index}
              className={`assistant__bubble assistant__bubble--${entry.role}${entry.error ? ' is-error' : ''}`}
            >
              {entry.content}
            </div>
          ))
        )}
        {busy ? (
          <div className="assistant__bubble assistant__bubble--assistant">{t('ap.thinking', lang)}</div>
        ) : null}
      </div>

      <div className="assistant__input">
        <textarea
          ref={inputRef}
          className="input textarea"
          rows={3}
          value={input}
          placeholder={t('ap.inputPlaceholder', lang)}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={busy || !input.trim()}>
            {busy ? t('ap.sending', lang) : t('ap.send', lang)}
          </button>
        </div>
      </div>
    </aside>
  );
}
