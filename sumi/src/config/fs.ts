/**
 * 自定义 FileSystemProvider — core/config/fs.ts
 *
 * 完全自实现 VS Code 风格 FileSystemProvider, 不依赖 codeblitz BrowserFS /
 * DiskFileSystemProvider / OverlayFS. 通过 OpenSumi 的
 * IFileServiceClient.registerProvider 把 'file' scheme 替换为本实现 —
 * explorer / monaco / editor 自动走它.
 *
 * 路径协议:
 *   - URI: file:///<host abs path>  (e.g. file:///Users/weizuxiao/Documents/foo.txt)
 *   - opencode /api/fs/* 用 cwd 相对路径 (e.g. foo.txt)
 *   - uriToRel(uri) → IDE 相对路径 (/foo.txt); relToUri(rel) → file:// URI
 *
 * IO 直连 opencode /api/fs/* HTTP 端点, 不维护本地缓存 / 墓碑 / overlay 索引.
 * watcher 走 opencode /global/event SSE (V1 file.watcher.updated) → emitter.
 *
 * 关键坑 (覆盖默认 file scheme):
 *   - codeblitz 默认在 @opensumi/ide-file-service/lib/browser/file-service-contribution.js:15
 *     注册 RPC DiskFileSystemProvider 到 fsProviders Map.
 *   - IFileServiceClient.registerProvider 拒绝覆盖已注册 scheme (line 328).
 *   - 我们 onStart 时强制 fsProviders.delete('file') 然后 registerProvider('file', ours),
 *     覆盖默认, 让 getProvider(scheme) (line 433) 优先返我们.
 *   - 不要用 IBrowserFileSystemRegistry.registerFileSystemProvider — 它是 BrowserFileSystemRegistryImpl
 *     的 Map, getProvider 不会查 (file-service-client.js:433 只查 fsProviders).
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution, Domain, Emitter, URI } from '@opensumi/ide-core-browser';
import {
  FileChangeEvent,
  FileChangeType,
  FileSystemProviderCapabilities,
  FileType,
  Schemes,
} from '@opensumi/ide-core-common';
import type { FileStat, FileSystemProvider } from '@opensumi/ide-core-common/lib/types/file';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { FileSystemError } from '@opensumi/ide-file-service/lib/common/files';

import { appBaseUrl, cwdHeader, effectiveCwd, secureUrl } from '../service/env';

// ---- helpers ----

/** 解析 URI 路径 → opencode 调用所需信息.
 *  返回 { relPath, headerPath } 二选一:
 *  - 在 cwd 内: { relPath } (用 cwd header)
 *  - 在 cwd 外: { headerPath: parent, relPath: basename } (用 parent 作为 header, 任意绝对路径都能操作)
 *  fsPath 异常 (e.g. 非 file scheme) → null. */
function resolveFsPath(uri: import('@opensumi/ide-core-common').Uri): { relPath: string; headerPath?: string } | null {
  let fsPath: string;
  try {
    fsPath = uri.fsPath;
  } catch {
    return null;
  }
  if (!fsPath) return null;
  const cwd = effectiveCwd();
  if (!cwd) {
    // 无 cwd: 用父根 + basename
    const norm = fsPath.replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    return { relPath: idx >= 0 ? norm.slice(idx + 1) : norm, headerPath: idx >= 1 ? norm.slice(0, idx) : '/' };
  }
  const a = fsPath.replace(/\/+$/, '');
  const c = cwd.replace(/\/+$/, '');
  if (a === c) return { relPath: '.' };
  if (a.startsWith(c + '/')) return { relPath: a.slice(c.length + 1) };
  // 在 cwd 外: 用 parent dir 作为 header
  const idx = a.lastIndexOf('/');
  const parent = idx >= 1 ? a.slice(0, idx) : '/';
  const name = idx >= 0 ? a.slice(idx + 1) : a;
  return { relPath: name || '.', headerPath: parent };
}

