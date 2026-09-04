/**
 * service/pty/pty.service.ts
 *
 * RemoteTerminalService — opensumi ITerminalNodeService 实现 (codeblitz Terminal 后端).
 *
 * 跨平台 PTY: opencode 直连 (无 /ai 前缀), 走 SDK pty.create + WS /pty/{id}/connect.
 * shell 选择由 opencode 后端 /pty/shells 探测 (不靠浏览器 UA 猜).
 *
 * DI 注册: TerminalModule.providers: [{ token: ITerminalServicePath, useClass: RemoteTerminalService }, RemoteTerminalService]
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
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import { appBaseUrl, cwdHeader, effectiveCwd, secureUrl } from '../../infra/url';
import { isMac } from '../../infra/os';
import { toHostPath } from '../../infra/path';
import { whenHostAnchors } from '../../infra/host';

import { pickShell } from './shell-ops';

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
  @Autowired(ITerminalService)
  private readonly terminalClient!: ITerminalService;

  private channels = new Map<string, Channel>();
  private client: ITerminalServiceClient | null = null;
  private sdk: ReturnType<typeof createOpencodeClient> | null = null;

  private ensureSdk(): ReturnType<typeof createOpencodeClient> {
    if (this.sdk) return this.sdk;
    const base = appBaseUrl();
    if (!base) throw new Error('opencode url not ready (appBaseUrl 未注入)');
    // 铁律 8: 必须传 directory 让 SDK 把 x-opencode-directory header 注入到每个请求.
    const cwd = effectiveCwd();
    this.sdk = createOpencodeClient({
      baseUrl: base,
      directory: cwd,
      headers: cwdHeader(),
      responseStyle: 'fields',
      throwOnError: true,
    });
    return this.sdk;
  }

  /** 等 pty 地址就绪 */
  private async waitPtyReady(): Promise<void> {
    if (appBaseUrl()) return;
    await new Promise<void>((resolve) => {
      const onReady = () => {
        if (appBaseUrl()) {
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

  /** 等 runtime-ready (initRuntime 注入 defaultShell/cwd) — 超时 5s 不阻塞 */
  private async waitRuntimeReady(): Promise<void> {
    if ((window as any).__APP_CONFIG__?.defaultShell) return;
    await new Promise<void>((resolve) => {
      const onReady = () => {
        window.removeEventListener('runtime-ready', onReady);
        resolve();
      };
      window.addEventListener('runtime-ready', onReady);
      setTimeout(() => {
        window.removeEventListener('runtime-ready', onReady);
        resolve();
      }, 5000);
    });
  }

  private async resolveLaunchCwd(launchConfig: IShellLaunchConfig): Promise<string> {
    const base = effectiveCwd();
    const raw = launchConfig.cwd;
    if (raw) {
      const s = typeof raw === 'string' ? raw : ((raw as any).fsPath || String(raw)) as string;
      const anchors = await whenHostAnchors();
      const directory = anchors.directory || base;
      // 虚拟根 ('/' / '/workspace' / WORKSPACE_ROOT) → 真实工作目录
      if (s === '/') return directory || s;
      // 虚拟路径 (/home/..., /home/AppData/Roaming, /workspace/...) → 锚定真实 home/directory;
      // 真实宿主绝对路径 (POSIX/Windows 盘符) 规范化返回; 无法锚定 → null
      const host = toHostPath(s, anchors);
      if (host) return host;
      // 真·相对路径 → directory/rel
      const rel = s.replace(/^\/+/, '');
      if (rel && directory) return `${directory.replace(/\/+$/, '')}/${rel}`;
    }
    return this.getPtyCwd();
  }

  private async ensureDefaultShell(): Promise<void> {
    if ((window as any).__APP_CONFIG__?.defaultShell) return;
    try {
      const c = this.ensureSdk();
      const { data, error } = await c.pty.shells({ directory: effectiveCwd() });
      if (!error && Array.isArray(data) && data.length) {
        const list = data as Array<{ name: string; path: string; acceptable: boolean }>;
        const preferred = isMac()
          ? (list.find((s) => s.acceptable && /zsh/i.test(s.name)) || list.find((s) => s.acceptable))
          : (list.find((s) => s.acceptable && /bash/i.test(s.name)) || list.find((s) => s.acceptable));
        if (preferred) (window as any).__APP_CONFIG__.defaultShell = preferred.path;
      }
    } catch { /* 忽略 */ }
  }

  private async getPtyCwd(): Promise<string> {
    const c = this.ensureSdk();
    const { data, error } = await c.path.get({ directory: effectiveCwd() });
    if (error) throw new Error(`pty /path ${(error as any)?.message || 'unknown'}`);
    const dir = (data as any)?.directory as string | undefined;
    return (dir || '/workspace').replace(/\/+$/, '');
  }

  private async createPty(launchConfig: IShellLaunchConfig, cwd: string): Promise<{ id: string; pid: number; command: string }> {
    const command = defaultShell() || launchConfig.executable || '/bin/bash';
    const c = this.ensureSdk();
    // numas: only send `directory` (the workspace dir). Do NOT send body `cwd` —
    // the server enforces header-only workspace resolution and always uses the
    // instance dir for the PTY's actual cwd, so body `cwd` is ignored anyway and
    // risks sending a wrong (e.g. codeblitz-garbled) value.
    const { data, error } = await c.pty.create({
      directory: cwd,
      command,
      args: (launchConfig.args as string[]) || undefined,
    });
    if (error || !data) throw new Error(`pty create ${(error as any)?.message || 'failed'}`);
    return data as { id: string; pid: number; command: string };
  }

  private wsUrl(ptyId: string, cwd: string): string {
    // numas fork: 铁律 8 — workspace 路径统一走 header. WS URL ?directory= 用 encodeURI 形态
    // (浏览器 fetch/WS 对 URL 路径/查询无 ISO-8859-1 限制, 但 server 端仍走 header 解析;
    // 这里 encodeURI 是为中文路径 URL 安全, server workspace-routing 默认忽略 query).
    const wsBase = secureUrl(appBaseUrl()).replace(/^http/, 'ws');
    return `${wsBase}/pty/${ptyId}/connect?directory=${encodeURI(cwd)}`;
  }

  async create2(id: string, _cols: number, _rows: number, launchConfig: IShellLaunchConfig): Promise<IPtyProcessProxy | undefined> {
    try {
      await this.waitPtyReady();
      await this.waitRuntimeReady();
      await this.ensureDefaultShell();
      const cwd = await this.resolveLaunchCwd(launchConfig);
      const info = await this.createPty(launchConfig, cwd);
      const ws = new WebSocket(this.wsUrl(info.id, cwd));
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
      ws.onclose = () => { client?.closeClient?.(id, 0); };
      ws.onerror = () => ws.close();
      const shellName = info.command.split('/').pop() || info.command;
      this.channels.set(id, { ptyId: info.id, ws, name: shellName });
      console.log('[terminal] create2 ok:', id, '→', info.id, shellName);
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

  onMessage(id: string, msg: string): void {
    const ws = this.channels.get(id)?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // opensumi 前端所有输入都包成 JSON 帧 {"id":N,...}:
    //   输入 = {"id":N,"data":"..."}  → 转发 data 到 pty
    //   resize = {"id":N,"method":"resize","params":{cols,rows}}  → 控制帧, 丢弃不转发 (否则 JSON 原文会打进 shell)
    // 非 JSON 原始文本兜底直接转发
    try {
      const json = JSON.parse(msg) as { data?: string; method?: string };
      if (json && typeof json === 'object') {
        if (typeof json.data === 'string') ws.send(json.data);
        return;
      }
    } catch { /* 非 JSON: 原始文本 */ }
    ws.send(msg);
  }

  resize(id: string, _rows: number, _cols: number): void {
    /* server 侧伪 TTY 暂不处理动态尺寸 */
  }

  getShellName(id: string): string { return this.channels.get(id)?.name || ''; }
  async getCwd(_id: string): Promise<string | undefined> { return '/workspace'; }
  getProcessId(_id: string): number { return 0; }

  disposeById(id: string): void { this.channels.get(id)?.ws?.close(); this.channels.delete(id); }
  dispose(): void { this.channels.forEach((c) => c.ws?.close()); this.channels.clear(); }

  setClient(_clientId: string, client: ITerminalServiceClient): void { this.client = client; }
  closeClient(_clientId: string): void { this.client = null; }
  async ensureClientTerminal(_clientId: string, _terminalIdArr: string[]): Promise<boolean> { return true; }

  // ---- 平台/配置 (跨平台: 浏览器环境 ≈ 宿主机, 跨 OS 由 opencode /pty/shells 探测) ----

  getOS(): OperatingSystem {
    return isMac() ? OperatingSystem.Macintosh : OperatingSystem.Linux;
  }

  async getCodePlatformKey(): Promise<'osx' | 'windows' | 'linux'> {
    return isMac() ? 'osx' : 'linux';
  }

  async detectAvailableProfiles(): Promise<{ profileName: string; path: string }[]> {
    const shell = defaultShell() || '/bin/bash';
    return [{ profileName: shell.split('/').pop() || shell, path: shell }];
  }

  async getDefaultSystemShell(_os: OperatingSystem): Promise<string> {
    return defaultShell() || '/bin/bash';
  }
}

/** 注册 ITerminalServicePath (opensumi 终端后端服务 = 远程 PTY 代理).
 *  useClass 由 DI 管理实例, @Autowired 注入可用. */
@Injectable()
export class TerminalModule extends BrowserModule {
  providers = [
    { token: ITerminalServicePath, useClass: RemoteTerminalService },
    RemoteTerminalService,
  ];
}

/** 暴露给 fs.ts 的 wrapWithMarker (fs-pty 内部用) */
export function wrapFsPtyCommand(body: string, ops: import('./shell-ops').ShellOps, completionMarker: string): string {
  if (ops.kind === 'posix') return `${body} && echo __FS_OK__ ; echo ${completionMarker}`;
  if (ops.kind === 'powershell') return `${body}; if ($?) { Write-Output __FS_OK__ }; Write-Output ${completionMarker}`;
  return `${body} & echo __FS_OK__ & echo ${completionMarker}`;
}

/** 暴露给 fs.ts 的 pickShell (fs-pty 内部用) */
export function pickFsPtyShell(
  list: Array<{ name: string; path: string; acceptable: boolean }>,
  kind: import('./shell-ops').ShellKind,
): string {
  return pickShell(list, kind);
}