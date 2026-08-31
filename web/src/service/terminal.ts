/**
 * terminal + shell-ops — service/terminal.ts
 *
 * 合并: 终端(远程 PTY)适配实现 + 平台抽象(shell 命令构造器)
 *
 * terminal 职责:
 *   - 注册为 opensumi 的 ITerminalServicePath(后端服务)
 *   - opencode serve 直连(无 /ai 前缀, server 端 = opencode 自己):
 *     POST {opencode}/pty 创建会话, WebSocket {opencode}/pty/{id}/connect 数据通道
 *   - 输出含服务端控制帧(\u0000{json}, 如 cursor 同步) → 过滤后为 pty 数据; 输入为纯文本
 *
 * shell-ops 职责 (被 fs.ts 复用, 写文件走 PTY 跑平台原生命令):
 *   - 平台分流: mac/linux=POSIX (bash/zsh), win=PowerShell
 *   - 命令构造器 (writeFile/readFileBase64/rm/mkdirp/move/stat)
 *   - 路径转义防注入
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

import { appBaseUrl, cwdHeader, effectiveCwd, secureUrl } from './env';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

// ---- shell-ops (合并自 service/shell-ops.ts) ----

export type Platform = 'mac' | 'linux' | 'windows' | 'unknown';
export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface ShellOps {
  kind: ShellKind;
  /** 把 base64 内容写入文件 (含 mkdir -p 父目录); 返回完整 shell 命令 */
  writeFile(absPath: string, base64Content: string): string;
  /** 读文件 base64 (供 readBinary 用) */
  readFileBase64(absPath: string): string;
  /** rm -rf 强制删除 (文件/目录都可用) */
  rm(absPath: string): string;
  /** rmdir -p 删空目录 (unlink 删目录 ENOTSUP, 区分走 rmdir) */
  rmdir(absPath: string): string;
  /** mkdir -p 递归建目录 */
  mkdirp(absPath: string): string;
  /** 移动/重命名 */
  move(fromAbs: string, toAbs: string): string;
  /** stat: 输出 "<type>|<size>|<mtime-epoch-seconds>" 格式供 fs.ts 解析 */
  stat(absPath: string): string;
  /** 写文件成功后输出 marker; 失败 (命令 exit != 0) 不输出 */
  successMarker(): string;
  /** 包装完整命令: 命令本体 + successMarker, 整体由 PTY exec 一次跑 */
  wrapCommand(body: string): string;
}

/** POSIX (bash / zsh / sh) — macOS + Linux */
const POSIX: ShellOps = {
  kind: 'posix',
  writeFile: (p, b64) =>
    `mkdir -p $(dirname ${shellQuotePosix(p)}) && printf %s ${shellQuotePosix(b64)} | base64 -d > ${shellQuotePosix(p)}`,
  readFileBase64: (p) => `base64 ${shellQuotePosix(p)} 2>/dev/null`,
  rm: (p) => `rm -rf ${shellQuotePosix(p)}`,
  rmdir: (p) => `rmdir ${shellQuotePosix(p)}`,
  mkdirp: (p) => `mkdir -p ${shellQuotePosix(p)}`,
  move: (f, t) => `mv ${shellQuotePosix(f)} ${shellQuotePosix(t)}`,
  stat: (p) =>
    `stat -c '%F|%s|%.Y' ${shellQuotePosix(p)} 2>/dev/null || stat -f '%HT|%z|%m' ${shellQuotePosix(p)} 2>/dev/null`,
  successMarker: () => 'echo __FS_OK__',
  wrapCommand: (body) => `${body} && echo __FS_OK__`,
};

