/**
 * filesystem IO service — service/fs.ts
 *
 * 职责:
 *   - 直连 opencode /api/fs/* (list/read/write/remove/rename/stat/mkdir)
 *     + 暴露给 FilePicker / chat agent / 业务代码
 *   - 不负责 explorer / monaco / editor 的 'file' scheme IO — 那部分由
 *     ../config/fs.ts 的 CustomFileSystemProvider 接管 (走 OpenSumi
 *     IFileServiceClient.registerProvider)
 *   - 不维护 InMemory 缓存 / 墓碑 / overlay 索引 / watcher (BrowserFS 全部不依赖)
 *
 * watcher 走 CustomFileSystemProvider 内部 /global/event SSE 订阅, 不再需要 PTY.
 *
 * 路径: 一律 IDE 相对路径 (/foo), server 在 cwd 下操作.
 * 单实例: 业务代码与容器共用同一文件系统实例.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { FsEntry, FileMeta, IFileSystem } from '../commands/fs';
import { FsToken } from '../commands/fs';
import {
  appBaseUrl,
  cwdHeader,
  effectiveCwd,
} from './env';

// ---- 工具函数 ----

/** 跨平台路径分隔符规范化 */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Windows 盘符判定 */
function isWindowsDrive(p: string): boolean {
  return /^\/?[A-Za-z]:/.test(p);
}

/** 绝对路径规范化: 盘符形态去前导 '/' + 反斜杠转正斜杠; POSIX 原样 */
function normalizeAbs(p: string): string {
  const s = normalizeSep(p);
  return isWindowsDrive(s) ? s.replace(/^\/+/, '') : s;
}

/** 跨平台 basename */
function pathBase(p: string): string {
  const s = normalizeSep(p).replace(/[\\\/]+$/, '');
  const seg = s.split('/').pop();
  return seg ? seg : p;
}

/** server 响应路径统一规范化 */
function normalizeServerPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 宿主机绝对路径 → 相对 effectiveCwd() 的相对路径.
 *  返回 null 表示 absPath 不在 cwd 下. */
function absToRel(absPath: string, cwd: string): string | null {
  if (!cwd) {
    return normalizeAbs(absPath).replace(/^\/+/, '');
  }
  const a = normalizeAbs(absPath).replace(/\/+$/, '');
  const c = normalizeAbs(cwd).replace(/\/+$/, '');
  if (a === c) return '.';
  if (a.startsWith(c + '/')) return a.slice(c.length + 1);
  return null;
}

/** idePath → opencode /api/fs 用相对路径 */
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

/** /api/fs HTTP 调用 (解包 {location, data} → data) */
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
  return fsApiGet<FsStatResult>(url).catch(() => null);
}

/** 文本 → base64 (浏览器端, 分块避免栈溢出) */
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

/** IDE 路径 → 绝对路径 (APP_CWD || hostCwd + / + rel) */
function absPath(idePath: string): string {
  const cwd = effectiveCwd();
  if (!cwd) throw new Error('fs: no cwd (APP_CWD unset and hostCwd not yet probed)');
  return cwd.replace(/\/+$/, '') + '/' + idePath.replace(/^\/+/, '');
}

// ---- FileSystemService 主类 ----

@Injectable()
export class FileSystemServiceImpl implements IFileSystem {
  static instance: FileSystemServiceImpl | null = null;

  /** list cache: dir → entries (避免重复拉同目录) */
  private listCache = new Map<string, FsEntry[]>();
  /** stat cache: file → {size, mtimeMs} (写后 invalidateStat 清) */
  private statCache = new Map<string, { size: number; mtimeMs: number }>();

  constructor() {
    FileSystemServiceImpl.instance = this;
    (window as any).__APP_FS__ = this;
  }

  /** 暴露给 PdfReader 等业务代码: 当前工作目录 (host 绝对) */
  getWorkspaceDir(): string {
    return effectiveCwd();
  }

  // ---- IFileSystem 接口 ----

