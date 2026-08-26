import React, { useState } from 'react';

export const TodosDock: React.FC<{
  todos: Array<{ content: string; status: string; priority?: string }>;
}> = ({ todos }) => {
  const [collapsed, setCollapsed] = useState(false);
  const completed = todos.filter((t) => t.status === 'completed').length;
  const cancelled = todos.filter((t) => t.status === 'cancelled').length;
  const total = todos.length;
  return (
    <div className={`chat__todos-dock${collapsed ? ' is-collapsed' : ''}`}>
      <div className="chat__todos-head" onClick={() => setCollapsed((v) => !v)}>
        <span className="chat__todos-title">
          已完成 {completed} · 已取消 {cancelled}（共 {total} 个）
        </span>
        <span className="chat__todos-caret">{collapsed ? '▾' : '▴'}</span>
      </div>
      {!collapsed && (
        <ul className="chat__todos-list">
          {todos.map((t, i) => (
            <li key={i} className={`chat__todo-item is-${t.status}`}>
              <span className="chat__todo-check" aria-hidden="true">
                {t.status === 'completed' ? '●' : t.status === 'in_progress' ? '◐' : t.status === 'cancelled' ? '✕' : '○'}
              </span>
              <span className="chat__todo-content">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};