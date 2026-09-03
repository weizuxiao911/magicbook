/**
 * filesystem + watcher — service/fs.ts
 *
 * 合并: 文件系统主类 + 写操作 PTY 单例 + 独立 fs watcher
 *
 * 职责:
 *   - list / read / find: opencode 全局 API (/api/fs/list, /api/fs/read/*, /find/file), 走 x-opencode-directory 切工作目录
 *   - write / rm / mkdirp / move / stat / readBinary: opencode v2 /api/fs/* 直连
 *   - 事件: 独立 fs watcher (PTY 跑 node:fs.watch recursive:true) + 兜底 SDK /global/event SSE
 *   - 单实例: 业务代码与容器共用同一文件系统实例,
 *     opensumi 容器与业务代码共用同一文件系统实例
 *
 * 路径: 一律 IDE 相对路径 (/foo), server 在 cwd 下操作.
 *
 * 设计: 全局交互不依赖 session; session 只服务 chat agent 工具调用.
 *   原实现 write/rm/mkdir/move 走 /session/{id}/shell, 单 session 一次只能跑一个 shell → 并发 409.
 *   写操作直连 /api/fs (write/mkdir/remove/rename/stat), 读/查找走 SDK.
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain, CommandService, FileChangeType, URI } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { IFileTreeService } from '@opensumi/ide-file-tree-next/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';

import type { FsEntry, FileMeta, IFileSystem } from '../commands/fs';
import { FsToken } from '../commands/fs';
import {
  appBaseUrl,
  cwdHeader,
  effectiveCwd,
  secureUrl,
} from './env';

// ---- 工具函数 ----

/**
 * v2 /api/fs/* 写接口直连 (write/mkdir/remove/rename/stat).
 * 替代 FsPty (pty 跑 node worker) — opencode server 新增的 /api/fs 写端点.
 */

/** idePath → opencode 相对路径
 *  - "/4.txt" 或 "/dir/2.txt" → "4.txt" / "dir/2.txt"
 *  - "/workspace/4.txt" → "4.txt" (兼容 codeblitz WORKSPACE_ROOT 残留)
 *  - "/Users/weizuxiao/.../4.txt" (host 绝对) → "4.txt" (去 host cwd 前缀, 跟 opencode cwd 拼)
 *  - "/Users/.../其他" (不在 cwd 下) → 原样, opencode 端会 "Path escapes the location" */
/** 跨平台路径分隔符: 把 \ 和 / 都规范化成 /.  Windows path.resolve 兼容 */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Windows 盘符判定 (含带前导 '/' 的错误形态 '/D:/...') */
function isWindowsDrive(p: string): boolean {
  return /^\/?[A-Za-z]:/.test(p);
}

/** 跨平台 basename: 兼容 '/' 和 '\' 分隔符.
 *  server Entry.path 目录尾 sep 用 path.sep: mac '/', win '\' (e.g. 'docs\').
 *  client 之前只按 '/' 解析 → Windows 下 name 带 '\' → explorer 树不显示. */
function pathBase(p: string): string {
  const s = normalizeSep(p).replace(/[\\\/]+$/, '');
  const seg = s.split('/').pop();
  return seg ? seg : p;
}

/** 绝对路径规范化: 盘符形态去前导 '/' + 反斜杠转正斜杠; POSIX 原样 */
function normalizeAbs(p: string): string {
  const s = normalizeSep(p);
  return isWindowsDrive(s) ? s.replace(/^\/+/, '') : s;
}

/** 宿主机绝对路径 → 相对 effectiveCwd() 的相对路径,  用于 server 端 /api/fs/* 端点.
 *  跨平台:  macOS/Linux '/Users/foo' 跟 cwd '/Users/foo' →  '.' ;  Windows 'C:\foo' 跟 cwd 'C:\foo' → '.'.
 *  返回 null 表示 absPath 不在 cwd 下 (server 端 FSUtil.contains 校验会失败).
 *  注: 用于 FilePicker 状态 (host 绝对路径) 跟 opencode /api/fs/list 等 server 端点协议.
 */
