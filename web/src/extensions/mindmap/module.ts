/**
 * Mindmap 拓展入口 — web/src/extensions/mindmap/module.ts
 *
 * 思维脑图 (markmap 库, d3 渲染). 跟 pdf / html 拓展同模式:
 *   - 注册 EditorComponent (uid = MINDMAP_COMPONENT_ID, scheme = file)
 *   - EditorComponentResolver 命中 .mindmap 文件 → MindmapView
 *   - 不内置任何业务逻辑之外的公共能力 (markmap 库自带渲染/交互)
 *
 * 存储: 走 numas fs, 文件路径 /workspace/.mindmap/<id>.md, 内容是嵌套 markdown 树.
 *
 * 跟其他模块通信: command (mindmap-vscode.open / mindmap-vscode.toggle) 走 CommandService,
 * 不直连其他拓展.
 */
import { Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import {
  BrowserModule,
  CommandContribution,
  CommandRegistry,
} from '@opensumi/ide-core-browser';
import type { ResourceService } from '@opensumi/ide-editor';
import {
  BrowserEditorContribution,
  EditorComponentRegistry,
} from '@opensumi/ide-editor/lib/browser/types';

import { MindmapView } from './MindmapView';

export const MINDMAP_COMPONENT_ID = 'numas.mindmap-viewer';
const FILE_SCHEME = 'file';
const MINDMAP_EXTS = new Set(['mindmap', 'mm']);

/**
 * 注册两个 command 供菜单 / keybinding 触发:
 *   - mindmap-vscode.open   : 打开当前 .mindmap 文件 (走 editorService.open)
 *   - mindmap-vscode.toggle  : 展开/折叠当前焦点节点
 * (与 vsix 参考实现命令对齐.)
 */
@Injectable()
@Domain(CommandContribution, BrowserEditorContribution)
export class MindmapContribution
  implements CommandContribution, BrowserEditorContribution {
  registerCommands(commands: CommandRegistry): void {
    // 命令注册 (label 来自 @vscode/extension 风格, 框架暂无该字段; 通过 menu 注册时由 menu 决定 label)
    commands.registerCommand({ id: 'mindmap-vscode.open' }, { execute: () => {} });
    commands.registerCommand({ id: 'mindmap-vscode.toggle' }, { execute: () => {} });
  }

  registerResource(_resourceService: ResourceService): void {
    // file scheme 已由框架提供
  }

  registerEditorComponent(registry: EditorComponentRegistry): void {
    registry.registerEditorComponent({
      uid: MINDMAP_COMPONENT_ID,
      scheme: FILE_SCHEME,
      component: MindmapView as any,
    });
    registry.registerEditorComponentResolver(
      (scheme: string) => (scheme === FILE_SCHEME ? 100 : -1),
      (resource: any, results: any[], resolve: (r: any[]) => void) => {
        const uri: any = resource?.uri;
        const pathStr: string =
          uri?.path?.toString?.() || String(uri?.codeUri?.fsPath || '');
        const ext = (pathStr.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
        if (MINDMAP_EXTS.has(ext)) {
          resolve([
            {
              componentId: MINDMAP_COMPONENT_ID,
              type: 'component',
              title: 'Mindmap',
              weight: 1000,
            },
          ]);
        }
        // 非 .mindmap: 不调 resolve, 让 OpenSumi 默认 chain 继续
      },
    );
  }
}

@Injectable()
export class MindmapModule extends BrowserModule {
  providers = [MindmapContribution];
  contributionProvider = [CommandContribution, BrowserEditorContribution];
}
