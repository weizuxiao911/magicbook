/**
 * sandbox 实现 — service/sandbox/index.ts
 *
 * implements core/commands/sandbox 的 ISandbox: 对接 server /sandbox/*.
 * 主线程直连（轻量低频, 暂不进 worker）.
 *
 * 核心: 只有 app_base_url 一个配置入口（编译期注入 __APP_BASE_URL__）;
 *   各协议地址由 service 自拼: opencode = appBaseUrl/ai, fs = appBaseUrl/fs（sandbox 反向代理）.
 * applyRuntime 只保留运行时信息（cwd/default_shell）并广播 runtime-ready.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';

import type { ISandbox, SandboxEvent, SandboxRuntime } from '../core/commands/sandbox';
import { SandboxToken } from '../core/commands/sandbox';

/** 服务地址（.env APP_BASE_URL, 编译期注入） */
function appBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.appBaseUrl || '').replace(/\/+$/, '');
}

/** 登录身份请求头（X-User-Id） */
function authHeaders(): Record<string, string> {
  const auth = (window as any).__APP_AUTH__;
  return { 'X-User-Id': auth?.getUsername?.() || 'default' };
}

@Injectable()
@Domain('SandboxService', ClientAppContribution)
export class SandboxServiceImpl implements ISandbox, ClientAppContribution {
  static instance: SandboxServiceImpl | null = null;
  private runtime: SandboxRuntime | null = null;

  constructor() {
    SandboxServiceImpl.instance = this;
    (window as any).__APP_SANDBOX__ = this;
    console.log('[sandbox] service installed, appBaseUrl:', appBaseUrl() || '(unset)');
  }

  /** 应用启动: 有 APP_CWD 时自动初始化（ensure + /sandbox + applyRuntime 注入 shell/状态）;
   *  无 APP_CWD 由 WorkspacePicker 选目录后 setWorkspace() 走同一链路 */
  onStart(): void {
    if (localStorage.getItem('APP_CWD')) {
      void this.get().then((rt) => this.applyRuntime(rt));
    }
  }

  // 注意: 不自动加载 sandbox —— 登录后由 LoginView.doLogin 调 get() + applyRuntime()（用户设计）
  // sandbox service 只负责 查询/创建/重载 用户的沙箱, 无启动钩子

  async get(): Promise<SandboxRuntime> {
    const base = appBaseUrl();
    const cwd = localStorage.getItem('APP_CWD');
    if (!cwd) {
      // 无 APP_CWD: 未选工作目录, 不访问 /sandbox（无沙箱上下文）, 地址仍由 app_base_url 派生
      const rt: SandboxRuntime = { runtimeId: 'default', cwd: '', opencode_base_url: `${base}/ai`, fs_base_url: `${base}/fs`, pty_base_url: '', default_shell: '/bin/bash', mode: 'local' };
      this.runtime = rt;
      return rt;
    }
    // 有 APP_CWD: 先确保 opencode/fs 就绪（幂等: 活且 cwd 匹配则不动）, 避免 sandbox/opencode
    // 重启后 chat 直接 502
    try {
      const res = await fetch(`${base}/workspace/ensure?cwd=${encodeURIComponent(cwd)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) console.warn('[sandbox] ensure opencode 未就绪:', res.status);
    } catch (e) {
      // 不阻塞: SDK/fs 请求仍会带 X-Current-Cwd 由 sandbox 中间件兜底拉起
      console.warn('[sandbox] ensure opencode 请求失败:', e);
    }
    // 拉取沙箱信息接口: 各 baseurl + 默认 shell + opencode/fs 连接状态
    let info: any = null;
    try {
      const res = await fetch(`${base}/sandbox`, { headers: { Accept: 'application/json' } });
      if (res.ok) info = await res.json();
    } catch (e) {
      console.warn('[sandbox] /sandbox 拉取失败 (mock 兜底):', e);
    }
    const rt: SandboxRuntime = {
      runtimeId: info?.runtimeId || 'default',
      cwd: info?.cwd || cwd || '',
      opencode_base_url: info?.opencode_base_url ? `${base}${info.opencode_base_url}` : `${base}/ai`,
      fs_base_url: info?.fs_base_url ? `${base}${info.fs_base_url}` : `${base}/fs`,
      pty_base_url: info?.pty_base_url || '',
      default_shell: info?.default_shell || '/bin/bash',
      mode: info?.mode || 'local',
      status: info?.status,
    };
    this.runtime = rt;
    return rt;
  }

  async create(): Promise<SandboxRuntime> {
    return this.get();
  }

  onEvents(runtimeId: string, handler: (e: SandboxEvent) => void): () => void {
    return () => {};
  }

  getRuntime(): SandboxRuntime | null {
    return this.runtime;
  }

  getMode(): 'local' | 'cluster' | null {
    return this.runtime?.mode ?? null;
  }

  applyRuntime(rt: SandboxRuntime): void {
    this.runtime = rt;
    // 只有 app_base_url 一个配置入口: 各协议地址由 service 自拼（appBaseUrl/ai、appBaseUrl/fs）,
    // 这里只保留运行时信息 + 默认 shell 偏好
    (window as any).__APP_CONFIG__ = {
      ...((window as any).__APP_CONFIG__ || {}),
      defaultShell: rt.default_shell,
    };
    // runtime 就绪广播（agent/fs/terminal 等 service 监听后自建实例）
    window.dispatchEvent(new CustomEvent('runtime-ready', { detail: rt }));
    console.log('[sandbox] runtime applied:', {
      cwd: rt.cwd,
      defaultShell: rt.default_shell,
    });
  }

  private async http<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers || {}) },
      ...init,
    });
    if (!res.ok) {
      throw new Error(`sandbox API ${res.status}: ${url}`);
    }
    return res.json() as Promise<T>;
  }

  async setWorkspace(directory: string): Promise<SandboxRuntime> {
    const res = await fetch(`${appBaseUrl()}/workspace/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory }),
    });
    if (!res.ok) throw new Error(`setWorkspace failed: ${res.status}`);
    const j = await res.json();
    const rt: SandboxRuntime = { runtimeId: 'default', cwd: directory, opencode_base_url: `${appBaseUrl()}/ai`, fs_base_url: `${appBaseUrl()}/fs`, pty_base_url: '', default_shell: j?.default_shell || '/bin/bash', mode: 'local' };
    this.runtime = rt;
    return rt;
  }

  async browse(path: string): Promise<{ path: string; directories: Array<{ name: string; path: string }> }> {
    const res = await fetch(`${appBaseUrl()}/workspace/browse?path=${encodeURIComponent(path)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`browse failed: ${res.status}`);
    return res.json();
  }

  async mkdir(parent: string, name: string): Promise<{ ok: boolean; path: string }> {
    const res = await fetch(`${appBaseUrl()}/workspace/mkdir`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name }),
    });
    if (!res.ok) throw new Error(`mkdir failed: ${res.status}`);
    return res.json();
  }
}

/** 模块级单例 getter（容器外取用） */
export function getSandboxService(): ISandbox {
  return SandboxServiceImpl.instance || (SandboxServiceImpl.instance = new SandboxServiceImpl());
}

@Injectable()
export class SandboxModule extends BrowserModule {
  providers = [
    { token: SandboxToken, useFactory: () => getSandboxService() },
    SandboxServiceImpl,
  ];

  contributionProvider = ClientAppContribution;
}