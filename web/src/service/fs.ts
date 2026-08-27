/**
 * filesystem + FsPty + watcher — service/fs.ts
 *
 * 合并: 文件系统主类 + 写操作 PTY 单例 + 独立 fs watcher
 *
 * 职责:
 *   - list / read / find: opencode 全局 API (/api/fs/list, /api/fs/read/*, /find/file), 走 x-opencode-directory 切工作目录
 *   - write / rm / mkdirp / move / readBinary: opencode 全局 PTY (单例 FsPty), 跨平台命令构造器
 *   - 事件: 独立 fs watcher (PTY 跑 node:fs.watch recursive:true) + 兜底 SDK /global/event SSE
 *   - 单实例: BrowserFS backend (config/bfs.ts, RemoteFS) 内部调用本实例,
 *     opensumi 容器与业务代码共用同一文件系统实例
 *
 * 路径: 一律 IDE 相对路径 (/foo), server 在 cwd 下操作.
 *
 * 设计: 全局交互不依赖 session; session 只服务 chat agent 工具调用.
 *   原实现 write/rm/mkdir/move 走 /session/{id}/shell, 单 session 一次只能跑一个 shell → 并发 409.
 *   现统一走 FsPty 单例 PTY, 串行化由 promise chain 兜底.
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain, CommandService, FileChangeType, URI } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import type { FsEntry, FileMeta, IFileSystem } from '../commands/fs';
import { FsToken } from '../commands/fs';
import {
  appBaseUrl,
  cwdHeader,
  effectiveCwd,
  secureUrl,
} from './env';
import {
  detectPlatform,
  getShellOps,
  pickShellKind,
  pickFsPtyShell,
  shellQuotePosix,
  wrapFsPtyCommand,
  type ShellKind,
  type ShellOps,
} from './terminal';

// ---- 工具函数 ----

/** IDE 路径 → opencode /api/fs/read 用的相对路径（去前导 / 和 /workspace 前缀, 跟 opencode 端 cwd 拼接） */
function relPathForRead(idePath: string): string {
  let p = idePath.replace(/^\/+/, '');
  if (p.startsWith('workspace/')) p = p.slice('workspace/'.length);
  return p;
}

