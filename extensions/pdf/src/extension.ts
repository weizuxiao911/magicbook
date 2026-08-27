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
  console.log('[pdf] activate (vsix)')

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      const uri = document.uri.toString()
      console.log('[pdf] resolve:', uri)
      webviewPanel.webview.options = { enableScripts: true, retainContextWhenHidden: true }

      // 1) 拿 opencode baseUrl (同 chat agent runtime)
      const base = (window as any).__APP_OPENCODE_RUNTIME__?.baseUrl || ''
      const headers: Record<string, string> = {}
      try {
        const appCwd = localStorage.getItem('APP_CWD') || ''
        if (appCwd) headers['x-opencode-directory'] = appCwd
      } catch { /* noop */ }

      // 2) webview html 模板 (无 base64, 走 postMessage + webview fetch)
      const fsPath = document.uri.fsPath
      const name = fsPath.split(/[\\/]/).pop() || 'document.pdf'
      const html = buildHtml(base, fsPath, name, headers)
      console.log('[pdf]   html 长度:', html.length, 'preview:', html.substring(0, 200))

      // 3) 多档重试 push (参照 paper 模式, 避 opensumi webview 监听窗口)
      const pushes: ReturnType<typeof setTimeout>[] = []
      const push = () => {
        pushes.forEach(clearTimeout)
        pushes.length = 0
        ;[0, 200, 800, 2000, 5000].forEach((d) => pushes.push(setTimeout(() => {
          try { webviewPanel.webview.html = html } catch (e) { console.warn('[pdf]   push html fail @', d, e) }
        }, d)))
      }
      push()

      // 4) 监听 webview 端的 ready 消息, 重新 push (防御性)
      const readySub = webviewPanel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
          console.log('[pdf]   webview ready 消息, 重新 push')
          push()
        }
      })

      // 5) 文件变化重渲
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) push()
      })
      webviewPanel.onDidDispose(() => {
        pushes.forEach(clearTimeout)
        readySub.dispose()
        changeSub.dispose()
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

function buildHtml(base: string, fsPath: string, name: string, headers: Record<string, string>): string {
  // 序列化 headers 给 webview 端 fetch 用
  const hdrsJson = JSON.stringify(headers)
  const fetchUrl = `${base}/api/fs/read?path=${encodeURIComponent(fsPath)}`
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
  const PDF_FETCH_URL = ${JSON.stringify(fetchUrl)};
  const PDF_HEADERS = ${hdrsJson};
  const FILE_NAME = ${JSON.stringify(name)};

  function bytesToArr(b){return new Uint8Array(b);}
  function arrToBytes(u){return u.buffer;}
  function setStatus(s){document.getElementById('info').textContent=s;}

  async function loadPdfJs(){
    if (window.pdfjsLib) return window.pdfjsLib;
    const cdn = ['https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.min.mjs',
                 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs'];
    for (const u of cdn) { try { await loadScript(u); break; } catch(_){} }
    if (!window.pdfjsLib) throw new Error('PDF.js CDN 都不可达');
    const wkCdn = ['https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
                  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'];
    for (const u of wkCdn) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const txt = await r.text();
        const blob = new Blob([txt], { type: 'text/javascript' });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
        break;
      } catch(_){}
    }
    return window.pdfjsLib;
  }
  function loadScript(src){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error(src));
      document.head.appendChild(s);
    });
  }

  let pdf = null;
  let scale = 1.0;
  let current = 1;
  const viewport = document.getElementById('viewport');

  async function fetchPdfBytes(){
    setStatus('请求 ' + FILE_NAME + '…');
    const r = await fetch(PDF_FETCH_URL, { headers: PDF_HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    return bytesToArr(buf);
  }

  async function renderAll(){
    if (!pdf) return;
    viewport.innerHTML = '';
    const total = pdf.numPages;
    for (let n = 1; n <= total; n++) {
      const page = await pdf.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      const fitScale = (viewport.clientWidth - 24) / v1.width;
      const vp = page.getViewport({ scale: fitScale });
      const dpr = window.devicePixelRatio || 1;
      const rvp = page.getViewport({ scale: fitScale * dpr });
      const canvas = document.createElement('canvas');
      canvas.className = 'page';
      canvas.width = rvp.width; canvas.height = rvp.height;
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      viewport.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: rvp }).promise;
      document.getElementById('cur').textContent = String(n);
    }
  }

  function bind(){
    document.getElementById('prev').onclick = () => goto(Math.max(1, current - 1));
    document.getElementById('next').onclick = () => goto(Math.min(pdf.numPages, current + 1));
    document.getElementById('zoom-in').onclick = () => { scale = Math.min(4, scale * 1.25); refresh(); };
    document.getElementById('zoom-out').onclick = () => { scale = Math.max(0.25, scale / 1.25); refresh(); };
    document.getElementById('fit').onclick = () => { scale = 1.0; renderAll(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'PageDown' || e.key === ' ') { goto(Math.min(pdf.numPages, current + 1)); e.preventDefault(); }
      else if (e.key === 'PageUp') { goto(Math.max(1, current - 1)); e.preventDefault(); }
      else if (e.key === 'Home') goto(1);
      else if (e.key === 'End') goto(pdf.numPages);
    });
  }

  function goto(n){
    if (n === current) return;
    current = n;
    document.getElementById('cur').textContent = String(n);
    const c = viewport.querySelectorAll('canvas.page')[n - 1];
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function refresh(){
    document.getElementById('zoom').textContent = Math.round(scale * 100) + '%';
    renderAll();
  }
  // 告诉 host 准备好了 (触发 host 端重新 push, 防 listening 窗口)
  if (window.parent !== window) try { window.parent.postMessage({ type: 'webview-ready' }, '*'); } catch(_){}

  (async () => {
    try {
      const pdfjs = await loadPdfJs();
      const bytes = await fetchPdfBytes();
      setStatus('解析 PDF (' + (bytes.length / 1024).toFixed(1) + ' KB)…');
      pdf = await pdfjs.getDocument({ data: bytes }).promise;
      document.getElementById('tot').textContent = String(pdf.numPages);
      setStatus(pdf.numPages + ' 页');
      await renderAll();
      bind();
    } catch (e) {
      viewport.innerHTML = '<div class="err">加载失败: ' + (e && e.message || e) + '</div>';
    }
  })();
})();
</script>
</body>
</html>`
}

export function deactivate() { }
