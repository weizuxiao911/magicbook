/**
 * vsix 拓展领域模型 — domain/models/extension.ts
 *
 * 拓展元数据（registry 协议契约）. 零框架依赖.
 */

export interface ExtensionMeta {
  extension: { publisher: string; name: string; version: string };
  packageJSON: Record<string, unknown>;
  /** 资源根（kt-ext 协议地址） */
  uri: string;
}