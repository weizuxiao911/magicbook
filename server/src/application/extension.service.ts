/**
 * vsix 拓展编排 — application/extension.service.ts
 *
 * 编排 ExtensionRepository: vsix 元数据/上传/下架/资源分发.
 */

import type { ExtensionRepository } from '../domain/repositories/extension-repository';
import type { ExtensionMeta } from '../domain/models/extension';

export class ExtensionService {
  constructor(private readonly extension: ExtensionRepository) {}

  listMetadata(): Promise<ExtensionMeta[]> {
    return this.extension.listMetadata();
  }

  getVsixPath(name: string): Promise<string | null> {
    return this.extension.getVsixPath(name);
  }

  upload(tmpPath: string): Promise<ExtensionMeta> {
    return this.extension.upload(tmpPath);
  }

  remove(name: string): Promise<void> {
    return this.extension.remove(name);
  }

  getDistAsset(id: string, rel: string): Promise<string | null> {
    return this.extension.getDistAsset(id, rel);
  }
}