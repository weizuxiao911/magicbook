/**
 * FsPty — fs 写操作专用的全局单例 PTY 客户端
 *
 * 替代原 session.shell (单 session 一次只跑一个 shell, 并发 409).
 * PTY 是全局的, 不依赖 session, 多个操作通过 promise chain 串行化.
 *
 * 生命周期:
 *   - lazy init: 首次 exec 时创建 (probe /pty/shells 选 shell → POST /api/pty → WS 连接)
 *   - 复用: 整个 client 生命周期共用一个 PTY session + WS
 *   - 清理: 不主动关; 跟随 opencode 关停 / 浏览器刷新
 *
 * 命令协议:
 *   exec(cmd) → 在 cmd 末尾追加成功 marker; 通过 ws.send 发到 PTY;
 *     累积 ws.onmessage 输出, 直到看到 marker 整行 → 返回 (output, ok).
 *   marker 用 UUID 避免与命令输出冲突.
 *
 * 路径: 调用方传绝对路径, fs.ts 在调用前已 IDE-rel 转 abs.
 */

import { detectPlatform, getShellOps, pickShellKind, type ShellKind, type ShellOps } from './shell-ops';
import { appBaseUrl, cwdHeader, effectiveCwd } from './env';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

interface Pending {
  resolve: (out: { ok: boolean; output: string }) => void;
  reject: (e: Error) => void;
  buffer: string;
  marker: string;
  timer: ReturnType<typeof setTimeout> | null;
}

class FsPty {
  private ptyId: string | null = null;
  private ws: WebSocket | null = null;
  private shellKind: ShellKind | null = null;
  private ops: ShellOps | null = null;
  /** 串行化: 上一个 exec 的 promise */
  private queue: Promise<unknown> = Promise.resolve();
  /** 等待中的命令 (marker 匹配前) */
  private pending: Pending | null = null;
  /** 累积输出 (marker 匹配前所有 ws.onmessage 拼起来) */
  private accum = '';

  private initPromise: Promise<void> | null = null;

  /** 懒初始化: probe shell + create pty + connect ws. 幂等. */
  private async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const base = appBaseUrl();
    if (!base) throw new Error('fs pty: app base url not ready');
    // cwd: APP_CWD (用户选择) || hostCwd (opencode /path 注入) || 报错
    const cwd = effectiveCwd();
    if (!cwd) throw new Error('fs pty: no cwd (APP_CWD unset and hostCwd not yet probed)');

    const sdk = createOpencodeClient({
      baseUrl: base,
      headers: cwdHeader(),
      responseStyle: 'fields',
      throwOnError: true,
    });

    // 1. SDK pty.shells 探测可用 shell
    let shellList: Array<{ name: string; path: string; acceptable: boolean }> = [];
    try {
      const { data, error } = await sdk.pty.shells({ directory: cwd });
      if (!error && Array.isArray(data)) shellList = data as any;
    } catch { /* 兜底 */ }
    this.shellKind = pickShellKind(shellList, detectPlatform());
    this.ops = getShellOps(this.shellKind);
    // 暴露 ops 供 fs.ts 同步取用 (无需再走 async)
    (window as any).__APP_FS_PTY_OPS__ = this.ops;
    const shell = pickShell(shellList, this.shellKind);
    console.log('[fs-pty] init: shellKind=', this.shellKind, 'command=', shell);

    // 2. SDK pty.create 创建会话
    const { data: createData, error: createErr } = await sdk.pty.create({ directory: cwd, command: shell, cwd });
    if (createErr || !createData) throw new Error(`fs pty: create pty failed: ${(createErr as any)?.message || 'no data'}`);
    this.ptyId = (createData as any).id;
    if (!this.ptyId) throw new Error('fs pty: create pty returned no id');

