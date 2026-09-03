/**
 * service/extension/extension.interface.ts
 *
 * vsix 拓展注册能力契约 (registry @ 7790, kt-ext 协议).
 * 实现: ExtensionServiceImpl + RegistryStaticResourceContribution (覆盖 kt-ext 解析).
 */

export interface ExtensionMetadata {
  extension: { publisher: string; name: string; version: string };
  packageJSON: Record<string, unknown>;
  uri: string;
}

export interface IExtensionService {
  /** 拉取 vsix 元数据清单 (启动期) */
  listMetadata(): Promise<ExtensionMetadata[]>;
  /** 拉取 + 写入全局 __APP_REGISTRY_METADATA__ (codeblitz ext host 用) */
  installMetadata(): Promise<ExtensionMetadata[]>;
  /** vsix 下载地址 */
  getVsixUrl(name: string): string;
  /** 是否就绪 */
  isReady(): boolean;
}

export const ExtensionToken: symbol = Symbol('IExtensionService');