/**
 * env + workspace — service/env.ts
 *
 * 合并: 单一事实源: 运行环境能力 + 全局 helper + 工作目录 manager
 *
 * env 三组 helper, 业务代码统一 import 此处:
 *   - appBaseUrl():  opencode serve 地址 (去尾 /, 直连, 无中间层)
 *   - effectiveCwd(): 当前有效工作目录 (APP_CWD 优先 → __APP_CONFIG__.cwd 兜底)
 *   - cwdHeader():   x-opencode-directory header (encodeURI 防 CJK 破 ISO-8859-1)
 *   - secureUrl():   https 页面下 http→https / ws→wss (mixed content 浏览器拒绝)
 *
 * workspace 单一变更入口 + pub/sub:
 *   - getCwd()           读当前 APP_CWD
 *   - setCwd(dir)        唯一写入口: 写 APP_CWD + 记 recent + 派 workspace:changed + reload
 *   - subscribeCwd(cb)   订阅变更
 *   - requestShowPicker() 派 workspace:request-show (chat 触发 picker)
 *
 * EnvServiceImpl / EnvModule 保留, 跟 IFileSystem 等 token 配合, 兼容老调用.
 *
 * 历史教训: 之前 helper 散落 6+ 文件, agent/fs/terminal/fs-pty/WorkspacePicker/Chat 各自复制.
 * 漏一处就报 "String contains non ISO-8859-1" → 统一在此, 改一处生效全部.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { IEnvService, Platform } from '../commands/env';
import { EnvToken } from '../commands/env';
import { getRecent, addRecent } from '../extensions/workspace/recent';

// ---- 共享 helper (纯函数, 全局唯一) ----

/** opencode serve 地址 (appBaseUrl 直连; 去尾 /) */
export function appBaseUrl(): string {
  const injected = (typeof window !== 'undefined' ? (window as any).__APP_CONFIG__?.appBaseUrl : '') || '';
  // '/' (同源默认) → 用页面 origin; 显式地址 → 直连
  if (injected === '/') {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/+$/, '');
    }
    return '';
  }
  return injected.replace(/\/+$/, '');
}

/** Windows 盘符格式判定: 'D:' / 'D:\...' / 'D:/...' (含带前导 '/' 的 '/D:/...' 错误形态) */
function isWindowsDrivePath(p: string): boolean {
  return /^\/?[A-Za-z]:/.test(p);
}

/** 工作目录规范化 (发送 header / 写 APP_CWD 前统一走):
 *  - Windows 盘符: 去前导 '/' (/D:/Work → D:/Work), 反斜杠转正斜杠 (D:\Work → D:/Work)
 *    (server 端 path.win32 能处理; 前导 '/' 会让 server 按 POSIX 根解析 → 500/错目录)
 *  - POSIX (/Users/...): 原样
 */
export function normalizeCwdPath(p: string): string {
  if (!p) return p;
  const s = p.replace(/\\/g, '/');
  if (isWindowsDrivePath(s)) return s.replace(/^\/+/, '');
  return s;
}

/** 当前有效工作目录: APP_CWD (用户选择) → __APP_CONFIG__.cwd (initRuntime 注入的 hostCwd) → '' */
export function effectiveCwd(): string {
  if (typeof localStorage === 'undefined') return '';
  const raw = localStorage.getItem('APP_CWD') || ((typeof window !== 'undefined' ? (window as any).__APP_CONFIG__?.cwd : '') || '');
  return normalizeCwdPath(raw);
}

/** x-opencode-directory header: per-request 工作目录切换; encodeURI 防中文路径破 ISO-8859-1
 *  盘符路径绝不带 '/' 前缀 (server 端按 POSIX 根解析会 500/错目录) */
export function cwdHeader(): Record<string, string> {
  const cwd = normalizeCwdPath(effectiveCwd());
  return cwd ? { 'x-opencode-directory': encodeURI(cwd) } : {};
}

