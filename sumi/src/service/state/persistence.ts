/**
 * service/state/persistence.ts
 *
 * localStorage 持久化 adapter.
 * 当前 storage: 'WORKSPACE_RECENT' (JSON string[] cwd paths).
 *
 * 后续重设计: 替换为 IndexedDB / 服务器, 持久化层 abstraction 保持不变.
 */

const KEY = 'WORKSPACE_RECENT';

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch { /* quota / privacy mode */ }
}