/**
 * 终端（远程 PTY）适配实现 — service/terminal.ts
 *
 * 注册为 opensumi 的 ITerminalServicePath（后端服务）:
 *   - NodePtyTerminalService（opensumi 终端前端）经 DI 注入本实现
 *   - opencode serve 直连（无 /ai 前缀, server 端 = opencode 自己）:
 *     POST {opencode}/pty 创建会话, WebSocket {opencode}/pty/{id}/connect 数据通道
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

/** opencode serve 地址（单一配置入口, appBaseUrl 直连, 无 /ai 前缀） */
function opencodeBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.appBaseUrl || '').replace(/\/+$/, '');
}

/** 当前 cwd → x-opencode-directory header（per-request 工作目录切换, APP_CWD 优先, 兜底 hostCwd; encodeURI 防中文路径 break header） */
function cwdHeader(): Record<string, string> {
  const cwd = localStorage.getItem('APP_CWD') || (window as any).__APP_CONFIG__?.cwd;
  return cwd ? { 'x-opencode-directory': encodeURI(cwd) } : {};
}

/** 默认 shell: 优先 applyRuntime 注入（宿主事实）; 未注入时先取默认值, ensureDefaultShell() 会从 server /platform 懒加载覆盖 */
function defaultShell(): string {
  return ((window as any).__APP_CONFIG__?.defaultShell as string) || '';
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

  /** 等 opencode 地址就绪（app_base_url 注入即就绪; 终端可能在登录前被创建） */
  private async waitPtyReady(): Promise<void> {
    if (opencodeBaseUrl()) return;
    await new Promise<void>((resolve) => {
      const onReady = () => {
        if (opencodeBaseUrl()) {
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

  /** 确保默认 shell 就绪: 未注入时从 opencode /pty/shells 取宿主默认（多平台由宿主机判定, 不猜浏览器 UA） */
  private async ensureDefaultShell(): Promise<void> {
    if ((window as any).__APP_CONFIG__?.defaultShell) return;
    try {
      const base = opencodeBaseUrl();
      if (!base) return;
      // /pty/shells 列出 opencode 探测到的可用 shell; macOS 偏好 zsh（acceptable=true 优先）
      const res = await fetch(`${base}/pty/shells`, { headers: { Accept: 'application/json', ...cwdHeader() } });
      if (res.ok) {
        const list = (await res.json()) as Array<{ name: string; path: string; acceptable: boolean }>;
        if (Array.isArray(list) && list.length) {
          const preferred = navigator.userAgent.includes('Mac')
            ? list.find((s) => s.acceptable && /zsh/i.test(s.name)) || list.find((s) => s.acceptable)
            : list.find((s) => s.acceptable && /bash/i.test(s.name)) || list.find((s) => s.acceptable);
          if (preferred) (window as any).__APP_CONFIG__.defaultShell = preferred.path;
        }
      }
    } catch { /* 忽略, 交给默认兜底 */ }
  }

  /** GET {opencode}/path 取宿主机绝对 cwd（pty 会话工作目录） */
  private async getPtyCwd(): Promise<string> {
    const base = opencodeBaseUrl();
    const res = await fetch(`${base}/path`, { headers: { Accept: 'application/json', ...cwdHeader() } });
    if (!res.ok) throw new Error(`pty /path ${res.status}`);
    const json = await res.json();
    const dir = json?.directory as string | undefined;
    return (dir || '/workspace').replace(/\/+$/, '');
  }

  /** POST {opencode}/pty 创建会话（spawn shell, cwd=宿主机绝对 workspace; 默认 shell 按 macOS 事实） */
  private async createPty(launchConfig: IShellLaunchConfig, cwd: string): Promise<{ id: string; pid: number; command: string }> {
    const base = opencodeBaseUrl();
    if (!base) throw new Error('opencode url not ready (appBaseUrl 未注入)');
    // 默认 shell（opencode /pty/shells 宿主事实, macOS zsh）优先: 前端可能在注入前就把 executable
    // 定为 bash（getDefaultSystemShell 早期调用）, 尊重它会导致刷新后 shell 变成 bash;
    // detectAvailableProfiles 只暴露 defaultShell 一个 profile, 用户显式选择不会冲突
    const command = defaultShell() || launchConfig.executable || '/bin/bash';
    const res = await fetch(`${base}/pty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cwdHeader() },
      body: JSON.stringify({
        command,
        args: (launchConfig.args as string[]) || undefined,
        cwd,
      }),
    });
    if (!res.ok) throw new Error(`pty create ${res.status}`);
    return res.json();
  }

  private wsUrl(ptyId: string, cwd: string): string {
    // WS 端点吃 query param directory（与 x-opencode-directory header 等价, 浏览器 WS API 不便加 header）
    return `${opencodeBaseUrl().replace(/^http/, 'ws')}/pty/${ptyId}/connect?directory=${encodeURIComponent(cwd)}`;
  }

  /** 创建终端会话（前端 sessionId = id） */
  async create2(id: string, _cols: number, _rows: number, launchConfig: IShellLaunchConfig): Promise<IPtyProcessProxy | undefined> {
    try {
      await this.waitPtyReady();
      await this.ensureDefaultShell();
      const cwd = await this.getPtyCwd();
      const info = await this.createPty(launchConfig, cwd);
      const ws = new WebSocket(this.wsUrl(info.id, cwd));
      // 等 ws 握手完成再返回（否则前端立即可输入, 触发 CONNECTING 态 send 报错）
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { ws.removeEventListener('open', onOpen); resolve(); }, 3000);
          const onOpen = () => { clearTimeout(timer); resolve(); };
          ws.addEventListener('open', onOpen);
        });
      }
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
    const ws = this.channels.get(id)?.ws;
    // 连接未就绪/已断, 丢弃输入（避免 CONNECTING 态 send 抛 InvalidStateError）
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const json = JSON.parse(msg) as { data?: string };
      if (typeof json.data === 'string') {
        ws.send(json.data);
      }
      return;
    } catch {
      /* 非 JSON: 原始文本输入 */
    }
    ws.send(msg);
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
    const shell = defaultShell() || '/bin/bash';
    return [{ profileName: shell.split('/').pop() || shell, path: shell }];
  }

  /** 默认 shell: server /platform 宿主事实（applyRuntime 注入优先） */
  async getDefaultSystemShell(_os: OperatingSystem): Promise<string> {
    return defaultShell() || '/bin/bash';
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