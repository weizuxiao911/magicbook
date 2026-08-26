import { Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { BrowserEditorContribution, EditorComponentRegistry } from '@opensumi/ide-editor/lib/browser/types';

import { PdfReaderView } from './PdfReaderView';

export const PDF_COMPONENT_ID = 'numas.pdf-reader';

/**
 * PDF 阅读器拓展 (按 animbook 方式, opensumi 原生)
 *
 * 双击 .pdf → registerEditorComponentResolver 命中 → PDF reader (pdf.js 流式分页渲染)
 * 读取: fetch(opencode /api/fs/read + arrayBuffer) 二进制无损, 不经 workspace.fs UTF-8 解码
 */
@Injectable()
@Domain(BrowserEditorContribution)
export class PdfReaderContribution implements BrowserEditorContribution {
  registerEditorComponent(registry: EditorComponentRegistry): void {
    registry.registerEditorComponent({
      uid: PDF_COMPONENT_ID,
      scheme: 'file',
      component: PdfReaderView as any,
    });
    registry.registerEditorComponentResolver(
      (scheme: string) => (scheme === 'file' ? 1000 : -1),
      (resource: any, results: any[], resolve: (r: any[]) => void) => {
        const uri: any = resource?.uri;
        const pathStr = (uri?.path?.toString?.() || '').toLowerCase();
        const codeFsPath = String(uri?.codeUri?.fsPath || '').toLowerCase();
        if (pathStr.endsWith('.pdf') || codeFsPath.endsWith('.pdf')) {
          resolve([
            {
              componentId: PDF_COMPONENT_ID,
              type: 'component',
              title: 'PDF Reader',
              weight: 1000,
            },
          ]);
        }
        // 非 pdf: 不 resolve, 让后续 resolver 继续
      },
    );
  }
}

@Injectable()
export class PdfReaderModule extends BrowserModule {
  providers = [PdfReaderContribution];
  contributionProvider = [BrowserEditorContribution];
}
