/**
 * magicbook-html-preview — HTML 文件预览拓展
 *
 * customEditor: *.html 打开时用 webview 渲染预览（可切换回文本编辑）
 * 命令: HTML: 预览当前文件（webview panel 渲染当前编辑器 html）
 */
// @ts-nocheck
'use strict';

const vscode = require('vscode');

/** 文件内容 → 预览 HTML（body 直嵌, 基础 meta 防乱码） */
function renderPreview(html) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 16px; background: #fff; color: #111; }
</style>
</head>
<body>${html}</body>
</html>`;
}

function activate(context) {
  console.log('[html-preview] activate called');
  // customEditor provider: html 文件 → webview 渲染预览（文档变更实时刷新）
  const provider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      console.log('[html-preview] resolveCustomTextEditor:', document.uri.toString());
      const update = () => {
        webviewPanel.webview.html = renderPreview(document.getText());
      };
      update();
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) update();
      });
      webviewPanel.onDidDispose(() => changeSub.dispose());
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('magicbook.htmlPreview', provider, {
      webviewOptions: { enableScripts: true },
    }),
  );

  // 命令: 预览当前文件（webview panel）
  context.subscriptions.push(
    vscode.commands.registerCommand('magicbook.htmlPreview.show', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'html') {
        vscode.window.showInformationMessage('当前没有打开的 HTML 文件');
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        'magicbook.htmlPreview',
        'HTML Preview',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      const update = () => {
        panel.webview.html = renderPreview(editor.document.getText());
      };
      update();
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === editor.document) update();
      });
      panel.onDidDispose(() => changeSub.dispose());
    }),
  );
}

module.exports = { activate };