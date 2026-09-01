import * as vscode from 'vscode'

export const HTML_VIEW_TYPE = 'htmlViewer'

/**
 * HTML 阅读/编辑 (独立 vsix, 替代 web/src/extensions/html 内置实现)
 *
 * 模式:
 *   1. 双击 .html/.htm → 命中 customEditor (viewType=htmlViewer) → resolveCustomTextEditor
 *   2. extension 把 document 文本塞进 webview (通过 postMessage, 不直接拼 webview.html 避免大字符串反复序列化)
 *   3. webview 用 iframe srcDoc 渲染 HTML (无浮动工具栏, 操作走 tab 菜单栏)
 *   4. tab 菜单栏按钮: [编辑] → showTextDocument 切到 vscode 编辑器; [刷新] → 重推内容
 *   5. onDidChangeTextDocument 监听编辑结果, 实时推回 webview 重渲
 *
 * 激活:
 *   - 只 onCustomEditor:htmlViewer (按需, 不抢启动时机)
 *   - 不写 onStartupFinished (避免影响主流程)
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** 空壳 webview (只渲染 iframe, 等待 postMessage 推内容) */
function buildShellHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' 'unsafe-eval'; frame-src 'unsafe-inline' data: blob:; img-src * data:; font-src * data:;">
<title>HTML Viewer</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #fff; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; }
  #stage { position: absolute; inset: 0; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: #fff; }
  .hv-err {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #1e1e1e; color: #f87171;
    font-family: ui-monospace, Menlo, monospace;
    padding: 24px; font-size: 13px;
    white-space: pre-wrap; word-break: break-word; text-align: left;
  }
</style>
</head>
<body>
<div id="stage">
  <iframe id="frame" sandbox="allow-scripts allow-modals allow-popups allow-forms allow-same-origin"></iframe>
</div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setHtml(html) {
    try {
      // srcDoc 比直接 document.write 更稳 (不会因旧文档残余事件触发 reload loop)
      frame.srcdoc = html;
    } catch (e) {
      document.getElementById('stage').innerHTML =
        '<div class="hv-err">渲染失败: ' + (e && e.message || e) + '</div>';
    }
  }

  // 接收来自 extension 的消息
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'content') {
      setHtml(msg.html || '');
    } else if (msg.type === 'error') {
      document.getElementById('stage').innerHTML =
        '<div class="hv-err">' + esc(msg.text) + '</div>';
    }
  });

  // 通知 extension webview 已就绪, 请求初始内容
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`
}

/** 当前激活的 html webview panel (tab 菜单命令定位) */
function getActiveHtmlPanel(panels: Map<string, vscode.WebviewPanel>): { uri: string; panel: vscode.WebviewPanel } | null {
  try {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
    const uri = (activeTab?.input as any)?.uri
    if (!uri) return null
    const key = uri.toString()
    const panel = panels.get(key)
    if (!panel) return null
    return { uri: key, panel }
  } catch { return null }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[html] activate (vsix, 独立实现, 不复用 web/src/extensions/html)')

  const panels = new Map<string, vscode.WebviewPanel>()

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      console.log('[html] resolve:', document.uri.toString())

      webviewPanel.webview.options = {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
      // opensumi webview listening 有空窗期: 一次 set html 会丢 (srcdoc 空)
      // 多档延迟重发, 确保 webview 就绪后能收到 (参照 paper 旧版)
      const shellHtml = buildShellHtml()
      ;[0, 300, 1000, 2500, 5000].forEach((delay) => {
        setTimeout(() => {
          try { webviewPanel.webview.html = shellHtml } catch { /* ignore */ }
        }, delay)
      })
      panels.set(document.uri.toString(), webviewPanel)

      const sendContent = () => {
        const text = document.getText()
        try {
          webviewPanel.webview.postMessage({ type: 'content', html: text })
        } catch (_) { /* ignore: panel disposed */ }
      }

      const sendError = (text: string) => {
        try {
          webviewPanel.webview.postMessage({ type: 'error', text })
        } catch (_) { /* ignore */ }
      }

      // 监听文件变化: 内部编辑 / 外部编辑 / vscode 文本编辑器改动 → 实时同步
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) {
          sendContent()
        }
      })

      // 外部文件变更 (宿主机/AI 改文件): createFileSystemWatcher 监听 → 自动刷新 webview
      // (onDidChangeTextDocument 只覆盖编辑器内编辑, 覆盖不了外部改动)
      let fileWatcher: vscode.FileSystemWatcher | undefined
      try {
        const fsPath = document.uri.fsPath
        const watcherPattern = new vscode.RelativePattern(
          vscode.Uri.file(fsPath.replace(/\/[^/]+$/, '')),  // 目录
          fsPath.split('/').pop()!,                          // 文件名
        )
        fileWatcher = vscode.workspace.createFileSystemWatcher(watcherPattern)
        const onFileChange = () => {
          // 文件可能外部改动, document.getText() 可能过期 → 用 fs 重读兜底
          void vscode.workspace.fs.readFile(document.uri).then((bytes) => {
            try {
              webviewPanel.webview.postMessage({ type: 'content', html: new TextDecoder('utf-8').decode(bytes) })
            } catch (_) { /* ignore */ }
          }).catch(() => sendContent())
        }
        fileWatcher.onDidChange(onFileChange)
        fileWatcher.onDidCreate(onFileChange)
      } catch (e) {
        console.warn('[html] createFileSystemWatcher failed:', e)
      }

      // 监听 webview 消息
      const msgSub = webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
        try {
          if (msg?.type === 'ready') {
            // 初始内容推送
            const text = document.getText()
            if (text.length === 0) {
              sendError('文件为空\n\nURI: ' + document.uri.toString())
            } else {
              sendContent()
            }
          }
        } catch (e) {
          console.warn('[html] message handler error:', e)
        }
      })

      webviewPanel.onDidDispose(() => {
        panels.delete(document.uri.toString())
        changeSub.dispose()
        msgSub.dispose()
        if (fileWatcher) {
          try { fileWatcher.dispose() } catch { /* ignore */ }
        }
      })
    },
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(HTML_VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  )

  // 注册命令: 主动用 HTML viewer 打开当前文件
  context.subscriptions.push(
    vscode.commands.registerCommand('html.open', () => {
      const ed = vscode.window.activeTextEditor
      if (!ed) return
      void vscode.commands.executeCommand('vscode.openWith', ed.document.uri, HTML_VIEW_TYPE)
    }),
  )

  // tab 菜单栏命令: 刷新当前 html webview
  context.subscriptions.push(
    vscode.commands.registerCommand('html.refresh', () => {
      const active = getActiveHtmlPanel(panels)
      if (!active) return
      const text = vscode.workspace.textDocuments.find((d) => d.uri.toString() === active.uri)?.getText()
      if (text === undefined) return
      try {
        active.panel.webview.postMessage({ type: 'content', html: text })
      } catch (_) { /* ignore */ }
    }),
  )

  // tab 菜单栏命令: 编辑 → 切到 vscode 文本编辑器
  context.subscriptions.push(
    vscode.commands.registerCommand('html.edit', async () => {
      const active = getActiveHtmlPanel(panels)
      if (!active) return
      try {
        await vscode.window.showTextDocument(vscode.Uri.parse(active.uri), {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
        })
      } catch (e) {
        console.warn('[html] open editor failed:', e)
      }
    }),
  )
}

export function deactivate() { }
