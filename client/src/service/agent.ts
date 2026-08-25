/**
 * agent 实现 — service/agent/index.ts
 *
 * implements core/commands/agent 的 IAgent: 对接 server /opencode/*.
 * AI SDK 客户端单例, 供全局使用（chat 等拓展经 AgentToken 注入）.
 *
 * baseUrl: 唯一配置入口 app_base_url → opencode 地址 = app_base_url/ai（sandbox 反向代理透传）.
 * 纯浏览器: 不依赖 process/node.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import type { IAgent, AgentMessage, AgentModel, AgentSession } from '../core/commands/agent';
import { AgentToken } from '../core/commands/agent';

let _client: any = null;

function agentUrl(): string {
  const base = ((window as any).__APP_CONFIG__?.appBaseUrl || '').replace(/\/+$/, '');
  return base ? `${base}/ai` : '';
}

@Injectable()
@Domain(ClientAppContribution)
export class AgentServiceImpl implements IAgent, ClientAppContribution {
  static instance: AgentServiceImpl | null = null;

  constructor() {
    AgentServiceImpl.instance = this;
    // runtime 就绪后自建 SDK client
    window.addEventListener('runtime-ready', () => {
      try {
        this.getClient();
        console.log('[agent] client 就绪 (runtime-ready):', agentUrl());
      } catch (err) {
        console.warn('[agent] client 实例化失败:', err);
      }
    });
  }

  /** 容器启动: 挂全局; runtime 已就绪（如 sandbox 先启动）则立即建 client */
  onStart(): void {
    (window as any).__APP_AGENT__ = this;
    if (agentUrl()) {
      try {
        this.getClient();
        console.log('[agent] client 就绪 (onStart):', agentUrl());
      } catch (err) {
        console.warn('[agent] client 实例化失败:', err);
      }
    }
  }

  getClient(): any {
    if (_client) return _client;
    const base = agentUrl();
    if (!base) return null;
    // 所有 SDK 请求带 X-Current-Cwd → sandbox 中间件幂等 ensure opencode 就绪
    // （活且 cwd 匹配则几 ms 放行; opencode 挂了会由 sandbox 拉起, 避免 chat 请求 502）
    const cwd = localStorage.getItem('APP_CWD');
    const headers = cwd ? { 'X-Current-Cwd': btoa(unescape(encodeURIComponent(cwd))) } : {};
    _client = createOpencodeClient({ baseUrl: base, headers, responseStyle: 'fields', throwOnError: true });
    (window as any).__APP_OPENCODE__ = _client;
    (window as any).__APP_OPENCODE_RUNTIME__ = { baseUrl: base };
    return _client;
  }

  isReady(): boolean {
    return !!_client || !!agentUrl();
  }

  async waitForReady(timeoutMs = 8000): Promise<void> {
    if (this.isReady()) return;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (agentUrl()) {
        this.getClient();
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('agent client not ready');
  }

  private async withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
    await this.waitForReady();
    const client = this.getClient();
    if (!client) throw new Error('agent client not ready');
    return fn(client);
  }

  async createSession(title?: string): Promise<string> {
    return this.withClient(async (c) => {
      const params: any = {};
      if (title) params.id = title;
      const { data, error } = await c.session.create(params);
      if (error) throw error;
      if (!data?.id) throw new Error('session.create 未返回 id');
      return data.id;
    });
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.withClient(async (c) => {
      const { data, error } = await c.session.list();
      if (error) throw error;
      return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    });
  }

  async listMessages(sessionID: string): Promise<AgentMessage[]> {
    return this.withClient(async (c) => {
      const { data, error } = await c.session.messages({ sessionID });
      if (error) throw error;
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.data)) return data.data;
      if (data && Array.isArray(data.messages)) return data.messages;
      return [];
    });
  }

  async sendMessage(sessionID: string, textOrParts: string | unknown[], agent?: string, model?: unknown, variant?: string): Promise<void> {
    return this.withClient(async (c) => {
      const parts: any[] = typeof textOrParts === 'string'
        ? [{ type: 'text', text: textOrParts }]
        : (textOrParts as any[]);
      const params: any = { sessionID, parts };
      if (agent) params.agent = agent;
      if (model) params.model = model;
      if (variant) params.variant = variant;
      const { error } = await c.session.prompt(params);
      if (error) throw error;
    });
  }

  async abort(sessionID: string): Promise<void> {
    return this.withClient(async (c) => {
      const { error } = await c.session.abort({ sessionID });
      if (error) throw error;
    });
  }

  async deleteSession(sessionID: string): Promise<void> {
    return this.withClient(async (c) => {
      const { error } = await c.session.delete({ sessionID });
      if (error) throw error;
    });
  }

  async listAgents(): Promise<unknown[]> {
    await this.waitForReady();
    const res = await fetch(`${agentUrl()}/agent`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /agent failed: HTTP ${res.status}`);
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  }

  async listModels(): Promise<AgentModel[]> {
    await this.waitForReady();
    const res = await fetch(`${agentUrl()}/provider`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /provider failed: HTTP ${res.status}`);
    const json = await res.json();
    const all: any[] = Array.isArray(json?.all) ? json.all : [];
    const connected = new Set(Array.isArray(json?.connected) ? json.connected : []);
    const result: AgentModel[] = [];
    for (const p of all) {
      if (!connected.has(p?.id)) continue;
      const models = p?.models || {};
      for (const mid of Object.keys(models)) {
        const m = models[mid];
        if (!m || m.status !== 'active') continue;
        result.push({ id: m.id || mid, providerID: m.providerID || p.id, name: m.name || mid });
      }
    }
    return result;
  }
}

/** 模块级单例 getter */
export function getAgentService(): IAgent {
  return AgentServiceImpl.instance || (AgentServiceImpl.instance = new AgentServiceImpl());
}

@Injectable()
export class AgentModule extends BrowserModule {
  providers = [
    { token: AgentToken, useFactory: () => getAgentService() },
    AgentServiceImpl,
  ];

  contributionProvider = ClientAppContribution;
}