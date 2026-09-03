/**
 * service/editor/editor.service.ts
 *
 * EditorServiceImpl — DI 单例 (偏好逻辑层).
 *
 * 当前: 实现壳子 + preference 持久化 (extensions/opentype 调用).
 * UI (右键菜单 / 配置默认编辑器弹窗) 留 extensions/opentype — UI 与 service 职责分清.
 *
 * TODO 后续: 拆 extensions/opentype 的 default-editor preference 逻辑到这里,
 *   extensions/opentype 只保留 UI (右键菜单 + 弹窗), 通过 useInjectable(EditorToken) 拿服务.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import type { IEditorService } from './editor.interface';
import { EditorToken } from './editor.interface';

const ASSOC_STORAGE_KEY = 'opentype.default.assoc';

@Injectable()
export class EditorServiceImpl implements IEditorService {
  private loadAssoc(): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(ASSOC_STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  private saveAssoc(assoc: Record<string, string>): void {
    try { localStorage.setItem(ASSOC_STORAGE_KEY, JSON.stringify(assoc)); }
    catch { /* quota */ }
  }

  async openWith(_viewType: string, _uri: string): Promise<void> {
    // 实际 open 由 codeblitz IEditorService.open 驱动; 这里仅记录关联
    // 后续 opentype 拆完后, 此 方法调 codeblitz open
  }

  getDefaultViewType(uri: string): string | undefined {
    const assoc = this.loadAssoc();
    return assoc[uri];
  }

  setDefaultViewType(uri: string, viewType: string): void {
    const assoc = this.loadAssoc();
    assoc[uri] = viewType;
    this.saveAssoc(assoc);
  }
}

@Injectable()
export class EditorModule extends BrowserModule {
  providers = [
    { token: EditorToken, useClass: EditorServiceImpl },
    EditorServiceImpl,
  ];
}