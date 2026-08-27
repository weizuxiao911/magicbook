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
  console.log('[pdf] activate (vsix)', context)

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      const uri = document.uri.toString()
      console.log('[pdf] resolve:', uri)
      webviewPanel.webview.options = { enableScripts: true, retainContextWhenHidden: true }

      // 1) registry baseUrl (pdfjs 静态资源)
      const registryBase =
        ((window as any).__APP_CONFIG__?.registryBaseUrl as string | undefined) ||
        ((window as any).__APP_REGISTRY_RUNTIME__?.baseUrl as string | undefined) ||
        'http://localhost:7790'

      // 2) PDF bytes: ext host 端 vscode.workspace.fs.readFile 拿 Uint8Array → base64 inline 到 webview html
      //    (反向 postMessage webview→ext host 在 opensumi srcdoc iframe 不通, window.parent 跨 sandbox 也不稳)
      const name = (document.uri?.fsPath || '').split(/[\\/]/).pop() || 'document.pdf'
      let pdfBase64 = ''
      let readErr: string | null = null
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri)
        console.log('[pdf]   readFile ok:', document.uri.toString(), 'bytes=', bytes.byteLength)
        // chunked btoa (整串 btoa 30MB 字符串爆, 分块每 ~32KB)
        let bin = ''
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
          // 不用 String.fromCharCode.apply (爆栈), 用循环 push charCodeAt
          let s = ''
          const end = Math.min(i + chunk, bytes.length)
          for (let j = i; j < end; j++) s += String.fromCharCode(bytes[j])
          bin += s
        }
        // 分块 btoa (每 ~30KB, 避免 btoa 内部 buffer 限制)
        let b64 = ''
        const b64Chunk = 0x8000
        for (let i = 0; i < bin.length; i += b64Chunk) {
          b64 += btoa(bin.substr(i, b64Chunk))
        }
        pdfBase64 = b64
        console.log('[pdf]   base64 ok, len=', pdfBase64.length)
      } catch (e: any) {
        console.error('[pdf]   readFile/base64 failed:', e?.message)
        readErr = e?.message || String(e)
      }

      // 3) webview html 模板 (pdfjs 走 registry 自包含, PDF bytes inline base64)
      const html = buildHtml(registryBase, name, pdfBase64, readErr)
      console.log('[pdf]   html 长度:', html.length, 'preview:', html.substring(0, 200))

      // 3) 多档重试 push (参照 paper 模式, 避 opensumi webview 监听窗口)
      const pushes: ReturnType<typeof setTimeout>[] = []
      const push = (b64: string = pdfBase64, err: string | null = readErr) => {
        pushes.forEach(clearTimeout)
        pushes.length = 0
        const html = buildHtml(registryBase, name, b64, err)
        ;[0, 200, 800, 2000, 5000].forEach((d) => pushes.push(setTimeout(() => {
          try { webviewPanel.webview.html = html } catch (e) { console.warn('[pdf]   push html fail @', d, e) }
        }, d)))
      }
      push()

      // 4) 文件变化重渲 (重新 readFile 拿最新 bytes → 重新 push html)
      const changeSub = vscode.workspace.onDidChangeTextDocument(async (e) => {
        if (e.document === document) {
          try {
            const bytes = await vscode.workspace.fs.readFile(document.uri)
            let bin = ''
            const chunk = 0x8000
            for (let i = 0; i < bytes.length; i += chunk) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any)
            }
            const b64 = btoa(bin)
            push(b64, null)
          } catch (e: any) {
            push('', e?.message || String(e))
          }
        }
      })
      const reqSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
          console.log('[pdf]   webview ready 消息, 重新 push')
          push()
        }
      })
      webviewPanel.onDidDispose(() => {
        pushes.forEach(clearTimeout)
        reqSub.dispose()
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

function buildHtml(registryBase: string, name: string, pdfBase64: string, readErr: string | null): string {
  // pdfjs 资源走 registry 自包含 (registry/vsix/numas.pdf-0.1.0/pdfjs/*), 不依赖 cdn
  // PDF bytes 通过 ext host inline base64 (反向 postMessage 在 opensumi srcdoc iframe 不通, window.parent 跨 sandbox 不稳)
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
  // ext host inline 的 PDF base64 (反向 postMessage 在 opensumi srcdoc iframe 不通)
  const PDF_B64 = ${JSON.stringify(pdfBase64)};
  const READ_ERR = ${JSON.stringify(readErr)};
  const FILE_NAME = ${JSON.stringify(name)};
  const PDFJS_BASE = ${JSON.stringify(pdfjsBase)};

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

  // base64 → Uint8Array (chunked, 避免 apply 栈溢出)
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  let pdf = null;
  let scale = 1.0;
  let current = 1;
  const viewport = document.getElementById('viewport');

  async function renderAll(){
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

  (async () => {
    try {
      if (READ_ERR) {
        viewport.innerHTML = '<div class="err">读取失败: ' + READ_ERR + '</div>';
        return;
      }
      if (!PDF_B64) {
        viewport.innerHTML = '<div class="err">PDF bytes 为空</div>';
        return;
      }
      const pdfjs = await loadPdfJs();
      setStatus('解析 PDF (' + (PDF_B64.length * 0.75 / 1024).toFixed(1) + ' KB)…');
      // base64 → bytes → Blob → blob URL, 喂 pdfjs.load (避免一次性大 Uint8Array 在 worker 序列化)
      const bytes = b64ToBytes(PDF_B64);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      pdf = await pdfjs.load({
        url: blobUrl,
        cMapUrl: PDFJS_BASE + '/cmaps/',
        cMapPacked: true,
      });
      URL.revokeObjectURL(blobUrl);
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
