import * as vscode from 'vscode'
import { resolvePaperFromContent } from '../services/paperFileService'
import { PaperWebviewHost } from './PaperWebviewHost'

export const PAPER_CUSTOM_EDITOR_VIEW_TYPE = 'paperEditor'

/**
 * 让 .paper 文件在工作区中直接以插件 Webview 形式打开。
 * 保留原有命令面板模式，文件双击则走这里的自定义编辑器模式。
 */
export class PaperCustomEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist')
      ]
    }

    const paperState = resolvePaperFromContent(document.uri.fsPath, document.getText())
    const host = new PaperWebviewHost({
      panel: webviewPanel,
      extensionUri: this.context.extensionUri,
      context: this.context,
      paperState
    })

    const changeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.document.uri.toString() !== document.uri.toString()) {
        return
      }

      const nextPaperState = resolvePaperFromContent(document.uri.fsPath, event.document.getText())
      await host.updatePaperState(nextPaperState)
    })

    // 外部文件变更 (宿主机/AI 改文件): createFileSystemWatcher 监听 → 自动刷新
    // (onDidChangeTextDocument 只覆盖编辑器内编辑, 覆盖不了外部改动)
    let fileWatcher: vscode.FileSystemWatcher | undefined
    try {
      const fsPath = document.uri.fsPath
      const dir = fsPath.replace(/\/[^/]+$/, '')
      const name = fsPath.split('/').pop()!
      fileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), name)
      )
      const onFileChange = () => {
        void vscode.workspace.fs.readFile(document.uri).then((bytes) => {
          const raw = new TextDecoder('utf-8').decode(bytes)
          const nextState = resolvePaperFromContent(document.uri.fsPath, raw)
          void host.updatePaperState(nextState)
        }).catch(() => {
          // fs 读失败 (可能刚删/移动): 兜底用 document
          const nextState = resolvePaperFromContent(document.uri.fsPath, document.getText())
          void host.updatePaperState(nextState)
        })
      }
      fileWatcher.onDidChange(onFileChange)
      fileWatcher.onDidCreate(onFileChange)
    } catch (e) {
      console.warn('[paper] createFileSystemWatcher failed:', e)
    }

    webviewPanel.onDidDispose(() => {
      changeDisposable.dispose()
      if (fileWatcher) {
        try { fileWatcher.dispose() } catch { /* ignore */ }
      }
      host.dispose()
    })
  }
}
