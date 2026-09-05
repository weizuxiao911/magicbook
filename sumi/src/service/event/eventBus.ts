/**
 * service/event/eventBus.ts — 客户端消息总线 (框架无关单例)
 *
 * 全客户端**唯一**对接 opencode `/global/event` SSE 的地方.
 * 数据流: opencode -sse-> service (eventBus) -event-> extensions.
 *
 * - 内部持有一条 EventSource('/global/event') (全局总线, 不按 workspace 路由,
 *   一条连接即可收到所有 instance 的会话事件 + directory:"global" 的端口事件).
 * - 引用计数: 首个订阅者连接, 0 订阅者关闭; EventSource 网络错误由浏览器自动重连.
 * - 帧归一化为 { type, properties, directory, raw } 后 fan-out 给所有订阅者.
 * - 不进 DI: DI service (ports) / 命令式纯函数 (ask) / React 组件 (chat) 都能直接 import.
 *
 * 订阅 API:
 *   onEvent(cb)              全量帧
 *   onEventType(types, cb)   按事件 type 过滤 (单个/多个)
 *   onSessionEvent(sid, cb)  按 properties.sessionID 过滤
 *   均返回 unsubscribe () => void.
 *
 * 详见 docs/消息总线服务设计与测试用例.md.
 */

import { appBaseUrl, secureUrl } from '../../infra/url';

export interface NormalizedEvent {
  /** payload.type */
  type: string;
  /** payload.properties || payload.data */
  properties: Record<string, any>;
  /** 总线信封 directory (会话=工作区绝对路径, 端口事件="global") */
  directory?: string;
  /** 原始帧 (调试用) */
  raw: any;
}

type Listener = (ev: NormalizedEvent) => void;
type Unsub = () => void;

const listeners = new Set<Listener>();
let es: EventSource | null = null;

/** 归一化一帧 SSE 数据; 无效帧返回 null. */
function normalize(msgData: string): NormalizedEvent | null {
  let raw: any;
  try {
    raw = JSON.parse(msgData);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  // /global/event 信封: { directory, payload: { id, type, properties } };
  // 兜底裸帧: { id, type, properties|data }.
  const envelope = raw.payload ?? raw;
  const type = envelope?.type as string | undefined;
  if (!type) return null;
  const properties = envelope?.properties ?? envelope?.data ?? {};
  if (!properties || typeof properties !== 'object') return null;
  return {
    type,
    properties: properties as Record<string, any>,
    directory: typeof raw.directory === 'string' ? raw.directory : undefined,
    raw,
  };
}

/** 引用计数 +1 并确保 SSE 已连接 (0→1 时建连). */
function connect(): void {
  if (es) return;
  const base = appBaseUrl();
  if (!base) return; // opencode 未起; 下次订阅时再尝试建连
  try {
    const source = new EventSource(secureUrl(`${base.replace(/\/+$/, '')}/global/event`), { withCredentials: false });
    es = source;
    source.onmessage = (msg) => {
      const ev = normalize(msg.data);
      if (!ev) return;
      listeners.forEach((l) => {
        try {
          l(ev);
        } catch (e) {
          console.warn('[eventBus] listener error:', e);
        }
      });
    };
    // 浏览器自动重连, 不手写重连定时器
    source.onerror = () => {};
  } catch (e) {
    console.warn('[eventBus] SSE start failed:', e);
    es = null;
  }
}

/** 引用计数 -1; 归 0 时关闭 SSE. */
function disconnect(): void {
  if (listeners.size > 0) return;
  try { es?.close(); } catch { /* ignore */ }
  es = null;
}

/** 全量订阅: 每一帧都回调. */
export function onEvent(cb: Listener): Unsub {
  listeners.add(cb);
  connect();
  return () => {
    listeners.delete(cb);
    disconnect();
  };
}

/** 按事件 type 订阅 (单个字符串或数组). */
export function onEventType(types: string | string[], cb: Listener): Unsub {
  const set = new Set(Array.isArray(types) ? types : [types]);
  return onEvent((ev) => {
    if (set.has(ev.type)) cb(ev);
  });
}

/** 按会话 ID 订阅 (匹配 properties.sessionID). */
export function onSessionEvent(sessionID: string, cb: Listener): Unsub {
  return onEvent((ev) => {
    if (ev.properties?.sessionID === sessionID) cb(ev);
  });
}