/** PowerShell — Windows (pwsh / powershell) */
const POWERSHELL: ShellOps = {
  kind: 'powershell',
  writeFile: (p, b64) =>
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(p)}) | Out-Null; ` +
    `[System.IO.File]::WriteAllBytes(${psQuote(p)}, [System.Convert]::FromBase64String(${psQuote(b64)}))`,
  readFileBase64: (p) => `[Convert]::ToBase64String([System.IO.File]::ReadAllBytes(${psQuote(p)}))`,
  rm: (p) => `Remove-Item -Recurse -Force ${psQuote(p)}`,
  rmdir: (p) => `Remove-Item -Force ${psQuote(p)}`,
  mkdirp: (p) => `New-Item -ItemType Directory -Force -Path ${psQuote(p)} | Out-Null`,
  move: (f, t) => `Move-Item -Force ${psQuote(f)} ${psQuote(t)}`,
  stat: (p) =>
    `$f=Get-Item ${psQuote(p)} -ErrorAction SilentlyContinue; ` +
    `if ($f) { $t=if($f.PSIsContainer){'directory'}else{'file'}; Write-Output ($t + '|' + $f.Length + '|' + [int][double]::Parse((Get-Date -Date $f.LastWriteTime -UFormat %s))) } else { Write-Output 'MISSING' }`,
  successMarker: () => 'Write-Output __FS_OK__',
  wrapCommand: (body) => `${body}; if ($?) { Write-Output __FS_OK__ }`,
};

/** cmd.exe — Windows 兜底 (无 PowerShell 时的最后回退) */
const CMD: ShellOps = {
  kind: 'cmd',
  writeFile: (_p, _b64) => { throw new Error('cmd.exe not implemented for write (install PowerShell)'); },
  readFileBase64: (_p) => { throw new Error('cmd.exe not implemented for readBinary'); },
  rm: (p) => `rmdir /S /Q ${cmdQuote(p)} 2>NUL & exit /B 0`,
  rmdir: (p) => `rmdir ${cmdQuote(p)} 2>NUL & exit /B 0`,
  mkdirp: (p) => `mkdir ${cmdQuote(p)} 2>NUL`,
  move: (f, t) => `move /Y ${cmdQuote(f)} ${cmdQuote(t)}`,
  stat: (_p) => { throw new Error('cmd.exe not implemented for stat'); },
  successMarker: () => 'echo __FS_OK__',
  wrapCommand: (body) => body,
};

/** 浏览器 UA 探测宿主平台 (假设浏览器与 opencode 同机, 这是绝大多数 dev 用例) */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  try {
    const uaData: any = (navigator as any).userAgentData;
    const p: string = (typeof uaData?.platform === 'string' ? uaData.platform : '') || navigator.platform || '';
    if (/mac/i.test(p)) return 'mac';
    if (/win/i.test(p)) return 'windows';
    if (/linux/i.test(p)) return 'linux';
  } catch { /* ignore */ }
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'mac';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'unknown';
}

/** 按 opencode /pty/shells 探测的可用 shell 名, 选 shell kind */
export function pickShellKind(shellList: Array<{ name: string; path: string; acceptable: boolean }>, platform: Platform): ShellKind {
  const acc = shellList.filter((s) => s.acceptable);
  if (!acc.length) {
    return platform === 'windows' ? 'cmd' : 'posix';
  }
  const names = acc.map((s) => s.name.toLowerCase());
  if (names.some((n) => /pwsh|powershell/.test(n))) return 'powershell';
  if (names.some((n) => /^cmd$/.test(n)) && platform === 'windows') return 'cmd';
  if (names.some((n) => /bash|zsh|sh|fish/.test(n))) return 'posix';
  return platform === 'windows' ? 'powershell' : 'posix';
}

/** 按 shell kind 取命令构造器 */
export function getShellOps(kind: ShellKind): ShellOps {
  if (kind === 'powershell') return POWERSHELL;
  if (kind === 'cmd') return CMD;
  return POSIX;
}

/** POSIX 单引号包裹: 内容里的 ' 替换为 '"'"' */
export function shellQuotePosix(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

/** PowerShell 双引号包裹: 内部双引号用 \", 反引号转义保留 */
function psQuote(s: string): string {
  return `"${s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')}"`;
}

/** cmd.exe 双引号包裹: 内部双引号 \", 路径斜杠保留 */
function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** 从 shell 列表按 kind 选具体命令路径 (用于 pty.create 的 command 字段) */
function pickShell(
  list: Array<{ name: string; path: string; acceptable: boolean }>,
  kind: ShellKind,
): string {
  const acc = list.filter((s) => s.acceptable);
  if (!acc.length) {
    return kind === 'powershell' ? 'powershell.exe' : kind === 'cmd' ? 'cmd.exe' : '/bin/sh';
  }
  if (kind === 'powershell') {
    return acc.find((s) => /pwsh/i.test(s.name))?.path
      || acc.find((s) => /powershell/i.test(s.name))?.path
      || acc[0].path;
  }
  if (kind === 'cmd') {
    return acc.find((s) => /^cmd$/i.test(s.name))?.path || acc[0].path;
  }
  return acc.find((s) => /zsh/i.test(s.name))?.path
    || acc.find((s) => /bash/i.test(s.name))?.path
    || acc.find((s) => /sh/i.test(s.name))?.path
    || acc[0].path;
}

// ---- terminal ----

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
  private sdk: ReturnType<typeof createOpencodeClient> | null = null;

  /** 懒建 SDK client（HTTP 部分走 SDK; WS connect 仍直连 opencode） */
  private ensureSdk(): ReturnType<typeof createOpencodeClient> {
    if (this.sdk) return this.sdk;
    const base = appBaseUrl();
    if (!base) throw new Error('opencode url not ready (appBaseUrl 未注入)');
    this.sdk = createOpencodeClient({
      baseUrl: base,
      headers: cwdHeader(),
      responseStyle: 'fields',
      throwOnError: true,
    });
    return this.sdk;
  }

  constructor() {
    RemoteTerminalService.instance = this;
    (window as any).__APP_TERMINAL__ = this;
  }

  /** 等 pty 地址就绪（app_base_url 注入即就绪; 终端可能在登录前被创建） */
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

  /** 等 runtime-ready (initRuntime 注入 defaultShell/cwd) — 超时 5s 不阻塞, 保证 shell 类型是宿主事实而非 OpenSumi 默认 */
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

  /**
   * 解析终端工作目录: launchConfig.cwd (OpenSumi 传入, codeblitz 虚拟路径 /workspace/xxx) → 宿主机绝对路径.
   * 无 cwd (普通新建终端) → workspace 根 (getPtyCwd).
   * 路径映射 (问题 3): codeblitz /workspace/rel ↔ 宿主机 effectiveCwd()/rel ↔ opencode x-opencode-directory (effectiveCwd)
   */
  private async resolveLaunchCwd(launchConfig: IShellLaunchConfig): Promise<string> {
    const raw = launchConfig.cwd;
    if (raw) {
      const s = typeof raw === 'string' ? raw : ((raw as any).fsPath || String(raw)) as string;
      const rel = s.replace(/^\/workspace(?:\/|$)/, '').replace(/^\/+/, '');
      if (rel) {
        const base = effectiveCwd();
        if (base) return `${base.replace(/\/+$/, '')}/${rel}`;
      }
    }
    return this.getPtyCwd();
  }

  /** 确保默认 shell 就绪: 未注入时从 opencode SDK pty.shells 取宿主默认 */
  private async ensureDefaultShell(): Promise<void> {
    if ((window as any).__APP_CONFIG__?.defaultShell) return;
    try {
      const c = this.ensureSdk();
      const { data, error } = await c.pty.shells({ directory: effectiveCwd() });
      if (!error && Array.isArray(data) && data.length) {
        const list = data as Array<{ name: string; path: string; acceptable: boolean }>;
        const preferred = navigator.userAgent.includes('Mac')
          ? list.find((s) => s.acceptable && /zsh/i.test(s.name)) || list.find((s) => s.acceptable)
          : list.find((s) => s.acceptable && /bash/i.test(s.name)) || list.find((s) => s.acceptable);
        if (preferred) (window as any).__APP_CONFIG__.defaultShell = preferred.path;
      }
    } catch { /* 忽略, 交给默认兜底 */ }
  }

  /** SDK path.get 取宿主机绝对 cwd (pty 会话工作目录) */
  private async getPtyCwd(): Promise<string> {
    const c = this.ensureSdk();
    const { data, error } = await c.path.get({ directory: effectiveCwd() });
    if (error) throw new Error(`pty /path ${(error as any)?.message || 'unknown'}`);
    const dir = (data as any)?.directory as string | undefined;
    return (dir || '/workspace').replace(/\/+$/, '');
  }

  /** SDK pty.create 创建会话 (spawn shell, cwd=宿主机绝对 workspace) */
  private async createPty(launchConfig: IShellLaunchConfig, cwd: string): Promise<{ id: string; pid: number; command: string }> {
    const command = defaultShell() || launchConfig.executable || '/bin/bash';
    const c = this.ensureSdk();
    const { data, error } = await c.pty.create({
      directory: cwd,
      command,
      args: (launchConfig.args as string[]) || undefined,
      cwd,
    });
    if (error || !data) throw new Error(`pty create ${(error as any)?.message || 'failed'}`);
    return data as { id: string; pid: number; command: string };
  }

  private wsUrl(ptyId: string, cwd: string): string {
    // WS 端点吃 query param directory（与 x-opencode-directory header 等价, 浏览器 WS API 不便加 header）
    // secureUrl 先升级 base 协议 (https 页面下 http→https), 再 http→ws; 最终 https→wss
    const wsBase = secureUrl(appBaseUrl()).replace(/^http/, 'ws');
    return `${wsBase}/pty/${ptyId}/connect?directory=${encodeURIComponent(cwd)}`;
  }

  /** 创建终端会话（前端 sessionId = id） */
  async create2(id: string, _cols: number, _rows: number, launchConfig: IShellLaunchConfig): Promise<IPtyProcessProxy | undefined> {
    try {
      await this.waitPtyReady();
      await this.waitRuntimeReady();
      await this.ensureDefaultShell();
      const cwd = await this.resolveLaunchCwd(launchConfig);
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

// ---- FsPty 用的 shell pickShell + wrapWithMarker + uuid (从 fs-pty.ts 合并, 避免循环导入) ----

function uuid(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 暴露给 fs.ts 的 wrapWithMarker (fs-pty 内部用) */
export function wrapFsPtyCommand(body: string, ops: ShellOps, completionMarker: string): string {
  if (ops.kind === 'posix') {
    return `${body} && echo __FS_OK__ ; echo ${completionMarker}`;
  }
  if (ops.kind === 'powershell') {
    return `${body}; if ($?) { Write-Output __FS_OK__ }; Write-Output ${completionMarker}`;
  }
  return `${body} & echo __FS_OK__ & echo ${completionMarker}`;
}

/** 暴露给 fs.ts 的 pickShell (fs-pty 内部用) */
export function pickFsPtyShell(
  list: Array<{ name: string; path: string; acceptable: boolean }>,
  kind: ShellKind,
): string {
  return pickShell(list, kind);
}
