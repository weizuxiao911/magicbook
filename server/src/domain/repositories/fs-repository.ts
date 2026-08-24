/**
 * 文件系统仓储接口（端口）— domain/repositories/fs-repository.ts
 *
 * 由基础设施层实现（本地文件系统 / 容器文件系统）.
 */

import type { FileEntry, FileMeta, FsWriteResult } from '../models/file-system';

export interface FsRepository {
  /** 列目录 */
  listDir(cwd: string, path: string): Promise<FileEntry[]>;
  /** 建目录（递归） */
  mkdir(cwd: string, path: string): Promise<void>;
  /** 读文件（utf-8 或二进制） */
  readFile(cwd: string, path: string, binary?: boolean): Promise<Buffer>;
  /** 写文件（内容原文或 base64） */
  writeFile(cwd: string, path: string, body: unknown): Promise<FsWriteResult>;
  /** 删除（递归） */
  remove(cwd: string, path: string): Promise<void>;
  /** 元信息 */
  stat(cwd: string, path: string): Promise<FileMeta>;
  /** 递归查找 */
  search(cwd: string, path: string, pattern: string): Promise<string[]>;
  /** 移动/重命名（opensumi move） */
  move(cwd: string, from: string, to: string, overwrite?: boolean): Promise<void>;
  /** 复制（opensumi copy） */
  copy(cwd: string, from: string, to: string, overwrite?: boolean): Promise<void>;
}