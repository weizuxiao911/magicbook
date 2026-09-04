/**
 * infra/http.ts — opencode HTTP client
 *
 * 统一 fetch 封装 + cwd header 自动注入 + JSON 解包 + 错误处理.
 * service 层 IO 全部走这里, 不直接 fetch (确保 header 一致 + 错误统一).
 *
 * 跨实例 header 路径:
 *   - 默认: x-opencode-directory = 当前 cwd (effectiveCwd())
 *   - 外部路径 (如 /home/.codeblitz/...): 用 parent as header, basename as path
 *     (重写在调用方 path 解析层做, http 层只接受 headerPath 参数)
 */

import { appBaseUrl, cwdHeader } from './url';
import { toHostPath } from './path';
import { getHostAnchors } from './host';

/** 错误类 (供 service 包装 FileSystemProviderError). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`http ${status} ${path}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/** 出口兜底: headerPath 必须锚定 /path 接口的真实 directory/home.
 *  虚拟路径 (/home, /workspace 且无法映射) 直接拒绝, 不发请求. */
function anchorHeaderPath(headerPath: string | undefined): string | undefined {
  if (!headerPath) return undefined;
  const anchored = toHostPath(headerPath, getHostAnchors());
  if (!anchored) {
    console.warn('[http] 拒绝无锚点虚拟 headerPath, 不发请求:', headerPath);
    throw new HttpError(404, headerPath, `unanchored virtual path: ${headerPath}`);
  }
  return anchored;
}

/** 内部 fetch 封装. headerPath 优先 (外部路径 IO 用), 否则 cwd header. */
async function apiFetch<T = any>(path: string, init: RequestInit = {}, headerPath?: string): Promise<T | null> {
  const base = appBaseUrl();
  if (!base) throw new Error('opencode api: app base url not ready');
  const url = `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const anchored = anchorHeaderPath(headerPath);
  const headers: Record<string, string> = anchored
    ? { 'x-opencode-directory': anchored }
    : cwdHeader();
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, path, text);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json();
    return (j && (j as any).data !== undefined) ? (j as any).data : (j as T);
  }
  return (await res.text()) as unknown as T;
}

/** GET 请求. 返回 null = 404. 抛 HttpError = 非 2xx. */
export async function apiGet<T = any>(path: string, headerPath?: string): Promise<T | null> {
  return apiFetch<T>(path, {}, headerPath);
}

/** POST 请求. body 自动 JSON.stringify. */
export async function apiPost<T = any>(path: string, body?: unknown, headerPath?: string): Promise<T | null> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, headerPath);
}

/** 直读字节 (走 path-style /api/fs/read/<encoded>, 适合大文件 / 二进制).
 *  抛 Error('not found') = 404, 其他非 2xx = HttpError. */
export async function apiReadBytes(relPath: string, headerPath?: string): Promise<Uint8Array> {
  const base = appBaseUrl();
  if (!base) throw new Error('opencode api: app base url not ready');
  const url = `${base.replace(/\/+$/, '')}/api/fs/read/${encodeURIComponent(relPath)}`;
  const anchored = anchorHeaderPath(headerPath);
  const headers: Record<string, string> = anchored
    ? { 'x-opencode-directory': anchored }
    : cwdHeader();
  const res = await fetch(url, { headers });
  if (res.status === 404) throw new Error('not found');
  if (!res.ok) throw new HttpError(res.status, '/api/fs/read/' + relPath, await res.text().catch(() => ''));
  return new Uint8Array(await res.arrayBuffer());
}

/** Uint8Array / string → base64 (浏览器端, 分块避免栈溢出). */
export function bytesToBase64(input: Uint8Array | string): string {
  if (typeof input === 'string') {
    const bytes = new TextEncoder().encode(input);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < input.length; i += chunk) {
    bin += String.fromCharCode(...input.subarray(i, i + chunk));
  }
  return btoa(bin);
}