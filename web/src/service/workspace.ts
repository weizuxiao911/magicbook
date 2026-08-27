/**
 * 全局工作目录 manager — web/src/service/workspace.ts
 *
 * 设计: 单一变更入口 + pub/sub
 *   - getCwd()              读当前 APP_CWD
 *   - setCwd(dir)           唯一写入口: 写 APP_CWD + 记 recent + 派 workspace:changed + reload
 *   - subscribeCwd(cb)      订阅变更 (其他拓展用)
 *   - requestShowPicker()   派 workspace:request-show (chat 触发 picker 用)
 *
 * 事件流:
 *   [chat] --workspace:request-show--> [WorkspacePicker]
 *   [WorkspacePicker] --setCwd(dir)--> [workspace.ts] --workspace:changed--> [explorer/terminal/...]
 *   [workspace.ts] 内部 --location.reload()--> 重新 init 所有拓展
 *
 * 之前散落: WorkspacePicker.confirm 直接写 localStorage + reload, recent.switchToRecent
 * 同样. 现在统一走 setCwd, 任何 cwd 变更都从这一处走.
 */

import { getRecent, addRecent } from '../extensions/workspace/recent';

const APP_CWD_KEY = 'APP_CWD';

/** 读 APP_CWD, 没设则返回 '' (用 hostCwd 兜底) */
export function getCwd(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(APP_CWD_KEY) || '';
}

/**
 * 切到 dir. 唯一变更入口.
 * - 写 APP_CWD
 * - 加 recent
 * - 派 workspace:changed
 * - 刷新页面 (reload 让所有拓展重新 init; 后续可改 in-place 增量更新)
 */
export function setCwd(dir: string): void {
  if (!dir) return;
  const prev = getCwd();
  if (prev === dir) return;
  localStorage.setItem(APP_CWD_KEY, dir);
  addRecent(dir);
  // 派事件 (reload 前通知, 让在挂拓展有机会保存状态)
  notifyChanged(dir, prev);
  // 刷新: 简方案, 后续切 in-place 时再去掉
  window.location.reload();
}

/** 订阅 cwd 变更, 返回 unsubscribe. cb(newCwd, oldCnd) */
export function subscribeCwd(cb: (next: string, prev: string) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ next: string; prev: string }>).detail;
    if (detail) cb(detail.next, detail.prev);
  };
  window.addEventListener('workspace:changed', handler);
  return () => window.removeEventListener('workspace:changed', handler);
}

function notifyChanged(next: string, prev: string): void {
  window.dispatchEvent(new CustomEvent('workspace:changed', { detail: { next, prev } }));
}

/** chat 触发 WorkspacePicker 用 */
export function requestShowPicker(): void {
  window.dispatchEvent(new CustomEvent('workspace:request-show'));
}
