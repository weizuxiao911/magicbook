/**
 * infra/host.ts — 宿主真实路径锚点 (opencode /path 接口为唯一事实源)
 *
 * 铁律: 发往 opencode 的任何路径 (x-opencode-directory header / pty cwd / fs path)
 * 必须锚定到 /path 接口响应的真实宿主路径:
 *   directory — 当前工作目录
 *   home      — 用户家目录
 * codeblitz 虚拟路径 (/home, /workspace, /home/AppData/Roaming) 一律先经
 * infra/path.ts 的 toHostPath 映射成真实路径再发; 映射不到的不发请求.
 *
 * 注入时机: OpencodeServiceImpl.initRuntime 拿到 /path 响应后 setHostAnchors.
 * 早期启动 (framework storage stat 早于 /path 返回) 用 whenHostAnchors 等待.
 */

import { normalizeCwdPath } from './path';
import { effectiveCwd } from './url';

export interface HostAnchors {
  /** 当前工作目录 (真实宿主绝对路径, URL ?directory= 同源) */
  directory: string;
  /** 用户家目录 (/path.home, e.g. /Users/weizuxiao / C:/Users/dev) */
  home: string;
}

let _anchors: HostAnchors | null = null;
let _resolveReady: (() => void) | null = null;
const _ready = new Promise<void>((resolve) => { _resolveReady = resolve; });

/** initRuntime /path 响应后注入. directory + home 一次性同时注入 (同源 /path). */
export function setHostAnchors(a: Partial<HostAnchors>): void {
  const prev = _anchors || { directory: '', home: '' };
  const next: HostAnchors = {
    directory: normalizeCwdPath(a.directory || prev.directory || effectiveCwd() || ''),
    home: normalizeCwdPath(a.home || prev.home || ''),
  };
  _anchors = next;
  if (typeof window !== 'undefined' && next.home) {
    (window as any).__APP_CONFIG__ = {
      ...((window as any).__APP_CONFIG__ || {}),
      userHome: next.home,
    };
  }
  // directory 与 home 同源 (/path) 同时注入, 两者都就绪才算 ready:
  // 框架 storage 早期会建 codeblitz 虚拟家目录 /home/.codeblitz, 需 home 锚点映射;
  // 只等 directory 会让 home 尚空时提前放行 → toHostPath 映射 /home 失败 → FileNotFound.
  if (next.directory && next.home) {
    _resolveReady?.();
    _resolveReady = null;
  }
}

/** 当前锚点快照 (不等待; directory 始终可从 URL 兜底, home 可能为空). */
export function getHostAnchors(): HostAnchors {
  if (_anchors) return _anchors;
  return { directory: normalizeCwdPath(effectiveCwd() || ''), home: '' };
}

/** 等待锚点就绪 (directory + home 同时可用才 resolve; 超时返回当前最佳快照, 不阻塞调用方). */
export async function whenHostAnchors(timeoutMs = 3000): Promise<HostAnchors> {
  if (_anchors?.directory && _anchors?.home) return _anchors;
  await Promise.race([
    _ready,
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
  return getHostAnchors();
}