  async list(idePath: string): Promise<FsEntry[]> {
    const norm = !idePath || idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const queryPath = norm === '/' ? '.' : norm.replace(/^\/+/, '');
    const cwd = effectiveCwd();
    try {
      const url = `/api/fs/list?path=${encodeURIComponent(queryPath)}`;
      const data = await fsApiGet<Array<{ path: string; type: 'file' | 'directory' }>>(url);
      const entries: FsEntry[] = (data || []).map((e: any) => ({
        name: pathBase(e.path),
        path: normalizeServerPath(e.path),
        type: e.type === 'directory' ? 'directory' : 'file',
      }));
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

  /** stat: type 走 listCache (opencode SDK /file 自带), size+mtime 走 fsStat */
  async meta(idePath: string): Promise<FileMeta> {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const base = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    const name = norm === '/' ? '' : norm.slice(norm.lastIndexOf('/') + 1);

    const cached = this.listCache.get(base);
    let entry: FsEntry | undefined;
    if (cached) {
      entry = cached.find((e) => e.name === name);
    }
    if (!entry) {
      const entries = await this.list(base);
      this.listCache.set(base, entries);
      entry = entries.find((e) => e.name === name);
    }
    if (!entry) throw new Error(`stat: not found ${idePath}`);
    if (entry.type === 'directory') {
      return { path: idePath, type: 'directory', size: 0 };
    }
    let st = this.statCache.get(norm) ?? null;
    if (!st) {
      const stat = await fsStat(idePath);
      if (stat && typeof stat.size === 'number') {
        st = { size: stat.size, mtimeMs: stat.mtime || 0 };
        this.statCache.set(norm, st);
      }
    }
    if (!st) return { path: idePath, type: 'file', size: 0 };
    return { path: idePath, type: 'file', size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  }

  async read(idePath: string): Promise<Uint8Array> {
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

  async readBinary(idePath: string): Promise<Uint8Array> {
    return this.read(idePath);
  }

  /** 写文件: 内容一致跳过 (防重复写 + 防版本冲突) */
  async write(
    idePath: string,
    content: string | { base64: string },
    onProgress?: (done: number, total: number) => void,
  ): Promise<boolean> {
    const abs = absPath(idePath);
    if (typeof content === 'string') {
      try {
        const st = await fsStat(idePath);
        if (st && st.type === 'file') {
          const remote = await this.read(idePath);
          const remoteText = new TextDecoder().decode(remote);
          if (remoteText === content) return true; // 一致跳过
        }
      } catch { /* 异常 → 正常写 */ }
    }
    const b64 = typeof content === 'string' ? bytesToBase64(content) : content.base64;
    try {
      await fsApiPost('/api/fs/write', { path: relForApi(idePath), content: b64 });
    } catch {
      return false;
    }
    onProgress?.(b64.length, b64.length);
    this.invalidateParent(idePath);
    return true;
  }

  async rm(idePath: string): Promise<boolean> {
    const rel = relForApi(idePath);
    if (rel === '/' || rel === '' || rel === '.') return false;
    try {
      await fsApiPost('/api/fs/remove', { path: rel, recursive: true });
      this.invalidateParent(idePath);
      return true;
    } catch {
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
    try {
      await fsApiPost('/api/fs/mkdir', { path: relForApi(idePath), recursive: true });
      this.invalidateParent(idePath);
      return true;
    } catch {
      return false;
    }
  }

  async move(from: string, to: string): Promise<boolean> {
    try {
      await fsApiPost('/api/fs/rename', { from: relForApi(from), to: relForApi(to) });
      this.invalidateParent(from);
      this.invalidateParent(to);
      return true;
    } catch {
      return false;
    }
  }

  async find(idePath: string, pattern = '*'): Promise<string[]> {
    const dir = !idePath || idePath === '/' ? '.' : idePath.replace(/^\/+/, '');
    try {
      const data = await fsApiGet<Array<{ path: string }>>(`/api/fs/find?query=${encodeURIComponent(pattern)}&type=file&path=${encodeURIComponent(dir)}`);
      return Array.isArray(data) ? data.map((e) => e.path) : [];
    } catch (e: any) {
      throw new Error(`fs find failed: ${idePath}: ${e?.message || 'unknown'}`);
    }
  }

  /** 宿主机任意目录浏览 (FilePicker 用): 用 absPath 作为 x-opencode-directory header */
  async listDir(absPath: string): Promise<FsEntry[]> {
    try {
      const norm = normalizeAbs(absPath);
      const data = await fsApiGet<Array<{ path: string; type: 'file' | 'directory' }>>(`/api/fs/list?path=.`, {
        headers: { 'x-opencode-directory': encodeURI(norm) },
      });
      const entries: FsEntry[] = Array.isArray(data) ? data.map((e: any) => ({
        name: pathBase(e.path),
        path: normalizeServerPath(e.path),
        type: e.type === 'directory' ? 'directory' : 'file',
      })) : [];
      return entries;
    } catch {
      return [];
    }
  }

  /** 宿主机任意目录下建目录 (FilePicker 用): header 是父目录 */
  async mkdirAbs(absPath: string): Promise<boolean> {
    const parent = normalizeAbs(absPath).replace(/\/+$/, '');
    const name = parent.split('/').pop() || '';
    try {
      await fsApiPost('/api/fs/mkdir', { path: name, recursive: true }, {
        headers: { 'x-opencode-directory': encodeURI(parent) },
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---- 内部 ----

  /** 文件树变化后: 清掉相关缓存 (自身 + 父目录: listCache + statCache) */
  private invalidateParent(idePath: string): void {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    this.listCache.delete(norm);
    const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    this.listCache.delete(parent);
    this.statCache.delete(norm);
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
}

/** 安装全局单例 */
export function installFileSystemService(): void {
  (window as any).__APP_FS__ = getFileSystemService();
  console.log('[filesystem] service installed');
}