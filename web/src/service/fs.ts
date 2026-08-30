/**
 * filesystem + FsPty + watcher — service/fs.ts
 *
 * 合并: 文件系统主类 + 写操作 PTY 单例 + 独立 fs watcher
 *
 * 职责:
 *   - list / read / find: opencode 全局 API (/api/fs/list, /api/fs/read/*, /find/file), 走 x-opencode-directory 切工作目录
 *   - write / rm / mkdirp / move / readBinary: opencode 全局 PTY (单例 FsPty), 跨平台命令构造器
 *   - 事件: 独立 fs watcher (PTY 跑 node:fs.watch recursive:true) + 兜底 SDK /global/event SSE
 *   - 单实例: 业务代码与容器共用同一文件系统实例,
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
import { IFileTreeService } from '@opensumi/ide-file-tree-next/lib/common';
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

/** file:///workspace/1.txt → /1.txt (IDE 相对路径) */
function uriToRel(uri: string): string {
  const marker = `file://${WORKSPACE_ROOT}`;
  if (uri.startsWith(marker)) return uri.slice(marker.length) || '/';
  const idx = uri.indexOf('://');
  const path = idx >= 0 ? uri.slice(idx + 3).replace(/^\/+/, '/') : uri;
  return path.startsWith('/') ? path : `/${path}`;
}

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
  /** 串行化: 上一个请求的 promise (一次只跑一个原子 pty 会话, 避免并发写同文件竞争) */
  private queue: Promise<unknown> = Promise.resolve();

  /** 原子 pty 会话: 创建 pty + 连 ws + 发 op(s) + 收响应, finally 关 ws + kill server 端 pty.
   *  每次操作独立生命周期 → 无长连接失联/无心跳/无自愈, 天然干净. */
  private async runSession<T>(
    ops: Array<{ op: string; payload: Record<string, unknown>; timeoutMs?: number }>,
  ): Promise<{ results: Array<{ ok: boolean; data: any }>; session: PtySession }> {
    const session = new PtySession();
    try {
      await session.init();
      const results: Array<{ ok: boolean; data: any }> = [];
      for (const { op, payload, timeoutMs } of ops) {
        results.push(await session.request(op, payload, timeoutMs));
      }
      return { results, session };
    } finally {
      void session.dispose();
    }
  }

  /** 单 op 原子会话 */
  async request<T = any>(op: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<{ ok: boolean; data: T }> {
    const next = this.queue.then(async () => {
      const { results } = await this.runSession([{ op, payload, timeoutMs }]);
      return results[0] as { ok: boolean; data: T };
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** 多 op 同会话 (write 分块: 首块 write + 后续 append 共用一个 pty, 保证原子) */
  async batch<T = any>(
    ops: Array<{ op: string; payload: Record<string, unknown>; timeoutMs?: number }>,
    onEach?: (i: number, r: { ok: boolean; data: any }) => void,
  ): Promise<Array<{ ok: boolean; data: T }>> {
    const next = this.queue.then(async () => {
      const { results, session } = await this.runSession(ops);
      results.forEach((r, i) => onEach?.(i, r));
      return results as Array<{ ok: boolean; data: T }>;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/** 单个 pty 会话: create → ws → op(s) → close. 生命周期随一次操作, 用完即弃. */
class PtySession {
  private ptyId: string | null = null;
  private ws: WebSocket | null = null;
  private sdk: ReturnType<typeof createOpencodeClient> | null = null;
  /** 等待中的请求 (id → resolve/reject/timer) */
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** worker 响应行缓冲 (跨 ws 帧拼接 JSON 行) */
  private respBuf = '';
  private nextId = 1;

  /** 创建 node worker pty + connect ws */
  async init(): Promise<void> {
    const base = appBaseUrl();
    if (!base) throw new Error('fs pty: app base url not ready');
    const cwd = effectiveCwd();
    if (!cwd) throw new Error('fs pty: no cwd (APP_CWD unset and hostCwd not yet probed)');

    const sdk = createOpencodeClient({ baseUrl: base, headers: cwdHeader(), responseStyle: 'fields', throwOnError: true });
    this.sdk = sdk;
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
    };
  }

  /** 主动清理: 关 ws + reject pending + kill server 端 pty. 幂等. */
  async dispose(): Promise<void> {
    if (this.ptyId && this.sdk) {
      try { await this.sdk.pty.remove({ ptyID: this.ptyId }); }
      catch { /* server 可能已断, 忽略 */ }
    }
    this.ptyId = null;
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
    this.pending.forEach((p) => { if (p.timer) clearTimeout(p.timer); p.reject(new Error('fs pty: session disposed')); });
    this.pending.clear();
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

  /** 发一个 op 并等响应 (同会话内 id 递增, 串行) */
  request<T = any>(op: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<{ ok: boolean; data: T }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('fs pty: not initialized');
    const id = String(this.nextId++);
    const line = JSON.stringify({ id, op, ...payload });
    const p = new Promise<{ ok: boolean; data: T }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`fs pty op timeout (${timeoutMs}ms): ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as any, reject, timer });
    });
    this.ws.send(`${line}\n`);
    return p;
  }
}

let _fsPty: FsPty | null = null;
function getFsPty(): FsPty {
  if (!_fsPty) {
    _fsPty = new FsPty();
  }
  return _fsPty;
}
/** 强制销毁当前 FsPty 单例. 下次 getFsPty() 重建. */
export function resetFsPty(): void {
  _fsPty = null;
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
let watcherSdk: ReturnType<typeof createOpencodeClient> | null = null;
let watcherRetryCount = 0;
let watcherStopped = false;
let watcherCwd = '';
let watcherStdoutBuf = '';
let watcherFireFn: ((changes: Array<{ uri: string; type: FileChangeType }>) => void) | null = null;
/** 已同步路径 → 内容 hash (fs.watch 事件对比: 一致 = 自己写/无变化, 跳过不 fire; 不一致 = 外部改, fire) */
const watcherSyncedHashes = new Map<string, string | null>();

/** 记录"自己写的"内容 hash — WriteSyncFS 写服务器成功后调用.
 *  断循环: 编辑器保存 → 写服务器 → fs.watch 事件 → hash 对比一致 → skip 不 fire;
 *  外部修改 (vim/Finder) 无记录 → hash 不同 → fire 通知 codeblitz.
 *  @param content 内容 (string/Uint8Array); null 表示"已删除" (watcher 读不到文件时对比 null)
 *  @returns Promise: 调用方 (WriteSyncFS.syncWrite) await 保证 hash 先于 watcher 对比写入 */
export function recordSyncedHash(relPath: string, content: string | Uint8Array | null): Promise<void> {
  if (content === null) {
    watcherSyncedHashes.set(relPath, null);
    return Promise.resolve();
  }
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return contentHash(bytes).then((h) => {
    watcherSyncedHashes.set(relPath, h);
  });
}

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
    // 先确认真实存在性: 用 FsPty stat (真实宿主磁盘, 不走 listCache 缓存).
    // 删除后 read 可能返回空数组而非抛错, 且 exists() 走 listCache 缓存误报 → 空文件 hash
    // 跟创建时一致 → skip, 删除事件被吞. stat 真实存在 → null (DELETED).
    try {
      const abs = absPath(relPath);
      const { ok } = await getFsPty().request<{ size: number }>('stat', { path: abs }, 5000).catch(() => ({ ok: false, data: null as any }));
      if (!ok) return null;
    } catch {
      return null;
    }
    const bytes = await fsApi.read(relPath);
    if (!bytes || bytes.length === 0) return await contentHash(new Uint8Array(0));
    return await contentHash(bytes as Uint8Array);
  } catch {
    return null;  // 文件不存在 (删除/目录)
  }
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

/** fs.watch 事件防抖表 (路径 → 定时器): PTY watcher + SDK event.subscribe 共用,
 *  同一 path 300ms 窗口内多次事件合并为一次 fire (双路径不重复). */
const debounceMap = new Map<string, { timer: ReturnType<typeof setTimeout>; event: FileChangeType; uri: string }>();

/**
 * 公共防抖调度: 同一 path 的事件 (PTY watcher / SDK event.subscribe 双路径都会来)
 * 在 300ms 窗口内合并, 到点只 fire 一次 fireFilesChange + fs:changed.
 * 内部再做 hash 对比 (自己保存/无变化跳过, 断循环).
 */
function scheduleFsFire(key: string, changeType: FileChangeType): void {
  const rawUri = `file://${WORKSPACE_ROOT}${key}`;
  const tmp = rawUri.replace('://', '\u0000\u0000\u0000').replace(/\/+/g, '/').replace('\u0000\u0000\u0000', '://');
  const uri = tmp;
  const prev = debounceMap.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    debounceMap.delete(key);
    void (async () => {
      const h = await readPathHash(key);
      const synced = watcherSyncedHashes.get(key);
      if (h === synced) {
        // 一致: editor 保存过 / 内容没变 → 跳过 (断循环)
        console.log('[watcher] skip (hash same)', key, h);
        return;
      }
      // 按最终状态修正: 文件不存在 → DELETED; 存在 → ADDED/UPDATED
      let finalEvent = changeType;
      if (h === null) {
        finalEvent = FileChangeType.DELETED;
      }
      console.log('[watcher] → fireFilesChange', uri, finalEvent, { old: synced, now: h });
      // 外部修改: 清 stat 缓存, 下次 stat 拿新 mtime/size (编辑器重载后 checkInSync 同值)
      invalidateStat(key);
      if (watcherFireFn) {
        watcherFireFn([{ uri, type: finalEvent }]);
      }
      // 派发 fs:changed CustomEvent (sidecar/其他拓展监听)
      const typeLabel = finalEvent === FileChangeType.ADDED ? 'add'
        : finalEvent === FileChangeType.DELETED ? 'unlink'
        : 'change';
      window.dispatchEvent(new CustomEvent('fs:changed', { detail: { type: typeLabel, path: key } }));
      // 更新已同步 hash (文件存在 → hash; 不存在 → null)
      watcherSyncedHashes.set(key, h);
    })();
  }, 300);
  debounceMap.set(key, { timer, event: changeType, uri });
}

/** 处理单个 JSON object: opencode pty 控制帧 (cursor/resize/method) 忽略, 其余作 fs event */
function handleJsonObject(obj: any): void {
  if (!obj || typeof obj !== 'object') return;
  if ('cursor' in obj || obj.type === 'cursor' || obj.type === 'resize' || 'method' in obj) return;
  if (typeof obj.e !== 'string' || typeof obj.p !== 'string') return;
  // fs.watch → OpenSumi 事件类型转换:
  //   node:fs.watch (跨平台) 的 'rename' 事件语义是 "路径节点被重命名/创建/删除/修改",
  //   macOS 上外部写入 (vim/Finder) 常表现为 rename 而非 change.
  //   OpenSumi fs-resource 的 onFilesChanged 只对 ADDED/DELETED 触发编辑器 reload (清缓存+ResourceNeedUpdateEvent),
  //   UPDATED 分支仅当缓存 undefined 才更新 → 已打开文件不 reload.
  //   故外部修改: 文件仍存在 → ADDED (reload 已打开编辑器); 不存在 → DELETED.
  let opencodeEvent: FileChangeType;
  if (obj.e === 'rename') {
    opencodeEvent = FileChangeType.ADDED;  // 防抖后 readPathHash null (不存在) 再改 DELETED
  } else {
    const t = TYPE_MAP[obj.e];
    if (t === undefined) { console.log('[watcher] unknown event type:', obj.e); return; }
    opencodeEvent = t;
  }
  // key 统一 IDE 相对路径格式 (带前导 /), 跟 recordSyncedHash 的 workspaceRel 一致 —
  // 否则 WriteSyncFS 写后记录的是 /1.txt, watcher 对比的是 1.txt → 永远匹配不上, 断循环失效
  const key = obj.p.startsWith('/') ? obj.p : `/${obj.p}`;
  scheduleFsFire(key, opencodeEvent);
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
    watcherSdk = sdk;

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
      // 正常关闭 (1000/1005) = 主动停或被杀 → 不重连; 异常断开 (1006) → 重试
      if (!watcherStopped && ev?.code !== 1000 && ev?.code !== 1005) scheduleWatcherRetry();
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
  // 杀 server 端 watcher pty (只关 ws 不杀 → 僵尸 pty 堆积, 页面 reload 累积十几个)
  const ptyId = watcherPtyId;
  const sdk = watcherSdk;
  watcherPtyId = null;
  watcherSdk = null;
  if (ptyId && sdk) {
    void sdk.pty.remove({ ptyID: ptyId }).catch(() => {});
  }
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

  @Autowired(IFileTreeService)
  private readonly fileTreeService!: IFileTreeService;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  /** SDK client (用于 event.subscribe SSE 兜底; 写走 FsPty) */
  private fsClient: ReturnType<typeof createOpencodeClient> | null = null;
  /** SDK 事件流 (SSE, 用于 file.* 兜底) */
  private eventAbort: AbortController | null = null;
  /** explorer 树重建防抖 timer (删除事件后重建) */
  private treeRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** 删除事件后重建 explorer 树 (BrowserFS 缓存/树节点残留, refresh 不移除) */
  private scheduleTreeRebuild: () => void = () => {};

  constructor() {
    FileSystemServiceImpl.instance = this;
    (window as any).__APP_FS__ = this;
  }

  /** 容器启动: 挂全局单例 + 订阅 fs 事件（runtime 就绪后）+ 启 fs watcher + explorer 刷新 + 恢复编辑器 tab */
  onStart(): void {
    (window as any).__APP_FS__ = this;
    console.log('[filesystem] service ready, baseUrl:', appBaseUrl() || '(unset)');
    // 页面卸载: 停 watcher + 杀 server 端 pty (防 reload 后僵尸 watcher 堆积)
    window.addEventListener('pagehide', () => stopFsWatcher());
    window.addEventListener('beforeunload', () => stopFsWatcher());
    // 把 fireFilesChange 注入到 watcher 模块 (避免循环 import) + 同步打开的编辑器 (外部修改 → reload)
    bindWatcherFireFilesChange(async (changes) => {
      // 清 BrowserFS readable (DynamicRequest) entriesLoaded → explorer 重新拉真实目录.
      // 注意: 不能 clearCache 全清 (目录树被清空后 OverlayFS 写文件 EBUSY).
      try { (window as any).__RESET_BFS_CACHE__?.(); } catch { /* ignore */ }
      // 外部删除 (DELETED): 精确移除 writable InMemory 中该路径 (否则 OverlayFS.readdir 合并旧目录树, 残留显示)
      const writeFs = (window as any).__APP_WRITE_SYNC_FS__;
      if (writeFs?.removePath) {
        changes.forEach((c) => {
          if (c.type === FileChangeType.DELETED) {
            try { writeFs.removePath(uriToRel(c.uri)); } catch { /* ignore */ }
          }
        });
      }
      changes.forEach((c) => this.invalidateParent(uriToRel(c.uri)));
      this.fileService.fireFilesChange({ changes });
      // 额外 fire 父目录 → 触发 explorer 树刷新 (单文件 ADDED 不会自动刷新树).
      // 根目录用 DELETED (type 2): explorer isRootAffected 只认 type > UPDATED 才强制刷新整树.
      const dirChanges = new Map<string, boolean>();
      changes.forEach((c) => {
        const rel = uriToRel(c.uri);
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) || '/' : '/';
        if (parent !== rel) {
          const dirUri = parent === '/' ? `file://${WORKSPACE_ROOT}` : `file://${WORKSPACE_ROOT}${parent}`;
          dirChanges.set(dirUri, true);
        }
      });
      if (dirChanges.size > 0) {
        this.fileService.fireFilesChange({
          changes: Array.from(dirChanges.keys()).map((uri) => {
            const isRoot = uri === `file://${WORKSPACE_ROOT}`;
            return { uri, type: (isRoot ? 2 : 1) as FileChangeType };
          }),
        });
      }
      // 外部修改 → 已打开且不 dirty 的编辑器直接更新内容 (绕开 OpenSumi getMd5 缓存链路)
      changes.forEach((c) => this.syncOpenEditor(uriToRel(c.uri)));
      // 强制 explorer 树刷新: 删除事件 → 重建 root (BrowserFS 缓存/树节点残留, refresh 不移除);
      // 其他事件 → refresh.
      try {
        const hasDelete = changes.some((c) => c.type === FileChangeType.DELETED);
        if (hasDelete) {
          this.scheduleTreeRebuild();
        } else {
          await this.fileTreeService?.refresh();
        }
      } catch (e) {
        console.warn('[filesystem] fileTree refresh fail:', e);
      }
    });
    // 删除事件后重建 explorer 树 (防抖 + 延迟: opencode SDK file.list 删除后 ~1.5s 缓存才失效,
    // 立即重建会拉到旧列表 (含已删项) 又显示回去. 延迟 2s 等缓存失效).
    this.treeRebuildTimer = null;
    this.scheduleTreeRebuild = () => {
      if (this.treeRebuildTimer) return;
      this.treeRebuildTimer = setTimeout(async () => {
        this.treeRebuildTimer = null;
        try {
          // 重建前再 reset (fire 时的 reset 被 fireFilesChange 立即触发的 resolveChildren 消费了;
          // 2s 后 SDK 缓存已失效, 再 reset 让重建时真正重新拉列表)
          try { (window as any).__RESET_BFS_CACHE__?.(); } catch { /* ignore */ }
          const tree = this.fileTreeService as any;
          if (!tree?.root) return;
          const roots = await tree.workspaceService?.roots;
          const rootUri = roots?.[0]?.uri;
          if (!rootUri) return;
          const dirClass = tree.root.constructor;
          const newRoot = new dirClass(tree, undefined, new (tree.root.uri.constructor)(rootUri), 'workspace', roots[0], 'workspace');
          tree.root = newRoot;
          tree.onWorkspaceChangeEmitter?.fire?.(newRoot);
          await tree.refresh?.();
          console.log('[filesystem] explorer 树已重建 (删除同步)');
        } catch (e) {
          console.warn('[filesystem] explorer 树重建失败:', e);
        }
      }, 2000);
    };
    const onReady = () => {
      this.connectEvents();
      void this.startWatcher();
      void this.verifyOpensumiLink();
      void this.refreshExplorer();
      this.watchEditorState();
      this.restoreOpenedEditors();
    };
    // 单次启动: runtime-ready 事件或 baseUrl 就绪, 二选一 (都调会 stop→start 双启 watcher)
    if (appBaseUrl()) {
      onReady();
    } else {
      window.addEventListener('runtime-ready', onReady);
    }
  }

  /** 外部修改 → 同步已打开的编辑器: 文件在打开 tab 且不 dirty 时, 读服务器新内容更新 monaco model.
   *  绕开 OpenSumi 原生链路 (fireFilesChange → getMd5 走 BrowserFS 缓存 → md5 对比 → reload, 不可靠). */
  private syncOpenEditor(relPath: string): void {
    if (!relPath || relPath === '/') return;
    try {
      const monaco: any = (window as any).monaco;
      if (!monaco?.editor) return;
      // 找对应 model (uri: file:///workspace/<rel>)
      const models = monaco.editor.getModels();
      const target = models.find((m: any) => {
        const s = String(m.uri?.toString?.() || '');
        return s === `file://${WORKSPACE_ROOT}${relPath}` || s.endsWith(relPath);
      });
      if (!target) return;
      // dirty (用户有未保存修改) → 不覆盖
      const ed = monaco.editor.getEditors?.().find((e: any) => e.getModel?.() === target);
      if (ed && ed.getModifiedLinesCount?.() > 0) return;
      if (target.getAlternativeVersionId() !== target.getVersionId()) return; // dirty 兜底
      // 读服务器新内容 → 更新 model (保留 undo 栈).
      // 先 stat 确认文件存在: 外部删除后 read 返回空数组 (非抛错), 直接更新会把删除当"空内容"
      // → model 变化 → 触发写回 (WriteSyncFS.syncWrite) → 远程又创建空文件!
      void (async () => {
        try {
          const st = await getFsPty().request<{ size: number }>('stat', { path: absPath(relPath) }, 5000).catch(() => ({ ok: false, data: null as any }));
          if (!st.ok) {
            // 文件已删除: 不更新编辑器 (防止空内容写回); 让 OpenSumi 自身处理 (tab 关闭等)
            console.log('[fs] 外部删除 → 跳过编辑器同步:', relPath);
            return;
          }
          const bytes = await getFileSystemService().read(relPath);
          const content = new TextDecoder().decode(bytes);
          if (content === target.getValue()) return;
          target.pushEditOperations([], [{ range: target.getFullModelRange(), text: content }], () => null);
          console.log('[fs] 外部修改 → 已同步编辑器:', relPath);
        } catch { /* read/stat 失败静默 */ }
      })();
    } catch (e) {
      console.warn('[fs] syncOpenEditor failed:', relPath, e);
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
   * 订阅 opencode 事件流. fs 相关 (file.edited / file.watcher.updated) 全部订阅:
   *   - 跟 host PTY fs.watch (通道 1) 双源重复 → OpenSumi BrowserFS 内部去重, 不冲突
   *   - 必须订阅, 否则 editor stat cache 跟 host disk 失同步 → "操作过于频繁" 冲突
   *     (实测: 2e8f06f 屏蔽后, editor 跟 host disk 12 个文件 stat cache 不一致, 弹同步提示)
   *   - 注: onDidDeleteFiles 误触侧已实测不存在 (写文件内部不 unlink,
   *     走 open+write), 所以订阅 fs.* 事件不会引发误删
   */
  private async connectEvents(): Promise<void> {
    const base = appBaseUrl();
    if (!base) return;
    if (this.eventAbort) return;
    const abort = new AbortController();
    this.eventAbort = abort;
    const typeMap: Record<string, FileChangeType> = {
      add: FileChangeType.ADDED,
      change: FileChangeType.UPDATED,
      unlink: FileChangeType.DELETED,
    };
    try {
      const client = this.ensureClient();
      const events = await client.event.subscribe(undefined, { signal: abort.signal });
      console.log('[filesystem] event.subscribe ok (fs 事件已重新订阅, 修 editor stat 同步)');
      for await (const evt of events.stream) {
        const t = (evt as any).type as string;
        if (!t) continue;
        // fs 事件重新订阅: file.edited / file.watcher.updated → fireFilesChange + dispatch fs:changed
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
        // 走公共防抖调度 (跟 PTY watcher 共用 debounceMap): 同一 path 300ms 窗口合并,
        // 双路径 (PTY + SDK) 收到同一变更只 fire 一次. hash 对比 + fire 在 scheduleFsFire 内.
        console.log('[filesystem] fs event:', t, rel, '→ scheduleFsFire');
        scheduleFsFire(rel, typeMap[changeType] ?? FileChangeType.UPDATED);
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
    // 目录可能已删除 (外部删/刷新竞态) → 返回空数组, 不抛错 (否则 explorer 刷新中断, 残留节点)
    try {
      const { data, error } = await c.file.list({ path: queryPath, directory: cwd })
      if (error) return [];
      const entries: FsEntry[] = (data || []).map((e) => ({
        name: e.name,
        type: e.type === 'directory' ? 'directory' : 'file',
      }));
      // 回填 stat 缓存 (meta 直接命中, 避免重复 list)
      this.listCache.set(norm, entries);
      return entries;
    } catch {
      return [];
    }
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
   *   原子性: 所有块在同一个 pty 会话内完成 (batch), 创建1次 pty → 发完所有块 → 关闭.
   *   父目录: worker 内自动 mkdir -p.
   *   onProgress?: (bytesWritten, totalBytes) 实时回调, 让 UI 显示进度
   */
  async write(
    idePath: string,
    content: string | { base64: string },
    onProgress?: (done: number, total: number) => void,
  ): Promise<boolean> {
    const abs = absPath(idePath);
    // 写入前对比远程内容: 文件已存在且内容一样 → 跳过写入 (防重复写 + 防 OverlayFS EBUSY 写路径).
    // 先 stat 确认存在 (SDK read 对不存在返回空数组而非抛错, 直接对比会把"新建空文件"误判为内容一致跳过!)
    if (typeof content === 'string') {
      try {
        const st = await getFsPty().request<{ size: number }>('stat', { path: abs }, 5000).catch(() => ({ ok: false, data: null as any }));
        if (st.ok) {
          const remote = await this.read(idePath);
          const remoteText = new TextDecoder().decode(remote);
          if (remoteText === content) {
            // 内容一致: 不写, 但记录 hash (断循环), 返回成功
            await recordSyncedHash(idePath, content);
            return true;
          }
        }
      } catch { /* 异常 → 正常写 */ }
    }
    const b64 = typeof content === 'string' ? bytesToBase64(content) : content.base64;
    // opencode pty 单次输入上限实测: b64 934 OK / 1068 TIMEOUT (~800 字节原文).
    // CHUNK (b64 chars) 必须远小于该限制: 取 600 → 对应 450 字节原文, 留 40% 余量.
    const CHUNK = 600; // base64 chars / 块 (实测 opencode pty 单行输入 < 1KB 安全)
    const ops: Array<{ op: string; payload: Record<string, unknown>; timeoutMs?: number }> = [];
    // 首块 write (truncate, 空内容也建空文件)
    ops.push({ op: 'write', payload: { path: abs, b64: b64.slice(0, CHUNK) }, timeoutMs: this.writeTimeoutMs(Math.min(CHUNK, b64.length)) });
    // 剩余块 append
    for (let i = CHUNK; i < b64.length; i += CHUNK) {
      const chunk = b64.slice(i, i + CHUNK);
      ops.push({ op: 'append', payload: { path: abs, b64: chunk }, timeoutMs: this.writeTimeoutMs(chunk.length) });
    }
    // 一次 pty 会话完成所有块 (原子写)
    const results = await getFsPty().batch(ops, (i, r) => {
      if (r.ok) onProgress?.(Math.min((i + 1) * CHUNK, b64.length), b64.length);
    });
    if (results.some((r) => !r.ok)) return false;
    this.invalidateParent(idePath);
    // 记录自写 hash → pty watch 对比一致 → skip 不 fire (断循环)
    if (typeof content === 'string') {
      await recordSyncedHash(idePath, content);
    }
    // 刚写的文件必然存在 → 从 OverlayFS deletionLog 恢复 (历史残留误删标记会挡 explorer + 触发反向删远程)
    try { (window as any).__RESTORE_DELETION_LOG__?.(idePath); } catch { /* ignore */ }
    return true;
  }

  /** 写超时: 30s 基础 + 1s / KB base64, 上限 5min. 大文件能传完, 又不会无限挂 */
  private writeTimeoutMs(b64Len: number): number {
    return Math.min(300000, 30000 + Math.ceil(b64Len / 1024) * 1000);
  }

  async rm(idePath: string): Promise<boolean> {
    const ok = (await getFsPty().request('rm', { path: absPath(idePath) })).ok;
    if (ok) {
      this.invalidateParent(idePath);
      await recordSyncedHash(idePath, null);  // 自删记录 null → watcher 对比一致 skip
    }
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
