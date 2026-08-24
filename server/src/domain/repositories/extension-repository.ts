/**
 * vsix 拓展仓储接口（端口）— domain/repositories/extension-repository.ts
 *
 * vsix 元数据 / 包存储管理, 由基础设施层实现.
 */

import type { ExtensionMeta } from '../models/extension';

export interface ExtensionRepository {
  /** 元数据清单 */
  listMetadata(): Promise<ExtensionMeta[]>;
  /** 下载原始 .vsix 文件路径（不存在返回 null） */
  getVsixPath(name: string): Promise<string | null>;
  /** 上传 vsix（multipart 临时文件 → 入库 + 解压） */
  upload(tmpPath: string): Promise<ExtensionMeta>;
  /** 下架 */
  remove(name: string): Promise<void>;
  /** 解压产物静态资源路径 */
  getDistAsset(id: string, rel: string): Promise<string | null>;
}