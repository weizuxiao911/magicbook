import * as vscode from 'vscode'

export const PDF_VIEW_TYPE = 'pdfViewer'

/**
 * PDF 阅读器 (vsix, 替代 web/src/extensions/pdf)
 *
 * 关键问题 + 解决:
 *   1. vscode.workspace.fs 在 opensumi 可能不暴露 → fallback 用 webview 端 fetch
 *      opencode /api/fs/read (走 x-opencode-directory header)
 *   2. webview.html 一次性 push 在 opensumi 经常丢 (listening 窗口) → 多档重试
 *   3. PDF 二进制太大, base64 字符串塞 html 容易超 bufferSize → 改 webview.postMessage
 *      传输 URL, webview 自己 fetch (opencode 服务暴露 PDF bytes, webview 当 client 拿)
 *   4. PDF.js 走 CDN 加载 (unpkg / jsdelivr, 失败 fallback)
 *   5. opensumi webview 的 base url 是 vscode-resource, PDF.js worker 路径处理
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('[pdf] context', context)

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {

      console.log('[pdf] window:', window)
      console.log('[pdf] document:', document)
      console.log('[pdf] webviewPanel:', webviewPanel)
      console.log('[pdf] _token:', _token)
      const uri = document.uri.toString()
      console.log('[pdf] resolve:', uri)
      webviewPanel.webview.options = { enableScripts: true, retainContextWhenHidden: true }

      // 1) registry baseUrl (pdfjs 静态资源)
      const registryBase =
        ((window as any).__APP_CONFIG__?.registryBaseUrl as string | undefined) ||
        ((window as any).__APP_REGISTRY_RUNTIME__?.baseUrl as string | undefined) ||
        'http://localhost:7790'

      // 2) 读 PDF 字节: 之前 vscode.workspace.fs.readFile 在 ext host worker 端 'fs' undefined fail.
      //    改走 web 容器 service/fs.read 路径 (走 fetch opencode SDK, ext host 端 fetch OK, CORS pre-config).
      //    web 容器 host API: 拿 baseUrl + cwd, 直接 fetch /file/content, 拿 { type, content, encoding, mimeType }.
      const name = (document.uri?.fsPath || '').split(/[\\/]/).pop() || 'document.pdf'
      const ocBase = ((window as any).__APP_OPENCODE_RUNTIME__?.baseUrl as string | undefined) || ''
      const cwdForFs = (() => { try { return localStorage.getItem('APP_CWD') || '' } catch { return '' } })()
      const pathParam = (() => {
        const fsPath = document.uri?.fsPath || ''
        const rootName = cwdForFs.split('/').pop() || ''
        if (rootName && fsPath.includes(`/workspace/${rootName}/`)) {
          return fsPath.split(`/workspace/${rootName}/`)[1] || ''
        }
        if (cwdForFs && fsPath.startsWith(cwdForFs + '/')) {
          return fsPath.slice(cwdForFs.length + 1)
        }
        return fsPath.split('/').pop() || ''
      })()
      let pdfBase64 = ''
      let readErr: string | null = null
      try {
        const apiUrl = `${ocBase}/file/content?path=${encodeURIComponent(pathParam)}&directory=${encodeURIComponent(cwdForFs)}`
        const r = await fetch(apiUrl)
        if (!r.ok) throw new Error(`opencode /file/content ${r.status}`)
        const data: any = await r.json()
        console.log('[pdf]   file/content ok:', pathParam, 'type=', data.type, 'len=', data.content?.length, 'encoding=', data.encoding)
        if (data.type === 'binary' && data.encoding === 'base64') {
          pdfBase64 = data.content
        } else {
          // 文本 (不该是 PDF, 但兜底)
          pdfBase64 = btoa(unescape(encodeURIComponent(data.content || '')))
        }
        console.log('[pdf]   base64 ok, len=', pdfBase64.length)
      } catch (e: any) {
        console.error('[pdf]   readFile failed:', e?.message)
        readErr = e?.message || String(e)
      }
      webviewPanel.webview.html = buildHtml(registryBase, name, pdfBase64, readErr)
      console.log('[pdf]   html 长度:', webviewPanel.webview.html.length)

      webviewPanel.onDidDispose(() => {
        console.log('[pdf]   dispose:', uri)
      })
    },
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('pdf.open', () => {
      const ed = vscode.window.activeTextEditor
      if (!ed) return
      void vscode.commands.executeCommand('vscode.openWith', ed.document.uri, PDF_VIEW_TYPE)
    }),
  )
  console.log('[pdf]   registered customEditor + command')
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/**
 * ext host 走 opencode /api/pty 跑 `base64 <abs>` 读 PDF 字节.
 *   跟 web/src/service/fs-pty.ts 同协议, vsix 内部独立实现.
 *   避 opencode /api/fs/read 对 30MB+ 大文件 500.
 *   独立于 vscode.workspace.fs / RemoteFS, 不影响 paper / html / monaco 等其他拓展.
 */
