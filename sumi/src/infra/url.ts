/**
 * infra/url.ts — URL / URI helpers
 *
 * 工作空间 (workspace) + opencode baseUrl + secure URL 升级 + workspace 订阅等小工具集中.
 * 工作目录唯一 source-of-truth = URL `?directory=` (不读 __APP_CONFIG__.cwd —
 * 它是 opencode 进程启动 workdir, 切 workspace 不更新会 stale).
 */

import { normalizeCwdPath } from './path';

/** opencode serve 地址 (去尾 /, 直连无中间层).
 *  来源: window.__APP_CONFIG__.appBaseUrl. '/' → window.location.origin; 显式 → 直连. */
export function appBaseUrl(): string {
  const injected = (typeof window !== 'undefined' ? (window as any).__APP_CONFIG__?.appBaseUrl : '') || '';
  if (injected === '/') {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/+$/, '');
    }
    return '';
  }
  return injected.replace(/\/+$/, '');
}

/** 读 URL `?directory=` query 参数 (显式 source, 优先于 localStorage). 跨平台: 路径 normalize 后返回. */
export function urlWorkspace(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = new URL(window.location.href).searchParams.get('directory');
    return raw ? normalizeCwdPath(raw) : '';
  } catch {
    return '';
  }
}

/** 当前工作空间 (workspace) 路径: 仅 URL `?directory=` (source-of-truth, 切 workspace 即变).
 *  不读 __APP_CONFIG__.cwd (opencode 进程启动 workdir, 切目录不更新 → stale).
 *  URL 缺失 (首启 splash 阶段) 返回 '' — 由 ensureUrlWorkspace/initRuntime 探测后补 URL + reload. */
export function getWorkspace(): string {
  return urlWorkspace();
}

/** @deprecated 历史别名, 新代码用 getWorkspace. */
export const effectiveCwd = getWorkspace;

/** x-opencode-directory header: per-request 工作空间切换 (铁律 8: 走 raw path, 不 encodeURI).
 *  server 端 defaultDirectory 防御性 decodeURIComponent (防御旧 client / 中间代理 encode).
 *  Windows 路径绝不带 '/' 前缀 (server 端按 POSIX 根解析会 500/错目录). */
export function workspaceHeader(): Record<string, string> {
  const ws = normalizeCwdPath(getWorkspace());
  return ws ? { 'x-opencode-directory': ws } : {};
}

/** @deprecated cwdHeader 别名 (新代码用 workspaceHeader). */
export const cwdHeader = workspaceHeader;

/** 错误是否表示 "路径不存在" (ENOENT / not found / no such file).
 *  用于 stale APP_CWD 检测分流:
 *    - 真删: 重置 APP_CWD + reload
 *    - 其他 (connection / timeout / 5xx): 短暂不可用, 保留 APP_CWD
 *  跨 opencode SDK / node fs / shell 错误信息匹配. */
export function isPathNotFoundError(e: any): boolean {
  const msg = (e?.message || e?.err || String(e || '')).toString();
  return /not\s*found|ENOENT|no\s*such\s*file|cannot\s*find|路径不存在/i.test(msg);
}

/** URL 协议升级: 页面 https 时, http→https / ws→wss (mixed content 浏览器拒绝)
 *  单一 helper, 所有自建 ws/sse 入口统一走, 避免散落 */
export function secureUrl(url: string): string {
  if (typeof window === 'undefined' || !url) return url;
  if (window.location.protocol !== 'https:') return url;
  return url.replace(/^http:/i, 'https:').replace(/^ws:/i, 'wss:');
}

/** 订阅 workspace 变更事件 (CustomEvent 'workspace:changed', detail = {next, prev}).
 *  派发方: setWorkspace (state/state.service 或调用方).
 *  返回 unsubscribe. */
export function subscribeWorkspace(cb: (next: string, prev: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ next: string; prev: string }>).detail;
    if (detail) cb(detail.next, detail.prev);
  };
  window.addEventListener('workspace:changed', handler);
  return () => window.removeEventListener('workspace:changed', handler);
}

/** @deprecated cwd 别名. */
export const subscribeCwd = subscribeWorkspace;

/** 派 workspace 变更事件 (state service 或 setWorkspace 调用). */
export function emitWorkspaceChanged(next: string, prev: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('workspace:changed', { detail: { next, prev } }));
}

/** @deprecated emitCwdChanged 别名. */
export const emitCwdChanged = emitWorkspaceChanged;