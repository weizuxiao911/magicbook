import * as vscode from 'vscode'

import { PDF_CUSTOM_EDITOR_VIEW_TYPE, PdfCustomEditorProvider } from './panels/PdfCustomEditorProvider'

export function activate(context: vscode.ExtensionContext) {
  // 注册 .pdf 自定义编辑器: 双击 .pdf 走 PDF Viewer (不暴露"打开方式"菜单)
  const customEditorDisposable = vscode.window.registerCustomEditorProvider(
    PDF_CUSTOM_EDITOR_VIEW_TYPE,
    new PdfCustomEditorProvider(context),
    {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    },
  )
  context.subscriptions.push(customEditorDisposable)
}

export function deactivate() {
  return undefined
}
