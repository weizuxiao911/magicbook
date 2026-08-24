import React, { useEffect, useMemo, useRef, useState } from 'react';

interface SessionsModalProps {
  sessions: any[];
  currentID: string;
  onSelect: (sid: string) => void;
  onDelete: (sid: string) => void;
  onClose: () => void;
}

const GROUP_ORDER = ['今天', '昨天', '近7天', '更早'];
const DAY_MS = 86400000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupLabel(ts: number): string {
  if (!ts) return '更早';
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays <= 7) return '近7天';
  return '更早';
}

function sessionTime(s: any): number {
  return s?.time?.updated || s?.time?.created || 0;
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const SessionsModal: React.FC<SessionsModalProps> = ({
  sessions,
  currentID,
  onSelect,
  onDelete,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sessions.filter((s) => (s?.title || '').toLowerCase().includes(q))
      : sessions;
    return [...list].sort((a, b) => sessionTime(b) - sessionTime(a));
  }, [sessions, query]);

  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const s of filtered) {
      const label = groupLabel(sessionTime(s));
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(s);
    }
    return GROUP_ORDER.filter((l) => map.has(l)).map((l) => ({ label: l, items: map.get(l)! }));
  }, [filtered]);

  return (
    <div
      className="chat__modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="chat__modal" role="dialog" aria-modal="true">
        <div className="chat__modal-header">
          <div className="chat__modal-header-text">
            <div className="chat__modal-title">
              <span className="chat__modal-title-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </span>
              历史会话
              <span className="chat__modal-count">{sessions.length} 个会话</span>
            </div>
          </div>
          <div className="chat__sess-actions">
            <button type="button" className="chat__modal-back" title="关闭" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div className="chat__modal-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
            placeholder="搜索会话标题"
          />
        </div>

        <div className="chat__modal-body">
          {filtered.length === 0 && (
            <div className="chat__modal-empty">
              {sessions.length === 0 ? '暂无历史会话' : '无匹配会话'}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="chat__modal-group">
              <div className="chat__modal-group-title">{g.label} · {g.items.length}</div>
                  {g.items.map((s) => {
                const active = s.id === currentID;
                const t = sessionTime(s);
                const label = s.title || `会话 ${(s.id || '').slice(0, 8)}`;
                return (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    className={`chat__modal-item chat__sess-item${active ? ' is-active' : ''}`}
                    onClick={() => onSelect(s.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(s.id); }}
                  >
                    <span className="chat__modal-item-name" title={t ? `${label}\n${fmtTime(t)}` : label}>{label}</span>
                    {s.directory && <span className="chat__sess-dir" title={s.directory}>{s.directory}</span>}
                    <button
                      type="button"
                      className="chat__sess-del"
                      title="删除会话"
                      onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
