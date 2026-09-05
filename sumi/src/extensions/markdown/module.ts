/**
 * extensions/markdown/module.ts — Markdown 预览拓展
 *
 * 启用 @opensumi/ide-markdown 的编辑器预览:
 *   - MarkdownModule (上游) 提供 IMarkdownService (底层 IWebviewService 渲染 marked + CSP)
 *   - 本贡献点把上游 MarkdownEditorComponent 注册为 file scheme 的编辑器组件,
 *     并对 .md 文件在"打开方式"里追加「预览」项, 权重 100 = 默认双击进预览
 *     (只 push 不 resolve, code 文本编辑器仍保留在打开方式列表, 可切回源码)
 *
 * 现状: codeblitz 默认只注册 MarkdownModule(服务), 预览贡献点 EmbeddedMarkdownEditorContribution
 *   未注册 → 双击 .md 走 monaco code 编辑器无预览. 这里补上贡献点.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule, Domain } from '@opensumi/ide-core-browser';
import { Schemes } from '@opensumi/ide-core-common';
import { EditorOpenType } from '@opensumi/ide-editor/lib/browser';
import {
  BrowserEditorContribution,
  EditorComponentRegistry,
} from '@opensumi/ide-editor/lib/browser/types';

// 上游组件 + 组件 uid (深路径导入, 与 @opensumi/ide-markdown 内部常量保持一致)
import { MarkdownEditorComponent } from '@opensumi/ide-markdown/lib/browser/editor.markdown';

const MARKDOWN_COMPONENT_ID = 'MARKDOWN_EDITOR_COMPONENT_ID';

@Injectable()
@Domain(BrowserEditorContribution)
export class MarkdownPreviewContribution implements BrowserEditorContribution {
  registerEditorComponent(registry: EditorComponentRegistry): void {
    registry.registerEditorComponent({
      uid: MARKDOWN_COMPONENT_ID,
      scheme: Schemes.file,
      component: MarkdownEditorComponent as any,
    });
    registry.registerEditorComponentResolver(
      (scheme: string) => (scheme === Schemes.file ? 100 : -1),
      (resource: any, results: any[]) => {
        const ext = (resource?.uri?.path?.ext || '').toLowerCase();
        if (ext !== '.md' && ext !== '.markdown') return;
        // 只 push 不 resolve: 预览提权为默认(weight 100), 责任链继续追加 code 文本编辑器,
        // 「打开方式」里同时保留 预览 / 文本编辑器 可互切
        results.push({
          type: EditorOpenType.component,
          componentId: MARKDOWN_COMPONENT_ID,
          title: '预览',
          weight: 100,
        });
      },
    );
  }
}

@Injectable()
export class MarkdownPreviewModule extends BrowserModule {
  providers = [MarkdownPreviewContribution];
  contributionProvider = [BrowserEditorContribution];
}