async function readPdfViaPty(base: string, cwd: string, absPath: string): Promise<Uint8Array> {
  if (!base) throw new Error('opencode baseUrl 未注入 (缺 __APP_OPENCODE_RUNTIME__)')
  if (!cwd) throw new Error('cwd 未注入 (缺 APP_CWD)')
  if (!absPath) throw new Error('absPath 为空')

  // 1. POST /pty 创建 PTY (zsh 走 POSIX, base64 命令是 coreutils)
  const createRes = await fetch(`${base}/pty`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-opencode-directory': cwd },
    body: JSON.stringify({ command: '/bin/sh', cwd }),
  })
  if (!createRes.ok) throw new Error(`create pty failed: HTTP ${createRes.status}`)
  const info = await createRes.json()
  const ptyId: string = info?.id
  if (!ptyId) throw new Error('create pty returned no id')

  // 2. WS connect
  const wsBase = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsBase}/pty/${ptyId}/connect?directory=${encodeURIComponent(cwd)}`)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pty ws connect timeout')), 5000)
    ws.onopen = () => { clearTimeout(t); resolve() }
    ws.onerror = () => { clearTimeout(t); reject(new Error('pty ws connect error')) }
  })

  // 3. 跑 base64, 跟 fs-pty.ts wrapWithMarker 同模式
  const marker = `__PDFM_${Date.now()}_${Math.random().toString(36).slice(2)}__`
  const cmd = `base64 "${absPath.replace(/"/g, '\\"')}" 2>/dev/null && echo __PDF_OK__ ; echo ${marker}`
  ws.send(`\r${cmd}\r`)

  // 4. 累积 output, 匹配 marker
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`pty exec timeout 60s`)), 60000)
      let accum = ''
      ws.onmessage = (e) => {
        const data = typeof e.data === 'string' ? e.data : ''
        const trimmed = data.replace(/^\u0000+/, '')
        if (
          trimmed.startsWith('{"cursor"') ||
          trimmed.startsWith('{"type":"cursor"') ||
          trimmed.startsWith('{"type":"resize"') ||
          (trimmed.startsWith('{') && trimmed.includes('"method"'))
        ) return
        accum += trimmed
        const idx = accum.indexOf(marker)
        if (idx >= 0) {
          clearTimeout(t)
          resolve(accum.slice(0, idx))
        }
      }
      ws.onerror = () => { clearTimeout(t); reject(new Error('pty ws error during exec')) }
    })

    // 5. atob → Uint8Array
    const b64 = output.replace('__PDF_OK__', '').replace(/\s+/g, '')
    if (!b64) throw new Error(`pty exec returned empty base64 for ${absPath}`)
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return arr
  } finally {
    try { ws.close() } catch { /* ignore */ }
    // opencode 端 PTY 不显式关, 等 shell 退出 / 超时
  }
}

function buildHtml(registryBase: string, name: string, vsixFsJson: string): string {
  // pdfjs 资源走 registry 自包含 (registry/vsix/numas.pdf-0.1.0/pdfjs/*), 不依赖 cdn
  // 试把 vscode.workspace.fs (JSON 序列化字符串) 给 webview, 测 webview 端能否拿到
  const pdfjsBase = `${registryBase.replace(/\/+$/, '')}/numas.pdf-0.1.0/pdfjs`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)}</title>
