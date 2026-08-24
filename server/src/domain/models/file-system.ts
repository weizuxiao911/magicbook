/**
 * 文件系统领域模型 — domain/models/file-system.ts
 *
 * 文件/目录条目与文件元信息. 零框架依赖.
 */

/** 目录条目（列目录返回） */
export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
}

/** 文件/目录元信息（stat） */
export interface FileMeta {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: string;
}

/** 文件系统操作结果 */
export interface FsWriteResult {
  ok: boolean;
  path: string;
}