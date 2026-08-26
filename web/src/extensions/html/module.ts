import { Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { BrowserModule } from '@opensumi/ide-core-browser';
import type { ResourceService } from '@opensumi/ide-editor';
import { BrowserEditorContribution, EditorComponentRegistry } from '@opensumi/ide-editor/lib/browser/types';

import { HtmlViewer } from './HtmlViewer';

const HTML_COMPONENT_ID = 'numas.html-viewer';
const FILE_SCHEME = 'file';

/** HTML 扩展名 */
const HTML_EXTS = new Set(['html', 'htm']);

function getExt(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * HTML 预览/编辑插件 — .html/.htm 默认 webview 渲染, 可切换文本编辑模式.
 *
 * 注册:
 *   - EditorComponent uid = HTML_COMPONENT_ID (scheme = file)
 *   - registerEditorComponentResolver for file scheme, 命中 .html/.htm 时高权重
 *     返回 HtmlViewer; 其余情况不 resolve (让后续 resolver 继续)
 */
@Injectable()
@Domain(BrowserEditorContribution)
export class HtmlContribution implements BrowserEditorContribution {
  registerResource(_resourceService: ResourceService): void {
    // file scheme 已由框架提供
  }

  registerEditorComponent(registry: EditorComponentRegistry): void {
    registry.registerEditorComponent({
      uid: HTML_COMPONENT_ID,
      scheme: FILE_SCHEME,
      component: HtmlViewer as any,
    });
    registry.registerEditorComponentResolver(
      (scheme: string) => (scheme === 'file' ? 1100 : -1),
      (resource: any, results: any[], resolve: (r: any[]) => void) => {
        const uri: any = resource?.uri;
        const pathStr = (uri?.path?.toString?.() || '').toLowerCase();
        const codeFsPath = String(uri?.codeUri?.fsPath || '').toLowerCase();
        const ext = getExt(pathStr || codeFsPath);
        if (HTML_EXTS.has(ext)) {
          resolve([
            {
              componentId: HTML_COMPONENT_ID,
              type: 'component',
              title: 'HTML 预览',
              weight: 1100,
            },
          ]);
        }
        // 非 html: 不 resolve, 让后续 resolver 继续 (resolve 会截断链)
      },
    );
  }
}

@Injectable()
export class HtmlModule extends BrowserModule {
  providers = [HtmlContribution];
  contributionProvider = [BrowserEditorContribution];
}
