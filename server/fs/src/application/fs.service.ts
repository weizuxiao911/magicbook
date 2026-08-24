/**
 * 文件系统编排 — application/fs.service.ts
 *
 * 编排 FsRepository: 基于宿主机工作区根（hostRoot）的文件操作.
 * cwd 语义: client 见相对地址（/workspace）, server 操作见绝对宿主机根.
 */

import type { FsRepository } from '../domain/repositories/fs-repository';
import type { FileEntry, FileMeta, FsWriteResult } from '../domain/models/file-system';

export class FsService {
  constructor(
    private readonly fs: FsRepository,
    /** 宿主机绝对工作区根（fs 操作根） */
    private readonly hostRoot: string,
  ) {}

  getCwd(): string {
    return '/workspace';
  }

  listDir(path: string): Promise<FileEntry[]> {
    return this.fs.listDir(this.hostRoot, path);
  }

  mkdir(path: string): Promise<void> {
    return this.fs.mkdir(this.hostRoot, path);
  }

  readFile(path: string, binary = false): Promise<Buffer> {
    return this.fs.readFile(this.hostRoot, path, binary);
  }

  writeFile(path: string, body: unknown): Promise<FsWriteResult> {
    return this.fs.writeFile(this.hostRoot, path, body);
  }

  remove(path: string): Promise<void> {
    return this.fs.remove(this.hostRoot, path);
  }

  stat(path: string): Promise<FileMeta> {
    return this.fs.stat(this.hostRoot, path);
  }

  search(path: string, pattern: string): Promise<string[]> {
    return this.fs.search(this.hostRoot, path, pattern);
  }

  move(from: string, to: string, overwrite?: boolean): Promise<void> {
    return this.fs.move(this.hostRoot, from, to, overwrite);
  }

  copy(from: string, to: string, overwrite?: boolean): Promise<void> {
    return this.fs.copy(this.hostRoot, from, to, overwrite);
  }
}