/** 兼容旧调用: 单纯 URI → rel 路径 (cwd 内才返, 外返 null) */
function uriToRel(uri: import('@opensumi/ide-core-common').Uri): string | null {
  const r = resolveFsPath(uri);
  if (!r) return null;
  if (r.headerPath) return null;
  return r.relPath;
}

/** IDE 相对路径 → file:// URI (cwd 拼) */
function relToUri(rel: string): string {
  const cwd = effectiveCwd();
  const normRel = rel.replace(/^\/+/, '');
  const abs = normRel === '' || normRel === '.' ? cwd : cwd.replace(/\/+$/, '') + '/' + normRel;
  return URI.file(abs).toString();
}

/** opencode /api/fs HTTP 调用 (解包 {location, data} → data; 404 = not found) */
async function apiFetch<T = any>(path: string, init: RequestInit = {}, headerPath?: string): Promise<T | null> {
  const base = appBaseUrl();
  if (!base) throw new Error('fs api: app base url not ready');
  const url = `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : '/' + path}`;
  const headers: Record<string, string> = headerPath
    ? { 'x-opencode-directory': encodeURI(headerPath) }
    : cwdHeader();
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`fs api ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await res.json();
    return (j && (j as any).data !== undefined) ? (j as any).data : (j as T);
  }
  return (await res.text()) as unknown as T;
}

async function apiGet<T = any>(path: string, headerPath?: string): Promise<T | null> {
  return apiFetch<T>(path, {}, headerPath);
}

async function apiPost<T = any>(path: string, body?: object, headerPath?: string): Promise<T | null> {
  return apiFetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, headerPath);
}

/** 直连读字节: 路径在 query, 不走 /api/fs/read/<encoded> 这种 path-style 形式 (避免编码问题) */
async function apiReadBytes(relPath: string, headerPath?: string): Promise<Uint8Array> {
  const base = appBaseUrl();
  if (!base) throw new Error('fs api: app base url not ready');
  const url = `${base.replace(/\/+$/, '')}/api/fs/read/${encodeURIComponent(relPath)}`;
  const headers: Record<string, string> = headerPath
    ? { 'x-opencode-directory': encodeURI(headerPath) }
    : cwdHeader();
  const res = await fetch(url, { headers });
  if (res.status === 404) throw new Error('not found');
  if (!res.ok) throw new Error(`read ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** server /api/fs/stat 返回 */
interface FsStatResult {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
}

/** server /api/fs/list 返回条目 */
interface FsEntry {
  name: string;
  type: 'file' | 'directory';
  path?: string;
}

// ---- CustomFileSystemProvider ----

/**
 * CustomFileSystemProvider — 自实现的 'file' scheme provider.
 * 直连 opencode /api/fs/* HTTP 端点, 不维护 InMemory 缓存 / 墓碑 / overlay.
 */
export class CustomFileSystemProvider implements FileSystemProvider {
  readonly scheme = Schemes.file;

  readonly capabilities = 2 | 4 | 1024; // FileReadWrite | FileOpenReadWriteClose | PathCaseSensitive

  private readonly _onDidChangeFile = new Emitter<FileChangeEvent>();
  readonly onDidChangeFile: import('@opensumi/ide-core-common').Event<FileChangeEvent> = this._onDidChangeFile.event;

  private readonly _onDidChangeCapabilities = new Emitter<void>();
  readonly onDidChangeCapabilities: import('@opensumi/ide-core-common').Event<void> = this._onDidChangeCapabilities.event;

  private watcherIdCounter = 0;
  private watchers = new Map<number, { uri: import('@opensumi/ide-core-common').Uri }>();
  private sse: EventSource | null = null;
  private sseReady: Promise<void> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      (window as any).__APP_FS_PROVIDER__ = this;
    }
  }

  // ---- VS Code FileSystemProvider 接口 ----

  async stat(uri: import('@opensumi/ide-core-common').Uri): Promise<FileStat> {
    const r = resolveFsPath(uri);
    if (!r) throw FileSystemError.FileNotFound(uri.toString());
    const queryPath = r.relPath === '/' ? '.' : r.relPath;
    const res = await apiGet<FsStatResult>(`/api/fs/stat?path=${encodeURIComponent(queryPath)}`, r.headerPath).catch(() => null);
    if (!res) throw FileSystemError.FileNotFound(uri.toString());
    const baseStat: FileStat = {
      uri: uri.toString(),
      isDirectory: res.type === 'directory',
      lastModification: res.mtime || 0,
      size: res.size || 0,
      type: res.type === 'directory' ? FileType.Directory : FileType.File,
      readonly: false,
    };
    // 目录: 填一层 children (codeblitz FileTreeService 渲染靠 children; 不填显示"无内容")
    if (res.type === 'directory') {
      try {
        const childEntries = (await this.readDirectory(uri)) ?? [];
        baseStat.children = childEntries.map(([name, type]) => ({
          uri: URI.file(uri.fsPath.replace(/\/+$/, '') + '/' + name).toString(),
          isDirectory: type === FileType.Directory,
          lastModification: 0,
          size: 0,
          type,
          readonly: false,
        }));
      } catch { /* ignore — children 留空 */ }
    }
    return baseStat;
  }

  async readDirectory(uri: import('@opensumi/ide-core-common').Uri): Promise<[string, FileType][]> {
    const r = resolveFsPath(uri);
    if (!r) return [];
    const queryPath = r.relPath === '/' ? '.' : r.relPath;
    const entries = (await apiGet<FsEntry[]>(`/api/fs/list?path=${encodeURIComponent(queryPath)}`, r.headerPath).catch(() => [])) ?? [];
    return entries.map((e): [string, FileType] => {
      // server Entry 只有 path + type; name 从 path 末段取 (兼容 Windows '\\')
      const p = (e.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
      const name = e.name && e.name !== p ? e.name : (p.split('/').pop() || p);
      return [name, e.type === 'directory' ? FileType.Directory : FileType.File];
    });
  }

  async readFile(uri: import('@opensumi/ide-core-common').Uri): Promise<Uint8Array> {
    const r = resolveFsPath(uri);
    if (!r) throw FileSystemError.FileNotFound(uri.toString());
    try {
      return await apiReadBytes(r.relPath === '/' ? '' : r.relPath, r.headerPath);
    } catch (e: any) {
      if (/not\s*found|404/i.test(e?.message || '')) {
        throw FileSystemError.FileNotFound(uri.toString());
      }
      throw FileSystemError.Unknown(uri.toString());
    }
  }

  async writeFile(
    uri: import('@opensumi/ide-core-common').Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const r = resolveFsPath(uri);
    if (!r) throw FileSystemError.FileNotFound(uri.toString());
    if (!r.headerPath && (r.relPath === '' || r.relPath === '/' || r.relPath === '.')) {
      throw FileSystemError.FileIsNoPermissions(uri.toString(), 'cannot write to mount root');
    }
    const b64 = bytesToBase64(content);
    try {
      await apiPost('/api/fs/write', { path: r.relPath, content: b64 }, r.headerPath);
    } catch (e: any) {
      const msg = (e?.message || '').toString();
      if (/exists|EEXIST/i.test(msg)) {
        throw FileSystemError.FileExists(uri.toString());
      }
      throw FileSystemError.Unknown(msg || 'write failed');
    }
  }

  async delete(uri: import('@opensumi/ide-core-common').Uri, options: { recursive: boolean }): Promise<void> {
    const r = resolveFsPath(uri);
    if (!r) throw FileSystemError.FileNotFound(uri.toString());
    if (!r.headerPath && (r.relPath === '' || r.relPath === '/' || r.relPath === '.')) {
      throw FileSystemError.FileIsNoPermissions(uri.toString(), 'cannot delete mount root');
    }
    try {
      await apiPost('/api/fs/remove', { path: r.relPath, recursive: options.recursive !== false }, r.headerPath);
    } catch (e: any) {
      throw FileSystemError.Unknown(e?.message || 'delete failed');
    }
  }

  async createDirectory(uri: import('@opensumi/ide-core-common').Uri): Promise<void> {
    const r = resolveFsPath(uri);
    if (!r) throw FileSystemError.FileNotFound(uri.toString());
    try {
      await apiPost('/api/fs/mkdir', { path: r.relPath, recursive: false }, r.headerPath);
    } catch (e: any) {
      const msg = (e?.message || '').toString();
      if (/exists|FileExists|EEXIST/i.test(msg)) {
        throw FileSystemError.FileExists(uri.toString());
      }
      throw FileSystemError.Unknown(msg || 'mkdir failed');
    }
  }

  async rename(
    oldUri: import('@opensumi/ide-core-common').Uri,
    newUri: import('@opensumi/ide-core-common').Uri,
    _options: { overwrite: boolean },
  ): Promise<void> {
    const from = resolveFsPath(oldUri);
    const to = resolveFsPath(newUri);
    if (!from || !to) throw FileSystemError.FileNotFound(oldUri.toString());
    // 同 header 才能跨 header 移动 (不同目录)
    if (from.headerPath !== to.headerPath) {
      throw FileSystemError.Unknown('rename across different cwd not supported');
    }
    try {
      await apiPost('/api/fs/rename', { from: from.relPath, to: to.relPath }, from.headerPath);
    } catch (e: any) {
      const msg = (e?.message || '').toString();
      if (/exists|EEXIST/i.test(msg)) {
        throw FileSystemError.FileExists(newUri.toString());
      }
      throw FileSystemError.Unknown(msg || 'rename failed');
    }
  }

  /** codeblitz 框架会调: 返回 user home FileStat. 我们返 cwd 根. */
  async getCurrentUserHome(): Promise<FileStat | undefined> {
    const cwd = effectiveCwd();
    if (!cwd) return undefined;
    return {
      uri: URI.file(cwd).toString(),
      isDirectory: true,
      lastModification: 0,
      size: 0,
      type: FileType.Directory,
      readonly: false,
    };
  }

  /** codeblitz 框架会调: 设置文件 watcher 排除. 我们 no-op (server 端 watcher 自己有 exclude). */
  async setWatchFileExcludes(_excludes: string[]): Promise<void> {
    // no-op
  }

  /** codeblitz 框架会调: 返回 watcher 排除列表. 我们返 []. */
  getWatchFileExcludes(): string[] {
    return [];
  }

  watch(uri: import('@opensumi/ide-core-common').Uri, _options?: { excludes?: string[] }): number {
    const id = ++this.watcherIdCounter;
    this.watchers.set(id, { uri });
    this.ensureSse();
    return id;
  }

  async unwatch(watcherId: number): Promise<void> {
    this.watchers.delete(watcherId);
    if (this.watchers.size === 0) {
      this.stopSse();
    }
  }

  // ---- watcher SSE ----

  private ensureSse(): void {
    if (this.sse || this.sseReady) return;
    const base = appBaseUrl();
    if (!base) return;
    this.sseReady = new Promise<void>((resolve) => {
      try {
        const url = secureUrl(`${base}/global/event`);
        const es = new EventSource(url, { withCredentials: false });
        this.sse = es;
        es.onopen = () => {
          console.log('[fs-provider] SSE open');
          resolve();
        };
        es.onmessage = (msg) => {
          try {
            const raw = JSON.parse(msg.data);
            // V1 payload 包裹: {payload: {type, data}}; V2 顶层: {type, data}
            const ev = (raw && raw.payload) || raw;
            const t = ev?.type;
            if (t !== 'file.watcher.updated') return;
            const props = ev?.data || ev?.properties || {};
            const e: string = props.event;
            const p: string = props.file;
            if (!e || !p) return;
            // 跨 location 隔离: 跳过非当前 cwd 事件
            const cwd = effectiveCwd();
            if (cwd && !p.startsWith(cwd)) return;
            let rel: string;
            if (p === cwd) rel = '/';
            else if (cwd && p.startsWith(cwd + '/')) rel = p.slice(cwd.length);
            else rel = p;
            const uriStr = relToUri(rel);
            const type = e === 'add' || e === 'rename'
              ? FileChangeType.ADDED
              : e === 'unlink'
                ? FileChangeType.DELETED
                : FileChangeType.UPDATED;
            this._onDidChangeFile.fire([{ uri: uriStr, type }]);
          } catch { /* ignore bad frame */ }
        };
        es.onerror = () => { /* EventSource 自动重连 */ };
        // onopen 未必触发 (某些浏览器 SSE 实现), 兜底 resolve
        setTimeout(() => resolve(), 50);
      } catch (e) {
        console.warn('[fs-provider] SSE start failed:', e);
        resolve();
      }
    });
  }

  private stopSse(): void {
    if (this.sse) {
      try { this.sse.close(); } catch { /* ignore */ }
      this.sse = null;
    }
    this.sseReady = null;
  }

  /** 强制 fire 文件变更 (服务层 / 外部修改时调用) */
  fireFilesChange(changes: Array<{ uri: string; type: FileChangeType }>): void {
    this._onDidChangeFile.fire(changes);
  }
}

