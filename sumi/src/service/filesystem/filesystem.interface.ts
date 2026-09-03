/**
 * service/filesystem/filesystem.interface.ts
 *
 * 文件系统能力契约 (node:fs promise 风格):
 *   - 全部方法接 idePath (相对 cwd 路径 /foo), server 在 cwd 下操作
 *   - 实现: FileSystemServiceImpl (FilePicker IO) + provider.ts (codeblitz file:// scheme)
 *
 * 消费方: useInjectable(FsToken) 拿单例.
 *
 * 路径约定: 一律 IDE 相对路径 (/foo), server 在 cwd 下操作.
 */

export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
  /** server 返回的原始 path (Windows 含 '\\' 已 normalize 成 '/'),  可选 */
  path?: string;
}

export interface FileMeta {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime?: string;
}

export interface IFileSystem {
  /** 列目录 (IDE 相对路径), 返回 {name,type}[] */
  list(idePath: string): Promise<FsEntry[]>;
  /** 判断文件/目录是否存在 */
  exists(idePath: string): Promise<boolean>;
  /** 文件元信息 */
  meta(idePath: string): Promise<FileMeta>;
  /** 读文件 (IDE 相对路径), 返回 utf-8 字符串 */
  read(idePath: string): Promise<Uint8Array>;
  /** 读文件为二进制 (IDE 相对路径) */
  readBinary(idePath: string): Promise<Uint8Array>;
  /** 写文件 (覆盖, 二进制安全: 字符串或 {base64}) */
  write(idePath: string, content: string | { base64: string }, onProgress?: (done: number, total: number) => void): Promise<boolean>;
  /** 删除文件/目录 (递归) */
  rm(idePath: string): Promise<boolean>;
  /** 删除空目录 (rmdir) */
  rmdir(idePath: string): Promise<boolean>;
  /** mkdir -p */
  mkdirp(idePath: string): Promise<boolean>;
  /** 移动/重命名 (server /fs/move) */
  move(from: string, to: string): Promise<boolean>;
  /** 递归查找文件名 */
  find(idePath: string, pattern?: string): Promise<string[]>;
  /** 宿主机绝对路径浏览 (FilePicker 用) */
  listDir(absPath: string): Promise<FsEntry[]>;
  /** 宿主机绝对路径建目录 (FilePicker 用) */
  mkdirAbs(absPath: string): Promise<boolean>;
  /** 当前工作目录 (host 绝对路径) */
  getWorkspaceDir(): string;
}

/** DI Token. useInjectable(FsToken) 拿单例. */
export const FsToken: symbol = Symbol('IFileSystem');