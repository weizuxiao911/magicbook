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

// ---- FsPty (node worker, 同 watcher 模式) ----
//
// 专用 node PTY 跑 worker 脚本: 读 stdin JSON 行, 用 node fs API 执行写/删/建/移/读/stat,
// 写 stdout JSON 行响应. 无 interactive shell → 无 zsh prompt/回显/syntax-highlight 污染,
// 无 marker 匹配歧义, ok 由 node fs API 真实返回. 持久化连接, 串行化 promise chain.
//
// 协议:
//   → {"id":"1","op":"write","path":"/abs","b64":"..."}
//   ← {"id":"1","ok":true,"data":{...}} | {"id":"1","ok":false,"err":"...","code":"ENOTEMPTY"}
// op: write(覆盖)/append(追加)/mkdir/rm(递归)/rmdir(真 rmdir)/move/readB64/stat
//
// 注: err 带 node 错误 code — OpenSumi fse.remove (rimraf) 靠 ENOTEMPTY/EISDIR/EPERM
// 判断目录递归; rmdir 用真 fs.rmdirSync (非空目录返 ENOTEMPTY, 而不是 rm 的 EISDIR)

const FS_PTY_WORKER = [
  "const fs=require('fs'),path=require('path');",
  "let buf='';",
  "process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){",
  "  const line=buf.slice(0,i);buf=buf.slice(i+1);",
  "  let r;try{r=JSON.parse(line)}catch(e){continue}",
  "  const id=r.id,out=(ok,data,err,code)=>{try{process.stdout.write(JSON.stringify({id,ok,data,err,code})+'\\n')}catch(e){}};",
  "  try{",
  "    if(r.op==='write'){fs.mkdirSync(path.dirname(r.path),{recursive:true});fs.writeFileSync(r.path,Buffer.from(r.b64,'base64'));out(true,{bytes:r.b64.length});}",
  "    else if(r.op==='append'){fs.appendFileSync(r.path,Buffer.from(r.b64,'base64'));out(true,{bytes:r.b64.length});}",
  "    else if(r.op==='mkdir'){fs.mkdirSync(r.path,{recursive:true});out(true);}",
  "    else if(r.op==='rm'){fs.rmSync(r.path,{recursive:true,force:true});out(true);}",
  "    else if(r.op==='rmdir'){fs.rmdirSync(r.path);out(true);}",
  "    else if(r.op==='move'){fs.mkdirSync(path.dirname(r.to),{recursive:true});fs.renameSync(r.from,r.to);out(true);}",
  "    else if(r.op==='readB64'){out(true,{b64:fs.readFileSync(r.path).toString('base64')});}",
  "    else if(r.op==='stat'){const s=fs.statSync(r.path);out(true,{size:s.size,mtimeMs:Math.floor(s.mtimeMs),isDir:s.isDirectory()});}",
  "    else if(r.op==='ping'){out(true,{pong:true});}",
  "    else out(false,null,'unknown op '+r.op);",
  "  }catch(e){out(false,null,String(e&&e.message||e),e&&e.code||'');}",
  "}});",
].join('');

class FsPty {
  private ptyId: string | null = null;
  private ws: WebSocket | null = null;
  /** 串行化: 上一个请求的 promise */
  private queue: Promise<unknown> = Promise.resolve();
  /** 等待中的请求 (id → resolve/reject/timer) */
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** worker 响应行缓冲 (跨 ws 帧拼接 JSON 行) */
  private respBuf = '';
  private nextId = 1;

  private initPromise: Promise<void> | null = null;

  /** 懒初始化: create node worker pty + connect ws. 幂等. */
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

    const sdk = createOpencodeClient({ baseUrl: base, headers: cwdHeader(), responseStyle: 'fields', throwOnError: true });
    console.log('[fs-pty] init node worker, cwd=', cwd);
    const { data: createData, error: createErr } = await sdk.pty.create({ directory: cwd, command: 'node', args: ['-e', FS_PTY_WORKER], cwd });
    if (createErr || !createData) throw new Error(`fs pty: create worker failed: ${(createErr as any)?.message || 'no data'}`);
    this.ptyId = (createData as any).id;
    if (!this.ptyId) throw new Error('fs pty: create worker returned no id');