<style>
  *{box-sizing:border-box}
  body,html{margin:0;padding:0;height:100%;background:#525659;color:#fff;font-family:system-ui,sans-serif;overflow:hidden}
  #app{height:100%;display:flex;flex-direction:column}
  .toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#323639;border-bottom:1px solid #1a1a1a;flex-shrink:0;font-size:12px}
  .toolbar button{background:#3c3d3e;border:1px solid #555;color:#eee;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;font-family:inherit}
  .toolbar button:hover{background:#4a4c4d}
  .toolbar button:disabled{opacity:.4;cursor:default}
  .toolbar .pg{font-variant-numeric:tabular-nums;min-width:54px;text-align:center;color:#eee}
  .toolbar .info{margin-left:auto;color:#aaa}
  .viewport{flex:1;overflow:auto;padding:12px;background:#525659}
  .page{display:block;margin:0 auto 8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4)}
  .err{color:#faa;padding:20px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;font-size:12px}
  .loading{display:flex;align-items:center;justify-content:center;height:100%;color:#aaa;font-size:13px}
</style>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <button id="prev">‹ 上一页</button>
    <span class="pg"><span id="cur">-</span> / <span id="tot">-</span></span>
    <button id="next">下一页 ›</button>
    <button id="zoom-out">−</button>
    <span class="pg" id="zoom">100%</span>
    <button id="zoom-in">+</button>
    <button id="fit">适应宽度</button>
    <span class="info" id="info"></span>
  </div>
  <div class="viewport" id="viewport"><div class="loading">加载中…</div></div>
</div>
<script>
(function(){

  function setStatus(s){document.getElementById('info').textContent=s;}

  async function loadPdfJs(){
    if (window.pdfjsLib) return window.pdfjsLib;
    const mainUrl = PDFJS_BASE + '/pdf.min.mjs';
    await loadScript(mainUrl);
    if (!window.pdfjsLib) throw new Error('PDF.js 主库加载失败: ' + mainUrl);
    const workerUrl = PDFJS_BASE + '/pdf.worker.min.mjs';
    const r = await fetch(workerUrl);
    if (!r.ok) throw new Error('PDF.js worker 加载失败: ' + workerUrl + ' (HTTP ' + r.status + ')');
    const txt = await r.text();
    const blob = new Blob([txt], { type: 'text/javascript' });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    return window.pdfjsLib;
  }
  function loadScript(src){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error(src));
      document.head.appendChild(s);
    });
  }

  (async () => {
    try {
      // 测: webview 端能否拿到 vscode 全局 + ext host 序列化 fs 的内容
      console.log('[pdf-webview] typeof vscode:', typeof window['vscode'])
      console.log('[pdf-webview] typeof acquireVsCodeApi:', typeof window['acquireVsCodeApi'])
      console.log('[pdf-webview] VSIX_FS_JSON (ext host 序列化):', VSIX_FS_JSON)
      try {
        const parsed = JSON.parse(VSIX_FS_JSON)
        console.log('[pdf-webview] parsed fs keys:', parsed.keys)
      } catch (e) {
        console.log('[pdf-webview] VSIX_FS_JSON parse fail:', e?.message)
      }
      const pdfjs = await loadPdfJs();
      // 听 ext host postMessage
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'pdf-bytes') {
          const bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
          const blob = new Blob([bytes], { type: m.mimeType || 'application/pdf' });
          const url = URL.createObjectURL(blob);
          pdfjs.load({ url, cMapUrl: PDFJS_BASE + '/cmaps/', cMapPacked: true })
            .then(p => { pdf = p; document.getElementById('tot').textContent = String(p.numPages); setStatus(p.numPages + ' 页'); URL.revokeObjectURL(url); renderAll(); bind(); })
            .catch(e => { viewport.innerHTML = '<div class="err">加载失败: ' + (e?.message || e) + '</div>'; });
        } else if (m.type === 'pdf-error') {
          viewport.innerHTML = '<div class="err">读取失败: ' + (m.message || 'unknown') + '</div>';
        }
      });
      // 通知 ext host 准备好了
      if (window.parent && window.parent !== window) {
        try { window.parent.postMessage({ type: 'webview-ready' }, '*'); } catch (_) {}
      }
    } catch (e) {
      viewport.innerHTML = '<div class="err">加载 PDF.js 失败: ' + (e && e.message || e) + '</div>';
    }
  })();
})();
</script>
</body>
</html>`
}

export function deactivate() { }
