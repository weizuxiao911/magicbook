/**
 * sandbox 实现 — service/sandbox/index.ts
 *
 * implements core/commands/sandbox 的 ISandbox: 对接 server /sandbox/*.
 * 主线程直连（轻量低频, 暂不进 worker）.
 *
 * 核心: 所有下游协议地址由 server 返回的完整 URL 驱动 —
 *   applyRuntime() 设置 agent/fs/registry 的 baseUrl（写全局配置）.
 * 前端只配置 APP_BASE_URL（server 入口）, 其他地址不拼不猜.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
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
@Domain('SandboxService')
export class SandboxServiceImpl implements ISandbox {
  static instance: SandboxServiceImpl | null = null;
  private runtime: SandboxRuntime | null = null;

  constructor() {
    SandboxServiceImpl.instance = this;
    (window as any).__APP_SANDBOX__ = this;
    console.log('[sandbox] service installed, appBaseUrl:', appBaseUrl() || '(unset)');
  }

  // 注意: 不自动加载 sandbox —— 登录后由 LoginView.doLogin 调 get() + applyRuntime()（用户设计）
  // sandbox service 只负责 查询/创建/重载 用户的沙箱, 无启动钩子

  async get(): Promise<SandboxRuntime> {
    const rt: SandboxRuntime = { runtimeId: 'default', cwd: '', opencode_base_url: `${appBaseUrl()}/ai`, fs_base_url: `${appBaseUrl()}/fs`, pty_base_url: '', default_shell: '/bin/zsh', mode: 'local' };
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
    // 由 server 返回的完整地址驱动各协议 baseUrl（写全局配置, service 各实现读取）
    (window as any).__APP_CONFIG__ = {
      ...((window as any).__APP_CONFIG__ || {}),
      agentUrl: rt.opencode_base_url,
      fsUrl: rt.fs_base_url,
      ptyUrl: rt.pty_base_url,
      defaultShell: rt.default_shell,
    };
    // runtime 就绪广播（agent/fs/terminal 等 service 监听后自建实例）
    window.dispatchEvent(new CustomEvent('runtime-ready', { detail: rt }));
    console.log('[sandbox] runtime applied:', {
      agent: rt.opencode_base_url,
      fs: rt.fs_base_url,
      pty: rt.pty_base_url,
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
    const rt: SandboxRuntime = { runtimeId: 'default', cwd: directory, opencode_base_url: `${appBaseUrl()}/ai`, fs_base_url: `${appBaseUrl()}/fs`, pty_base_url: '', default_shell: '/bin/zsh', mode: 'local' };
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
}