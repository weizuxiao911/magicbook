/**
 * IRegistry 接口定义 — core/commands/registry
 *
 * 全局协议/接口定义（内核）: vsix 动态拓展注册能力契约.
 * 实现: service/registry（implements IRegistry, 对接 server /extension/*）.
 *
 * 使用方通过 useInjectable(RegistryToken) 注入.
 */

/** vsix 元数据条目 */
export interface ExtensionMetadata {
  extension: { publisher: string; name: string; version: string };
  packageJSON: Record<string, unknown>;
  uri: string;
}

/** vsix 动态拓展注册能力接口 */
export interface IRegistry {
  /** 元数据清单（启动期拉取, 供 codeblitz ext host 加载 vsix） */
  listMetadata(): Promise<ExtensionMetadata[]>;
  /** 安装元数据到全局（填充 __APP_REGISTRY_METADATA__） */
  installMetadata(): Promise<ExtensionMetadata[]>;
  /** vsix 下载地址（按 name 解析） */
  getVsixUrl(name: string): string;
  /** 是否就绪 */
  isReady(): boolean;
}

/** Registry Token（全局定义） — service/registry 局部实现 */
export const RegistryToken: symbol = Symbol('IRegistry');