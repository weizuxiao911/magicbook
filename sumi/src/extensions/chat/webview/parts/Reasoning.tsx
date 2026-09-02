import React, { useState, useEffect } from 'react';

export const ReasoningView: React.FC<{ part: any; streaming?: boolean; done?: boolean }> = ({ part, done }) => {
  const text = String(part?.text || '').trim();
  // 默认展开; 用户可手动折叠; 对话完成后自动折叠
  const [open, setOpen] = useState(true);
  useEffect(() => { if (done) setOpen(false); }, [done]);

  if (!text) return null;

  return (
    <div className={`reason${open ? ' is-open' : ''}`}>
      <button type="button" className="reason__head" onClick={() => setOpen(v => !v)}>
        <span className="reason__icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </span>
        <span>思考过程</span>
        <span className="reason__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="reason__body">
          <pre>{text}</pre>
        </div>
      )}
    </div>
  );
};
