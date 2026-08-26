/**
 * registry 实现 — service/registry.ts
 *
 * implements core/commands/registry 的 IRegistry: 对接 registry 分发服务（:7790, HTTPS, kt-ext 协议）.
 *   - 启动期拉取 /metadata.json（codeblitz IExtensionBasicMetadata 完整字段）→ __APP_REGISTRY_METADATA__
 *   - 覆盖 kt-ext 静态资源解析 → 直连 registry 真实地址（自签证书需本机信任, 部署用正式证书）
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, Domain, URI } from '@opensumi/ide-core-browser';
import { StaticResourceContribution, StaticResourceService } from '@opensumi/ide-core-browser/lib/static-resource';
import { EXT_SCHEME } from '@codeblitzjs/ide-sumi-core/lib/common/constant';

import type { ExtensionMetadata, IRegistry } from '../commands/registry';
import { RegistryToken } from '../commands/registry';

/** registry 服务地址（编译期 REGISTRY_BASE_URL 注入; HTTPS, kt-ext 协议） */
function registryBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.registryBaseUrl || '').replace(/\/+$/, '');
}

/**
 * kt-ext 静态资源贡献 — 覆盖 codeblitz 默认的 kt-ext→https 解析.
 * codeblitz 默认把 kt-ext://<host>/<id> 转 https://<host>/<id>; 这里改为直连 registryBaseUrl,
 * 让扩展代码/资源从 registry 加载.
 */
@Injectable()
@Domain(StaticResourceContribution)
export class RegistryStaticResourceContribution implements StaticResourceContribution {
  registerStaticResolver(service: StaticResourceService): void {
    const base = registryBaseUrl();
    service.registerStaticResourceProvider({
      scheme: EXT_SCHEME,
      resolveStaticResource: (uri) => {
        const path = uri.path.toString();
        // 保留原 host（registry 扩展 / 内置 marketplace 资源各自命中）; 仅 kt-ext → https
        const scheme = uri.scheme === 'https' || uri.scheme === 'http' ? uri.scheme : base.startsWith('https') ? 'https' : 'http';
        return URI.from({
          scheme,
          authority: uri.authority || new URL(base).host,
          path: `${path}`,
        });
      },
      roots: [base],
    });
  }
}

@Injectable()
export class RegistryServiceImpl implements IRegistry {
  static instance: RegistryServiceImpl | null = null;

  async listMetadata(): Promise<ExtensionMetadata[]> {
    const base = registryBaseUrl();
    if (!base) return [];
    const res = await fetch(`${base}/metadata.json`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`registry metadata fetch failed: ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  }

  async installMetadata(): Promise<ExtensionMetadata[]> {
    try {
      const metadata = await this.listMetadata();
      (window as any).__APP_REGISTRY_METADATA__ = metadata;
      console.log('[registry] metadata 拉取 OK:', metadata.length, 'entries:', metadata.map((m) => m.extension.name).join(', '));
      return metadata;
    } catch (e: any) {
      console.warn('[registry] metadata 拉取失败:', e?.message);
      (window as any).__APP_REGISTRY_METADATA__ = [];
      return [];
    }
  }

  getVsixUrl(name: string): string {
    const base = registryBaseUrl();
    return `${base}/vsix/${encodeURIComponent(name)}`;
  }

  isReady(): boolean {
    return !!registryBaseUrl();
  }
}

/** 模块级单例 getter */
export function getRegistryService(): IRegistry {
  return RegistryServiceImpl.instance || (RegistryServiceImpl.instance = new RegistryServiceImpl());
}

@Injectable()
export class RegistryModule extends BrowserModule {
  providers = [
    RegistryStaticResourceContribution,
    { token: RegistryToken, useFactory: () => getRegistryService() },
  ];

  contributionProvider = [StaticResourceContribution];
}

/** 安装全局单例 */
export function installRegistryService(): void {
  (window as any).__APP_REGISTRY__ = getRegistryService();
  console.log('[registry] service installed');
}