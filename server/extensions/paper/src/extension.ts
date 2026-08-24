import * as vscode from 'vscode'

import { PAPER_CUSTOM_EDITOR_VIEW_TYPE, PaperCustomEditorProvider } from './panels/PaperCustomEditorProvider'
import { initConfig } from './services/config'
import { resolvePaperFromContent } from './services/paperFileService'
import { savePaper } from './services/paperService'
import { getPluginConfig } from './services/config'
import { normalizeQuestionForSave } from './utils/transform'

export function activate(context: vscode.ExtensionContext) {
  // 初始化 YAML 配置路径（/app/.env 或扩展目录下 app/.env）
  initConfig(context.extensionPath)

  const customEditorDisposable = vscode.window.registerCustomEditorProvider(
    PAPER_CUSTOM_EDITOR_VIEW_TYPE,
    new PaperCustomEditorProvider(context),
    {
      webviewOptions: {
        retainContextWhenHidden: true
      },
      supportsMultipleEditorsPerDocument: false
    }
  )
  context.subscriptions.push(customEditorDisposable)
  // 全局监听激活资源切换 → 激活 paper 视图时重发数据 (兜底恢复/切换后内容未加载)
  context.subscriptions.push(PaperCustomEditorProvider.ensureActivationReloadListener())

  // 刷新恢复自愈: 页面刷新后 DOM 销毁重建, 框架可能不重新触发 resolve
  // (custom editor webview 恢复依赖扩展 worker 激活, 激活晚于编辑器恢复).
  // 扩展激活后延迟检查: 已打开但未 resolve 的 .paper 文档 → 主动重新打开
  // 触发框架重新 resolve → webview 重新加载内容.
  context.subscriptions.push(
    PaperCustomEditorProvider.createRestoreSelfHeal(context)
  )

  // tab 栏 action: 存入试卷库 — 直接读当前 paper 文档内容保存 (不依赖 webview 渲染)
  context.subscriptions.push(
    vscode.commands.registerCommand('magicbook.paper.saveToLibrary', async () => {
      try {
        // 找当前激活的 .paper 文档 (custom editor 的 document)
        const editorDoc = vscode.window.activeTextEditor?.document
        const paperDoc =
          editorDoc?.uri.path.endsWith('.paper')
            ? editorDoc
            : vscode.workspace.textDocuments.find((d) => d.uri.path.endsWith('.paper'))
        if (!paperDoc) {
          vscode.window.showWarningMessage('未打开试卷文件')
          return
        }

        const state = resolvePaperFromContent(paperDoc.uri.fsPath, paperDoc.getText())
        if (state.status !== 'ready') {
          vscode.window.showWarningMessage(state.status === 'empty' ? '当前试卷内容为空，请录入题目后再试' : '试卷文件不是合法的 JSON')
          return
        }

        const config = getPluginConfig()
        await savePaper({
          name: state.paper.title,
          questions: state.paper.questions.map((item) => normalizeQuestionForSave(item, config.scope.labCode))
        })
        vscode.window.showInformationMessage(`试卷「${state.paper.title}」已存入试卷库`)
      } catch (err) {
        vscode.window.showErrorMessage(`存入试卷库失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  )
}

export function deactivate() {
  return undefined
}