    // 3. WS 连接 (SDK 无 WS, 直连 opencode)
    const wsBase = base.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/pty/${this.ptyId}/connect?directory=${encodeURIComponent(cwd)}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fs pty: ws connect timeout')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error('fs pty: ws connect error')); };
    });

    // 4. 装消息处理: 累积 → 匹配 pending marker
    ws.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : '';
      // 过滤 opencode pty 控制帧 (cursor/resize/method JSON)
      const trimmed = data.replace(/^\u0000+/, '');
      if (
        trimmed.startsWith('{"cursor"') ||
        trimmed.startsWith('{"type":"cursor"') ||
        trimmed.startsWith('{"type":"resize"') ||
        (trimmed.startsWith('{') && trimmed.includes('"method"'))
      ) {
        return;
      }
      this.accum += trimmed;
      this.matchMarker();
    };
    ws.onclose = () => {
      // ws 断了: 拒绝所有 pending; 后续 exec 会重新 init
      if (this.pending) {
        this.pending.reject(new Error('fs pty: ws closed'));
        this.pending = null;
      }
      this.ws = null;
      this.ptyId = null;
      this.initPromise = null;
    };
  }

  /** 执行一条命令, 返回 { ok, output }. 串行化 (promise chain). */
  async exec(body: string, timeoutMs = 10000): Promise<{ ok: boolean; output: string }> {
    const next = this.queue.then(async () => {
      await this.init();
      if (!this.ops || !this.ws) throw new Error('fs pty: not initialized');
      const marker = `__FSM_${uuid()}_${Date.now()}__`;
      const fullCmd = wrapWithMarker(body, this.ops, marker);
      this.accum = '';
      this.pending = {
        resolve: () => {},
        reject: () => {},
        buffer: '',
        marker,
        timer: null,
      };
      const p = new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
        this.pending!.resolve = resolve;
        this.pending!.reject = reject;
        this.pending!.timer = setTimeout(() => {
          if (this.pending) {
            const cur = this.pending;
            this.pending = null;
            cur.reject(new Error(`fs pty: exec timeout (${timeoutMs}ms)`));
          }
        }, timeoutMs);
      });
      this.ws!.send(`\r${fullCmd}\r`);
      try {
        const out = await p;
        return out;
      } finally {
        if (this.pending?.timer) clearTimeout(this.pending.timer);
        this.pending = null;
      }
    }) as Promise<{ ok: boolean; output: string }>;
    this.queue = next;
    return next;
  }

  /** 累积里匹配 pending marker; 命中 → resolve pending, 清空 accum */
  private matchMarker(): void {
    if (!this.pending) return;
    const idx = this.accum.indexOf(this.pending.marker);
    if (idx < 0) return;
    // marker 前的输出 + 是否有 okMarker 决定成功
    const output = this.accum.slice(0, idx);
    // 找 __FS_OK__ (success marker) 在 output 中; 有 → 成功
    // 注: successMarker 是 wrap 的一部分, 跟命令 marker 不同; 都在 accum 里
    const okMarker = this.ops?.successMarker().trim() || '';
    const ok = okMarker ? output.includes(okMarker) : true;
    const cur = this.pending;
    this.pending = null;
    this.accum = '';
    if (cur.timer) clearTimeout(cur.timer);
    cur.resolve({ ok, output: stripOkMarker(output, okMarker) });
  }
}

// ---- helpers ----

function uuid(): string {
  // 不依赖 crypto.randomUUID (旧浏览器兜底)
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function pickShell(
  list: Array<{ name: string; path: string; acceptable: boolean }>,
  kind: ShellKind,
): string {
  const acc = list.filter((s) => s.acceptable);
  if (!acc.length) {
    // 兜底: 按 kind 给一个标准路径
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
  // posix
  return acc.find((s) => /zsh/i.test(s.name))?.path
    || acc.find((s) => /bash/i.test(s.name))?.path
    || acc.find((s) => /sh/i.test(s.name))?.path
    || acc[0].path;
}

/** 把命令包成: <body> + (ok marker 条件) + (completion marker). 各 shell 语法不同 */
function wrapWithMarker(body: string, ops: ShellOps, completionMarker: string): string {
  if (ops.kind === 'posix') {
    // POSIX: body && echo __FS_OK__ ; echo <completionMarker>
    return `${body} && echo __FS_OK__ ; echo ${completionMarker}`;
  }
  if (ops.kind === 'powershell') {
    // PowerShell: body; if ($?) { Write-Output __FS_OK__ }; Write-Output <completionMarker>
    return `${body}; if ($?) { Write-Output __FS_OK__ }; Write-Output ${completionMarker}`;
  }
  // cmd: 简化, 直接跑 + echo
  return `${body} & echo __FS_OK__ & echo ${completionMarker}`;
}

function stripOkMarker(output: string, okMarker: string): string {
  if (!okMarker) return output;
  const i = output.lastIndexOf(okMarker);
  if (i < 0) return output;
  return output.slice(0, i) + output.slice(i + okMarker.length);
}

// ---- 单例 ----

let _instance: FsPty | null = null;

export function getFsPty(): FsPty {
  if (!_instance) _instance = new FsPty();
  return _instance;
}
