/**
 * service/opencode/opencode.service.ts
 *
 * OpencodeServiceImpl — DI 单例实现.
 * bridge: opencode SDK client + runtime 探测 + AI 能力封装.
 *
 * DI 注册:
 *   - AgentModule.providers: [{ token: AgentToken, useClass: OpencodeServiceImpl }, OpencodeServiceImpl]
 *   - 客户端: useInjectable(AgentToken) 或 injector.get(AgentToken)
 *
 * 跨平台:
 *   - shell 探测跨 OS 委托给 opencode 后端 (/pty/shells), 浏览器不靠 UA 猜
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import { appBaseUrl, cwdHeader, isPathNotFoundError, effectiveCwd, emitWorkspaceChanged } from '../../infra/url';
import { normalizeCwdPath } from '../../infra/path';
import { setHostAnchors } from '../../infra/host';
import { isMac, isWindows, isLinux } from '../../infra/os';

import type { IOpencodeService, AgentSession, AgentMessage, AgentModel, AgentRuntime } from './opencode.interface';
import { AgentToken } from './opencode.interface';

let _client: any = null;
// 跟踪 SDK client 创建时的 cwd, 切换 workspace 后必须重建 (header 跟随新 cwd)
let _clientCwd = '';

@Injectable()
@Domain(ClientAppContribution)
export class OpencodeServiceImpl implements IOpencodeService, ClientAppContribution {
  private _runtime: AgentRuntime | null = null;

  /** 容器启动: 总是跑 initRuntime (有 APP_CWD 时也跑, 探测 cwd/shell/health) */
  onStart(): void {
    void this.initRuntime();
  }

  /**
   * 初始化 runtime: 探 opencode /global/health + /path + /pty/shells,
   * 注入 defaultShell 到 __APP_CONFIG__, 派发 runtime-ready, 建 SDK client.
   * 幂等: 已初始化则直接返回.
   */
  async initRuntime(): Promise<void> {
    if (this._runtime) return;
    const base = appBaseUrl();
    if (!base) return;
    const cwd = effectiveCwd();
    let sdk: any = null;
    try { sdk = this.getClient(); } catch { /* opencode 未起, 占位即可 */ }

    // 1. /global/health
    let healthy = false;
    try { if (sdk) { const { data } = await sdk.global.health(); healthy = !!(data as any)?.healthy; } }
    catch { /* ignore */ }

    // 2. /path + /pty/shells (per-request cwd header)
    //    /path 返回:
    //      directory: opencode 进程 workdir (用户启动 numas 时的 cwd) — 默认 workspace 源
    //      worktree:  git worktree 根 (有 git 才有, 跟 workdir 一致或更浅)
    //      home:      用户 home dir (仅 .config/.local 路径用, 不当 workspace)
    //    默认 workspace 取 directory (workdir).
    let hostCwd = '';
    let hostHome = '';
    let defaultShell = '';
    try {
      if (sdk) {
        const { data } = await sdk.path.get({ directory: cwd });
        const resp = (data as any) || {};
        const fallbackWs = (typeof resp.directory === 'string' && resp.directory)
          || (typeof resp.worktree === 'string' && resp.worktree)
          || '';
        if (fallbackWs) hostCwd = normalizeCwdPath(fallbackWs);
        if (typeof resp.home === 'string' && resp.home) hostHome = normalizeCwdPath(resp.home);
        defaultShell = await probeDefaultShell(sdk, cwd);
      }
    } catch { /* 忽略, 走默认 */ }

    // 宿主路径锚点: 所有发往 opencode 的路径只能锚定这里 (directory/home),
    // codeblitz 虚拟路径 (/home, /workspace, /home/AppData/Roaming) 由 toHostPath 映射.
    setHostAnchors({ directory: hostCwd || cwd, home: hostHome });

    // 2.1 hostCwd 兜底
    if (!hostCwd && !cwd) {
      try {
        const base = appBaseUrl();
        const res = await fetch(`${base.replace(/\/+$/, '')}/api/fs/list?path=.`, {
          headers: { Accept: 'application/json' },
        });
        const json = await res.json();
        const locDir = (json as any)?.location?.directory;
        if (typeof locDir === 'string' && locDir) hostCwd = normalizeCwdPath(locDir);
        if (hostCwd) console.log('[opencode] hostCwd 探测 (fs.list location.directory):', hostCwd);
      } catch { /* ignore */ }
    }

    this._runtime = {
      workspace: hostCwd || cwd,
      defaultShell: defaultShell || '/bin/bash',
      healthy,
    };

    // 2.5 workspace 校验 (URL 指定的目录可能已被删)
    if (cwd && cwd !== hostCwd) {
      try {
        const c = this.getClient();
        if (c) await c.file.list({ path: '.', directory: cwd });
      } catch (e: any) {
        if (isPathNotFoundError(e)) {
          // URL workspace 失效 → 移除 ?directory= 让 fallback 用 hostCwd
          console.warn('[opencode] URL workspace 宿主机不存在, 移除 query 走 fallback:', cwd, e?.message);
          try {
            const u = new URL(window.location.href);
            u.searchParams.delete('directory');
            window.history.replaceState(null, '', u.toString());
            window.location.reload();
          } catch { /* ignore */ }
          return;
        }
        console.warn('[opencode] URL workspace browse 失败 (短暂不可用), 保留:', cwd, e?.message);
        this._runtime.workspace = cwd;
      }
    }

    // 注入全局配置 (env / fs-uri / terminal 读这里).
    // 注意: 不注入 cwd — 工作目录唯一 source-of-truth 是 URL ?directory (getWorkspace),
    // __APP_CONFIG__.cwd 是 opencode 进程启动 workdir, 切 workspace 不更新 (stale), 曾导致
    // editor 恢复/PDF sidecar 等按错目录操作. 需要当前目录一律走 infra/url getWorkspace().
    (window as any).__APP_CONFIG__ = {
      ...((window as any).__APP_CONFIG__ || {}),
      defaultShell: this._runtime.defaultShell,
    };

    // 3. URL 兜底: 访问地址缺 ?directory= → 用 opencode /path 拿 home 重定向到 ?directory={home}
    //    URL 一旦补上, 后续 reload / 跨 tab / 复制 URL 全部显式一致.
    //    注: WORKSPACE_ROOT patch (codeblitz constant.js) 在 module load 时求值 — 必须 reload
    //    让 patch 读到新 URL. (无 workspace → reload 一次; 有 → 跳过 reload)
    if (typeof window !== 'undefined' && this._runtime.workspace) {
      try {
        const u = new URL(window.location.href);
        const hadDir = u.searchParams.get('directory');
        if (!hadDir) {
          u.searchParams.set('directory', this._runtime.workspace);
          window.history.replaceState(null, '', u.toString());
          console.log('[opencode] URL 补 ?directory= + reload 让 WORKSPACE_ROOT patch 重新求值:', this._runtime.workspace);
          // 派 workspace:changed 事件, 通知 React state / 订阅者刷新
          emitWorkspaceChanged(this._runtime.workspace, '');
          // 一次性 reload (rebuild codeblitz 根到新 workspace)
          window.location.reload();
          return;
        }
      } catch { /* ignore */ }
    }

    // 派发 runtime-ready
    window.dispatchEvent(new CustomEvent('runtime-ready', { detail: this._runtime }));
    try {
      this.getClient();
      console.log('[opencode] runtime applied:', this._runtime);
    } catch (err) {
      console.warn('[opencode] client 实例化失败:', err);
    }
  }

