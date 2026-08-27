import * as vscode from 'vscode'

export const HTML_VIEW_TYPE = 'htmlViewer'

/**
 * HTML 阅读/编辑 (独立 vsix, 替代 web/src/extensions/html 内置实现)
 *
 * 模式:
 *   1. 双击 .html/.htm → 命中 customEditor (viewType=htmlViewer) → resolveCustomTextEditor
 *   2. extension 把 document 文本塞进 webview (通过 postMessage, 不直接拼 webview.html 避免大字符串反复序列化)
 *   3. webview 用 iframe srcDoc 渲染 HTML, 浮动工具栏: [刷新] [编辑] [在浏览器打开]
 *   4. 「编辑」按钮 → vscode.window.showTextDocument(uri) 切到 vscode 编辑器, monaco 直接编辑
 *   5. onDidChangeTextDocument 监听编辑结果, 实时推回 webview 重渲
 *   6. 「在浏览器打开」→ vscode.env.openExternal(file://...) 走系统默认浏览器
 *
 * 激活:
 *   - 只 onCustomEditor:htmlViewer (按需, 不抢启动时机)
 *   - 不写 onStartupFinished (避免影响主流程)
 *   - 不复用 web/src/extensions/html (内置, 用户明确不启用)
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** 空壳 webview (只渲染浮动工具栏 + 等待 postMessage 推内容) */
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
  /* 浮动工具栏 — 不占独立行, fixed 顶部居中 */
  .hv-toolbar {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: rgba(28, 28, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    z-index: 9999;
    opacity: 0.45;
    transition: opacity 0.18s ease, transform 0.18s ease;
    user-select: none;
  }
  .hv-toolbar:hover, .hv-toolbar:focus-within { opacity: 1; }
  .hv-toolbar.hv-pulse { transform: translateX(-50%) scale(1.04); }
  .hv-btn {
    appearance: none;
    border: none;
    background: transparent;
    color: #f5f5f7;
    padding: 5px 10px;
    font-size: 12px;
    font-family: inherit;
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
    transition: background 0.12s ease;
  }
  .hv-btn:hover { background: rgba(255, 255, 255, 0.16); }
  .hv-btn:active { background: rgba(255, 255, 255, 0.24); }
  .hv-btn.hv-btn--primary {
    background: #2563eb;
    color: #fff;
  }
  .hv-btn.hv-btn--primary:hover { background: #1d4fd1; }
  .hv-sep { width: 1px; height: 16px; background: rgba(255, 255, 255, 0.18); margin: 0 2px; }
  .hv-status {
    position: fixed;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 5px 12px;
    background: rgba(34, 197, 94, 0.92);
    color: #fff;
    font-size: 12px;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
    z-index: 9999;
  }
  .hv-status.hv-show { opacity: 1; }
  .hv-err {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #1e1e1e; color: #f87171;
    font-family: ui-monospace, Menlo, monospace;
    padding: 24px; font-size: 13px;
    white-space: pre-wrap; word-break: break-word; text-align: left;
  }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: #fff; }
</style>
</head>
<body>
<div id="stage">
  <iframe id="frame" sandbox="allow-scripts allow-modals allow-popups allow-forms allow-same-origin"></iframe>
</div>
<div class="hv-toolbar" id="toolbar">
  <button class="hv-btn" id="btn-refresh" title="重新加载 (Ctrl/Cmd+R)">⟳ 刷新</button>
  <span class="hv-sep"></span>
  <button class="hv-btn hv-btn--primary" id="btn-edit" title="用编辑器打开 (Ctrl/Cmd+E)">✏️ 编辑</button>
  <span class="hv-sep"></span>
  <button class="hv-btn" id="btn-open" title="用系统浏览器打开">🌐 浏览器</button>
</div>
<div class="hv-status" id="status"></div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('frame');
  const toolbar = document.getElementById('toolbar');
  const status = document.getElementById('status');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnEdit = document.getElementById('btn-edit');
  const btnOpen = document.getElementById('btn-open');
  let lastHtml = '';

  function showStatus(msg, ms = 1400) {
    status.textContent = msg;
    status.classList.add('hv-show');
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => status.classList.remove('hv-show'), ms);
  }

  function pulse() {
    toolbar.classList.add('hv-pulse');
    setTimeout(() => toolbar.classList.remove('hv-pulse'), 180);
  }

  function setHtml(html) {
    lastHtml = html;
    try {
      // srcDoc 比直接 document.write 更稳 (不会因旧文档残余事件触发 reload loop)
      frame.srcdoc = html;
    } catch (e) {
      document.getElementById('stage').innerHTML =
        '<div class="hv-err">渲染失败: ' + (e && e.message || e) + '</div>';
    }
  }

  btnRefresh.addEventListener('click', () => {
    pulse();
    vscode.postMessage({ type: 'refresh' });
  });
  btnEdit.addEventListener('click', () => {
    pulse();
    vscode.postMessage({ type: 'edit' });
  });
  btnOpen.addEventListener('click', () => {
    pulse();
    vscode.postMessage({ type: 'openExternal' });
  });

  // 键盘快捷键 (在 toolbar 容器内时生效)
  toolbar.addEventListener('keydown', (e) => {
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      vscode.postMessage({ type: 'refresh' });
    } else if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      vscode.postMessage({ type: 'edit' });
    }
  });
  // 默认让 toolbar 可聚焦, 触发快捷键
  toolbar.tabIndex = 0;
  toolbar.focus();

  // 接收来自 extension 的消息
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'content') {
      setHtml(msg.html || '');
    } else if (msg.type === 'status') {
      showStatus(msg.text, msg.ms);
    } else if (msg.type === 'error') {
      document.getElementById('stage').innerHTML =
        '<div class="hv-err">' + msg.text + '</div>';
    }
  });

  // 通知 extension webview 已就绪, 请求初始内容
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[html] activate (vsix, 独立实现, 不复用 web/src/extensions/html)')

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      console.log('[html] resolve:', document.uri.toString())

      webviewPanel.webview.options = {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
      webviewPanel.webview.html = buildShellHtml()

      const sendContent = () => {
        const text = document.getText()
        try {
          webviewPanel.webview.postMessage({ type: 'content', html: text })
        } catch (_) { /* ignore: panel disposed */ }
      }

      const sendStatus = (text: string, ms = 1400) => {
        try {
          webviewPanel.webview.postMessage({ type: 'status', text, ms })
        } catch (_) { /* ignore */ }
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
          } else if (msg?.type === 'refresh') {
            sendContent()
            sendStatus('已刷新')
          } else if (msg?.type === 'edit') {
            // 切到 vscode 文本编辑器, monaco 直接编辑 HTML
            try {
              await vscode.window.showTextDocument(document.uri, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: false,
              })
              sendStatus('已切到编辑器')
            } catch (e) {
              sendStatus('打开编辑器失败: ' + ((e as any)?.message || e))
            }
          } else if (msg?.type === 'openExternal') {
            try {
              await vscode.env.openExternal(vscode.Uri.file(document.uri.fsPath))
              sendStatus('已在系统浏览器打开')
            } catch (e) {
              sendStatus('打开失败: ' + ((e as any)?.message || e))
            }
          }
        } catch (e) {
          console.warn('[html] message handler error:', e)
        }
      })

      webviewPanel.onDidDispose(() => {
        changeSub.dispose()
        msgSub.dispose()
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
}

export function deactivate() { }
