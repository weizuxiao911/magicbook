/**
 * service/ports/ports.interface.ts
 *
 * 本地服务端口发现契约 (opencode 服务端 PortsService 的客户端面).
 * 对标 VSCode 端口面板: 扫描宿主机 LISTEN 端口 → 面板展示 → 一键打开(走反代)/复制 URL.
 *
 * 服务端端点 (raw, 全局):
 *   GET    /ports            → 即时扫描 + 当前列表
 *   POST   /ports {port}     → 手动白名单
 *   DELETE /ports/:port      → 移除
 *   /proxy/:port/<rest>      → HTTP/WS 反代 (127.0.0.1)
 * 事件 (SSE /global/event): type = ports.detected | ports.closed
 */

export interface PortEntry {
  port: number;
  pid?: number;
  process?: string;
  detectedAt: number;
}

export interface IPortsService {
  /** 当前列表 (即时重扫一次) */
  scan(): Promise<PortEntry[]>;
  /** 缓存快照 (不触发扫描) */
  list(): Promise<PortEntry[]>;
  /** 手动添加端口 (白名单) */
  add(port: number): Promise<void>;
  /** 从面板移除 (白名单删除或忽略已发现) */
  remove(port: number): Promise<void>;
  /** 通过 opencode 反代访问该服务的 URL (浏览器直接打开) */
  proxyUrl(port: number): string;
  /** 订阅端口事件 (SSE /global/event, 过滤 ports.*). 返回取消订阅 */
  subscribe(cb: (e: { type: 'ports.detected' | 'ports.closed'; port: number; process?: string }) => void): () => void;
}

export const PortsToken: symbol = Symbol('IPortsService');
