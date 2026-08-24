/**
 * 文件系统编排 — application/fs.service.ts
 *
 * 编排 FsRepository + SandboxRepository: 基于用户 cwd 的文件操作.
 */

import type { FsRepository } from '../domain/repositories/fs-repository';
import type { SandboxRepository } from '../domain/repositories/sandbox-repository';
import type { FileEntry, FileMeta, FsWriteResult } from '../domain/models/file-system';

export class FsService {
  constructor(
    private readonly fs: FsRepository,
    private readonly sandbox: SandboxRepository,
  ) {}

  private cwd(user: string, tenant: string): string {
    return this.sandbox.resolveCwd(user, tenant);
  }

  getCwd(user: string, tenant: string): string {
    return this.cwd(user, tenant);
  }

  listDir(user: string, tenant: string, path: string): Promise<FileEntry[]> {
    return this.fs.listDir(this.cwd(user, tenant), path);
  }

  mkdir(user: string, tenant: string, path: string): Promise<void> {
    return this.fs.mkdir(this.cwd(user, tenant), path);
  }

  readFile(user: string, tenant: string, path: string, binary = false): Promise<Buffer> {
    return this.fs.readFile(this.cwd(user, tenant), path, binary);
  }

  writeFile(user: string, tenant: string, path: string, body: unknown): Promise<FsWriteResult> {
    return this.fs.writeFile(this.cwd(user, tenant), path, body);
  }

  remove(user: string, tenant: string, path: string): Promise<void> {
    return this.fs.remove(this.cwd(user, tenant), path);
  }

  stat(user: string, tenant: string, path: string): Promise<FileMeta> {
    return this.fs.stat(this.cwd(user, tenant), path);
  }

  search(user: string, tenant: string, path: string, pattern: string): Promise<string[]> {
    return this.fs.search(this.cwd(user, tenant), path, pattern);
  }
}