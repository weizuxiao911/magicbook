/**
 * service/extension/extension.service.ts
 *
 * ExtensionServiceImpl — DI 单例.
 * bridge: kt-ext 协议 (registry @ :7790) → codeblitz ext host 元数据.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, Domain, URI } from '@opensumi/ide-core-browser';
import { StaticResourceContribution, StaticResourceService } from '@opensumi/ide-core-browser/lib/static-resource';
import { EXT_SCHEME } from '@codeblitzjs/ide-sumi-core/lib/common/constant';

import type { ExtensionMetadata, IExtensionService } from './extension.interface';
import { ExtensionToken } from './extension.interface';

function registryBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.registryBaseUrl || '').replace(/\/+$/, '');
}

/** kt-ext 静态资源贡献 — 覆盖 codeblitz 默认的 kt-ext→https 解析.
 *  codeblitz 默认把 kt-ext://<host>/<id> 转 https://<host>/<id>; 这里改为直连 registryBaseUrl. */
@Injectable()
@Domain(StaticResourceContribution)
export class RegistryStaticResourceContribution implements StaticResourceContribution {
  registerStaticResolver(service: StaticResourceService): void {
    const base = registryBaseUrl();
    service.registerStaticResourceProvider({
      scheme: EXT_SCHEME,
      resolveStaticResource: (uri) => {
        const path = uri.path.toString();
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
export class ExtensionServiceImpl implements IExtensionService {
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
      console.log('[extension] metadata 拉取 OK:', metadata.length, 'entries:', metadata.map((m) => m.extension.name).join(', '));
      return metadata;
    } catch (e: any) {
      console.warn('[extension] metadata 拉取失败:', e?.message);
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

@Injectable()
export class ExtensionModule extends BrowserModule {
  providers = [
    RegistryStaticResourceContribution,
    { token: ExtensionToken, useClass: ExtensionServiceImpl },
    ExtensionServiceImpl,
  ];
  contributionProvider = [StaticResourceContribution];
}