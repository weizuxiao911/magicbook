/**
 * service/editor/editor.interface.ts
 *
 * 编辑器能力契约: open / openWith / 默认编辑器.
 * 实现: EditorServiceImpl (DI 单例). UI 部分留 extensions/opentype.
 */

export interface OpenWithRequest {
  uri: string;
  /** 候选 viewType 列表 (默认编辑器优先) */
  candidates?: string[];
}

export interface IEditorService {
  /** 按 viewType 打开 URI */
  openWith(viewType: string, uri: string): Promise<void>;
  /** 获取 URI 关联的默认 viewType (持久化在 preference/localStorage) */
  getDefaultViewType(uri: string): string | undefined;
  /** 设置 URI 的默认 viewType */
  setDefaultViewType(uri: string, viewType: string): void;
}

export const EditorToken: symbol = Symbol('IEditorService');