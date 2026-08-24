/**
 * 终端（远程 PTY）适配实现 — service/terminal.ts
 *
 * 注册为 opensumi 的 ITerminalServicePath（后端服务）:
 *   - NodePtyTerminalService（opensumi 终端前端）经 DI 注入本实现
 *   - pty_base_url 由 /sandbox 返回（登录后 applyRuntime 注入）; client 只消费 pty 服务的通用契约:
 *     POST {pty_base_url}/pty 创建会话, WebSocket {pty_base_url}/pty/{id}/connect 数据通道
 *   - 输出含服务端控制帧（\u0000{json}, 如 cursor 同步）→ 过滤后为 pty 数据; 输入为纯文本
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { Domain, OperatingSystem } from '@opensumi/ide-core-common';
import {
  ITerminalService,
  ITerminalServicePath,
  type IPtyProcessProxy,
  type IShellLaunchConfig,
  type ITerminalNodeService,
  type ITerminalServiceClient,
} from '@opensumi/ide-terminal-next/lib/common';

/** pty_base_url（/sandbox 返回, 登录后 applyRuntime 注入） */
function ptyBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.ptyUrl || '').replace(/\/+$/, '');
}

interface Channel {
  ptyId: string;
  ws: WebSocket | null;
  name: string;
}

@Injectable()
@Domain('TerminalService')
export class RemoteTerminalService implements ITerminalNodeService {
  static instance: RemoteTerminalService | null = null;

  /** browser 侧终端 client（NodePtyTerminalService, ITerminalService token）: 输出/退出回调目标 */
  @Autowired(ITerminalService)
  private readonly terminalClient!: ITerminalService;

  private channels = new Map<string, Channel>();
  private client: ITerminalServiceClient | null = null;

  constructor() {
    RemoteTerminalService.instance = this;
    (window as any).__APP_TERMINAL__ = this;
  }

  /** 等 pty_base_url 就绪（登录后 applyRuntime 注入; 终端可能在登录前被创建） */
  private async waitPtyReady(): Promise<void> {
    if (ptyBaseUrl()) return;
    await new Promise<void>((resolve) => {
      const onReady = () => {
        if (ptyBaseUrl()) {
          window.removeEventListener('runtime-ready', onReady);
          resolve();
        }
      };
      window.addEventListener('runtime-ready', onReady);
      setTimeout(() => {
        window.removeEventListener('runtime-ready', onReady);
        resolve();
      }, 5000);
    });
  }

  /** GET {pty_base_url}/path 取宿主机绝对 cwd（pty 会话工作目录） */
  private async getPtyCwd(): Promise<string> {
    const base = ptyBaseUrl();
    const res = await fetch(`${base}/path`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`pty /path ${res.status}`);
    const json = await res.json();
    const dir = json?.directory as string | undefined;
    return (dir || '/workspace').replace(/\/+$/, '');
  }

