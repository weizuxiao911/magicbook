import React, { useEffect, useMemo, useRef, useState } from 'react';

interface Skill {
  name: string;
  description?: string;
  location?: string;
}

interface SkillsModalProps {
  skills: Skill[];
  onSelect: (skill: Skill) => void;
  onClose: () => void;
}

/** 技能选择弹层 — /skills 唤出, 搜索 + 键盘导航选择技能 */
export const SkillsModal: React.FC<SkillsModalProps> = ({ skills, onSelect, onClose }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
    );
  }, [skills, query]);

  useEffect(() => { setActiveIndex(0); }, [filtered.length, query]);

  // 高亮项跟随滚动进入视野
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const el = body.querySelector('.is-highlighted');
    if (!el) return;
    const bRect = body.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < bRect.top) body.scrollTop += eRect.top - bRect.top;
    else if (eRect.bottom > bRect.bottom) body.scrollTop += eRect.bottom - bRect.bottom;
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const n = filtered.length;
    if (n === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % n);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + n) % n);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const s = filtered[activeIndex];
      if (s) onSelect(s);
      return;
    }
  };

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
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>
              </span>
              技能选择
              <span className="chat__modal-count">{filtered.length} 个技能</span>
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
            onKeyDown={handleKeyDown}
            placeholder="搜索技能"
          />
        </div>

        <div className="chat__modal-body" ref={bodyRef}>
          {filtered.length === 0 && (
            <div className="chat__modal-empty">无匹配技能</div>
          )}
          {filtered.map((s, i) => (
            <div
              key={s.name}
              role="button"
              tabIndex={0}
              className={`chat__modal-item chat__skill-item${i === activeIndex ? ' is-highlighted' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelect(s)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(s); }}
            >
              <span className="chat__skill-body">
                <span className="chat__skill-name">{s.name}</span>
                {s.description && <span className="chat__skill-desc">{s.description}</span>}
                {s.location && <span className="chat__skill-loc" title={s.location}>{s.location}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
