/**
 * env — 单一事实源: 运行环境能力 + 全局 helper
 *
 * 三组 helper, 全部 export, 业务代码统一 import 此处:
 *   - appBaseUrl():  opencode serve 地址 (去尾 /, 直连, 无中间层)
 *   - effectiveCwd(): 当前有效工作目录 (APP_CWD 优先 → __APP_CONFIG__.cwd 兜底)
 *   - cwdHeader():   x-opencode-directory header (encodeURI 防 CJK 破 ISO-8859-1)
 *
 * EnvServiceImpl 内部用同一组 helper, 保持 class 接口兼容老调用.
 *
 * 历史教训: 之前 helper 散落 6+ 文件, agent/fs/terminal/fs-pty/WorkspacePicker/Chat 各自复制.
 * 漏一处就报 "String contains non ISO-8859-1" → 统一在此, 改一处生效全部.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { IEnvService, Platform } from '../commands/env';
import { EnvToken } from '../commands/env';

// ---- 共享 helper (纯函数, 全局唯一) ----

/** opencode serve 地址 (appBaseUrl 直连; 去尾 /) */
export function appBaseUrl(): string {
  return ((typeof window !== 'undefined' ? (window as any).__APP_CONFIG__?.appBaseUrl : '') || '').replace(/\/+$/, '');
}

/** 当前有效工作目录: APP_CWD (用户选择) → __APP_CONFIG__.cwd (initRuntime 注入的 hostCwd) → '' */
export function effectiveCwd(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('APP_CWD') || ((typeof window !== 'undefined' ? (window as any).__APP_CONFIG__?.cwd : '') || '');
}

/** x-opencode-directory header: per-request 工作目录切换; encodeURI 防中文路径破 ISO-8859-1 */
export function cwdHeader(): Record<string, string> {
  const cwd = effectiveCwd();
  return cwd ? { 'x-opencode-directory': encodeURI(cwd) } : {};
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
    if (p) {
      if (/win/i.test(p)) return 'windows';
      if (/mac/i.test(p)) return 'mac';
      if (/linux/i.test(p)) return 'linux';
    }
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
