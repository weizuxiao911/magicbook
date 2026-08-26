import * as vscode from 'vscode'
import { PdfWebviewHost } from './PdfWebviewHost'

export const PDF_CUSTOM_EDITOR_VIEW_TYPE = 'pdfViewer'

/**
 * 让 .pdf 在工作区中以插件 Webview 形式打开.
 * webview 内用 pdfjs-dist 渲染 (跟 animbook 思路一致, 自己实现避免依赖外部 vsix).
 */
export class PdfCustomEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly panels = new Map<string, vscode.WebviewPanel>()

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    PdfCustomEditorProvider.panels.set(document.uri.toString(), webviewPanel)

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.parse(`${this.context.extensionUri.toString().replace(/\/$/, '')}/webview/dist`),
      ],
    }

    const host = new PdfWebviewHost({ panel: webviewPanel, extensionUri: this.context.extensionUri })
    void host.loadDocument(document)

    const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return
      void host.reload()
    })

    webviewPanel.onDidDispose(() => {
      PdfCustomEditorProvider.panels.delete(document.uri.toString())
      changeDisposable.dispose()
      host.dispose()
    })
  }
}
