import React, { useMemo, useState, useEffect } from 'react';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: string;
}

export function extractAssistantTodos(value: any): TodoItem[] {
  if (!value) return [];
  let arr: any = null;
  if (Array.isArray(value)) arr = value;
  else if (Array.isArray(value?.todos)) arr = value.todos;
  else if (Array.isArray(value?.data)) arr = value.data;
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const items: TodoItem[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const content = (e as any).content;
    const status = (e as any).status;
    const priority = (e as any).priority;
    if (typeof content !== 'string' || content.trim().length === 0) continue;
    const normalizedStatus: TodoItem['status'] =
      status === 'completed' || status === 'in_progress' || status === 'pending' || status === 'cancelled'
        ? status
        : 'pending';
    items.push({
      content: content.trim(),
      status: normalizedStatus,
      priority: typeof priority === 'string' ? priority.trim().toLowerCase() : undefined,
    });
  }
  return items;
}

export function findTodosInPart(part: any): TodoItem[] {
  const candidates = [
    part?.state?.output,
    part?.state?.input,
    part?.state?.metadata?.todos,
    part?.state?.metadata,
    part?.state?.raw,
  ];
  for (const c of candidates) {
    const list = extractAssistantTodos(c);
    if (list.length > 0) return list;
  }
  if (typeof part?.state?.output === 'string') {
    try {
      const parsed = JSON.parse(part.state.output);
      const list = extractAssistantTodos(parsed);
      if (list.length > 0) return list;
    } catch { /* noop */ }
  }
  return [];
}

export const TodoCard: React.FC<{ part: any; done?: boolean }> = ({ part, done }) => {
  const todos = useMemo(() => {
    // 官方 (packages/web part.tsx TodoWriteTool): state.input.todos, 排序 in_progress→pending→completed
    const priority: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };
    const raw = findTodosInPart(part);
    return [...raw].sort((a, b) => priority[a.status] - priority[b.status]);
  }, [part]);
  const toolStatus: string = part?.state?.status || 'pending';
  const starting = todos.length > 0 && todos.every((t) => t.status === 'pending');
  const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed' || t.status === 'cancelled');
  const allCancelled = todos.length > 0 && todos.every((t) => t.status === 'cancelled');
  const title = allCancelled ? '已取消计划' : allDone ? '完成计划' : starting ? '创建计划' : '更新计划';
  const stats = useMemo(() => {
    let total = todos.length, completed = 0, inProgress = 0, cancelled = 0;
    for (const t of todos) {
      if (t.status === 'completed') completed += 1;
      else if (t.status === 'cancelled') cancelled += 1;
      else if (t.status === 'in_progress') inProgress += 1;
    }
    return { total, completed, inProgress, cancelled };
  }, [todos]);
  const [open, setOpen] = useState(true);
  // 对话完成后自动折叠
  useEffect(() => { if (done) setOpen(false); }, [done]);

  if (todos.length === 0) {
    return (
      <div className="todo todo--empty">
        <span className="todo__icon todo__icon--spin">◐</span>
        <span>正在规划任务...</span>
      </div>
    );
  }

  return (
    <div className={`todo${open ? ' is-open' : ''}`}>
      <button type="button" className="todo__head" onClick={() => setOpen((v) => !v)}>
        <span className={`todo__status todo__status--${toolStatus}`}>
          {toolStatus === 'completed' ? '✓' : toolStatus === 'running' ? '◐' : '○'}
        </span>
        <span className="todo__title">
          {`${title} ${stats.completed}/${stats.total}`}
          {stats.inProgress > 0 ? ` · ${stats.inProgress} 进行中` : ''}
          {stats.cancelled > 0 ? ` · ${stats.cancelled} 已取消` : ''}
        </span>
        <span className="todo__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ol className="todo__list">
          {todos.map((t, i) => (
            <li key={i} className={`todo__item is-${t.status}`}>
              <span className="todo__check">
                {t.status === 'completed' ? '✓' : t.status === 'cancelled' ? '✕' : t.status === 'in_progress' ? '◐' : (i + 1)}
              </span>
              <span className="todo__content">{t.content}</span>
              {t.priority && t.priority !== 'medium' && (
                <span className={`todo__pri is-${t.priority}`}>{t.priority}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
