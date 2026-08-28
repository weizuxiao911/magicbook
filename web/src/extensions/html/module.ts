import { Injectable } from '@opensumi/di';
import { Domain, ClientAppContribution } from '@opensumi/ide-core-common';
import { BrowserModule, CommandContribution, CommandRegistry } from '@opensumi/ide-core-browser';
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
 * HTML 预览拓展 — .html/.htm 文件支持 "HTML 预览" webview 渲染.
 *
 * 注册:
 *   - EditorComponent uid = HTML_COMPONENT_ID (scheme = file).
 *     「打开方式」菜单会列出这个 component (OpenSumi 的 MenuId.EditorTitle
 *     submenu 自动收集所有已注册的 EditorComponent).
 *   - registerEditorComponentResolver weight=100 但**不调 resolve**,
 *     让 OpenSumi 默认 monaco text editor resolver 先匹配, .html 走默认 webview/code.
 *     用户可右键 "打开方式" 选 "HTML 预览" 切到 numas 的 webview 实现.
 */
@Injectable()
@Domain(CommandContribution, ClientAppContribution, BrowserEditorContribution)
export class HtmlContribution implements CommandContribution, ClientAppContribution, BrowserEditorContribution {
  registerCommands(commands: CommandRegistry): void {
    // 不需要 commands, 之前为 tab 栏 menu actions 注册的 3 个 commands 已撤回.
  }
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
      (scheme: string) => (scheme === 'file' ? 100 : -1),
      (resource: any, results: any[], resolve: (r: any[]) => void) => {
        const uri: any = resource?.uri;
        const pathStr = (uri?.path?.toString?.() || '').toLowerCase();
        const codeFsPath = String(uri?.codeUri?.fsPath || '').toLowerCase();
        const ext = getExt(pathStr || codeFsPath);
        if (!HTML_EXTS.has(ext)) {
          return; // 非 .html/.htm: 不调 resolve, 让 OpenSumi 默认 chain 继续
        }
        // 返回 2 个打开方式: HTML 预览 (numas webview) + 代码 (OpenSumi monaco text editor)
        // weight 'default' 让两个并列出现, 不互相覆盖
        resolve([
          {
            componentId: HTML_COMPONENT_ID,
            type: 'component',
            title: 'HTML 预览',
            weight: 'default',
          },
          {
            type: 'code',
            title: '代码',
            weight: 'default',
          },
        ]);
      },
    );
  }
}

@Injectable()
export class HtmlModule extends BrowserModule {
  providers = [HtmlContribution];
  contributionProvider = [CommandContribution, ClientAppContribution, BrowserEditorContribution];
}