/**
 * infra/os.ts — 平台检测抽象
 *
 * 所有 OS-specific 判断 (Windows / Mac / Linux / 未知) 都收敛到这里.
 * service / extensions / config 层严禁直接 `navigator.userAgent.includes('Mac')` 这种散落判断,
 * 一律 `import { getPlatform, isWindows, isMac, userHome } from '@/infra/os'`.
 *
 * 跨平台要点:
 *   - 浏览器 UA 检测足够稳定 (无 node:process 可用, 走 navigator.userAgent)
 *   - USERPROFILE (Windows) / HOME (POSIX) → userHome() 统一兜底硬编码常见值
 *   - 跨域 cross-platform: 代码不依赖 OS 特定路径, 路径处理走 infra/path
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'unknown';

let _cached: Platform | null = null;

/** 检测宿主平台 (浏览器内, 走 navigator.userAgent). 跨调用缓存。 */
export function getPlatform(): Platform {
  if (_cached) return _cached;
  _cached = detectPlatform();
  return _cached;
}

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

export function isWindows(): boolean {
  return getPlatform() === 'windows';
}

export function isMac(): boolean {
  return getPlatform() === 'mac';
}

export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

/** 用户 home dir 跨平台 fallback.
 *  浏览器内无 process.env.USERPROFILE/HOME 时按平台常见值兜底.
 *  实际生产路径应优先从后端注入 (服务端拿的 cwd 才能真实反映 host cwd). */
export function userHome(): string {
  if (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.userHome) {
    return (window as any).__APP_CONFIG__.userHome;
  }
  if (isWindows()) return 'C:\\Users\\Public';
  if (isMac()) return '/Users';
  if (isLinux()) return '/home';
  return '/';
}