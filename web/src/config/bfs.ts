/**
 * BrowserFS backend — core/config/bfs.ts
 *
 * RemoteFS: 读写全透传 opencode fs 的 BrowserFS 后端（opensumi 容器专用适配层）.
 *   - opensumi 容器（explorer/编辑器/@ 引用）经 BrowserFS 访问文件系统
 *   - 所有操作直连 service/fs 单实例（业务代码与容器共用同一文件系统实例）→ opencode /api/fs/*
 *   - 无缓存: 外部修改立即可见, 保存/创建/删除立即落盘, 无循环写回
 *
 * 注册: app.ts 里 BrowserFS.addFileSystemType(RemoteFS.Name, RemoteFS),
 *       runtime.ts workspace.filesystem 配置 fs: RemoteFS.Name.
 */

import { BaseFileSystem } from '@codeblitzjs/ide-browserfs/lib/core/file_system';
import { ApiError } from '@codeblitzjs/ide-browserfs/lib/core/api_error';
import { FileFlag } from '@codeblitzjs/ide-browserfs/lib/core/file_flag';
import Stats, { FileType } from '@codeblitzjs/ide-browserfs/lib/core/node_fs_stats';
import { NoSyncFile } from '@codeblitzjs/ide-browserfs/lib/generic/preload_file';
import { Buffer as Buf } from 'buffer';

import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';
import { getFileSystemService } from '../service/fs';
import type { FileMeta } from '../commands/fs';

type Cb<T = void> = (err: ApiError | null, result?: T) => void;

/** BrowserFS 路径 → IDE 相对路径（去 /workspace 前缀） */
function workspaceRel(path: string): string {
  const p = path.startsWith(WORKSPACE_ROOT) ? path.slice(WORKSPACE_ROOT.length) : path;
  return p || '/';
}

/** opencode FileMeta → BrowserFS Stats（mtime 取 server 值: 保存时 lastModification 稳定, 不误报 out-of-sync） */
function toStats(meta: FileMeta): Stats {
  const type = meta.type === 'directory' ? FileType.DIRECTORY : FileType.FILE;
  const t = meta.mtime ? Date.parse(meta.mtime) : Date.now();
  return new Stats(type, meta.size, 0x16d, t, t, t);
}

export class RemoteFS extends BaseFileSystem {
  static readonly Name = 'RemoteFS';
  static readonly Options = {};

  static isAvailable(): boolean {
    return true;
  }

  static Create(_opts: unknown, cb: Cb<RemoteFS>): void {
    cb(null, new RemoteFS());
  }

  getName(): string {
    return RemoteFS.Name;
  }

  diskSpace(_p: string, cb: (total: number, free: number) => void): void {
    cb(0, 0);
  }

  isReadOnly(): boolean {
    return false;
  }

  supportsLinks(): boolean {
    return false;
  }

  supportsProps(): boolean {
    return false;
  }

  supportsSynch(): boolean {
    return false;
  }

  stat(p: string, _isLstat: boolean | null, cb: Cb<Stats>): void {
    getFileSystemService()
      .meta(workspaceRel(p))
      .then((meta) => {
        cb(null, toStats(meta));
      })
      .catch(() => {
        // 未就绪（runtime 未注入）或不存在: 根目录视为空目录, 避免 file-tree 判定"无打开的文件夹";
        // 登录后 runtime 就绪 + explorer 刷新, 自动填充真实内容
        if (p === WORKSPACE_ROOT || p === '/') cb(null, toStats({ path: p, type: 'directory', size: 0 }));
        else cb(ApiError.ENOENT(p));
      });
  }

  readdir(p: string, cb: Cb<string[]>): void {
    getFileSystemService()
      .list(workspaceRel(p))
      .then((entries) => cb(null, entries.map((e) => e.name)))
      .catch(() => cb(null, []));
  }

  readFile(fname: string, encoding: string | null, _flag: FileFlag, cb: Cb<string | Buffer>): void {
    const rel = workspaceRel(fname);
    getFileSystemService()
      .read(rel)
      .then((bytes) => {
        // service/fs.read 返 Uint8Array (vscode API 一致): text 已 TextEncoder, binary 是原始 bytes
        const buf = Buf.from(bytes);
        cb(null, encoding === null ? buf : buf.toString(encoding as any));
      })
      .catch(() => cb(ApiError.ENOENT(fname)));
  }

  open(p: string, flags: FileFlag, _mode: number, cb: Cb<NoSyncFile<RemoteFS>>): void {
    // 写路径由 writeFile 直连 opencode 处理; open 仅服务读
    if (flags.isWriteable()) {
      return cb(ApiError.EPERM(p));
    }
    const rel = workspaceRel(p);
    Promise.all([getFileSystemService().meta(rel), getFileSystemService().read(rel)])
      .then(([meta, bytes]) => {
        cb(null, new NoSyncFile(this, p, flags, toStats(meta), Buf.from(bytes)));
      })
      .catch(() => cb(ApiError.ENOENT(p)));
  }

  writeFile(fname: string, data: unknown, _encoding: string | null, _flag: FileFlag, _mode: number, cb: Cb): void {
    const content = Buf.isBuffer(data) ? (data as any).toString('utf-8') : String((data as any) ?? '');
    const rel = workspaceRel(fname);
    console.log('[bfs] writeFile → opencode:', rel, JSON.stringify(content.slice(0, 40)));
    getFileSystemService()
      .write(rel, content)
      .then(() => cb(null))
      .catch((e: Error) => cb(ApiError.FileError(e as never, e?.message || 'write failed')));
  }

  unlink(p: string, cb: Cb): void {
    getFileSystemService()
      .rm(workspaceRel(p))
      .then(() => cb(null))
      .catch((e: Error) => cb(ApiError.FileError(e as never, e?.message || 'unlink failed')));
  }

  mkdir(p: string, _mode: number, cb: Cb): void {
    getFileSystemService()
      .mkdirp(workspaceRel(p))
      .then(() => cb(null))
      .catch((e: Error) => cb(ApiError.FileError(e as never, e?.message || 'mkdir failed')));
  }

  rename(oldPath: string, newPath: string, cb: Cb): void {
    getFileSystemService()
      .move(workspaceRel(oldPath), workspaceRel(newPath))
      .then(() => cb(null))
      .catch((e: Error) => cb(ApiError.FileError(e as never, e?.message || 'rename failed')));
  }
}