/**
 * server fs provider — service/filesystem/provider.ts
 *
 * opensumi 标准 FileSystemProvider（scheme='file'）: 对接 server /fs/*.
 * 注册进 IFileServiceClient 后, explorer / 编辑器经 opensumi 标准链路惰性读写 server fs.
 *
 * 事件: onDidChangeFile 由 fs:changed（server SSE 监听）驱动, 宿主机变更实时刷新 explorer.
 */

import { Emitter, Event, FileSystemProviderCapabilities } from '@opensumi/ide-core-common';
import type { Uri } from '@opensumi/ide-core-common';
import type { FileSystemProvider, FileStat, FileType, FileChangeEvent, IFileSystemProvider } from '@opensumi/ide-file-service/lib/common';

import { getFileSystemService } from './index';
import { toFileUri } from '../base';

export class ServerFsProvider implements IFileSystemProvider {
  readonly scheme = 'file';

  readonly capabilities: FileSystemProviderCapabilities = FileSystemProviderCapabilities.FileReadWrite;
  readonly onDidChangeCapabilities: Event<void> = Event.None;

  private readonly onDidChangeFileEmitter = new Emitter<FileChangeEvent>();
  readonly onDidChangeFile: Event<FileChangeEvent> = this.onDidChangeFileEmitter.event;

  constructor() {
    // 宿主机变更（server SSE /fs/events → fs:changed）→ 通知 explorer
    window.addEventListener('fs:changed', (e) => {
      const detail = (e as CustomEvent).detail || {};
      const uri = detail.uri;
      if (!uri) return;
      const type = detail.type === 'unlink' ? 2 : (detail.type === 'add' ? 1 : 0);
      this.onDidChangeFileEmitter.fire([{ type, uri }]);
    });
  }

  async stat(uri: Uri): Promise<FileStat | undefined> {
    return getFileSystemService().getFileStat(uri.toString());
  }

  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    const stat = await getFileSystemService().getFileStat(uri.toString());
    return (stat?.children || []).map((c) => [
      c.uri.split('/').pop() || '',
      c.isDirectory ? 2 : 1,
    ]);
  }

  async createDirectory(uri: Uri): Promise<void> {
    await getFileSystemService().createFolder(uri.toString());
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const { content } = await getFileSystemService().resolveContent(uri.toString());
    return new TextEncoder().encode(content || '');
  }

  async writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    await getFileSystemService().write(uri.toString(), content);
  }

  async delete(uri: Uri, options: { recursive: boolean; moveToTrash?: boolean }): Promise<void> {
    await getFileSystemService().delete(uri.toString(), options);
  }

  async rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): Promise<void> {
    await getFileSystemService().move(oldUri.toString(), newUri.toString(), options);
  }

  watch(uri: Uri, options: { recursive: boolean; excludes: string[] }): number {
    // 监听由 server SSE 全局驱动（fs:changed）, 这里返回占位 watcher id
    return 0;
  }

  unwatch?(watcherId: number): void {
    // noop
  }
}

/** 注册 server fs provider（explorer 数据源） */
export function registerServerFsProvider(register: (provider: IFileSystemProvider) => { dispose: () => void }): { dispose: () => void } {
  return register(new ServerFsProvider());
}