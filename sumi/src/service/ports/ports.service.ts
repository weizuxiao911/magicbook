/**
 * service/ports/ports.service.ts
 *
 * PortsServiceImpl — DI 单例. 封装 opencode 端口端点 + SSE 事件订阅.
 * SSE 用共享单条 EventSource (/global/event), 只过滤 ports.* 事件.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { apiGet, apiPost } from '../../infra/http';
import { appBaseUrl, secureUrl } from '../../infra/url';

import type { IPortsService, PortEntry } from './ports.interface';
import { PortsToken } from './ports.interface';

@Injectable()
export class PortsServiceImpl implements IPortsService {
  private sse: EventSource | null = null;
  private listeners = new Set<(e: { type: 'ports.detected' | 'ports.closed'; port: number; process?: string }) => void>();
  private cached: PortEntry[] = [];

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

  proxyUrl(port: number): string {
    const base = appBaseUrl();
    return `${base.replace(/\/+$/, '')}/proxy/${port}/`;
  }

  subscribe(
    cb: (e: { type: 'ports.detected' | 'ports.closed'; port: number; process?: string }) => void,
  ): () => void {
    this.listeners.add(cb);
    this.ensureSse();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.closeSse();
    };
  }

  /** SSE /global/event: 只处理 ports.detected / ports.closed, 其余丢弃 */
  private ensureSse(): void {
    if (this.sse) return;
    const base = appBaseUrl();
    if (!base) return;
    try {
      const es = new EventSource(secureUrl(`${base.replace(/\/+$/, '')}/global/event`));
      this.sse = es;
      es.onmessage = (msg) => {
        try {
          const raw = JSON.parse(msg.data);
          const ev = (raw && raw.payload) || raw;
          const t: string = ev?.type || '';
          const props = ev?.data || ev?.properties || {};
          if (t !== 'ports.detected' && t !== 'ports.closed') return;
          const entry = { type: t as 'ports.detected' | 'ports.closed', port: Number(props.port), process: props.process };
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
      };
      es.onerror = () => { /* EventSource 自动重连 */ };
    } catch { /* ignore */ }
  }

  private closeSse(): void {
    try { this.sse?.close(); } catch { /* ignore */ }
    this.sse = null;
  }
}

@Injectable()
export class PortsModule extends BrowserModule {
  providers = [
    { token: PortsToken, useClass: PortsServiceImpl },
    PortsServiceImpl,
  ];
}
