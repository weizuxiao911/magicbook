/**
 * filesystem 实现 — service/filesystem/index.ts
 *
 * implements core/commands/fs 的 IFileSystem（opensumi IFileService 标准）.
 *
 * 契约:
 *   - API 地址 = ${fs_base_url}/{api}（fs_base_url 由 sandbox server 返回, 含 /fs）
 *   - cwd 根 = sandbox runtime 返回的 cwd（相对路径, 不写死）
 *   - URI = file:// + cwd 根 + 相对路径
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';

import type { FileCopyOptions, FileDeleteOptions, FileMoveOptions, FileSetContentOptions, FileStat, IFileSystem } from '../../core/commands/fs';
import { FsToken } from '../../core/commands/fs';
import { toFileUri, cwdRoot } from '../base';
import { ServerFsProvider } from './provider';

/** fs_base_url（sandbox 返回, 含 /fs 前缀） */
function fsBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.fsUrl || '').replace(/\/+$/, '');
}

/** file:// URI → server 相对路径（剥离 cwd 根前缀, 如 /workspace/foo → /foo） */
function uriToPath(uri: string): string {
  const full = uri.replace(/^file:\/\//, '') || '/';
  const root = cwdRoot();
  if (root !== '/' && full.startsWith(root)) {
    return full.slice(root.length) || '/';
  }
  return full;
}

/** 相对路径 → file:// URI（根 = cwd） */
function pathToUri(path: string): string {
  return toFileUri(path);
}

function toFileStat(dto: any): FileStat {
  return {
    uri: pathToUri(dto.path ?? '/'),
    lastModification: dto.mtime ? new Date(dto.mtime).getTime() : 0,
    isDirectory: dto.type === 'directory',
    size: dto.size,
    type: dto.type === 'directory' ? 2 : 1,
  };
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`fs API ${res.status}: ${url}`);
  }
  return res.json() as Promise<T>;
}

/** 字节 → base64（浏览器端, 分块避免栈溢出） */
function bytesToBase64(input: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < input.length; i += chunk) {
    bin += String.fromCharCode(...input.subarray(i, i + chunk));
  }
  return btoa(bin);
}

@Injectable()
@Domain(ClientAppContribution)
export class FileSystemServiceImpl implements IFileSystem, ClientAppContribution {
  static instance: FileSystemServiceImpl | null = null;

  @Autowired(IFileServiceClient)
  private readonly fileService!: IFileServiceClient;

  private eventSource: EventSource | null = null;

  /** 容器启动: 挂全局单例 + 注册 server fs provider（explorer 数据源）+ 订阅 fs SSE */
  onStart(): void {
    (window as any).__APP_FS__ = this;
    console.log('[filesystem] service ready, fsBaseUrl:', fsBaseUrl() || '(unset)');
    // 注册 file scheme provider → explorer / 编辑器经 opensumi 标准链路读 server fs
    this.fileService.registerProvider('file', new ServerFsProvider());
    console.log('[filesystem] server fs provider registered (scheme=file)');
    this.connectEvents();
  }

  /** 订阅 /fs/events SSE, 收到变更后派发 fs:changed（explorer 等监听刷新） */
  private connectEvents(): void {
    const base = fsBaseUrl();
    if (!base) return;
    const es = new EventSource(`${base}/events`);
    this.eventSource = es;
    es.onmessage = (msg) => {
      try {
        const change = JSON.parse(msg.data);
        const rel = change.path || '/';
        const uri = toFileUri(rel);
        window.dispatchEvent(new CustomEvent('fs:changed', {
          detail: { ...change, uri },
        }));
      } catch {
        /* ignore bad frame */
      }
    };
    es.onerror = () => {
      // 断线自动重连（EventSource 内置重连）
      console.warn('[filesystem] fs events 断线, 等待重连');
    };
    console.log('[filesystem] fs events subscribed:', `${base}/events`);
  }

