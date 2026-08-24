/**
 * IFileSystem 接口定义 — core/commands/fs
 *
 * 全局协议/接口定义（内核）: 文件系统能力契约.
 * **以 opensumi 文件系统（IFileServiceClient）为标准**:
 *   - 方法: getFileStat / resolveContent / setContent / createFile / createFolder / delete / move / copy
 *   - 类型: FileStat（uri / lastModification / isDirectory / children / size / type）
 *   - 路径: URI（file://...）
 *
 * 实现: service/filesystem（implements IFileSystem, 对接 server /fs/*）.
 * server 按本接口暴露 RESTful 端点.
 * 使用方通过 useInjectable(FsToken) 注入.
 */

/** 同 vscode FileType / opensumi FileType */
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

/** opensumi FileStat 标准 */
export interface FileStat {
  /** 资源路径（file:// URI） */
  uri: string;
  /** 最后修改时间（毫秒时间戳） */
  lastModification: number;
  /** 创建时间（毫秒时间戳） */
  createTime?: number;
  /** 是否为文件夹 */
  isDirectory: boolean;
  /** 是否为软连接 */
  isSymbolicLink?: boolean;
  /** 子项（isDirectory 且已 resolve 时存在; undefined 表示未解析） */
  children?: FileStat[];
  /** 文件大小 */
  size?: number;
  /** 同 vscode FileType */
  type?: FileType;
  /** 只读 */
  readonly?: boolean;
  /** 真实资源路径 */
  realUri?: string;
}

/** 读内容选项 */
export interface FileSetContentOptions {
  encoding?: 'utf8' | 'binary';
  overwriteEncoding?: boolean;
}

/** 移动选项 */
export interface FileMoveOptions {
  overwrite?: boolean;
}

/** 复制选项 */
export interface FileCopyOptions {
  overwrite?: boolean;
}

/** 删除选项 */
export interface FileDeleteOptions {
  recursive?: boolean;
  moveToTrash?: boolean;
}

/** 文件系统能力接口（opensumi IFileService 标准） */
export interface IFileSystem {
  /** 获取文件/目录 stat（uri 指向文件夹时返回一层 children）; 不存在返回 undefined */
  getFileStat(uri: string): Promise<FileStat | undefined>;
  /** 解析文件内容 */
  resolveContent(uri: string, options?: FileSetContentOptions): Promise<{ stat: FileStat; content: string }>;
  /** 更新文件内容 */
  setContent(file: FileStat, content: string, options?: FileSetContentOptions): Promise<FileStat>;
  /** 创建文件 */
  createFile(uri: string, options?: { content?: string; overwrite?: boolean }): Promise<FileStat>;
  /** 创建目录 */
  createFolder(uri: string): Promise<FileStat>;
  /** 写入（支持二进制, 对齐 FileSystemProvider.write; 用于文件上传/粘贴等） */
  write(uri: string, content: string | Uint8Array): Promise<void>;
  /** 删除文件/目录 */
  delete(uri: string, options?: FileDeleteOptions): Promise<void>;
  /** 移动/重命名 */
  move(sourceUri: string, targetUri: string, options?: FileMoveOptions): Promise<FileStat>;
  /** 复制 */
  copy(sourceUri: string, targetUri: string, options?: FileCopyOptions): Promise<FileStat>;
}

/** Fs Token（全局定义） — service/filesystem 局部实现 */
export const FsToken: symbol = Symbol('IFileSystem');