getClient(): any {
    const cwd = effectiveCwd();
    // 铁律 8: 必须传 directory 让 SDK 把 x-opencode-directory header 注入每个请求.
    // SDK client 是单例, 切换 workspace 后必须重建, 否则 header 仍指向旧 cwd.
    if (_client && _clientCwd === cwd) return _client;
    if (_client) {
      // 旧 client 还在但 cwd 已变 → 关闭旧 client (新 client 重建)
      try { _client = null; } catch { /* ignore */ }
    }
    const base = appBaseUrl();
    if (!base) return null;
    _client = createOpencodeClient({
      baseUrl: base,
      directory: cwd,
      headers: cwdHeader(),
      responseStyle: 'fields',
      throwOnError: true,
    });
    // numas: 干掉 npm @opencode-ai/sdk 默认的 rewrite interceptor (对 GET 把 header 改写到
    // ?directory= query 并删除 header). server 端 defaultDirectory 只读 x-opencode-directory
    // header (铁律 8), GET 请求会因此 fall back 到 process.cwd() (numas), 切 workspace 后所有
    // GET 端点 (path.get / file.list / session.list / provider.list 等) 都用错目录.
    // 拦截器清空后 header 保持, server 端解析正确.
    try {
      const innerClient: any = (typeof _client?.client === 'object' && (_client as any).client) || _client;
      if (innerClient?.interceptors?.request?.clear) {
        innerClient.interceptors.request.clear();
        console.log('[opencode] cleared SDK rewrite interceptor (header stays in request)');
      }
    } catch (e) { console.warn('[opencode] clear interceptor failed:', e); }
    _clientCwd = cwd;
    (window as any).__APP_OPENCODE__ = _client;
    (window as any).__APP_OPENCODE_RUNTIME__ = { baseUrl: base };
    return _client;
  }

  getRuntime(): AgentRuntime | null { return this._runtime; }
  isReady(): boolean { return !!_client || !!appBaseUrl(); }

  async waitForReady(timeoutMs = 8000): Promise<void> {
    if (this.isReady()) return;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (appBaseUrl()) { this.getClient(); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('opencode client not ready');
  }

  private async withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
    await this.waitForReady();
    const client = this.getClient();
    if (!client) throw new Error('opencode client not ready');
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

  async sendMessage(
    sessionID: string,
    textOrParts: string | unknown[],
    agent?: string,
    model?: unknown,
    variant?: string,
  ): Promise<void> {
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
    return this.withClient(async (c) => {
      const cwd = effectiveCwd();
      const { data, error } = await c.app.agents({ query: { directory: cwd } });
      if (error) throw new Error(`listAgents failed: ${(error as any)?.message || 'unknown'}`);
      return Array.isArray(data) ? (data as unknown[]) : [];
    });
  }

  async listModels(): Promise<AgentModel[]> {
    return this.withClient(async (c) => {
      const cwd = effectiveCwd();
      const { data, error } = await c.provider.list({ query: { directory: cwd } });
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
    });
  }
}

