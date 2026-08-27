/**
 * 最近工作目录 (本地存储) — web/src/extensions/workspace/recent.ts
 *
 * - localStorage key: WORKSPACE_RECENT, value: JSON string[] of cwd paths
 * - 最多 5 条, 最新在前; 重复路径移动到首位
 * - 切换目录时 (WorkspacePicker 确认 / 下拉框点击最近项) 调用 addRecent 记录
 * - 下拉框 (ActionsView 顶部) 调用 getRecent 展示快速切换
 *
 * 与 WorkspacePicker 一致: 切换路径 = localStorage.setItem('APP_CWD', dir)
 *   + window.location.reload() (opencode/fs/agent 全部 reload 后重连)
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

/** 把 dir 放到第 1 位; 已存在则去重后前移; 超过 MAX 截断 */
export function addRecent(dir: string): string[] {
  if (!dir) return read();
  const next = [dir, ...read().filter((p) => p !== dir)].slice(0, MAX);
  write(next);
  // 通知所有监听者 (ActionsView 等) 刷新 UI
  window.dispatchEvent(new CustomEvent('workspace:recent-changed', { detail: next }));
  return next;
}

/** 切换到指定 dir: 写 APP_CWD + 记录 recent + 刷新页面 (跟 WorkspacePicker 流程一致) */
export function switchToRecent(dir: string): void {
  if (!dir) return;
  addRecent(dir);
  localStorage.setItem('APP_CWD', dir);
  window.location.reload();
}
