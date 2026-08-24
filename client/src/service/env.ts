/**
 * env 实现 — service/env/index.ts
 *
 * implements core/commands/env 的 IEnvService: 运行环境能力.
 * getCwd 来自 sandbox runtime 的 cwd（server 返回, 平台无关）.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { IEnvService, Platform } from '../core/commands/env';
import { EnvToken } from '../core/commands/env';

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
    // 来自 sandbox runtime（登录后 applyRuntime 写入全局配置）
    if (this._cwd) return this._cwd;
    const runtime = (window as any).__APP_SANDBOX__?.getRuntime?.();
    if (runtime?.cwd) {
      this._cwd = runtime.cwd;
      return runtime.cwd;
    }
    return '/workspace';
  }

  getCwdSync(): string | null {
    if (this._cwd) return this._cwd;
    const runtime = (window as any).__APP_SANDBOX__?.getRuntime?.();
    if (runtime?.cwd) {
      this._cwd = runtime.cwd;
      return runtime.cwd;
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