function absToRel(absPath: string, cwd: string): string | null {
  if (!cwd) {
    // 无 cwd 兜底,  不 strip — server fallback process.cwd 时会拼错位,  但至少不崩.
    return normalizeAbs(absPath).replace(/^\/+/, '');
  }
  const a = normalizeAbs(absPath).replace(/\/+$/, '');
  const c = normalizeAbs(cwd).replace(/\/+$/, '');
  if (a === c) return '.';
  if (a.startsWith(c + '/')) return a.slice(c.length + 1);
  return null;
}

function relForApi(idePath: string): string {
  const hostCwd = effectiveCwd();
  if (hostCwd) {
    const r = absToRel(idePath, hostCwd);
    if (r !== null) return r;
  }
  let p = normalizeSep(idePath).replace(/^\/+/, '');
  if (p.startsWith('workspace/')) p = p.slice('workspace/'.length);
  return p;
}

/** /api/fs 请求 (JSON), 解包 {location, data} → data */
async function fsApiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const base = appBaseUrl();
  if (!base) throw new Error('fs api: app base url not ready');
  const url = `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    ...cwdHeader(),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`fs api ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json() as Promise<T>;
  return (await res.text()) as unknown as T;
}

async function fsApiGet<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fsApiFetch<{ data?: T }>(path, init);
  return (res as any)?.data !== undefined ? (res as any).data : (res as T);
}

async function fsApiPost<T = any>(path: string, body?: object, init: RequestInit = {}): Promise<T> {
  const res = await fsApiFetch<{ data?: T }>(path, { ...init, method: 'POST', body: body ? JSON.stringify(body) : undefined });
  return (res as any)?.data !== undefined ? (res as any).data : (res as T);
}

/** /api/fs/stat: {path, type, size?, mtime?} */
interface FsStatResult {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
}

/** stat (真实宿主磁盘): 存在 → 结果; 不存在/错误 → null */
async function fsStat(idePath: string): Promise<FsStatResult | null> {
  const url = `/api/fs/stat?path=${encodeURIComponent(relForApi(idePath))}`;
  const r = await fsApiGet<FsStatResult>(url).catch((e) => { console.log('[fsStat] ERR', { idePath, err: e?.message }); return null; });
  console.log('[fsStat]', { idePath, result: r });
  return r;
}

/** 读文件内容 (真实宿主磁盘, 不走 BrowserFS InMemory 缓存): 存在 → Uint8Array; 404 → null.
 *  注意: 不能用 BrowserFS read — 它的 _writable 是 InMemory, 跟磁盘可能不一致 (例如外部 truncate 后
 *  monaco 推 _syncSync 写 _writable = 空, 但磁盘已变成 3 字节"中文", 后续 read 走 InMemory 永远空).
 *  opencode 端 /api/fs/read 404 = 文件不存在 (DELETED), 200 + body length 0 = 文件存在但 0 字节. */
async function fsReadRaw(idePath: string): Promise<Uint8Array | null> {
  const url = `/api/fs/read/${encodeURIComponent(relForApi(idePath))}`;
  try {
    const resp = await fetch(`${appBaseUrl()}${url}`, { headers: cwdHeader() });
    console.log('[fsReadRaw]', { idePath, status: resp.status, contentLen: resp.status === 200 ? (await resp.clone().arrayBuffer()).byteLength : 0 });
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    console.log('[fsReadRaw] ERR', { idePath, err: (e as any)?.message });
    return null;
  }
}

/** 两种 URI 格式都支持:
 *  - file:///workspace/1.txt (旧 BrowserFS mount 路径, fireFilesChange 自己发)
 *  - file:///Users/weizuxiao/.../4.txt (BrowserFS 实际 URI = host 绝对路径, editor 用,
 *    含 URL-encoded 字符如 %E6%98%A5 中文, 不能直接和 effectiveCwd() 比)
 *  都转成 codeblitz IDE 相对路径 (即相对于 host cwd): /1.txt, /4.txt
 *  返回 null 表示路径不在 host cwd 下, 调用方应跳过 (fire 出去 BrowserFS 会当 cwd 内路径
 *  处理 → 触发 stat 500 + DirInode reset + "explorer 树已重建" 全清空 = 文件被误删) */
