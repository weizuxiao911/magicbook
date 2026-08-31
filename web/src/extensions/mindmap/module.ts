/**
 * Mindmap 拓展入口 — web/src/extensions/mindmap/module.ts
 *
 * 思维脑图 (@xyflow/react + 自实现树布局). 跟 pdf / html 拓展同模式:
 *   - 注册 EditorComponent (uid = MINDMAP_COMPONENT_ID, scheme = file)
 *   - EditorComponentResolver 命中 .mindmap/.md/.markdown → MindmapView
 *
 * 渲染: 由 MindmapView 接管 (@xyflow/react 节点 + 贝塞尔边 + 批注框)
 * 存储: 走 numas fs; 文件内容 = parser.ts 定义的 markdown 格式 (# 根 + tab-缩进 - 子节点 + @xxx 修饰)
 *       节点位置不存盘 (拖动后内存维护, 重开文件重排)
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

/**
 * 支持的扩展名:
 *   - .md / .markdown: 嵌套 markdown 可视化为脑图
 *   - .mindmap: 与 .md 同, 是 .mindmap 专属后缀 (用户偏好)
 *
 * 每个扩展名都注册两个并列组件 (weight='default', 与 PDF 类似):
 *   - Mindmap (默认推荐): 嵌套树可视化 + 编辑 (右键菜单 + 双击 + 拖拽)
 *   - Code: monaco 源码编辑 (修改后下次打开 mindmap 看到新内容)
 *
 * .md 走默认 monaco, 不强制 mindmap — 用户在"打开方式"里手动选 mindmap.
 * 无内容或无 # 根时, mindmap 渲染会回退为单节点 (不崩).
 */
const MINDMAP_EXTS = new Set(['md', 'markdown', 'mindmap']);

@Injectable()
@Domain(CommandContribution, BrowserEditorContribution)
export class MindmapContribution
  implements CommandContribution, BrowserEditorContribution {
  registerCommands(commands: CommandRegistry): void {
    // 命令占位 (label 由 menu 注册时决定; 框架暂无该字段)
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
        if (!MINDMAP_EXTS.has(ext)) {
          return; // 非 .md/.markdown/.mindmap: 不 resolve, 让 OpenSumi 默认 chain 继续
        }
        // 双模式并列 (mindmap 优先)
        resolve([
          {
            componentId: MINDMAP_COMPONENT_ID,
            type: 'component',
            title: 'Mindmap',
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
export class MindmapModule extends BrowserModule {
  providers = [MindmapContribution];
  contributionProvider = [CommandContribution, BrowserEditorContribution];
}

