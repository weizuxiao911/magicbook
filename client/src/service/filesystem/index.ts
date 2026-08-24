/**
 * filesystem 实现 — service/filesystem/index.ts
 *
 * implements core/commands/fs 的 IFileSystem（fs + path）:
 *   - fs 部分: 对接 server /fs/*（readFile/writeFile/readdir/rm/mkdir/stat/find）
 *   - path 部分: 纯前端路径运算（POSIX 风格, IDE 相对路径 /foo, 平台无关）
 *
 * 基于 sandbox 返回的 fs_base_url（server 返回完整地址）.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { FsEntry, FsReadOptions, FsStats, FsWriteResult, IFileSystem } from '../../core/commands/fs';
import { FsToken } from '../../core/commands/fs';

function fsUrl(): string {
  return ((window as any).__APP_CONFIG__?.fsUrl || '').replace(/\/+$/, '');
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`fs API ${res.status}: ${url}`);
  }
  return res.json() as Promise<T>;
}

/**
 * path 实现 — 纯前端 POSIX 风格路径运算（IDE 路径恒为 / 分隔, 平台无关）.
 */
function posixPath() {
  const SEP = '/';
  return {
    join(...parts: string[]): string {
      return parts.filter((p) => p).join(SEP).replace(/\/{2,}/g, SEP);
    },
    resolve(...parts: string[]): string {
      const joined = this.join(...parts);
      return joined.startsWith(SEP) ? joined : `${SEP}${joined}`;
    },
    basename(p: string): string {
      const idx = p.lastIndexOf(SEP);
      return idx >= 0 ? p.slice(idx + 1) : p;
    },
    dirname(p: string): string {
      const idx = p.lastIndexOf(SEP);
      return idx > 0 ? p.slice(0, idx) : (idx === 0 ? SEP : '.');
    },
    extname(p: string): string {
      const name = this.basename(p);
      const idx = name.lastIndexOf('.');
      return idx > 0 ? name.slice(idx) : '';
    },
    isAbsolute(p: string): boolean {
      return p.startsWith(SEP);
    },
    normalize(p: string): string {
      return p.replace(/\/{2,}/g, SEP).replace(/\/$/, '') || SEP;
    },
  };
}

@Injectable()
export class FileSystemServiceImpl implements IFileSystem {
  static instance: FileSystemServiceImpl | null = null;

  private path = posixPath();

  private base(): string {
    const base = fsUrl();
    if (!base) throw new Error('fs base url not ready (sandbox runtime 未应用)');
    return base;
  }

  // ---- fs 部分 ----

  async cwd(): Promise<string> {
    const { cwd } = await http<{ cwd: string }>(`${this.base()}/fs/cwd`);
    return cwd;
  }

  async readdir(path: string): Promise<FsEntry[]> {
    return http<FsEntry[]>(`${this.base()}/fs/dir?path=${encodeURIComponent(path)}`);
  }

  async readFile(path: string, options?: FsReadOptions): Promise<string | Uint8Array> {
    const binary = options?.binary === true;
    const res = await fetch(`${this.base()}/fs/file?path=${encodeURIComponent(path)}${binary ? '&binary=1' : ''}`);
    if (!res.ok) throw new Error(`fs read ${res.status}`);
    if (binary) {
      return new Uint8Array(await res.arrayBuffer());
    }
    return res.text();
  }

  async writeFile(path: string, content: string | { base64: string }): Promise<FsWriteResult> {
    const body = typeof content === 'string' ? { content } : { base64: content.base64 };
    return http<FsWriteResult>(
      `${this.base()}/fs/file?path=${encodeURIComponent(path)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  }

  async rm(path: string): Promise<void> {
    await http<{ ok: boolean }>(`${this.base()}/fs/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  }

  async mkdir(path: string): Promise<void> {
    await http<{ ok: boolean }>(`${this.base()}/fs/dir?path=${encodeURIComponent(path)}`, { method: 'POST' });
  }

  async stat(path: string): Promise<FsStats> {
    return http<FsStats>(`${this.base()}/fs/file/meta?path=${encodeURIComponent(path)}`);
  }

  async find(path: string, pattern = '*'): Promise<string[]> {
    return http<string[]>(`${this.base()}/fs/search?path=${encodeURIComponent(path)}&pattern=${encodeURIComponent(pattern)}`);
  }

  // ---- path 部分 ----

  join(...parts: string[]): string {
    return this.path.join(...parts);
  }

  resolve(...parts: string[]): string {
    return this.path.resolve(...parts);
  }

  basename(p: string): string {
    return this.path.basename(p);
  }

  dirname(p: string): string {
    return this.path.dirname(p);
  }

  extname(p: string): string {
    return this.path.extname(p);
  }

  isAbsolute(p: string): boolean {
    return this.path.isAbsolute(p);
  }

  normalize(p: string): string {
    return this.path.normalize(p);
  }
}

/** 模块级单例 getter */
export function getFileSystemService(): IFileSystem {
  return FileSystemServiceImpl.instance || (FileSystemServiceImpl.instance = new FileSystemServiceImpl());
}

@Injectable()
export class FileSystemModule extends BrowserModule {
  providers = [{ token: FsToken, useFactory: () => getFileSystemService() }];
}

/** 安装全局单例 */
export function installFileSystemService(): void {
  (window as any).__APP_FS__ = getFileSystemService();
  console.log('[filesystem] service installed');
}