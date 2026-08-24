/**
 * registry 实现 — service/registry/index.ts
 *
 * implements core/commands/registry 的 IRegistry: 对接 server /extension/*.
 * 启动期拉取 vsix 元数据 → 填充 __APP_REGISTRY_METADATA__（codeblitz ext host 加载）.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { ExtensionMetadata, IRegistry } from '../core/commands/registry';
import { RegistryToken } from '../core/commands/registry';


function registryUrl(): string {
  // 优先 sandbox runtime 返回的完整 registry_url（含 /extension）;
  // 未应用前 fallback 到 .env REGISTRY_BASE_URL
  const raw = ((window as any).__APP_CONFIG__?.registryUrl || registryBaseUrl()).replace(/\/+$/, '');
  // 统一返回服务根（剥离 /extension 后缀, 方法里拼 /extension）
  return raw.replace(/\/extension$/, '');
}

/** 拓展分发服务地址（.env REGISTRY_BASE_URL, 编译期注入） */
function registryBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.registryBaseUrl || '').replace(/\/+$/, '');
}

@Injectable()
export class RegistryServiceImpl implements IRegistry {
  static instance: RegistryServiceImpl | null = null;

  async listMetadata(): Promise<ExtensionMetadata[]> {
    const base = registryUrl();
    if (!base) return [];
    const res = await fetch(`${base}/extension`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`registry metadata fetch failed: ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  }

  async installMetadata(): Promise<ExtensionMetadata[]> {
    try {
      const metadata = await this.listMetadata();
      (window as any).__APP_REGISTRY_METADATA__ = metadata;
      console.log('[registry] metadata 拉取 OK:', metadata.length, 'entries');
      return metadata;
    } catch (e: any) {
      console.warn('[registry] metadata 拉取失败:', e?.message);
      (window as any).__APP_REGISTRY_METADATA__ = [];
      return [];
    }
  }

  getVsixUrl(name: string): string {
    const base = registryUrl();
    return `${base}/extension/vsix/${encodeURIComponent(name)}`;
  }

  isReady(): boolean {
    return !!registryUrl();
  }
}

/** 模块级单例 getter */
export function getRegistryService(): IRegistry {
  return RegistryServiceImpl.instance || (RegistryServiceImpl.instance = new RegistryServiceImpl());
}

@Injectable()
export class RegistryModule extends BrowserModule {
  providers = [{ token: RegistryToken, useFactory: () => getRegistryService() }];
}

/** 安装全局单例 */
export function installRegistryService(): void {
  (window as any).__APP_REGISTRY__ = getRegistryService();
  console.log('[registry] service installed');
}