/** 错误是否表示 "路径不存在" (ENOENT / not found / no such file)
 *  用于 stale APP_CWD 检测分流:
 *    - 真删: 重置 APP_CWD + reload
 *    - 其他 (connection / timeout / 5xx): 短暂不可用, 保留 APP_CWD
 *  跨 opencode SDK / node fs / shell 错误信息匹配. */
export function isPathNotFoundError(e: any): boolean {
  const msg = (e?.message || e?.err || String(e || '')).toString();
  return /not\s*found|ENOENT|no\s*such\s*file|cannot\s*find|路径不存在/i.test(msg);
}

/**
 * URL 协议升级: 页面 https 时, http→https / ws→wss (mixed content 浏览器拒绝)
 * 单一 helper, 所有自建 ws/sse 入口统一走, 避免散落
 */
export function secureUrl(url: string): string {
  if (typeof window === 'undefined' || !url) return url;
  if (window.location.protocol !== 'https:') return url;
  return url.replace(/^http:/i, 'https:').replace(/^ws:/i, 'wss:');
}

// ---- platform 探测 (兼容老 API) ----

let _cachedPlatform: Platform | null = null;

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  try {
    const uaData: any = (navigator as any).userAgentData;
    const p: string = typeof uaData?.platform === 'string' ? uaData.platform : '';
    if (/win/i.test(p)) return 'windows';
    if (/mac/i.test(p)) return 'mac';
    if (/linux/i.test(p)) return 'linux';
  } catch { /* ignore */ }
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'mac';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'unknown';
}

// ---- IEnvService 实现 (兼容历史; class 内复用上面 helper) ----

@Injectable()
export class EnvServiceImpl implements IEnvService {
  static instance: EnvServiceImpl | null = null;

  private _cwd: string | null = null;

  getPlatform(): Platform {
    if (!_cachedPlatform) _cachedPlatform = detectPlatform();
    return _cachedPlatform;
  }

  isWindows(): boolean {
    return this.getPlatform() === 'windows';
  }

  isMac(): boolean {
    return this.getPlatform() === 'mac';
  }

  async getCwd(): Promise<string> {
    if (this._cwd) return this._cwd;
    const cwd = effectiveCwd();
    if (cwd) {
      this._cwd = cwd;
      return cwd;
    }
    return '/workspace';
  }

  getCwdSync(): string | null {
    if (this._cwd) return this._cwd;
    const cwd = effectiveCwd();
    if (cwd) {
      this._cwd = cwd;
      return cwd;
    }
    return null;
  }
}

/** 模块级单例 getter */
export function getEnvService(): IEnvService {
  return EnvServiceImpl.instance || (EnvServiceImpl.instance = new EnvServiceImpl());
}

@Injectable()
export class EnvModule extends BrowserModule {
  providers = [{ token: EnvToken, useFactory: () => getEnvService() }];
}

// ---- workspace manager (合并自 service/workspace.ts) ----

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
  const norm = normalizeCwdPath(dir);
  if (!norm) return;
  const prev = getCwd();
  if (prev === norm) return;
  localStorage.setItem(APP_CWD_KEY, norm);
  addRecent(norm);
  // 派事件 (reload 前通知, 让在挂拓展有机会保存状态)
  notifyChanged(norm, prev);
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

/**
 * 启动时应用 URL `?directory=` 作为工作目录 (访问携带 query 参数时, 将该路径作为工作目录).
 * - 有 `?directory=` → normalizeCwdPath 后 setCwd (写 APP_CWD + reload 一次)
 * - setCwd 内部 `prev === norm` 幂等 → 同值不 reload, 无死循环
 * - 无 query / 已同值 → 不动作
 */
export function applyUrlDirectory(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    const raw = new URL(window.location.href).searchParams.get('directory');
    if (!raw) return;
    setCwd(raw);
  } catch { /* ignore */ }
}

function notifyChanged(next: string, prev: string): void {
  window.dispatchEvent(new CustomEvent('workspace:changed', { detail: { next, prev } }));
}

/** chat 触发 WorkspacePicker 用 */
export function requestShowPicker(): void {
  window.dispatchEvent(new CustomEvent('workspace:request-show'));
}
