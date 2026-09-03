/**
 * service/filesystem/filesystem.service.ts
 *
 * FileSystemServiceImpl — FilePicker / chat agent / 业务代码用的文件系统 IO.
 * explorer / monaco 的 'file://' scheme IO 走 ./provider.ts (CustomFileSystemProvider).
 *
 * DI 注册: FsModule.providers: [{ token: FsToken, useClass: FileSystemServiceImpl }, FileSystemServiceImpl]
 * 消费方: useInjectable(FsToken) 拿单例.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { apiGet, apiPost } from '../../infra/http';
import { effectiveCwd } from '../../infra/url';
import { relForApi, normalizeSep, pathBase } from '../../infra/path';

import type { IFileSystem, FsEntry, FileMeta } from './filesystem.interface';
import { FsToken } from './filesystem.interface';

@Injectable()
export class FileSystemServiceImpl implements IFileSystem {
  /** 当前打开的 editor workspace dir (host 绝对路径) */
  getWorkspaceDir(): string {
    return effectiveCwd();
  }

  async list(idePath: string): Promise<FsEntry[]> {
    const norm = !idePath || idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const queryPath = norm === '/' ? '.' : norm.replace(/^\/+/, '');
    try {
      const data = await apiGet<Array<{ path: string; type: 'file' | 'directory' }>>(`/api/fs/list?path=${encodeURIComponent(queryPath)}`);
      const list = Array.isArray(data) ? data : [];
      return list.map((e) => ({
        name: pathBase(e.path),
        path: normalizeSep(e.path),
        type: e.type === 'directory' ? 'directory' : 'file',
      }));
    } catch {
      return [];
    }
  }

  async exists(idePath: string): Promise<boolean> {
    try { await this.meta(idePath); return true; }
    catch { return false; }
  }

  async meta(idePath: string): Promise<FileMeta> {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    const base = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    const name = norm === '/' ? '' : norm.slice(norm.lastIndexOf('/') + 1);
    const cached = this._listCache.get(base);
    let entry: FsEntry | undefined;
    if (cached) {
      entry = cached.find((e) => e.name === name);
    }
    if (!entry) {
      const entries = await this.list(base);
      this._listCache.set(base, entries);
      entry = entries.find((e) => e.name === name);
    }
    if (!entry) throw new Error(`stat: not found ${idePath}`);
    if (entry.type === 'directory') {
      return { path: idePath, type: 'directory', size: 0 };
    }
    let st = this._statCache.get(norm) ?? null;
    if (!st) {
      const stat = await apiGet<{ size?: number; mtime?: number }>(`/api/fs/stat?path=${encodeURIComponent(relForApi(idePath, effectiveCwd()))}`);
      if (stat && typeof stat.size === 'number') {
        st = { size: stat.size, mtimeMs: stat.mtime || 0 };
        this._statCache.set(norm, st);
      }
    }
    if (!st) return { path: idePath, type: 'file', size: 0 };
    return { path: idePath, type: 'file', size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  }

  async read(idePath: string): Promise<Uint8Array> {
    const rel = relForApi(idePath, effectiveCwd());
    try {
      const base = window.location.origin;
      const res = await fetch(`${base.replace(/\/+$/, '')}/api/fs/read/${encodeURIComponent(rel)}`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`fs read failed: ${idePath}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e: any) {
      throw new Error(`fs read failed: ${idePath}: ${e?.message || 'unknown'}`);
    }
  }

  async readBinary(idePath: string): Promise<Uint8Array> {
    return this.read(idePath);
  }

  async write(
    idePath: string,
    content: string | { base64: string },
    onProgress?: (done: number, total: number) => void,
  ): Promise<boolean> {
    // 内容一致跳过: 远程 vs 本地字节比对, 相同不写
    if (typeof content === 'string') {
      try {
        const st = await apiGet<{ type: string }>(`/api/fs/stat?path=${encodeURIComponent(relForApi(idePath, effectiveCwd()))}`);
        if (st && st.type === 'file') {
          const remote = await this.read(idePath);
          const remoteText = new TextDecoder().decode(remote);
          if (remoteText === content) return true;
        }
      } catch { /* 异常 → 正常写 */ }
    }
    const b64 = typeof content === 'string' ? bytesToBase64(content) : content.base64;
    try {
      await apiPost('/api/fs/write', { path: relForApi(idePath, effectiveCwd()), content: b64 });
    } catch {
      return false;
    }
    onProgress?.(b64.length, b64.length);
    this._invalidateParent(idePath);
    return true;
  }

  async rm(idePath: string): Promise<boolean> {
    const rel = relForApi(idePath, effectiveCwd());
    if (rel === '/' || rel === '' || rel === '.') return false;
    try {
      await apiPost('/api/fs/remove', { path: rel, recursive: true });
      this._invalidateParent(idePath);
      return true;
    } catch {
      return false;
    }
  }

  async rmdir(idePath: string): Promise<boolean> {
    try {
      await apiPost('/api/fs/remove', { path: relForApi(idePath, effectiveCwd()), recursive: false });
      this._invalidateParent(idePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(idePath: string): Promise<boolean> {
    try {
      await apiPost('/api/fs/mkdir', { path: relForApi(idePath, effectiveCwd()), recursive: true });
      this._invalidateParent(idePath);
      return true;
    } catch {
      return false;
    }
  }

  async move(from: string, to: string): Promise<boolean> {
    try {
      await apiPost('/api/fs/rename', { from: relForApi(from, effectiveCwd()), to: relForApi(to, effectiveCwd()) });
      this._invalidateParent(from);
      this._invalidateParent(to);
      return true;
    } catch {
      return false;
    }
  }

  async find(idePath: string, pattern = '*'): Promise<string[]> {
    const dir = !idePath || idePath === '/' ? '.' : idePath.replace(/^\/+/, '');
    try {
      const data = await apiGet<Array<{ path: string }>>(`/api/fs/find?query=${encodeURIComponent(pattern)}&type=file&path=${encodeURIComponent(dir)}`);
      return Array.isArray(data) ? data.map((e) => e.path) : [];
    } catch (e: any) {
      throw new Error(`fs find failed: ${idePath}: ${e?.message || 'unknown'}`);
    }
  }

  async listDir(absPath: string): Promise<FsEntry[]> {
    try {
      const data = await apiGet<Array<{ path: string; type: 'file' | 'directory' }>>('/api/fs/list?path=.', absPath);
      const list = Array.isArray(data) ? data : [];
      return list.map((e) => ({
        name: pathBase(e.path),
        path: normalizeSep(e.path),
        type: e.type === 'directory' ? 'directory' : 'file',
      }));
    } catch {
      return [];
    }
  }

  async mkdirAbs(absPath: string): Promise<boolean> {
    const parent = absPath.replace(/\/+$/, '');
    const name = parent.split('/').pop() || '';
    try {
      await apiPost('/api/fs/mkdir', { path: name, recursive: true }, parent);
      return true;
    } catch {
      return false;
    }
  }

  // ---- 内部: listCache + statCache 避免重复拉 ----
  private _listCache = new Map<string, FsEntry[]>();
  private _statCache = new Map<string, { size: number; mtimeMs: number }>();

  private _invalidateParent(idePath: string): void {
    const norm = idePath === '/' ? '/' : idePath.replace(/\/+$/, '');
    this._listCache.delete(norm);
    const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : '/';
    this._listCache.delete(parent);
    this._statCache.delete(norm);
  }
}

/** Uint8Array / string → base64 (浏览器端, 分块避免栈溢出). */
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

@Injectable()
export class FsModule extends BrowserModule {
  providers = [
    { token: FsToken, useClass: FileSystemServiceImpl },
    FileSystemServiceImpl,
  ];
}