  /** POST {pty_base_url}/pty 创建会话（spawn shell, cwd=宿主机绝对 workspace; 默认 shell 由 sandbox 返回） */
  private async createPty(launchConfig: IShellLaunchConfig, cwd: string): Promise<{ id: string; pid: number; command: string }> {
    const base = ptyBaseUrl();
    if (!base) throw new Error('pty base url not ready (sandbox runtime 未应用)');
    // 默认 shell 以 sandbox 返回为准（前端 executable 可能在 runtime 就绪前被设为 fallback）;
    // 用户显式指定的 executable 仍优先
    const defaultShell = (window as any).__APP_CONFIG__?.defaultShell as string | undefined;
    const command = defaultShell || launchConfig.executable || '/bin/bash';
    const res = await fetch(`${base}/pty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        args: (launchConfig.args as string[]) || undefined,
        cwd,
        directory: cwd,
      }),
    });
    if (!res.ok) throw new Error(`pty create ${res.status}`);
    return res.json();
  }

  private wsUrl(ptyId: string, cwd: string): string {
    return `${ptyBaseUrl().replace(/^http/, 'ws')}/pty/${ptyId}/connect?directory=${encodeURIComponent(cwd)}`;
  }

  /** 创建终端会话（前端 sessionId = id） */
  async create2(id: string, _cols: number, _rows: number, launchConfig: IShellLaunchConfig): Promise<IPtyProcessProxy | undefined> {
    try {
      await this.waitPtyReady();
      const cwd = await this.getPtyCwd();
      const info = await this.createPty(launchConfig, cwd);
      const ws = new WebSocket(this.wsUrl(info.id, cwd));
      const client = this.terminalClient as any;
      ws.onmessage = (e) => {
        const data = typeof e.data === 'string' ? e.data : '';
        // 过滤 pty 服务控制帧: 去 \u0000 前缀; cursor/resize 等 JSON 帧跳过, 其余为 pty 数据
        const trimmed = data.replace(/^\u0000+/, '');
        if (
          trimmed.startsWith('{"cursor"') ||
          trimmed.startsWith('{"type":"cursor"') ||
          trimmed.startsWith('{"type":"resize"') ||
          (trimmed.startsWith('{') && trimmed.includes('"method"'))
        ) {
          return;
        }
        client?.onMessage?.(id, trimmed);
      };
      ws.onclose = () => {
        client?.closeClient?.(id, 0);
      };
      ws.onerror = () => ws.close();
      const shellName = info.command.split('/').pop() || info.command;
      this.channels.set(id, { ptyId: info.id, ws, name: shellName });
      console.log('[terminal] create2 ok:', id, '→', info.id, shellName);
      // IPtyProcessProxy extends node-pty IPty; 前端主要消费 name/pid/launchConfig, 其余按需补充
      return {
        id: info.id,
        name: shellName,
        pid: info.pid,
        process: info.command,
        bin: info.command,
        launchConfig,
        parsedName: shellName,
        getProcessDynamically: () => info.command,
        getCwd: async () => cwd,
      } as unknown as IPtyProcessProxy;
    } catch (err) {
      console.warn('[terminal] create2 failed:', id, err);
      return undefined;
    }
  }

  /** 前端输入 → ws: 只转发 {data} 文本（resize 等控制帧忽略, 不发给 shell） */
  onMessage(id: string, msg: string): void {
    try {
      const json = JSON.parse(msg) as { data?: string };
      if (typeof json.data === 'string') {
        this.channels.get(id)?.ws?.send(json.data);
      }
      return;
    } catch {
      /* 非 JSON: 原始文本输入 */
    }
    this.channels.get(id)?.ws?.send(msg);
  }

  resize(id: string, _rows: number, _cols: number): void {
    // server 侧伪 TTY 暂不处理动态尺寸（固定 80x24 语义）; 预留
  }

  getShellName(id: string): string {
    return this.channels.get(id)?.name || '';
  }

  async getCwd(_id: string): Promise<string | undefined> {
    return '/workspace';
  }

  getProcessId(_id: string): number {
    return 0;
  }

  disposeById(id: string): void {
    this.channels.get(id)?.ws?.close();
    this.channels.delete(id);
  }

  dispose(): void {
    this.channels.forEach((c) => c.ws?.close());
    this.channels.clear();
  }

  setClient(_clientId: string, client: ITerminalServiceClient): void {
    this.client = client;
  }

  closeClient(_clientId: string): void {
    this.client = null;
  }

  async ensureClientTerminal(_clientId: string, _terminalIdArr: string[]): Promise<boolean> {
    return true;
  }

  // ---- 平台/配置（本地开发: 浏览器环境 ≈ 宿主机 macOS; 跨平台按需扩展）----

  getOS(): OperatingSystem {
    return navigator.userAgent.includes('Mac') ? OperatingSystem.Macintosh : OperatingSystem.Linux;
  }

  async getCodePlatformKey(): Promise<'osx' | 'windows' | 'linux'> {
    return navigator.userAgent.includes('Mac') ? 'osx' : 'linux';
  }

  async detectAvailableProfiles(): Promise<{ profileName: string; path: string }[]> {
    return [{ profileName: 'bash', path: '/bin/bash' }];
  }

  /** 默认 shell: /sandbox 返回（宿主机事实, applyRuntime 注入） */
  async getDefaultSystemShell(_os: OperatingSystem): Promise<string> {
    return ((window as any).__APP_CONFIG__?.defaultShell as string) || '/bin/bash';
  }
}

/** 注册 ITerminalServicePath（opensumi 终端后端服务 = 远程 PTY 代理; useClass 由 DI 管理实例, @Autowired 注入可用） */
@Injectable()
export class TerminalModule extends BrowserModule {
  providers = [
    { token: ITerminalServicePath, useClass: RemoteTerminalService },
    RemoteTerminalService,
  ];
}