/** 探测宿主机默认 shell: 从 /pty/shells 取 (跨平台由宿主机 opencode 判定, 不猜浏览器 UA).
 *  macOS 偏好 zsh; Windows 偏好 pwsh; Linux 偏好 bash. */
async function probeDefaultShell(sdk: any, cwd: string): Promise<string> {
  try {
    const { data } = await sdk.pty.shells({ directory: cwd });
    const list = (data as any) as Array<{ name: string; path: string; acceptable: boolean }>;
    if (!Array.isArray(list) || !list.length) return '';
    const acc = list.filter((s) => s.acceptable);
    if (!acc.length) return '';
    const pick = isMac()
      ? (acc.find((s) => /zsh/i.test(s.name)) || acc.find((s) => /bash/i.test(s.name)) || acc[0])
      : isWindows()
        ? (acc.find((s) => /pwsh|powershell/i.test(s.name)) || acc[0])
        : isLinux()
          ? (acc.find((s) => /bash|sh/i.test(s.name)) || acc[0])
          : acc[0];
    return pick.path;
  } catch {
    return '';
  }
}

@Injectable()
export class AgentModule extends BrowserModule {
  providers = [
    { token: AgentToken, useClass: OpencodeServiceImpl },
    OpencodeServiceImpl,
  ];
  contributionProvider = ClientAppContribution;
}