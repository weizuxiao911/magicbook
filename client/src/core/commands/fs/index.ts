/**
 * IFileSystem 接口定义 — core/commands/fs
 *
 * 全局协议/接口定义（内核）: 文件系统能力契约.
 * 按 node:fs/promises + node:path 标准定义:
 *   - fs 部分: readFile / writeFile / readdir / rm / mkdir / stat（+ cwd / find 自扩展）
 *   - path 部分: join / resolve / basename / dirname / extname / isAbsolute / normalize
 *
 * 实现: service/filesystem（implements IFileSystem, 对接 server /fs/*）.
 * 使用方通过 useInjectable(FsToken) 注入.
 *
 * 路径约定（平台无关）: 一律使用 IDE 相对路径（/foo）; 路径运算由 server 端按平台处理,
 * client 只传路径字符串.
 */

/** 目录条目（readdir 返回值, ≈ fs.Dirent 子集） */
export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
}

/** 文件元信息（≈ fs.Stats 子集） */
export interface FsStats {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: string;
}

/** 写文件结果 */
export interface FsWriteResult {
  ok: boolean;
  path: string;
}

/** 读文件选项（对齐 fs/promises readFile options） */
export interface FsReadOptions {
  /** 返回类型: 默认 utf-8 字符串; true 返回二进制（对齐 readFile encoding: 'utf8' | 'buffer'） */
  binary?: boolean;
}

/**
 * 文件系统能力接口 — fs 部分（对齐 fs/promises）.
 */
export interface IFs {
  /** 当前用户 cwd（≈ process.cwd, 自扩展） */
  cwd(): Promise<string>;
  /** 列目录（≈ fs/promises readdir） */
  readdir(path: string): Promise<FsEntry[]>;
  /** 读文件（≈ fs/promises readFile; options.binary=true 返回 Uint8Array, 默认 utf-8 字符串） */
  readFile(path: string, options?: FsReadOptions): Promise<string | Uint8Array>;
  /** 写文件（≈ fs/promises writeFile; content 原文 / { base64 } 二进制） */
  writeFile(path: string, content: string | { base64: string }): Promise<FsWriteResult>;
  /** 删除文件/目录递归（≈ fs/promises rm recursive+force） */
  rm(path: string): Promise<void>;
  /** 建目录递归（≈ fs/promises mkdir recursive） */
  mkdir(path: string): Promise<void>;
  /** 元信息（≈ fs/promises stat） */
  stat(path: string): Promise<FsStats>;
  /** 递归查找文件名（≈ find, 自扩展） */
  find(path: string, pattern?: string): Promise<string[]>;
}

/**
 * 路径能力接口 — path 部分（对齐 node:path, 平台无关）.
 */
export interface IPath {
  /** 拼接路径（≈ path.join） */
  join(...parts: string[]): string;
  /** 解析绝对路径（≈ path.resolve） */
  resolve(...parts: string[]): string;
  /** 文件名（≈ path.basename） */
  basename(p: string): string;
  /** 目录部分（≈ path.dirname） */
  dirname(p: string): string;
  /** 扩展名（≈ path.extname） */
  extname(p: string): string;
  /** 是否绝对路径（≈ path.isAbsolute） */
  isAbsolute(p: string): boolean;
  /** 规范化（≈ path.normalize） */
  normalize(p: string): string;
}

/** 文件系统能力接口（fs + path 合并暴露） */
export interface IFileSystem extends IFs, IPath {}

/** BrowserFS 文件类型常量 */
export const FILE_TYPE_FILE = 1;
export const FILE_TYPE_DIR = 2;

/** Fs Token（全局定义） — service/filesystem 局部实现 */
export const FsToken: symbol = Symbol('IFileSystem');