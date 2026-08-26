/**
 * IFileSystem 接口定义 — core/commands/fs
 *
 * 全局协议/接口定义（内核）: 文件系统能力契约.
 * **相对路径 + 简单方法**（对齐 codeblitz OverlayFS 对接要求, 参考已验证实现）:
 *   - 方法: list / read / write / rm / mkdir / find（IDE 相对路径 /foo）
 *   - 对接: OverlayFS DynamicRequest 回调直接调用（core/config/runtime.ts）
 *
 * 路径约定: 一律使用 IDE 相对路径（/foo）; server 在 cwd 下操作.
 * 使用方通过 useInjectable(FsToken) 注入.
 */

/** 目录条目 */
export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
}

/** 文件元信息（server /fs/stat） */
export interface FileMeta {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime?: string;
}

/** 文件系统能力接口（相对路径, service/fs 实现; 同一实例兼作 BrowserFS backend 服务 opensumi 容器） */
export interface IFileSystem {
  /** 列目录（IDE 相对路径）, 返回 {name,type}[] */
  list(idePath: string): Promise<FsEntry[]>;
  /** 判断文件/目录是否存在 */
  exists(idePath: string): Promise<boolean>;
  /** 文件元信息（BrowserFS stat 适配的取值源） */
  meta(idePath: string): Promise<FileMeta>;
  /** 读文件（IDE 相对路径）, 返回 utf-8 字符串 */
  read(idePath: string): Promise<string>;
  /** 读文件为二进制（IDE 相对路径） */
  readBinary(idePath: string): Promise<Uint8Array>;
  /** 写文件（覆盖, 二进制安全: 字符串或 {base64}） */
  write(idePath: string, content: string | { base64: string }, onProgress?: (done: number, total: number) => void): Promise<boolean>;
  /** 删除文件/目录（递归） */
  rm(idePath: string): Promise<boolean>;
  /** mkdir -p */
  mkdirp(idePath: string): Promise<boolean>;
  /** 移动/重命名（server /fs/move, body {from,to}） */
  move(from: string, to: string): Promise<boolean>;
  /** 递归查找文件名 */
  find(idePath: string, pattern?: string): Promise<string[]>;
}

/** BrowserFS 文件类型常量（codeblitz ide-browserfs FileType 枚举） */
export const FILE_TYPE_FILE = 32768;
export const FILE_TYPE_DIR = 16384;

/** Fs Token（全局定义） — service/fs 局部实现 */
export const FsToken: symbol = Symbol('IFileSystem');