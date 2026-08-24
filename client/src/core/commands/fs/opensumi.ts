/**
 * fs opensumi 对接 — core/commands/fs/opensumi.ts
 *
 * 按 opensumi FileSystemProvider 机制接入: 实现 opensumi 扩展点, 注册进 IFileServiceClient.
 * 内部经 FsToken（IFileSystem 接口）消费 service 实现（server /fs/*）.
 *
 * 事件: onDidChangeFile 由 fs:changed（server SSE 监听）驱动, 宿主机变更实时刷新 explorer.
 */

import { Emitter, Event } from '@opensumi/ide-core-common';
import type { Uri } from '@opensumi/ide-core-common';
import type { FileStat, FileType, FileChangeEvent, FileSystemProvider, IFileSystemProvider } from '@opensumi/ide-file-service/lib/common';

import type { IFileSystem } from './index';

/** opensumi FileSystemProvider 实现（scheme='file', 对接 server fs） */
export class FsOpensumiProvider implements IFileSystemProvider, FileSystemProvider {
  readonly scheme = 'file';

  // FileSystemProviderCapabilities.FileReadWrite（const enum 运行时不可用, 直接用值）
  readonly capabilities = 2 as any;
  readonly onDidChangeCapabilities: Event<void> = Event.None;

  private readonly onDidChangeFileEmitter = new Emitter<FileChangeEvent>();
  readonly onDidChangeFile: Event<FileChangeEvent> = this.onDidChangeFileEmitter.event;

  constructor(private readonly fs: IFileSystem) {
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
    return this.fs.getFileStat(uri.toString());
  }

  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    const stat = await this.fs.getFileStat(uri.toString());
    return (stat?.children || []).map((c) => [
      c.uri.split('/').pop() || '',
      c.isDirectory ? 2 : 1,
    ]);
  }

  async createDirectory(uri: Uri): Promise<void> {
    await this.fs.createFolder(uri.toString());
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const { content } = await this.fs.resolveContent(uri.toString());
    return new TextEncoder().encode(content || '');
  }

  async writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    await this.fs.write(uri.toString(), content);
  }

  async delete(uri: Uri, options: { recursive: boolean; moveToTrash?: boolean }): Promise<void> {
    await this.fs.delete(uri.toString(), options);
  }

  async rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): Promise<void> {
    await this.fs.move(oldUri.toString(), newUri.toString(), options);
  }

  watch(uri: Uri, options: { recursive: boolean; excludes: string[] }): number {
    // 监听由 server SSE 全局驱动（fs:changed）, 这里返回占位 watcher id
    return 0;
  }

  unwatch?(watcherId: number): void {
    // noop
  }
}

/** 注册 fs provider 到 opensumi IFileServiceClient（file scheme） */
export function registerFsOpensumiProvider(
  fileService: { registerProvider(scheme: string, provider: FileSystemProvider): unknown },
  fs: IFileSystem,
): unknown {
  return fileService.registerProvider('file', new FsOpensumiProvider(fs));
}