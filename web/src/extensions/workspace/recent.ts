/**
 * 最近工作目录 (本地存储) — web/src/extensions/workspace/recent.ts
 *
 * - localStorage key: WORKSPACE_RECENT, value: JSON string[] of cwd paths
 * - 最多 5 条, 最新在前; 重复路径移动到首位
 * - 唯一变更入口在 service/workspace.ts: setCwd() 内部 addRecent 后写 APP_CWD + reload
 * - UI 层 (chat 选择器等) 只读 getRecent 展示
 *
 * 不再提供 switchToRecent — 切目录统一走 setCwd, 避免散落变更入口
 */

const KEY = 'WORKSPACE_RECENT';
const MAX = 5;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota / privacy mode */ }
}

export function getRecent(): string[] {
  return read();
}

/** 把 dir 放到第 1 位; 已存在则去重后前移; 超过 MAX 截断.
 *  仅 service/workspace.setCwd 内部调用, 外部 UI 不应直接调. */
export function addRecent(dir: string): string[] {
  if (!dir) return read();
  const next = [dir, ...read().filter((p) => p !== dir)].slice(0, MAX);
  write(next);
  window.dispatchEvent(new CustomEvent('workspace:recent-changed', { detail: next }));
  return next;
}

/** 从最近列表移除 dir (UI × 按钮调用). 返回更新后列表. */
export function removeRecent(dir: string): string[] {
  if (!dir) return read();
  const next = read().filter((p) => p !== dir);
  write(next);
  window.dispatchEvent(new CustomEvent('workspace:recent-changed', { detail: next }));
  return next;
}
