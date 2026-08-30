/**
 * agent 实现 — service/agent.ts
 *
 * implements core/commands/agent 的 IAgent: 对接 opencode 直连（无中间层）.
 * AI SDK 客户端单例, 供全局使用（chat 等拓展经 AgentToken 注入）.
 *
 * baseUrl: 唯一配置入口 app_base_url → opencode serve 直连（无 /ai 前缀; server 端 = opencode 自己）.
 *
 * 运行时初始化 (initRuntime): 启动期探 /global/health + /path + /pty/shells,
 *   注入 cwd/defaultShell 到 __APP_CONFIG__, 派发 runtime-ready 事件, 建 SDK client.
 * 纯浏览器: 不依赖 process/node.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import type { IAgent, AgentMessage, AgentModel, AgentSession } from '../commands/agent';
import { AgentToken } from '../commands/agent';
import { appBaseUrl, effectiveCwd, cwdHeader, isPathNotFoundError } from './env';

let _client: any = null;

/** 探测宿主机默认 shell: 从 /pty/shells 取 (多平台由宿主机 opencode 判定, 不猜浏览器 UA) */
async function probeShells(sdk: any, cwd: string): Promise<string> {
  try {
    const { data } = await sdk.pty.shells({ directory: cwd });
    const list = (data as any) as Array<{ name: string; path: string; acceptable: boolean }>;
    if (!Array.isArray(list) || !list.length) return '';
    return list.find((s) => s.acceptable)?.path || '';
  } catch {
    return '';
  }
}

@Injectable()
@Domain(ClientAppContribution)
export class AgentServiceImpl implements IAgent, ClientAppContribution {
  static instance: AgentServiceImpl | null = null;

  /** runtime 状态（initRuntime 后填充, 注入 __APP_CONFIG__.cwd/.defaultShell） */
  private _runtime: { cwd: string; defaultShell: string; healthy: boolean } | null = null;

  constructor() {
    AgentServiceImpl.instance = this;
    (window as any).__APP_AGENT__ = this;
  }

  /** 容器启动: 总是自动 initRuntime（探 hostCwd 兜底无 APP_CWD 场景; 派发 runtime-ready; 已有 APP_CWD 时也跑） */
  onStart(): void {
    void this.initRuntime();
  }