/** 文本 → base64（浏览器端, 分块避免栈溢出） */
function bytesToBase64(input: Uint8Array | string): string {
  if (typeof input === 'string') {
    const bytes = new TextEncoder().encode(input);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < input.length; i += chunk) {
    bin += String.fromCharCode(...input.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** IDE 相对路径 (/foo) → 绝对路径 (APP_CWD || hostCwd + / + rel) */
function absPath(idePath: string): string {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error('fs: no cwd (APP_CWD unset and hostCwd not yet probed)');
  return cwd.replace(/\/+$/, '') + '/' + idePath.replace(/^\/+/, '');
}

// ---- FsPty (合并自 service/fs-pty.ts) ----

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
    (window as any).__APP_FS_PTY_OPS__ = this.ops;
    const shell = pickFsPtyShell(shellList, this.shellKind);
    console.log('[fs-pty] init: shellKind=', this.shellKind, 'command=', shell);

    // 2. SDK pty.create 创建会话
    const { data: createData, error: createErr } = await sdk.pty.create({ directory: cwd, command: shell, cwd });
    if (createErr || !createData) throw new Error(`fs pty: create pty failed: ${(createErr as any)?.message || 'no data'}`);
    this.ptyId = (createData as any).id;
    if (!this.ptyId) throw new Error('fs pty: create pty returned no id');

    // 3. WS 连接 (SDK 无 WS, 直连 opencode; secureUrl 让 https 页面下 wss)
    const wsBase = secureUrl(base).replace(/^http/, 'ws');
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
      const fullCmd = wrapFsPtyCommand(body, this.ops, marker);
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
    const output = this.accum.slice(0, idx);
    const okMarker = this.ops?.successMarker().trim() || '';
    const ok = okMarker ? output.includes(okMarker) : true;
    const cur = this.pending;
    this.pending = null;
    this.accum = '';
    if (cur.timer) clearTimeout(cur.timer);
    cur.resolve({ ok, output: stripOkMarker(output, okMarker) });
  }
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function stripOkMarker(output: string, okMarker: string): string {
  if (!okMarker) return output;
  const i = output.lastIndexOf(okMarker);
  if (i < 0) return output;
  return output.slice(0, i) + output.slice(i + okMarker.length);
}

let _fsPty: FsPty | null = null;
function getFsPty(): FsPty {
  if (!_fsPty) _fsPty = new FsPty();
  return _fsPty;
}

// ---- FsWatcher (合并自 service/watcher.ts) ----
//
// 独立 PTY 跑 node:fs.watch 监听 cwd 全树 (recursive: true), 把事件推给 opensumi.
// 覆盖 opencode 自身文件操作 + 外部修改 (macOS Finder / vim / git pull 等).
//
// 协议: pty 跑 `node -e "inline script"`, script 用 fs.watch + console.log 输出 JSON lines.
//   {"e": "change", "p": "relative/path"}  e=rename|change  p=相对 cwd 路径
//
// 生命周期: 跟随 cwd, setCwd 后启, 切 cwd 停 + 重启; 断线指数退避 1s→2s→…→30s, 3 次后放弃.
// 兜底: cwd 不存在/启不动 → console.warn 不阻塞 setCwd, 依赖 opencode SSE 兜底 (fs.ts 暂未删 file.* 处理).
/** 1 + 2 + 4 + 8 = 1|2|4|8 fs.ts 里 OpenSumi 用的 FileChangeType 编码 (ADDED=1 UPDATED=2 DELETED=3) */
const TYPE_MAP: Record<string, FileChangeType> = {
  add: FileChangeType.ADDED,
  change: FileChangeType.UPDATED,
  unlink: FileChangeType.DELETED,
};

let watcherPtyId: string | null = null;
let watcherWs: WebSocket | null = null;
let watcherRetryCount = 0;
let watcherStopped = false;
let watcherCwd = '';
let watcherStdoutBuf = '';
let watcherFireFn: ((changes: Array<{ uri: string; type: FileChangeType }>) => void) | null = null;

export function bindWatcherFireFilesChange(fn: typeof watcherFireFn): void {
  watcherFireFn = fn;
}

/** brace matching 增量 JSON 解析: 一个 ws 帧可能含多个 JSON object 拼一起
 *  ({"cursor":0}{"e":"rename","p":"a"}{"e":"change","p":"b"})
 *  也可能一个 object 跨两个 ws 帧 — 不完整时 rest 保留等下次
 *  考虑 string 内的引号 / 反斜杠, 不被误判 brace
 */
function extractJsonObjects(buf: string): { objects: any[]; rest: string } {
  const objects: any[] = [];
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    let inStr = false;
    let escape = false;
    for (let j = start; j < buf.length; j++) {
      const c = buf[j];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break;  // 不完整, 等更多数据
    const sub = buf.slice(start, end + 1);
    try {
      const obj = JSON.parse(sub);
      if (obj && typeof obj === 'object') objects.push(obj);
    } catch (e: any) {
      console.warn('[watcher] JSON parse fail:', sub, e?.message ?? String(e));
    }
    i = end + 1;
  }
  return { objects, rest: buf.slice(i) };
}

/** 处理单个 JSON object: opencode pty 控制帧 (cursor/resize/method) 忽略, 其余作 fs event */
function handleJsonObject(obj: any): void {
  if (!obj || typeof obj !== 'object') return;
  if ('cursor' in obj || obj.type === 'cursor' || obj.type === 'resize' || 'method' in obj) return;
  if (typeof obj.e !== 'string' || typeof obj.p !== 'string') return;
  // fs.watch → OpenSumi 事件类型转换:
  //   node:fs.watch (跨平台) 的 'rename' 事件语义是 "路径节点被重命名/创建/删除",
  //   filename 是否存在区分 add/unlink; 这里不 stat 判定, 统一当 UPDATED (OpenSumi 会重新 stat 同步)
  //   之后可加 stat 优化, 但 'change' / 'add' / 'unlink' 直接映射 TYPE_MAP
  let opencodeEvent: FileChangeType;
  if (obj.e === 'rename') {
    opencodeEvent = FileChangeType.UPDATED;
  } else {
    const t = TYPE_MAP[obj.e];
    if (t === undefined) { console.log('[watcher] unknown event type:', obj.e); return; }
    opencodeEvent = t;
  }
  // URI: file:///{WORKSPACE_ROOT}/{rel}.  保留 :// 三 slash 段不被合并
  //  (负 lookbehind (?<!:) 看前 1 字符, 拦不住 file:// 的第二/三个 /)
  //  改成: 先把 :// 段占位为 3 个 \u0000, 合并连续 / 为 1, 再恢复 ://
  const rawUri = `file://${WORKSPACE_ROOT}/${obj.p}`;
  const tmp = rawUri.replace('://', '\u0000\u0000\u0000').replace(/\/+/g, '/').replace('\u0000\u0000\u0000', '://');
  const uri = tmp;
  console.log('[watcher] → fireFilesChange', uri, opencodeEvent);
  if (watcherFireFn) {
    watcherFireFn([{ uri, type: opencodeEvent }]);
  }
}

/**
 * 启 fs watcher PTY (跑 node -e 'inline fs.watch script')
 * @param cwd 监听根目录
 */
export async function startFsWatcher(cwd: string): Promise<void> {
  stopFsWatcher();
  if (!cwd) return;
  const base = appBaseUrl();
  if (!base) {
    console.warn('[watcher] no baseUrl, skip');
    return;
  }
  // 连接前确认 cwd 存在
  try {
    const sdk = createOpencodeClient({ baseUrl: base, headers: cwdHeader(), responseStyle: 'fields', throwOnError: true });
    const { error } = await sdk.file.list({ path: '.', directory: cwd });
    if (error) {
      console.warn('[watcher] cwd check fail, skip:', cwd, error);
      return;
    }
  } catch (e) {
    console.warn('[watcher] cwd check exception, skip:', cwd, e);
    return;
  }

  watcherCwd = cwd;
  watcherStopped = false;
  // node 脚本 (单行无 ' " \n, 用 \x27 替代单引号避免 shell 拆 arg)
  const nodeScript = [
    "const fs=require(\"node:fs\");",
    "const ROOT=process.argv[1];",
    "let ws=[];",
    "try{",
    "  const w=fs.watch(ROOT,{recursive:true,persistent:true},(e,f)=>{",
    "    const rel=f||\"\";",
    "    try{process.stdout.write(JSON.stringify({e,p:rel})+\"\\n\");}catch{}",
    "  });",
    "  ws.push(w);",
    "}catch(e){process.stderr.write(\"watcher err: \"+e.message+\"\\n\");}",
    "process.on(\"SIGTERM\",()=>{try{ws.forEach(w=>w.close());}catch{}process.exit(0);});",
    "process.on(\"SIGINT\",()=>{try{ws.forEach(w=>w.close());}catch{}process.exit(0);});",
  ].join('');
  // command 单 word, args 数组传参数 (跟 terminal.ts 一样, opencode /pty 接受 args 数组)
  const command = 'node';
  const args = ['-e', nodeScript, cwd];
  console.log('[watcher] start, cwd=', cwd);

  try {
    const sdk = createOpencodeClient({ baseUrl: base, headers: cwdHeader(), responseStyle: 'fields', throwOnError: true });
    const { data, error } = await sdk.pty.create({ directory: cwd, command, args, cwd });
    if (error || !data) {
      console.warn('[watcher] pty.create failed:', (error as any)?.message);
      scheduleWatcherRetry();
      return;
    }
    watcherPtyId = (data as any).id;
    if (!watcherPtyId) {
      console.warn('[watcher] no ptyId returned');
      scheduleWatcherRetry();
      return;
    }
    console.log('[watcher] pty created, id=', watcherPtyId);

    const wsBase = secureUrl(base).replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/pty/${watcherPtyId}/connect?directory=${encodeURIComponent(cwd)}`);
    watcherWs = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watcher ws connect timeout')), 5000);
      socket.onopen = () => { clearTimeout(timer); console.log('[watcher] ws open'); resolve(); };
      socket.onerror = (e) => { clearTimeout(timer); reject(new Error('watcher ws connect error')); };
    });
    socket.onmessage = async (msg) => {
      // msg.data 类型: string (text frame) | Blob (binary frame default) | ArrayBuffer
      // Blob 要用 .text() 读真实字符串; ArrayBuffer 用 TextDecoder; string 直接用
      let chunk: string;
      const data: any = msg.data;
      if (typeof data === 'string') {
        chunk = data;
      } else if (data instanceof Blob) {
        chunk = await data.text();
      } else if (data instanceof ArrayBuffer) {
        chunk = new TextDecoder().decode(data);
      } else {
        console.log('[watcher] ws msg unknown type:', typeof data);
        return;
      }
      console.log('[watcher] ws msg chunk:', JSON.stringify(chunk).slice(0, 300));
      watcherStdoutBuf += chunk;
      // brace matching 增量解析: 一个 ws 帧可能含多个 JSON object 拼一起
      // ({"cursor":0}{"e":"rename","p":"a"}{"e":"change","p":"b"})
      // 也可能一个 object 跨两个 ws 帧 — 不完整时等下次
      const { objects, rest } = extractJsonObjects(watcherStdoutBuf);
      watcherStdoutBuf = rest;
      for (const obj of objects) {
        handleJsonObject(obj);
      }
    };
    socket.onclose = (ev) => {
      console.log('[watcher] ws close', ev?.code);
      if (!watcherStopped) scheduleWatcherRetry();
    };
    socket.onerror = (e) => {
      console.warn('[watcher] ws error', e);
    };
    watcherRetryCount = 0;
  } catch (e: any) {
    console.warn('[watcher] start failed:', e?.message);
    scheduleWatcherRetry();
  }
}

export function stopFsWatcher(): void {
  if (!watcherPtyId && !watcherWs) return;
  watcherStopped = true;
  watcherRetryCount = 0;
  watcherStdoutBuf = '';
  if (watcherWs) {
    try { watcherWs.close(); } catch { /* */ }
    watcherWs = null;
  }
  watcherPtyId = null;
  console.log('[watcher] stopped, cwd was=', watcherCwd);
  watcherCwd = '';
}

function scheduleWatcherRetry(): void {
  if (watcherStopped) return;
  watcherRetryCount++;
  if (watcherRetryCount > 3) {
    console.warn('[watcher] retry exhausted, give up');
    stopFsWatcher();
    return;
  }
  const delay = Math.min(30000, 1000 * Math.pow(2, watcherRetryCount - 1));
  console.log(`[watcher] retry #${watcherRetryCount} in ${delay}ms`);
  setTimeout(() => { if (!watcherStopped) void startFsWatcher(watcherCwd); }, delay);
}

// ---- FileSystemService 主类 ----

@Injectable()
@Domain(ClientAppContribution)
export class FileSystemServiceImpl implements IFileSystem {
  static instance: FileSystemServiceImpl | null = null;

  @Autowired(CommandService)
  private readonly commandService!: CommandService;

  @Autowired(IFileServiceClient)
  private readonly fileService!: IFileServiceClient;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  /** SDK client (用于 event.subscribe SSE 兜底; 写走 FsPty) */
  private fsClient: ReturnType<typeof createOpencodeClient> | null = null;
  /** SDK 事件流 (SSE, 用于 file.* 兜底) */
  private eventAbort: AbortController | null = null;

  constructor() {
    FileSystemServiceImpl.instance = this;
    (window as any).__APP_FS__ = this;
  }

  /** 容器启动: 挂全局单例 + 订阅 fs 事件（runtime 就绪后）+ 启 fs watcher + explorer 刷新 + 恢复编辑器 tab */
  onStart(): void {
    (window as any).__APP_FS__ = this;
    console.log('[filesystem] service ready, baseUrl:', appBaseUrl() || '(unset)');
    // 把 fireFilesChange 注入到 watcher 模块 (避免循环 import)
    bindWatcherFireFilesChange((changes) => this.fileService.fireFilesChange({ changes }));
    window.addEventListener('runtime-ready', () => {
      this.connectEvents();
      void this.startWatcher();
      void this.verifyOpensumiLink();
      void this.refreshExplorer();
      this.watchEditorState();
      this.restoreOpenedEditors();
    });
    if (appBaseUrl()) {
      this.connectEvents();
      void this.startWatcher();
    }
  }

  /** 启 fs watcher (PTY 跑 node:fs.watch), 跟随 cwd */
  private async startWatcher(): Promise<void> {
    const cwd = effectiveCwd();
    if (!cwd) {
      console.log('[filesystem] no cwd, skip watcher');
      return;
    }
    await startFsWatcher(cwd);
  }

  /** 验证 opensumi IFileServiceClient → BrowserFS → server fs 链路（拓展读文件的通道） */
  private async verifyOpensumiLink(): Promise<void> {
    try {
      const stat = await this.fileService.getFileStat('file:///workspace');
      console.log('[filesystem] opensumi 链路验证: file:///workspace stat =', {
        isDirectory: stat?.isDirectory,
        children: stat?.children?.map((c) => ({ name: c.uri.split('/').pop(), isDirectory: c.isDirectory })),
      });
    } catch (e) {
      console.warn('[filesystem] opensumi 链路验证失败:', e);
    }
  }

  /**
   * 恢复上次打开的编辑器 tab（与 explorer 加载解耦: 异步 500ms 延后, 互不影响）.
   */
  private restoreOpenedEditors(): void {
    try {
      const uris: string[] =
        (window as any).__SAVED_EDITOR_URIS__ ||
        (() => {
          const raw = localStorage.getItem('editor.restore.uris');
          if (!raw) return [];
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        })();
      const activeUri: string =
        (window as any).__SAVED_EDITOR_ACTIVE_URI__ ||
        localStorage.getItem('editor.restore.activeUri') ||
        '';
      if (!uris.length) return;
      console.log('[filesystem] 恢复编辑器 tab:', uris.length, uris, 'active:', activeUri);
      setTimeout(() => {
      const alive: string[] = [];
      void Promise.all(
        uris.map((uri) =>
          this.fileService
            .getFileStat(uri)
            .then((stat) => {
              if (!stat || stat.isDirectory) return;
              alive.push(uri);
              return this.editorService
                .open(URI.parse(uri), { backend: true, preview: false, deletedPolicy: 'skip' })
                .then(() => console.log('[filesystem] 恢复建 tab:', uri))
                .catch((e) => console.warn('[filesystem] 恢复建 tab 失败:', uri, e));
            })
            .catch(() => {}),
        ),
      ).then(() => {
        if (alive.length !== uris.length) {
          localStorage.setItem('editor.restore.uris', JSON.stringify(alive));
          console.log('[filesystem] 恢复状态自愈:', uris.filter((u) => !alive.includes(u)), '已从持久化移除');
        }
        const target =
          activeUri && alive.includes(activeUri) && !activeUri.startsWith('welcome:')
            ? activeUri
            : alive[alive.length - 1];
        if (target) {
          void this.editorService
            .open(URI.parse(target), { focus: true, preview: false })
            .then(() => console.log('[filesystem] 恢复激活当前 tab:', target))
            .catch((e) => console.warn('[filesystem] 恢复激活失败:', target, e));
        }
      });
      }, 500);
    } catch { /* ignore */ }
  }

  private watchEditorState(): void {
    try {
      this.editorService.onActiveResourceChange(() => this.syncPersistedUris());
      this.editorService.onDidEditorGroupsChanged(() => this.syncPersistedUris());
      (this.editorService as any).onDidEditorGroupTabChanged?.(() => this.syncPersistedUris());
      setInterval(() => this.syncPersistedUris(), 2000);
    } catch { /* ignore */ }
  }

  private syncPersistedUris(): void {
    try {
      const uris = this.editorService.getAllOpenedUris().map((u) => u.toString());
      const next = JSON.stringify(uris);
      const active = this.editorService.currentEditorGroup?.currentResource?.uri.toString() || '';
      if (next === localStorage.getItem('editor.restore.uris') && active === localStorage.getItem('editor.restore.activeUri')) {
        return;
      }
      localStorage.setItem('editor.restore.uris', next);
      if (active) localStorage.setItem('editor.restore.activeUri', active);
    } catch { /* ignore */ }
  }

  /** 刷新 explorer 文件树 */
  private async refreshExplorer(): Promise<void> {
    try {
      this.fileService.fireFilesChange({ changes: [{ uri: 'file:///workspace', type: 1 }] });
      console.log('[filesystem] explorer 已刷新 (fireFilesChange)');
    } catch (e) {
      console.warn('[filesystem] explorer 刷新失败:', e);
    }
  }

  /**
   * 订阅 opencode 事件流 (兜底). 内部 PTY watcher 已覆盖 file.* 事件, 这里只订阅其他 event
   * 类型 (message.* / a2ui.* 等). 简化: 暂时只 log 一下, 后续如需 SSE 推非 fs 事件再展开.
   */
  private async connectEvents(): Promise<void> {
    const base = appBaseUrl();
    if (!base) return;
    if (this.eventAbort) return;
    const abort = new AbortController();
    this.eventAbort = abort;
    try {
      const client = this.ensureClient();
      const events = await client.event.subscribe(undefined, { signal: abort.signal });
      console.log('[filesystem] event.subscribe ok');
      const typeMap: Record<string, FileChangeType> = {
        add: FileChangeType.ADDED,
        change: FileChangeType.UPDATED,
        unlink: FileChangeType.DELETED,
      };
      for await (const evt of events.stream) {
        const t = (evt as any).type as string;
        if (!t) continue;
        // 处理 file.* 事件: opencode 自身操作(写/读/删通过 opencode 走)→ fireFilesChange
        //   PTY watcher 覆盖外部修改; 两者都 fireFilesChange, OpenSumi 内部去重
        let changeType: string | null = null;
        let relPath = '';
        if (t === 'file.edited') {
          changeType = 'change';
          relPath = ((evt as any).properties?.file || '').toString();
        } else if (t === 'file.watcher.updated') {
          changeType = ((evt as any).properties?.event || '').toString();
          relPath = ((evt as any).properties?.file || '').toString();
        }
        if (!changeType || !relPath) continue;
        const rel = relPath.startsWith('/') ? relPath : `/${relPath}`;
        const uri = `file://${WORKSPACE_ROOT}${rel}`;
        console.log('[filesystem] fs event:', t, rel, '→ fireFilesChange', uri);
        this.fileService.fireFilesChange({
          changes: [{ uri, type: typeMap[changeType] ?? FileChangeType.UPDATED }],
        });
        window.dispatchEvent(new CustomEvent('fs:changed', { detail: { type: changeType, path: rel } }));
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        console.warn('[filesystem] event.subscribe 失败:', e);
      }
    }
  }

  /** 懒建 SDK client（共享, 不重置 cwd header） */
  private ensureClient(): ReturnType<typeof createOpencodeClient> {
    if (this.fsClient) return this.fsClient;
    const base = appBaseUrl();
    if (!base) throw new Error('fs base url not ready');
    this.fsClient = createOpencodeClient({
      baseUrl: base,
      headers: cwdHeader(),
      responseStyle: 'fields',
      throwOnError: true,
    });
    return this.fsClient;
  }

  // ---- 相对路径接口（OverlayFS 对接）----

  async list(idePath: string): Promise<FsEntry[]> {
    // SDK client.file.list: 返回 FileNode[] (name, path, absolute, type: 'file'|'directory', ignored)
    const norm = !idePath || idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const queryPath = norm === '/' ? '.' : norm.replace(/^\/+/, '');
    const c = this.ensureClient()
    const cwd = effectiveCwd()
    const { data, error } = await c.file.list({ path: queryPath, directory: cwd })
    if (error) throw new Error(`fs list failed: ${idePath}: ${(error as any)?.message || 'unknown'}`)
    const entries: FsEntry[] = (data || []).map((e) => ({
      name: e.name,
      type: e.type === 'directory' ? 'directory' : 'file',
    }));
    // 回填 stat 缓存 (meta 直接命中, 避免重复 list)
    this.listCache.set(norm, entries);
    return entries;
  }

  async exists(idePath: string): Promise<boolean> {
    try {
      await this.meta(idePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * stat: opencode 没有单独的 stat endpoint, 复用 /api/fs/list 拿父目录 entries, 找 entry 拿 type.
   *   优点: 不用 FsPty 跑 stat 命令 (interactive shell prompt/syntax highlight 干扰 stat 输出);
   *         opencode 自己拿 type, 准
   *   缺点: 多一次 list 请求; 但 explorer 先 readdir 后 stat, 命中缓存
   */
  private listCache = new Map<string, FsEntry[]>();

  async meta(idePath: string): Promise<FileMeta> {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const base = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    const name = norm === '/' ? '' : norm.slice(norm.lastIndexOf('/') + 1);

    // 缓存命中 (readdir 已经拿过)
    const cached = this.listCache.get(base);
    let entry: FsEntry | undefined;
    if (cached) {
      entry = cached.find((e) => e.name === name);
    }
    // 未命中: list 父目录拿 entry (opencode SDK /file 不返 mtime, mtime 由 OpenSumi 内部 currentTime 兜底)
    if (!entry) {
      const entries = await this.list(base);
      this.listCache.set(base, entries);
      entry = entries.find((e) => e.name === name);
    }
    if (!entry) throw new Error(`stat: not found ${idePath}`);
    return { path: idePath, type: entry.type, size: 0 };
  }

  async read(idePath: string): Promise<Uint8Array> {
    // 走 SDK client.file.read: 返回 FileContent { type: 'text'|'binary', content, encoding?, mimeType? }.
    //   文本: content 是 utf-8 字符串 → TextEncoder → Uint8Array (跟 vscode API 一致).
    //   binary: content 是 base64 → atob → Uint8Array (原始 bytes, 不再 utf-8 强解避免损坏).
    //   优势: 30MB+ 大文件 (PDF 等) 不再 500, mimeType 拿到, bytes 真实.
    const c = this.ensureClient()
    const relPath = relPathForRead(idePath)
    const cwd = effectiveCwd()
    console.log('[fs.read] start:', { relPath, cwd })
    const { data, error } = await c.file.read({ path: relPath, directory: cwd })
    if (error || !data) {
      console.error('[fs.read] fail:', { relPath, error, hasData: !!data })
      throw new Error(`fs read failed: ${idePath}: ${(error as any)?.message || 'no data'}`)
    }
    console.log('[fs.read] ok:', { relPath, type: data.type, mimeType: data.mimeType, len: data.content.length, encoding: data.encoding })
    if (data.type === 'binary') {
      const b64 = (data.encoding === 'base64' ? data.content : btoa(data.content)).replace(/\s+/g, '')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes
    }
    return new TextEncoder().encode(data.content)
  }

  /**
   * 二进制读: 走 FsPty 跑 base64 编码, 浏览器端 atob 解码.
   *   POSIX: base64 <file>
   *   PowerShell: [Convert]::ToBase64String([System.IO.File]::ReadAllBytes(...))
   */
  async readBinary(idePath: string): Promise<Uint8Array> {
    const ops = await this.ops();
    const abs = absPath(idePath);
    const { ok, output } = await getFsPty().exec(ops.readFileBase64(abs));
    if (!ok) throw new Error(`fs readBinary: pty exec failed ${idePath}`);
    const b64 = output.replace(/\s+/g, '');
    if (!b64) throw new Error(`fs readBinary: empty content ${idePath}`);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 二进制读 (无损, 大文件安全): 走 FsPty 跑 `base64 <abs>`, 浏览器端 atob 解码.
   *   跟 readBinary 思路一致, 但接受 relPath (workspace 内路径) → absPath 拼.
   *   原 fetch opencode /api/fs/read 对 30MB+ 大文件 (PDF 等) 返回 500; FsPty
   *   走平台原生 base64 命令读文件, 绕开 opencode 后端 30MB 限制.
   *   timeout: 30s (30MB base64 编码/传输耗时).
   *   注: 不支持 onProgress, FsPty 一次性返回 (跟 readBinary 一致).
   */
  async readBinaryAbsolute(relPath: string): Promise<Uint8Array> {
    const ops = await this.ops();
    const abs = absPath(relPath);
    const { ok, output } = await getFsPty().exec(ops.readFileBase64(abs), 30000);
    if (!ok) throw new Error(`fs readBinaryAbsolute: pty exec failed ${relPath}`);
    const b64 = output.replace(/\s+/g, '');
    if (!b64) throw new Error(`fs readBinaryAbsolute: empty content ${relPath}`);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 写文件: base64 内容通过 FsPty 写到绝对路径, 父目录自动 mkdir -p.
   *   大文件分块: 每块 ≤ CHUNK_BYTES, 多次 exec 追加.
   *   超时: 5s 基础, 大文件按 KB 比例放宽 (上限 60s).
   *   POSIX: 每块 `printf %s ... | base64 -d >> path` (首块用 >)
   *   PowerShell: 单条 [IO.File]::WriteAllBytes (无 ARG_MAX 问题, 不分块)
   *   onProgress?: (bytesWritten, totalBytes) 实时回调, 让 UI 显示进度
   */
  async write(
    idePath: string,
    content: string | { base64: string },
    onProgress?: (done: number, total: number) => void,
  ): Promise<boolean> {
    const ops = await this.ops();
    const abs = absPath(idePath);
    const b64 = typeof content === 'string' ? bytesToBase64(content) : content.base64;
    const kind = (await this.ops()).kind;
    // PowerShell: 单条命令, 无 ARG_MAX, 不分块
    if (kind === 'powershell') {
      const { ok } = await getFsPty().exec(ops.writeFile(abs, b64), this.writeTimeoutMs(b64.length));
      if (ok) {
        this.invalidateParent(idePath);
        onProgress?.(b64.length, b64.length);
      }
      return ok;
    }
    // POSIX: 分块写 (4KB base64 / 块, 远低于 ARG_MAX, 25 块/100KB, 单次 50ms)
    const CHUNK = 4 * 1024;
    const absQ = shellQuotePosix(abs);
    const dir = abs.replace(/\/[^/]+$/, '');
    if (dir && dir !== abs) {
      const { ok: ok1 } = await getFsPty().exec(`mkdir -p ${shellQuotePosix(dir)}`, 3000);
      if (!ok1) return false;
    }
    // 写首块 (> 覆盖)
    const first = b64.slice(0, CHUNK);
    const { ok: ok2 } = await getFsPty().exec(
      `printf %s ${first} | base64 -d > ${absQ}`,
      this.writeTimeoutMs(first.length),
    );
    if (!ok2) return false;
    onProgress?.(first.length, b64.length);
    // 写剩余块 (>> 追加)
    for (let i = CHUNK; i < b64.length; i += CHUNK) {
      const chunk = b64.slice(i, i + CHUNK);
      const r = await getFsPty().exec(
        `printf %s ${chunk} | base64 -d >> ${absQ}`,
        this.writeTimeoutMs(chunk.length),
      );
      if (!r.ok) {
        console.warn('[fs.write] chunk fail at', i, '/', b64.length, 'output:', r.output?.slice(0, 200));
        return false;
      }
      onProgress?.(Math.min(i + chunk.length, b64.length), b64.length);
    }
    this.invalidateParent(idePath);
    return true;
  }

  /** 写超时: 30s 基础 + 1s / KB base64, 上限 5min. 大文件能传完, 又不会无限挂 */
  private writeTimeoutMs(b64Len: number): number {
    return Math.min(300000, 30000 + Math.ceil(b64Len / 1024) * 1000);
  }

  async rm(idePath: string): Promise<boolean> {
    const ops = await this.ops();
    const { ok } = await getFsPty().exec(ops.rm(absPath(idePath)));
    if (ok) this.invalidateParent(idePath);
    return ok;
  }

  async rmdir(idePath: string): Promise<boolean> {
    const ops = await this.ops();
    const { ok } = await getFsPty().exec(ops.rmdir(absPath(idePath)));
    if (ok) this.invalidateParent(idePath);
    return ok;
  }

  async mkdirp(idePath: string): Promise<boolean> {
    const ops = await this.ops();
    const { ok } = await getFsPty().exec(ops.mkdirp(absPath(idePath)));
    if (ok) this.invalidateParent(idePath);
    return ok;
  }

  async move(from: string, to: string): Promise<boolean> {
    const ops = await this.ops();
    const { ok } = await getFsPty().exec(ops.move(absPath(from), absPath(to)));
    if (ok) {
      this.invalidateParent(from);
      this.invalidateParent(to);
    }
    return ok;
  }

  /** 文件树变化后: 清掉相关缓存 (自身 + 父目录) */
  private invalidateParent(idePath: string): void {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    this.listCache.delete(norm);
    const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    this.listCache.delete(parent);
  }

  async find(idePath: string, pattern = '*'): Promise<string[]> {
    // SDK client.find.files: 参数 query (搜索模式), type, directory
    //   注: directory 是搜索根, 不是工作目录; 我们把 IDE 路径当搜索根
    const dir = !idePath || idePath === '/' ? '.' : idePath.replace(/^\/+/, '');
    const c = this.ensureClient()
    const cwd = effectiveCwd()
    const { data, error } = await c.find.files({ query: pattern, type: 'file', directory: dir })
    if (error) throw new Error(`fs find failed: ${idePath}: ${(error as any)?.message || 'unknown'}`)
    return Array.isArray(data) ? (data as any[]).map(String) : []
  }

  /**
   * 懒解析 shell 命令构造器: 调用 getFsPty().init() 时已选定 shellKind, 此处直接拿
   * 同步的 ops (用同步 getter 兜底: 第一次 init 前 fallback 到 POSIX).
   */
  private async ops(): Promise<ReturnType<typeof getShellOps>> {
    // FsPty.init 完成后会写一个 window 全局供这里读
    const cached = (window as any).__APP_FS_PTY_OPS__;
    if (cached) return cached;
    // 没就绪: 用浏览器 UA 兜底, 不阻塞
    return getShellOps(detectPlatform() === 'windows' ? 'powershell' : 'posix');
  }
}

/** 模块级单例 getter */
export function getFileSystemService(): IFileSystem {
  return FileSystemServiceImpl.instance || (FileSystemServiceImpl.instance = new FileSystemServiceImpl());
}

@Injectable()
export class FileSystemModule extends BrowserModule {
  providers = [
    { token: FsToken, useFactory: () => getFileSystemService() },
    FileSystemServiceImpl,
  ];

  contributionProvider = ClientAppContribution;
}

/** 安装全局单例 */
export function installFileSystemService(): void {
  (window as any).__APP_FS__ = getFileSystemService();
  console.log('[filesystem] service installed');
}