function uriToRel(uri: string): string | null {
  const marker = `file://${WORKSPACE_ROOT}`;
  if (uri.startsWith(marker)) return uri.slice(marker.length) || '/';
  const idx = uri.indexOf('://');
  const rawPath = idx >= 0 ? uri.slice(idx + 3).replace(/^\/+/, '/') : uri;
  // URL-decode 让路径和 effectiveCwd() (raw) 可比 (BrowserFS 用 URL-encoded 形式)
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  // host 绝对路径 → 去 host cwd 前缀; 不在 cwd 下 → null 丢弃
  // 跨平台: Windows host 路径 'C:\Users\...' 跟 cwd 比较必须规范化 (反斜杠/正斜杠),
  // 不能直接 startsWith — 否则 Windows 下全部事件 null → explorer 不更新;
  // 更不能给盘符路径补 '/' 前缀 (会变 '/C:/Users/...' 坏路径).
  const hostCwd = effectiveCwd();
  if (hostCwd) {
    const r = absToRel(path, hostCwd);
    if (r === null) return null;
    return r === '.' ? '/' : `/${r}`;
  }
  // 兜底: 无 cwd 时接受任意绝对路径 (保持原行为); 盘符格式不加 / 前缀
  if (/^[A-Za-z]:/.test(path)) return path;
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

let watcherAbort: AbortController | null = null;
let watcherRetryCount = 0;
let watcherStopped = false;
let watcherCwd = '';
let watcherFireFn: ((changes: Array<{ uri: string; type: FileChangeType }>) => void) | null = null;
// 之前: watcherSyncedHashes Map + recordSyncedHash 写自己 hash 给 watcher 对比 skip 断循环.
// 现状: 不走 hash 路线. 断循环靠 (1) fs.write '内容一致不写' (fs.ts:881) (2) 防抖 100ms
// (3) __APP_FS_EXTERNAL_SYNC__ 抑制 BrowserFS _syncSync 回写 (runtime.ts:103). recordSyncedHash
// 保留为 no-op 兼容旧调用点 (runtime.ts 等).

/** @deprecated 之前用于 watcher hash 对比, 现 no-op. 保留签名兼容 runtime.ts 调用. */
export function recordSyncedHash(_relPath: string, _content: string | Uint8Array | null): Promise<void> {
  return Promise.resolve();
}

// ---- 真实 stat (FsPty node worker 'stat' op) ----

/** 真实 stat 缓存 (IDE 路径 → {size,mtimeMs}): FsPty stat 结果; 写/外部修改后 invalidateStat 清 */
const statCache = new Map<string, { size: number; mtimeMs: number }>();

/** 清 stat 缓存 (写入/外部修改后, 保证下次 stat 拿到新值) */
function invalidateStat(idePath: string): void {
  const norm = !idePath || idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
  const had = statCache.has(norm);
  if (had) console.log('[cache] invalidateStat', { norm, hadValue: statCache.get(norm) });
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

/** 目录路径的 hash 标记 (目录无内容, 用存在性标记对比, 不能与"已删除 null"混淆) */
const DIR_HASH = 'dir';

/** 读路径状态 hash: 文件 → 内容 hash; 目录 → 'dir' 标记; 不存在 → null (DELETED).
 *  注: 目录不能走 fs.read (读目录失败返 null 会被当成"已删除", 创建/删除 hash 一致 → skip 吞事件). */
async function readPathHash(relPath: string): Promise<string | null> {
  try {
    console.log('[readPathHash] IN', { relPath });
    // 1. 先 stat 真实宿主磁盘确认存在性 + 区分文件/目录
    const stat = await fsStat(relPath);
    if (!stat) { console.log('[readPathHash] stat null → return null', { relPath }); return null; }
    if (stat.type === 'directory') { console.log('[readPathHash] dir', { relPath }); return DIR_HASH; }
    // 2. 读真实磁盘内容 (不走 BrowserFS InMemory — 那可能跟磁盘不一致)
    const bytes = await fsReadRaw(relPath);
    if (bytes === null) { console.log('[readPathHash] read null → return null', { relPath }); return null; }
    // bytes 是 Uint8Array(0) 时 = 文件存在但 0 字节, 不应当成"不存在"
    const h = await contentHash(bytes);
    console.log('[readPathHash] file hash', { relPath, len: bytes.length, hash: h });
    return h;
  } catch (e) {
    console.log('[readPathHash] EXC', { relPath, err: (e as any)?.message });
    return null;
  }
}

export function bindWatcherFireFilesChange(fn: typeof watcherFireFn): void {
  watcherFireFn = fn;
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
  console.log('[scheduleFsFire] IN', { key, changeType });
  // 关键: BrowserFS 在 sumi 里的 URI 形如 `file:///<host abs path>` (e.g.
  // `file:///Users/weizuxiao/Documents/2026春季学期实验/4.txt`), 不是 codeblitz 内部的
  // `file://${WORKSPACE_ROOT}${key}` (e.g. `file:///workspace/4.txt`).
  // 不匹配 → `BaseFileSystemEditorDocumentProvider._fileContentMd5OnBrowserFs.has(change.uri)`
  // 永远是 false → 走不到 `acceptExternalChange` → 旧 baseContent 仍保存 → md5 DIFF 错误.
  // 故 fireFilesChange 的 uri 必须用 host 绝对路径. 旧实现把 mount 路径当 BrowserFS 路径是错的.
  const hostCwd = effectiveCwd();
  const absPath = hostCwd && key.startsWith('/') ? `${hostCwd.replace(/\/$/, '')}${key}` : key;
  const uri = URI.file(absPath).toString();
  const prev = debounceMap.get(key);
  if (prev) { console.log('[scheduleFsFire] RESET prev timer', { key, prevChange: prev.event }); clearTimeout(prev.timer); }
  const timer = setTimeout(() => {
    debounceMap.delete(key);
    void (async () => {
      const h = await readPathHash(key);
      // 之前这里: const synced = watcherSyncedHashes.get(key); if (h === synced) skip. 现去掉.
      // 断循环靠 (1) fs.write '内容一致不写' (2) 防抖 100ms (3) __APP_FS_EXTERNAL_SYNC__ 抑制回写.
      // 按最终状态修正: 文件不存在 → DELETED; 存在 → ADDED/UPDATED
      let finalEvent = changeType;
      if (h === null) {
        finalEvent = FileChangeType.DELETED;
      }
      console.log('[watcher] → fireFilesChange', uri, finalEvent, { now: h });
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
    })();
    // 防抖 250ms: server @parcel/watcher 自身 200ms 防抖, 100ms 窗口会反复 reset +
    // 双路径 (PTY + SSE) 双 fire → 250ms 合并 server 双事件, 只 fire 一次
  }, 250);
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
  // 注: Windows 盘符路径 (C:\...) 不加 / 前缀
  const key = obj.p.startsWith('/') || /^[A-Za-z]:/.test(obj.p) ? obj.p : `/${obj.p}`;
  scheduleFsFire(key, opencodeEvent);
}

/**
 * 启 fs watcher: opencode /api/fs/watch SSE (服务端 @parcel/watcher, 200ms 防抖).
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
    // fs 事件统一走 /api/event (V2 SSE, FileSystemServiceImpl.connectEvents 已订阅):
    //   file.edited / file.watcher.updated → scheduleFsFire.
    // 这里只确认 cwd 存在 (connectEvents 无 cwd 依赖, 但 cwd 校验防止 stale APP_CWD 静默失效).
    try {
      await fsApiGet(`/api/fs/list?path=${encodeURIComponent('.')}`);
      watcherCwd = cwd;
      watcherStopped = false;
      watcherRetryCount = 0;
      console.log('[watcher] /api/event 驱动 (connectEvents), cwd ok=', cwd);
    } catch (e) {
      console.warn('[watcher] cwd check exception, skip:', cwd, e);
      scheduleWatcherRetry();
    }
}

export function stopFsWatcher(): void {
  watcherStopped = true;
  watcherRetryCount = 0;
  watcherAbort = null;
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
      console.log('[debug] bindWatcherFireFilesChange IN', { changes });
      // 清 BrowserFS readable (DynamicRequest) entriesLoaded → explorer 重新拉真实目录.
      // 注意: 不能 clearCache 全清 (目录树被清空后 OverlayFS 写文件 EBUSY).
      try { (window as any).__RESET_BFS_CACHE__?.(); } catch { /* ignore */ }
      // 外部删除 (DELETED): 精确移除 writable InMemory 中该路径 (否则 OverlayFS.readdir 合并旧目录树, 残留显示)
      const writeFs = (window as any).__APP_WRITE_SYNC_FS__;
      if (writeFs?.removePath) {
        changes.forEach((c) => {
          if (c.type === FileChangeType.DELETED) {
            const rel = uriToRel(c.uri);
            if (rel === null) return; // 路径不在 host cwd, 跳过
            try { writeFs.removePath(rel); } catch { /* ignore */ }
          }
        });
      }
      changes.forEach((c) => {
        const rel = uriToRel(c.uri);
        if (rel !== null) this.invalidateParent(rel);
      });
      // 过滤掉不在 host cwd 下的路径, 避免 BrowserFS 当 cwd 内路径处理触发 stat 500
      // + DirInode reset + "explorer 树已重建 (删除同步)" 全清空 (用户感知: 文件被删)
      const safeChanges = changes.filter((c) => uriToRel(c.uri) !== null);
      this.fileService.fireFilesChange({ changes: safeChanges });
      // 额外 fire 父目录 → 触发 explorer 树刷新 (单文件 ADDED 不会自动刷新树).
      // 根目录用 DELETED (type 2): explorer isRootAffected 只认 type > UPDATED 才强制刷新整树.
      const dirChanges = new Map<string, boolean>();
      changes.forEach((c) => {
        const rel = uriToRel(c.uri);
        if (rel === null) return; // 路径不在 host cwd, 跳过
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
      changes.forEach((c) => {
        const rel = uriToRel(c.uri);
        if (rel !== null) this.syncOpenEditor(rel);
      });
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
          const st = await fsStat(relPath);
          if (!st) {
            // 文件已删除: 不更新编辑器 (防止空内容写回); 让 OpenSumi 自身处理 (tab 关闭等)
            console.log('[fs] 外部删除 → 跳过编辑器同步:', relPath);
            return;
          }
          const bytes = await getFileSystemService().read(relPath);
          const content = new TextDecoder().decode(bytes);
          if (content === target.getValue()) return;
          // 标记本次写入是外部同步 (来自 host), BrowserFS 收到 _syncSync 跳过回写 opencode,
          // 避免与 host 最新内容竞速 + 触发 opencode 版本号冲突错误.
          const externalSync = (window as any).__APP_FS_EXTERNAL_SYNC__ ||= new Set<string>();
          externalSync.add(relPath);
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
    const typeMap: Record<string, FileChangeType> = {
      add: FileChangeType.ADDED,
      change: FileChangeType.UPDATED,
      unlink: FileChangeType.DELETED,
    };
    try {
      // V1 全局 SSE: /global/event 顶层 {payload:{id,type,properties}}.
      // fs watcher 事件 (file.watcher.updated) 和 chat 流式 (message.part.delta) 都走这里.
      // V2 /api/event 顶层 {id, type, data} 也做兜底 (统一用 V1 通道, 保证 UTF-8 编码一致).
      const source = new EventSource(secureUrl(`${base}/global/event`), { withCredentials: false });
      this.eventAbort = new AbortController();
      source.onmessage = (msg) => {
        try {
          const raw = JSON.parse(msg.data);
          // V2 顶层: type + data. 兜底 v1 payload 包装 (旧 server).
          const ev = (raw && raw.payload) || raw;
          const t = (ev?.type || '') as string;
          if (!t) return;
          const props = ev?.data || ev?.properties || {};
          let changeType: string | null = null;
          let relPath = '';
          if (t === 'file.edited') {
            changeType = 'change';
            relPath = (props?.file || '').toString();
          } else if (t === 'file.watcher.updated') {
            changeType = (props?.event || '').toString();
            relPath = (props?.file || '').toString();
          }
          if (!changeType || !relPath) return;
          // 宿主机绝对路径 → codeblitz 相对路径. watcher 报的是 host 绝对路径
          // (如 /Users/weizuxiao/Documents/.../1.txt), 但 explorer / monaco 走的是
          // /workspace 前缀, 跟 effectiveCwd() 拼出 browserfs 相对路径.
          const hostCwd = effectiveCwd();
          // 跨 location 隔离: /global/event (V1 SSE) 会收到**所有** instance 的 watcher
          // 事件 (每个打开过的目录各有一个 watcher, 含 git 仓库). 若 relPath 不在当前
          // effectiveCwd() 子树内 → 是别的目录的事件, 必须 skip, 否则 fsStat 打 500
          // (server resolve 不存在/逃逸 → die) → readPathHash null → 误报 DELETED →
          // explorer 树反复重建/清空 (实测: numas 根 .git/index.lock + debug.http 事件
          // 污染 2026春季学期实验 会话).
          if (hostCwd) {
            const r = absToRel(relPath, hostCwd);
            if (r === null) {
              console.log('[filesystem] skip 非当前工作目录事件:', relPath, { hostCwd });
              return;
            }
          }
          const rel = hostCwd
            ? (() => {
                const r = absToRel(relPath, hostCwd);
                if (r === null) return null;
                return r === '.' ? '/' : `/${r}`;
              })()
            : relPath.startsWith('/') ? relPath : `/${relPath}`;
          if (!rel) return;
          console.log('[filesystem] fs event:', t, rel, '→ scheduleFsFire');
          scheduleFsFire(rel, typeMap[changeType] ?? FileChangeType.UPDATED);
        } catch { /* ignore bad frame */ }
      };
      source.onerror = () => { /* EventSource 自动重连 */ };
      console.log('[filesystem] /global/event subscribed (V1 SSE)');
    } catch (e) {
      console.warn('[filesystem] event subscribe 失败:', e);
    }
  }

  // ---- 相对路径接口（OverlayFS 对接）----

  async list(idePath: string): Promise<FsEntry[]> {
    console.log('[fs.list] IN', { idePath });
    // /api/fs/list 直连: 返回 [{path, type, size?, mtime?}]
    const norm = !idePath || idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const queryPath = norm === '/' ? '.' : norm.replace(/^\/+/, '');
    // 目录可能已删除 (外部删/刷新竞态) → 返回空数组, 不抛错 (否则 explorer 刷新中断, 残留节点)
    try {
      const data = await fsApiGet<Array<{ path: string; type: 'file' | 'directory' }>>(`/api/fs/list?path=${encodeURIComponent(queryPath)}`);
      const entries: FsEntry[] = Array.isArray(data) ? data.map((e) => ({
        name: pathBase(e.path),
        type: e.type === 'directory' ? 'directory' : 'file',
      })) : [];
      console.log('[fs.list] OUT', { idePath, count: entries.length, names: entries.map(e => e.name) });
      // 回填 stat 缓存 (meta 直接命中, 避免重复 list)
      this.listCache.set(norm, entries);
      return entries;
    } catch (e) {
      console.log('[fs.list] ERR', { idePath, err: (e as any)?.message });
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
    console.log('[fs.meta] IN', { idePath, norm, base, name });

    // 缓存命中 (readdir 已经拿过)
    const cached = this.listCache.get(base);
    let entry: FsEntry | undefined;
    if (cached) {
      console.log('[cache] listCache HIT', { base, size: cached.length, lookFor: name });
      entry = cached.find((e) => e.name === name);
    }
    // 未命中: list 父目录拿 entry (opencode SDK /file 不返 mtime, mtime 由 statCache 真实 stat 补)
    if (!entry) {
      console.log('[cache] listCache MISS, calling list', { base });
      const entries = await this.list(base);
      this.listCache.set(base, entries);
      entry = entries.find((e) => e.name === name);
      console.log('[cache] listCache FILLED', { base, size: entries.length, found: !!entry, foundType: entry?.type });
    }
    if (!entry) throw new Error(`stat: not found ${idePath}`);
    // 目录: 不需要 size/mtime (checkInSync 只对文件, setContent 目录会抛 FileIsADirectory)
    if (entry.type === 'directory') {
      return { path: idePath, type: 'directory', size: 0 };
    }
    // 文件: 真实 size + mtime (FsPty worker 'stat', 缓存)
    let st: { size: number; mtimeMs: number } | null = statCache.get(norm) ?? null;
    if (st) {
      console.log('[cache] statCache HIT', { norm, st });
    } else {
      const stat = await fsStat(idePath);
      console.log('[cache] statCache MISS, fsStat result', { norm, stat });
      if (stat && typeof stat?.size === 'number') {
        st = { size: stat.size, mtimeMs: stat.mtime || 0 };
        statCache.set(norm, st);
      }
    }
    if (!st) return { path: idePath, type: 'file', size: 0 };
    return { path: idePath, type: 'file', size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  }

  async read(idePath: string): Promise<Uint8Array> {
    console.log('[fs.read] IN', { idePath, stack: new Error().stack?.split('\n').slice(2, 5).join(' | ') });
    // /api/fs/read 直连: 返回原始字节 (text/binary 统一)
    const relPath = relForApi(idePath);
    const base = appBaseUrl();
    if (!base) throw new Error('fs read: app base url not ready');
    const url = `${base.replace(/\/+$/, '')}/api/fs/read/${encodeURIComponent(relPath)}`;
    const res = await fetch(url, { headers: cwdHeader() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`fs read failed: ${idePath}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * 二进制读 (无损, 大文件安全): 走 FsPty node worker 'readB64' (node fs.readFileSync → base64),
   *   浏览器端 atob 解码. 绕开 opencode /api/fs/read 30MB 限制, 无 shell 污染.
   *   timeout: 30s (大文件 base64 编码/传输耗时).
   */
  async readBinary(idePath: string): Promise<Uint8Array> {
    return this.read(idePath);
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
    console.log('[fs.write] IN', { idePath, contentType: typeof content, contentLen: typeof content === 'string' ? content.length : (content as any).base64?.length, stack: new Error().stack?.split('\n').slice(2, 5).join(' | ') });
    const abs = absPath(idePath);
    // 写入前对比远程内容: 文件已存在且内容一样 → 跳过写入 (防重复写 + 防 OverlayFS EBUSY 写路径).
    // 先 stat 确认存在 (SDK read 对不存在返回空数组而非抛错, 直接对比会把"新建空文件"误判为内容一致跳过!)
    if (typeof content === 'string') {
      try {
        const st = await fsStat(idePath);
        console.log('[fs.write] content-skip-check', { idePath, statType: st?.type });
        if (st && st.type === 'file') {
          const remote = await this.read(idePath);
          const remoteText = new TextDecoder().decode(remote);
          console.log('[fs.write] content-skip-compare', { idePath, remoteLen: remoteText.length, localLen: content.length, same: remoteText === content });
          if (remoteText === content) {
            // 内容一致: 不写 (避免触发写事件循环 + 触发 opencode 版本号冲突错误).
            console.log('[fs.write] content-skip-RETURN', { idePath });
            return true;
          }
        }
      } catch { /* 异常 → 正常写 */ }
    }
    const b64 = typeof content === 'string' ? bytesToBase64(content) : content.base64;
    try {
      console.log('[fs.write] POST /api/fs/write', { idePath, b64Len: b64.length });
      await fsApiPost('/api/fs/write', { path: relForApi(idePath), content: b64 });
      console.log('[fs.write] POST /api/fs/write OK', { idePath });
    } catch (e) {
      console.error('[fs.write] fail:', idePath, e);
      return false;
    }
    onProgress?.(b64.length, b64.length);
    console.log('[fs.write] after-POST invalidateParent + restore', { idePath });
    this.invalidateParent(idePath);
    // 刚写的文件必然存在 → 从 OverlayFS deletionLog 恢复 (历史残留误删标记会挡 explorer + 触发反向删远程)
    try { (window as any).__RESTORE_DELETION_LOG__?.(idePath); } catch { /* ignore */ }
    return true;
  }

  /** 写超时: 30s 基础 + 1s / KB base64, 上限 5min. 大文件能传完, 又不会无限挂 */
  private writeTimeoutMs(b64Len: number): number {
    return Math.min(300000, 30000 + Math.ceil(b64Len / 1024) * 1000);
  }

  async rm(idePath: string): Promise<boolean> {
    // Guard: 拒绝 mount root 或 '.' — relForApi('/') === '.', opencode 端 fs.remove('.', recursive=true) = 删整个 cwd.
    const rel = relForApi(idePath);
    if (rel === '/' || rel === '' || rel === '.') { console.warn('[fs.rm] skip mount root', { idePath, rel }); return false; }
    console.log('[fs.rm] IN', { idePath, rel, stack: new Error().stack?.split('\n').slice(2, 5).join(' | ') });
    try {
      console.log('[fs.rm] POST /api/fs/remove', { idePath });
      await fsApiPost('/api/fs/remove', { path: rel, recursive: true });
      console.log('[fs.rm] POST OK', { idePath });
      this.invalidateParent(idePath);
      return true;
    } catch (e) {
      console.log('[fs.rm] ERR', { idePath, err: (e as any)?.message });
      return false;
    }
  }

  async rmdir(idePath: string): Promise<boolean> {
    try {
      await fsApiPost('/api/fs/remove', { path: relForApi(idePath), recursive: false });
      this.invalidateParent(idePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(idePath: string): Promise<boolean> {
    console.log('[fs.mkdirp] IN', { idePath, stack: new Error().stack?.split('\n').slice(2, 5).join(' | ') });
    try {
      await fsApiPost('/api/fs/mkdir', { path: relForApi(idePath), recursive: true });
      this.invalidateParent(idePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 宿主机任意目录浏览 (FilePicker 用):  走 /api/fs/list?path=. + `x-opencode-directory: <absPath>`.
   *   header 本身就是目标目录 → 任意目录都能列 (含上级/根, 不被 APP_CWD 锁死),  不 escape,  跨平台.
   *   absPath 不存在 → server 500 (ENOENT),  这里 catch 返回 [] + warn.
   *   macOS/Linux abs 形如 '/Users/...'; Windows 形如 'C:\\Users\\...' (encodeURI 兼容).
   */
  async listDir(absPath: string): Promise<FsEntry[]> {
    console.log('[fs.listDir] IN', { absPath });
    try {
      const norm = normalizeAbs(absPath);
      const data = await fsApiGet<Array<{ path: string; type: 'file' | 'directory' }>>(`/api/fs/list?path=.`, {
        headers: { 'x-opencode-directory': encodeURI(norm) },
      });
      const entries: FsEntry[] = Array.isArray(data) ? data.map((e) => ({
        name: pathBase(e.path),
        type: e.type === 'directory' ? 'directory' : 'file',
      })) : [];
      console.log('[fs.listDir] OUT', { absPath, norm, count: entries.length });
      return entries;
    } catch (e) {
      console.warn('[fs.listDir] ERR', { absPath, err: (e as any)?.message });
      return [];
    }
  }

  /**
   * 宿主机任意目录下建目录 (FilePicker 用):  走 /api/fs/mkdir { path: <name> } + `x-opencode-directory: <parent>`.
   *   header 是父目录 → 任意位置可建,  跨平台.
   */
  async mkdirAbs(absPath: string): Promise<boolean> {
    console.log('[fs.mkdirAbs] IN', { absPath });
    const parent = normalizeAbs(absPath).replace(/\/+$/, '');
    const name = parent.split('/').pop() || '';
    try {
      await fsApiPost('/api/fs/mkdir', { path: name, recursive: true }, {
        headers: { 'x-opencode-directory': encodeURI(parent) },
      });
      return true;
    } catch (e) {
      console.warn('[fs.mkdirAbs] ERR', { absPath, err: (e as any)?.message });
      return false;
    }
  }

  async move(from: string, to: string): Promise<boolean> {
    console.log('[fs.move] IN', { from, to, stack: new Error().stack?.split('\n').slice(2, 5).join(' | ') });
    try {
      await fsApiPost('/api/fs/rename', { from: relForApi(from), to: relForApi(to) });
      this.invalidateParent(from);
      this.invalidateParent(to);
      return true;
    } catch {
      return false;
    }
  }

  /** 文件树变化后: 清掉相关缓存 (自身 + 父目录: listCache + statCache) */
  private invalidateParent(idePath: string): void {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    console.log('[cache] invalidateParent', { idePath, norm });
    this.listCache.delete(norm);
    const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    this.listCache.delete(parent);
    invalidateStat(norm);
    invalidateStat(parent);
  }

  async find(idePath: string, pattern = '*'): Promise<string[]> {
    // /api/fs/find 直连: query + type=file
    const dir = !idePath || idePath === '/' ? '.' : idePath.replace(/^\/+/, '');
    try {
      const data = await fsApiGet<Array<{ path: string }>>(`/api/fs/find?query=${encodeURIComponent(pattern)}&type=file&path=${encodeURIComponent(dir)}`);
      return Array.isArray(data) ? data.map((e) => e.path) : []
    } catch (e: any) {
      throw new Error(`fs find failed: ${idePath}: ${e?.message || 'unknown'}`)
    }
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
