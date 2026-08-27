/**
 * 通用 opencode 端点调用 (基于全局 SDK client 配置)
 *
 * 走 fetch 但 baseUrl + cwdHeader 从 SDK client.config 拿 (单一事实源, 跟 SDK 同步).
 * SDK 没包装的端点 (如 /skill, /find/file) 走这里调用.
 */
import { getGlobalOpencodeClient } from './api';
import type { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

type SdkClient = ReturnType<typeof createOpencodeClient>;

function getSdkConfig() {
  const c = getGlobalOpencodeClient() as SdkClient | null;
  if (!c) throw new Error('opencodeFetch: SDK client not ready');
  // SDK v2: c 是 OpencodeClient (HeyApiClient 子类), baseUrl/headers 存在 inner client._config
  // 路径: c.client (inner HeyApiClient) → getConfig() → { baseUrl, headers, ... }
  const inner = (c as any).client;
  const cfg = (inner && typeof inner.getConfig === 'function') ? inner.getConfig() : ((c as any).config || {});
  const baseUrl: string = cfg?.baseUrl || '';
  const headers: Record<string, string> = { ...(cfg?.headers || {}) };
  if (!baseUrl) throw new Error('opencodeFetch: SDK baseUrl missing');
  return { baseUrl, headers };
}

export interface OpencodeFetchOptions extends Omit<RequestInit, 'body' | 'headers'> {
  body?: string | object;
  /** 额外 header (会跟 SDK 的 cwdHeader 合并, 同名 SDK 优先) */
  headers?: Record<string, string>;
}

export async function opencodeFetch<T = any>(
  path: string,
  opts: OpencodeFetchOptions = {},
): Promise<T> {
  const { baseUrl, headers: sdkHeaders } = getSdkConfig();
  const url = path.startsWith('http') ? path : `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
    ...sdkHeaders,
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`opencodeFetch ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json() as Promise<T>;
  return (await res.text()) as unknown as T;
}