  private api(path: string): string {
    const base = fsBaseUrl();
    if (!base) throw new Error('fs base url not ready (sandbox runtime 未应用)');
    return `${base}/${path}`;
  }

  async getFileStat(uri: string): Promise<FileStat | undefined> {
    const path = uriToPath(uri);
    try {
      const meta = await http<any>(`${this.api('stat')}?path=${encodeURIComponent(path)}`);
      const entries = path === cwdRoot() ? null : await http<any[]>(`${this.api('dir')}?path=${encodeURIComponent(path)}`).catch(() => null);
      const stat = toFileStat(meta);
      if (stat.isDirectory && entries) {
        stat.children = entries.map((e) => toFileStat({ ...e, path: `${path === '/' ? '' : path}/${e.name}` }));
      }
      return stat;
    } catch (e: any) {
      if (e?.message?.includes('404')) return undefined;
      throw e;
    }
  }

  async resolveContent(uri: string, options?: FileSetContentOptions): Promise<{ stat: FileStat; content: string }> {
    const path = uriToPath(uri);
    const res = await fetch(`${this.api('file')}?path=${encodeURIComponent(path)}${options?.encoding === 'binary' ? '&binary=1' : ''}`);
    if (!res.ok) throw new Error(`fs resolveContent ${res.status}`);
    const content = options?.encoding === 'binary'
      ? Array.from(new Uint8Array(await res.arrayBuffer())).map((b) => String.fromCharCode(b)).join('')
      : await res.text();
    const stat: FileStat = await this.getFileStat(uri) ?? { uri, lastModification: Date.now(), isDirectory: false };
    return { stat, content };
  }

  async setContent(file: FileStat, content: string, options?: FileSetContentOptions): Promise<FileStat> {
    const path = uriToPath(file.uri);
    await http(`${this.api('file')}?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    const stat: FileStat = await this.getFileStat(file.uri) ?? file;
    return stat;
  }

  async createFile(uri: string, options?: { content?: string; overwrite?: boolean }): Promise<FileStat> {
    const path = uriToPath(uri);
    await http(`${this.api('file')}?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content: options?.content ?? '' }),
    });
    const stat: FileStat = await this.getFileStat(uri) ?? { uri, lastModification: Date.now(), isDirectory: false };
    return stat;
  }

  async createFolder(uri: string): Promise<FileStat> {
    const path = uriToPath(uri);
    await http(`${this.api('dir')}?path=${encodeURIComponent(path)}`, { method: 'POST' });
    const stat: FileStat = await this.getFileStat(uri) ?? { uri, lastModification: Date.now(), isDirectory: true };
    return stat;
  }

  async write(uri: string, content: string | Uint8Array): Promise<void> {
    const path = uriToPath(uri);
    const body = typeof content === 'string'
      ? { content }
      : { base64: bytesToBase64(content) };
    await http(`${this.api('file')}?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async delete(uri: string, options?: FileDeleteOptions): Promise<void> {
    const path = uriToPath(uri);
    await http(`${this.api('file')}?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  }

  async move(sourceUri: string, targetUri: string, options?: FileMoveOptions): Promise<FileStat> {
    const from = uriToPath(sourceUri);
    const to = uriToPath(targetUri);
    await http(`${this.api('move')}`, {
      method: 'POST',
      body: JSON.stringify({ from, to, overwrite: options?.overwrite }),
    });
    const stat: FileStat = await this.getFileStat(targetUri) ?? { uri: targetUri, lastModification: Date.now(), isDirectory: false };
    return stat;
  }

  async copy(sourceUri: string, targetUri: string, options?: FileCopyOptions): Promise<FileStat> {
    const from = uriToPath(sourceUri);
    const to = uriToPath(targetUri);
    await http(`${this.api('copy')}`, {
      method: 'POST',
      body: JSON.stringify({ from, to, overwrite: options?.overwrite }),
    });
    const stat: FileStat = await this.getFileStat(targetUri) ?? { uri: targetUri, lastModification: Date.now(), isDirectory: false };
    return stat;
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