  /**
   * 初始化 runtime: 探 opencode /global/health + /path + /pty/shells, 注入 cwd/defaultShell 到全局配置,
   * 派发 runtime-ready 事件, 建 SDK client. 幂等: 已初始化则直接返回.
   * 调用方: agent.onStart()（自动）/ LoginView.doLogin（手动, 登录后兜底）
   */
  async initRuntime(): Promise<void> {
    if (this._runtime) return;
    const base = appBaseUrl();
    if (!base) return;
    const cwd = effectiveCwd();
    // 启动期先建 SDK (用 cwdHeader 即使 stale 也行, 探测用), 后续探测都走 SDK
    let sdk: any = null;
    try { sdk = this.getClient(); } catch { /* opencode 未起, 占位即可 */ }
    // 1. 探 /global/health（不阻塞, 失败按"未就绪"占位）
    let healthy = false;
    try {
      if (sdk) {
        const { data } = await sdk.global.health();
        healthy = !!(data as any)?.healthy;
      }
    } catch { /* opencode 未起, 占位即可 */ }
    // 2. 探 /path + /pty/shells 拿宿主 cwd + 默认 shell（per-request 用 cwdHeader 切目录）
    // 总是探测: APP_CWD 没设时拿 hostCwd 兜底, 写了 __APP_CONFIG__.cwd
    let hostCwd = '';
    let defaultShell = '';
    try {
      if (sdk) {
        const { data } = await sdk.path.get({ directory: cwd });
        if ((data as any)?.directory) hostCwd = (data as any).directory;
        const shells = await probeShells(sdk, cwd);
        defaultShell = shells;
      }
    } catch { /* 忽略, 走默认 */ }

    this._runtime = {
      cwd: hostCwd || cwd,
      defaultShell: defaultShell || '/bin/bash',
      healthy,
    };
    // 2.5 APP_CWD 校验: 用户选的目录可能被删/移走, 留着会导致后续 file/pty 全 500
    //    走 SDK client.file.list 校验 (跟 AGENTS.md 铁律: 走 SDK, 不直 fetch)
    //    SDK throwOnError=true → 错误抛, 用 try/catch 抓
    //    用户业务规则:
    //      - 有 APP_CWD 且宿主机存在 → 按 APP_CWD 加载 (正常)
    //      - 有 APP_CWD 但宿主机不存在 (真删) → 重置 APP_CWD + reload
    //      - 短暂不可用 (connection / timeout / 5xx) → 保留 APP_CWD, 等下次重试
    //    区分: 错误信息含 not found / ENOENT / no such file → 真删, 其他 → 短暂不可用
    if (cwd && cwd !== hostCwd) {
      try {
        const c = this.getClient();
        if (c) {
          await c.file.list({ path: '.', directory: cwd });
        }
      } catch (e: any) {
        if (isPathNotFoundError(e)) {
          console.warn('[agent] APP_CWD 宿主机不存在, 重置 + reload:', cwd, e?.message);
          try { localStorage.removeItem('APP_CWD'); } catch { /* */ }
          window.location.reload();
          return;
        }
        // 短暂不可用: 保留 APP_CWD, 保留 runtime.cwd = cwd (用户意愿优先)
        console.warn('[agent] APP_CWD browse 失败 (短暂不可用), 保留 localStorage:', cwd, e?.message);
        this._runtime.cwd = cwd;
      }
    }
    // 注入全局配置（env / fs/uri / terminal 读这里）
    (window as any).__APP_CONFIG__ = {
      ...((window as any).__APP_CONFIG__ || {}),
      cwd: this._runtime.cwd,
      defaultShell: this._runtime.defaultShell,
    };
    // 派发 runtime-ready（fs 事件订阅 / chat 重新拉配置 / 终端懒加载 shell / explorer 刷新）
    window.dispatchEvent(new CustomEvent('runtime-ready', { detail: this._runtime }));
    // 立即建 SDK client
    try {
      this.getClient();
      console.log('[agent] runtime applied:', this._runtime);
    } catch (err) {
      console.warn('[agent] client 实例化失败:', err);
    }
  }

  getClient(): any {
    if (_client) return _client;
    const base = appBaseUrl();
    if (!base) return null;
    // 所有 SDK 请求带 x-opencode-directory → opencode 按 header 切换工作目录上下文
    // （per-request 路由, 无需重启服务; 直连 opencode, 无中间代理）
    _client = createOpencodeClient({ baseUrl: base, headers: cwdHeader(), responseStyle: 'fields', throwOnError: true });
    (window as any).__APP_OPENCODE__ = _client;
    (window as any).__APP_OPENCODE_RUNTIME__ = { baseUrl: base };
    return _client;
  }

  /** runtime 元信息（cwd / defaultShell / healthy; 未初始化返回 null） */
  getRuntime(): { cwd: string; defaultShell: string; healthy: boolean } | null {
    return this._runtime;
  }

  isReady(): boolean {
    return !!_client || !!appBaseUrl();
  }

  async waitForReady(timeoutMs = 8000): Promise<void> {
    if (this.isReady()) return;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (appBaseUrl()) {
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
    // SDK client.app.agents: 参数 directory (cwd), 返回 agents 列表
    const { data, error } = await this.withClient(async (c) => {
      return await c.app.agents({ query: { directory: effectiveCwd() } });
    });
    if (error) throw new Error(`listAgents failed: ${(error as any)?.message || 'unknown'}`);
    return Array.isArray(data) ? (data as unknown[]) : [];
  }

  async listModels(): Promise<AgentModel[]> {
    await this.waitForReady();
    // SDK client.provider.list: 返回 { all, connected, default }
    const { data, error } = await this.withClient(async (c) => {
      return await c.provider.list({ query: { directory: effectiveCwd() } });
    });
    if (error) throw new Error(`listModels failed: ${(error as any)?.message || 'unknown'}`);
    const json: any = data || {};
    const all: any[] = Array.isArray(json.all) ? json.all : [];
    const connected = new Set(Array.isArray(json.connected) ? json.connected : []);
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
export function getAgentService(): AgentServiceImpl {
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