    // WS 连接 (SDK 无 WS, 直连 opencode; secureUrl 让 https 页面下 wss)
    const wsBase = secureUrl(base).replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/pty/${this.ptyId}/connect?directory=${encodeURIComponent(cwd)}`);
    this.ws = ws;
    // opencode pty ws 的帧是 binary (Blob) — binaryType=arraybuffer 让 onmessage 同步拿 ArrayBuffer
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fs pty: ws connect timeout')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('fs pty: ws connect error')); };
    });

    ws.onmessage = (e) => this.handleWsData((e as any).data);
    ws.onclose = () => {
      const err = new Error('fs pty: ws closed');
      this.pending.forEach((p) => { if (p.timer) clearTimeout(p.timer); p.reject(err); });
      this.pending.clear();
      this.ws = null;
      this.ptyId = null;
      this.initPromise = null;
    };
  }

  /** 处理一段 ws 数据: 剥离控制帧 → 按 \n 切 JSON 响应行 → dispatch */
  private handleWsData(data: any): void {
    let chunk: string;
    if (typeof data === 'string') {
      chunk = data;
    } else if (data instanceof ArrayBuffer) {
      chunk = new TextDecoder().decode(data);
    } else if (data instanceof Blob) {
      // binaryType=arraybuffer 兜底 Blob 帧
      void data.text().then((t) => this.handleWsData(t));
      return;
    } else {
      return;
    }
    let cleaned = chunk.replace(/\u0000/g, '');
    // 剥离 opencode 控制帧 ({"cursor":..} / {"type":"cursor"..} / {"type":"resize"..})
    cleaned = cleaned
      .replace(/\{"cursor":[^}]*\}/g, '')
      .replace(/\{"type":"(?:cursor|resize)"[^}]*\}/g, '');
    if (!cleaned) return;
    this.respBuf += cleaned;
    let nl: number;
    while ((nl = this.respBuf.indexOf('\n')) >= 0) {
      const line = this.respBuf.slice(0, nl).trim();
      this.respBuf = this.respBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.dispatch(msg);
      } catch { /* 拼不完整, 等下一帧 */ }
    }
  }

  private dispatch(msg: { id?: string; ok?: boolean; data?: any; err?: string; code?: string }): void {
    // 只认带 ok 字段的 worker 响应; tty 会回显请求行 ({id,op,...} 无 ok) → 忽略
    if (!msg || msg.id === undefined || !('ok' in msg)) return;
    const p = this.pending.get(String(msg.id));
    if (!p) return;
    this.pending.delete(String(msg.id));
    if (p.timer) clearTimeout(p.timer);
    if (msg.ok) p.resolve({ ok: true, data: msg.data });
    else {
      const err = new Error(msg.err || 'fs pty op failed');
      (err as any).code = msg.code;
      p.reject(err);
    }
  }

  /** 执行一个 node fs 操作 (串行化 promise chain).
   *  自愈: 超时 (PTY 卡住) 时清 self 状态, 下次 init 重建 PTY, 业务 retry 透明恢复. */
  async request<T = any>(op: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<{ ok: boolean; data: T }> {
    const next = this.queue.then(async () => {
      await this.init();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('fs pty: not initialized');
      const id = String(this.nextId++);
      const line = JSON.stringify({ id, op, ...payload });
      const p = new Promise<{ ok: boolean; data: T }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          // 自愈: 超时 = PTY 卡住, 清 self 状态让下次 request 重建 PTY.
          this.initPromise = null;
          if (this.ws) {
            try { this.ws.close(); } catch { /* */ }
            this.ws = null;
          }
          this.ptyId = null;
          reject(new Error(`fs pty op timeout (${timeoutMs}ms): ${op}`));
        }, timeoutMs);
        this.pending.set(id, { resolve: resolve as any, reject, timer });
      });
      this.ws.send(`${line}\n`);
      return await p;
    }) as Promise<{ ok: boolean; data: T }>;
    this.queue = next;
    return next;
  }

  /** 强制销毁: 关 ws + 清 pending + 拒新请求. 下次 init() 重建 PTY.
   *  用于 cwd 切换 / PTY 异常卡住 (写盘 timeout) 后让下次请求重新走新 PTY. */
  reset(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* */ }
      this.ws = null;
    }
    if (this.ptyId) {
      // 不直接调 pty.kill (SDK 没暴露), 让 opencode server 自己回收 idle pty
      this.ptyId = null;
    }
    this.pending.forEach((p) => { if (p.timer) clearTimeout(p.timer); p.reject(new Error('fs pty: reset')); });
    this.pending.clear();
    this.initPromise = null;
  }

  /** 心跳: 每 5s ping 一次, 连续失败 2 次 (10s 内无响应) → 强制 reset.
   *  PTY 卡住时即使 request 自愈也未必能重建 (queue 里有挂死 promise), 心跳主动 reset 兜底.
   *  worker 必须支持 'ping' op (立即返 {pong:true}). */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatFailCount = 0;
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.request('ping', {}, 3000);
        this.heartbeatFailCount = 0;
      } catch (e) {
        this.heartbeatFailCount++;
        if (this.heartbeatFailCount >= 2) {
          // 连续 2 次失败 (~10s 无响应) → 强制 reset, 下次 ping 走新 PTY
          console.warn('[fs-pty] heartbeat failed x2, forcing reset');
          this.reset();
          this.heartbeatFailCount = 0;
        }
      }
    }, 5000);
  }
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

let _fsPty: FsPty | null = null;
function getFsPty(): FsPty {
  if (!_fsPty) {
    _fsPty = new FsPty();
    _fsPty.startHeartbeat();
  }
  return _fsPty;
}
/** 强制销毁当前 FsPty 单例. 下次 getFsPty() 重建.
 *  用于 cwd 切换 / PTY 卡住后自动恢复. */
export function resetFsPty(): void {
  if (_fsPty) {
    _fsPty.stopHeartbeat();
    _fsPty.reset();
    _fsPty = null;
  }
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
/** 已同步路径 → 内容 hash (fs.watch 事件对比: 一致 = 自己写/无变化, 跳过不 fire; 不一致 = 外部改, fire) */
const watcherSyncedHashes = new Map<string, string | null>();

// ---- 真实 stat (FsPty node worker 'stat' op) ----

/** 真实 stat 缓存 (IDE 路径 → {size,mtimeMs}): FsPty stat 结果; 写/外部修改后 invalidateStat 清 */
const statCache = new Map<string, { size: number; mtimeMs: number }>();

/** 清 stat 缓存 (写入/外部修改后, 保证下次 stat 拿到新值) */
function invalidateStat(idePath: string): void {
  const norm = !idePath || idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
  statCache.delete(norm);
}

/** 内容 hash (SHA-256 hex, 浏览器 crypto.subtle) */
async function contentHash(bytes: Uint8Array): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle 不可用 (http 非 localhost) fallback: 简单 hash
    let h = 0;
    for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
      h = ((h << 5) - h + bytes[i]) | 0;
    }
    return `f${h}`;
  }
}

/** 读路径内容 hash (浏览器 fs.read → SDK /file/content) */
async function readPathHash(relPath: string): Promise<string | null> {
  try {
    const fsApi = (window as any).__APP_FS__;
    if (!fsApi?.read) return null;
    const bytes = await fsApi.read(relPath);
    if (!bytes || bytes.length === 0) return await contentHash(new Uint8Array(0));
    return await contentHash(bytes as Uint8Array);
  } catch {
    return null;  // 文件不存在 (删除/目录)
  }
}

/** editor 保存内容 hash (runtime.ts onDidSaveTextDocument 调用) */
export function recordEditorSaveHash(relPath: string, content: string): void {
  void (async () => {
    const bytes = new TextEncoder().encode(content);
    const h = await contentHash(bytes);
    watcherSyncedHashes.set(relPath, h);
  })();
}

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
  //   filename 是否存在区分 add/unlink. 用 client.file.list 父目录看 entry 判断 (不走 PTY).
  //   注: 别用 UPDATED — OpenSumi editor 收到 UPDATED 报 "已经被在磁盘上修改,不能保存"
  let opencodeEvent: FileChangeType;
  if (obj.e === 'rename') {
    opencodeEvent = FileChangeType.ADDED;  // 先 ADDED, OpenSumi 自己 stat 修正
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
  // 内容 hash 对比 + 防抖 (300ms):
  //   自己保存 (editor 记录 hash) / 无变化 → 跳过不 fire (断循环)
  //   外部修改 → hash 不同 → fire
  //   防抖: fs.watch 高频触发时合并, 且等 editor 保存 hash 记录完成
  const key = obj.p;
  const prev = debounceMap.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    debounceMap.delete(key);
    void (async () => {
      const h = await readPathHash(key);
      const synced = watcherSyncedHashes.get(key);
      if (h === synced) {
        // 一致: editor 保存过 / 内容没变 → 跳过
        console.log('[watcher] skip (hash same)', key, h);
        return;
      }
      console.log('[watcher] → fireFilesChange', uri, opencodeEvent, { old: synced, now: h });
      // 外部修改: 清 stat 缓存, 下次 stat 拿新 mtime/size (编辑器重载后 checkInSync 同值)
      invalidateStat(key);
      if (watcherFireFn) {
        watcherFireFn([{ uri, type: opencodeEvent }]);
      }
      // 更新已同步 hash (文件存在 → hash; 不存在 → null)
      watcherSyncedHashes.set(key, h);
    })();
  }, 300);
  debounceMap.set(key, { timer, event: opencodeEvent, uri });
}

/** fs.watch 事件防抖表 (路径 → 定时器) */
const debounceMap = new Map<string, { timer: ReturnType<typeof setTimeout>; event: FileChangeType; uri: string }>();

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
   * 订阅 opencode 事件流. fs 相关 (file.edited / file.watcher.updated) 全部跳过:
   *   - PTY fs.watch (通道 1) 已是 fs 事件唯一来源
   *   - opencode 服务端的 file.watcher.updated 跟 host fs.watch 重复, 双源触发
   *     onDidDeleteFiles 把 sidecar 写入事件当删除 (历史教训)
   *   - 本通道仅用于非 fs 事件 (message.* / a2ui.* 等), 暂时仅 log
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
      console.log('[filesystem] event.subscribe ok (fs 事件已跳过, 仅收非 fs 事件)');
      for await (const evt of events.stream) {
        const t = (evt as any).type as string;
        if (!t) continue;
        // fs 事件全部跳过: PTY fs.watch (通道 1) 是唯一 fs 事件源
        if (t === 'file.edited' || t === 'file.watcher.updated') continue;
        // 其他事件 (message.* / a2ui.* 等) 暂时仅 log
        console.log('[filesystem] non-fs event:', t, (evt as any).properties);
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
   * stat: type 复用 /api/fs/list 拿父目录 entries (opencode 自己拿 type, 准, 且不跑 PTY);
   *       size+mtime 走 FsPty node worker 'stat' op (真实宿主磁盘 fs.statSync, 无 shell 污染).
   *   为什么不用 meta 之前 read 全文拿长度: 读整个文件只为长度, 网络开销远大于一次 stat.
   *   缓存: statCache (path → {size,mtimeMs}), 写/外部修改 invalidateStat 清.
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
    // 未命中: list 父目录拿 entry (opencode SDK /file 不返 mtime, mtime 由 statCache 真实 stat 补)
    if (!entry) {
      const entries = await this.list(base);
      this.listCache.set(base, entries);
      entry = entries.find((e) => e.name === name);
    }
    if (!entry) throw new Error(`stat: not found ${idePath}`);
    // 目录: 不需要 size/mtime (checkInSync 只对文件, setContent 目录会抛 FileIsADirectory)
    if (entry.type === 'directory') {
      return { path: idePath, type: 'directory', size: 0 };
    }
    // 文件: 真实 size + mtime (FsPty worker 'stat', 缓存)
    let st: { size: number; mtimeMs: number } | null = statCache.get(norm) ?? null;
    if (!st) {
      const abs = absPath(idePath);
      const { ok, data } = await getFsPty().request<{ size: number; mtimeMs: number }>('stat', { path: abs }, 8000).catch(() => ({ ok: false, data: null as any }));
      if (ok && typeof data?.size === 'number') {
        st = { size: data.size, mtimeMs: data.mtimeMs };
        statCache.set(norm, st);
      }
    }
    if (!st) return { path: idePath, type: 'file', size: 0 };
    return { path: idePath, type: 'file', size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
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
   * 二进制读 (无损, 大文件安全): 走 FsPty node worker 'readB64' (node fs.readFileSync → base64),
   *   浏览器端 atob 解码. 绕开 opencode /api/fs/read 30MB 限制, 无 shell 污染.
   *   timeout: 30s (大文件 base64 编码/传输耗时).
   */
  async readBinary(idePath: string): Promise<Uint8Array> {
    const abs = absPath(idePath);
    const { ok, data } = await getFsPty().request<{ b64: string }>('readB64', { path: abs }, 30000);
    if (!ok || !data?.b64) throw new Error(`fs readBinary failed: ${idePath}`);
    const bin = atob(data.b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 二进制读 (无损, 大文件安全): 同 readBinary, 接受 relPath (workspace 内路径) → absPath 拼.
   *   timeout: 30s.
   */
  async readBinaryAbsolute(relPath: string): Promise<Uint8Array> {
    return this.readBinary(relPath);
  }

  /**
   * 写文件: base64 内容通过 FsPty node worker 'write'/'append' 写到绝对路径 (node fs API, 无 shell).
   *   大文件分块: 每块 ≤ CHUNK_BYTES base64, 首块 'write' (truncate) 后续 'append'.
   *   父目录: worker 内自动 mkdir -p.
   *   onProgress?: (bytesWritten, totalBytes) 实时回调, 让 UI 显示进度
   */
  async write(
    idePath: string,
    content: string | { base64: string },
    onProgress?: (done: number, total: number) => void,
  ): Promise<boolean> {
    const abs = absPath(idePath);
    const b64 = typeof content === 'string' ? bytesToBase64(content) : content.base64;
    const CHUNK = 4 * 1024; // base64 chars / 块 (远低于 ws 单帧安全大小)
    // 首块 write (truncate, 空内容也建空文件)
    const first = b64.slice(0, CHUNK);
    let ok = (await getFsPty().request('write', { path: abs, b64: first }, this.writeTimeoutMs(first.length))).ok;
    if (!ok) return false;
    onProgress?.(first.length, b64.length);
    // 剩余块 append
    for (let i = CHUNK; i < b64.length; i += CHUNK) {
      const chunk = b64.slice(i, i + CHUNK);
      const r = await getFsPty().request('append', { path: abs, b64: chunk }, this.writeTimeoutMs(chunk.length));
      if (!r.ok) return false;
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
    const ok = (await getFsPty().request('rm', { path: absPath(idePath) })).ok;
    if (ok) this.invalidateParent(idePath);
    return ok;
  }

  async rmdir(idePath: string): Promise<boolean> {
    const ok = (await getFsPty().request('rmdir', { path: absPath(idePath) })).ok;
    if (ok) this.invalidateParent(idePath);
    return ok;
  }

  async mkdirp(idePath: string): Promise<boolean> {
    const ok = (await getFsPty().request('mkdir', { path: absPath(idePath) })).ok;
    if (ok) this.invalidateParent(idePath);
    return ok;
  }

  async move(from: string, to: string): Promise<boolean> {
    const ok = (await getFsPty().request('move', { from: absPath(from), to: absPath(to) })).ok;
    if (ok) {
      this.invalidateParent(from);
      this.invalidateParent(to);
    }
    return ok;
  }

  /** 文件树变化后: 清掉相关缓存 (自身 + 父目录: listCache + statCache) */
  private invalidateParent(idePath: string): void {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    this.listCache.delete(norm);
    const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    this.listCache.delete(parent);
    invalidateStat(norm);
    invalidateStat(parent);
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