/** Uint8Array → base64 (浏览器端, 分块避免栈溢出) */
function bytesToBase64(input: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < input.length; i += chunk) {
    bin += String.fromCharCode(...input.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---- DI 注入: 覆盖 codeblitz 默认 'file' scheme provider ----

/** 强制移除 codeblitz 默认 'file' scheme provider 并替换为本实现.
 *  getProvider(scheme) 只查 fsProviders Map (file-service-client.js:433),
 *  IBrowserFileSystemRegistry 的 registry.providers 不会被查, 不能用于覆盖. */
@Injectable()
@Domain(ClientAppContribution)
export class CustomFsProviderContribution implements ClientAppContribution {
  @Autowired(IFileServiceClient)
  private readonly fileServiceClient!: IFileServiceClient;

  /** 单例 provider, 方便 service 层 fireFilesChange 同步 monaco editor */
  static provider: CustomFileSystemProvider | null = null;

  onStart(): Promise<void> {
    const provider = new CustomFileSystemProvider();
    CustomFsProviderContribution.provider = provider;

    const client = this.fileServiceClient as any;
    // 强制移除 codeblitz 默认注册的 'file' scheme provider
    if (client.fsProviders && typeof client.fsProviders.has === 'function' && client.fsProviders.has(Schemes.file)) {
      client.fsProviders.delete(Schemes.file);
    }
    // 注册我们的 provider
    client.registerProvider(Schemes.file, provider);

    // 通知 explorer 文件根变化: fireFilesChange 给当前 root URI 让 file tree 重新 stat.
    // (workspace extension 之前 setWorkspace 已发, 但 FileTreeService 可能仍缓存旧根的 stat 失败状态)
    const cwd = effectiveCwd();
    if (cwd) {
      const rootUri = URI.file(cwd).toString();
      try {
        client.fireFilesChange({ changes: [{ uri: rootUri, type: 1 }] });
      } catch (e) {
        console.warn('[fs-provider] fireFilesChange 失败:', e);
      }
    }

    console.log('[fs-provider] custom file scheme provider registered');
    return Promise.resolve();
  }
}

/** 浏览器侧 FileSystemProvider 注册表 (Map<scheme, provider>) 注入.
 *  IBrowserFileSystemRegistry 是 BrowserFileSystemRegistryImpl 的 DI token,
 *  自定义 scheme (非 'file') 用 registerFileSystemProvider 注册.  'file' 仍走上面
 *  IFileServiceClient.registerProvider. */
@Injectable()
export class FsProviderModule extends BrowserModule {
  providers = [CustomFsProviderContribution];
  contributionProvider = ClientAppContribution;
}

/** 业务代码读 provider 单例 */
export function getCustomFsProvider(): CustomFileSystemProvider | null {
  return CustomFsProviderContribution.provider;
}