/**
 * service/ports/ports.service.ts
 *
 * PortsServiceImpl — DI 单例. 封装 opencode 端口端点.
 * 端口开/关事件来自客户端消息总线 (service/event/eventBus.ts, 唯一 /global/event SSE),
 * 这里只订阅 ports.detected / ports.closed 并维护缓存 + fan-out, 不再自建 EventSource.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { apiGet, apiPost } from '../../infra/http';
import { appBaseUrl } from '../../infra/url';
import { onEventType } from '../event/eventBus';

import type { IPortsService, PortEntry } from './ports.interface';
import { PortsToken } from './ports.interface';

@Injectable()
export class PortsServiceImpl implements IPortsService {
  private listeners = new Set<(e: { type: 'ports.detected' | 'ports.closed'; port: number; process?: string }) => void>();
  private cached: PortEntry[] = [];
  private busOff: (() => void) | null = null;

  async scan(): Promise<PortEntry[]> {
    const list = await apiGet<PortEntry[]>('/ports');
    this.cached = Array.isArray(list) ? list : [];
    return this.cached;
  }

  async list(): Promise<PortEntry[]> {
    if (this.cached.length === 0) {
      try { return await this.scan(); } catch { return []; }
    }
    return this.cached;
  }

  async add(port: number): Promise<void> {
    await apiPost('/ports', { port });
    try { await this.scan(); } catch { /* 静默 */ }
  }

  async remove(port: number): Promise<void> {
    const base = appBaseUrl();
    if (!base) return;
    try {
      await fetch(`${base.replace(/\/+$/, '')}/ports/${port}`, { method: 'DELETE' });
      this.cached = this.cached.filter((e) => e.port !== port);
    } catch { /* 静默 */ }
  }

  /** 注册 numas spawn 的根 PID (PTY/Agent 工具). 服务端自动 scan 一次 */
  async registerPid(pid: number): Promise<void> {
    const base = appBaseUrl();
    if (!base || !Number.isInteger(pid) || pid <= 0) return;
    try {
      await fetch(`${base.replace(/\/+$/, '')}/ports/pids`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid }),
      });
    } catch { /* 静默 */ }
  }

  /** 反注册 (PTY/Agent 工具退出时). 服务端下次 scan 自动清理已退出 PID */
  async unregisterPid(pid: number): Promise<void> {
    const base = appBaseUrl();
    if (!base || !Number.isInteger(pid) || pid <= 0) return;
    try {
      await fetch(`${base.replace(/\/+$/, '')}/ports/pids/${pid}`, { method: 'DELETE' });
    } catch { /* 静默 */ }
  }

  proxyUrl(port: number): string {
    const base = appBaseUrl();
    return `${base.replace(/\/+$/, '')}/proxy/${port}/`;
  }

  subscribe(
    cb: (e: { type: 'ports.detected' | 'ports.closed'; port: number; process?: string }) => void,
  ): () => void {
    this.listeners.add(cb);
    this.ensureBus();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.closeBus();
    };
  }

  /** 订阅消息总线: 只处理 ports.detected / ports.closed, 其余丢弃 */
  private ensureBus(): void {
    if (this.busOff) return;
    this.busOff = onEventType(['ports.detected', 'ports.closed'], (ev) => {
      try {
        const t = ev.type as 'ports.detected' | 'ports.closed';
        const props = ev.properties || {};
        const entry = { type: t, port: Number(props.port), process: props.process };
        if (!entry.port) return;
        // 更新缓存
        if (t === 'ports.detected') {
          if (!this.cached.some((e) => e.port === entry.port)) {
            this.cached = [...this.cached, { port: entry.port, process: entry.process, detectedAt: Date.now() }]
              .sort((a, b) => a.port - b.port);
          }
        } else {
          this.cached = this.cached.filter((e) => e.port !== entry.port);
        }
        this.listeners.forEach((l) => l(entry));
      } catch { /* 坏帧忽略 */ }
    });
  }

  private closeBus(): void {
    try { this.busOff?.(); } catch { /* ignore */ }
    this.busOff = null;
  }
}

@Injectable()
export class PortsModule extends BrowserModule {
  providers = [
    { token: PortsToken, useClass: PortsServiceImpl },
    PortsServiceImpl,
  ];
}
