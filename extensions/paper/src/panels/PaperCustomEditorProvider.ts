import * as vscode from 'vscode'
import { resolvePaperFromContent } from '../services/paperFileService'
import { PaperWebviewHost } from './PaperWebviewHost'

export const PAPER_CUSTOM_EDITOR_VIEW_TYPE = 'paperEditor'

/**
 * 让 .paper 文件在工作区中直接以插件 Webview 形式打开。
 * 保留原有命令面板模式，文件双击则走这里的自定义编辑器模式。
 */
export class PaperCustomEditorProvider implements vscode.CustomTextEditorProvider {
  /** 当前活动的 paper editor panel (供 tab 栏 action 命令触发存入试卷库) */
  static activePanel: vscode.WebviewPanel | null = null
  /** 所有已 resolve 的 paper editor panel (uri → panel), 刷新恢复后也能通过 uri 反查 */
  static readonly panels = new Map<string, vscode.WebviewPanel>()
  /** 已 resolve 的 paper 文档 (uri → document), 供重载时重新解析内容 */
  static readonly documents = new Map<string, vscode.TextDocument>()
  /** resolve 时注册的激活切换监听 (全局一份, 用于激活 paper 视图时重发数据) */
  private static activationDisposable: vscode.Disposable | null = null

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * 数据兜底重载:
   * 刷新/恢复时 fs 可能尚未就绪, document.getText() 读到空 → 延迟重试重解析,
   * 直到内容非空 (或尝试次数耗尽), 再通过 paper:update 重发数据给 webview.
   */
  private static scheduleReload(
    document: vscode.TextDocument,
    host: PaperWebviewHost,
    attempt = 0
  ): void {
    const state = resolvePaperFromContent(document.uri.fsPath, document.getText())
    if (state.status === 'empty' && attempt < 30) {
      // 空内容可能是沙箱文件系统未就绪 (恢复时序), 延迟重试 (每 2s, 最长 60s)
      setTimeout(() => PaperCustomEditorProvider.scheduleReload(document, host, attempt + 1), 2000)
      return
    }
    void host.updatePaperState(state)
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    PaperCustomEditorProvider.activePanel = webviewPanel
    PaperCustomEditorProvider.panels.set(document.uri.toString(), webviewPanel)
    PaperCustomEditorProvider.documents.set(document.uri.toString(), document)
    // eslint-disable-next-line no-console
    console.log('[paper] resolveCustomTextEditor:', document.uri.toString(), 'panel:', webviewPanel.viewType)

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        // browser 环境 Uri.joinPath 不可用 (CodeBlitz), 用字符串拼接
        vscode.Uri.parse(`${this.context.extensionUri.toString().replace(/\/$/, '')}/webview/dist`)
      ]
    }

    const paperState = resolvePaperFromContent(document.uri.fsPath, document.getText())
    const host = new PaperWebviewHost({
      panel: webviewPanel,
      extensionUri: this.context.extensionUri,
      paperState
    })
    // 数据兜底: 首次解析为空 (fs 未就绪) → 延迟重试重解析 + 重发, 覆盖恢复时序
    PaperCustomEditorProvider.scheduleReload(document, host)

    const changeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.document.uri.toString() !== document.uri.toString()) {
        return
      }

      const nextPaperState = resolvePaperFromContent(document.uri.fsPath, event.document.getText())
      await host.updatePaperState(nextPaperState)
    })

    webviewPanel.onDidDispose(() => {
      if (PaperCustomEditorProvider.activePanel === webviewPanel) {
        PaperCustomEditorProvider.activePanel = null
      }
      PaperCustomEditorProvider.panels.delete(document.uri.toString())
      PaperCustomEditorProvider.documents.delete(document.uri.toString())
      changeDisposable.dispose()
      host.dispose()
    })
  }

  /**
   * 插件注册层: 全局监听 IDE 激活资源切换 (OpenSumi 桥接的 onDidChangeActiveTextEditor,
   * custom editor 激活时同样触发), 每次激活 paper 视图都重发最新数据,
   * 兜底恢复/切换后 webview 内容未加载的场景. 仅注册一次.
   */
  static ensureActivationReloadListener(): vscode.Disposable {
    if (PaperCustomEditorProvider.activationDisposable) {
      return PaperCustomEditorProvider.activationDisposable
    }
    PaperCustomEditorProvider.activationDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      for (const uri of PaperCustomEditorProvider.panels.keys()) {
        const panel = PaperCustomEditorProvider.panels.get(uri)
        const document = PaperCustomEditorProvider.documents.get(uri)
        if (panel && document) {
          // 重发最新数据 (webview 侧 paper:update 已覆盖渲染), 不重建 webview
          const state = resolvePaperFromContent(document.uri.fsPath, document.getText())
          void panel.webview.postMessage({ type: 'paper:update', data: state }).catch(() => undefined)
        }
      }
    })
    return PaperCustomEditorProvider.activationDisposable
  }

  /**
   * 刷新恢复自愈: 页面刷新后框架可能不重新触发 resolve (custom editor 的
   * webview 恢复依赖扩展 worker 激活, 而 worker 激活晚于编辑器恢复).
   * 扩展激活后延迟检查: 打开中但未 resolve 的 .paper 文档 → 主动重新打开
   * (vscode.open 同一 uri) 触发框架重新 resolve → webview 重新加载内容.
   */
  static createRestoreSelfHeal(context: vscode.ExtensionContext): vscode.Disposable {
    const timers: ReturnType<typeof setTimeout>[] = []
    const check = (attempt: number) => {
      const docs = vscode.workspace.textDocuments.filter((d) => d.uri.path.endsWith('.paper'))
      const pending = docs.filter((d) => !PaperCustomEditorProvider.panels.has(d.uri.toString()))
      if (pending.length === 0) {
        return
      }
      // 等编辑器恢复完成 (document 内容可用) 再重新打开; 最多重试 10 次 (~30s)
      for (const doc of pending) {
        const state = resolvePaperFromContent(doc.uri.fsPath, doc.getText())
        if (state.status !== 'empty') {
          // eslint-disable-next-line no-console
          console.log('[paper] self-heal reopen (edit):', doc.uri.toString())
          // 强制以 custom editor (编辑态) 打开, 避免某些路径默认走预览/preview
          void vscode.commands
            .executeCommand('vscode.openWith', doc.uri, PAPER_CUSTOM_EDITOR_VIEW_TYPE)
            .catch(() => undefined)
          return
        }
      }
      if (attempt < 10) {
        timers.push(setTimeout(() => check(attempt + 1), 3000))
      }
    }
    // 延迟启动: 等编辑器恢复 + 框架触发一次 resolve 的机会
    timers.push(setTimeout(() => check(0), 5000))
    return { dispose: () => timers.forEach(clearTimeout) }
  }
}
