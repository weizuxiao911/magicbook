import * as vscode from 'vscode'

export const PDF_VIEW_TYPE = 'pdfViewer'

/**
 * PDF 阅读器 (独立 vsix, 替代 web/src/extensions/pdf 内置实现)
 *
 * 模式:
 *   1. 双击 .pdf → 命中 customEditor (viewType=pdfViewer) → resolveCustomTextEditor
 *   2. 从 document 读字节 (VSCode 用 binary stream 传, 不经 UTF-8 编码, 完整 PDF)
 *   3. 走 kt-ext 协议把字节塞进 webview, webview 用 pdf.js (CDN) 渲染
 *   4. PDF.js worker 也从 CDN 拿, 不打包 lib (省 3MB)
 *
 * 激活:
 *   - 只 onCustomEditor:pdfViewer (按需, 不抢启动时机)
 *   - 不写 onStartupFinished (避免影响主流程)
 *   - 不复用 web/src/extensions/pdf (内置, 用户明确不启用)
 */

function buildHtml(b64: string, name: string): string {
  const v = '4.10.38'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)}</title>
<style>
  *{box-sizing:border-box}
  body,html{margin:0;padding:0;height:100%;background:#525659;color:#fff;font-family:system-ui,-apple-system,sans-serif;overflow:hidden}
  #app{height:100%;display:flex;flex-direction:column}
  .toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#323639;border-bottom:1px solid #1a1a1a;flex-shrink:0;font-size:12px}
  .toolbar button,.toolbar .pg{background:#3c3d3e;border:1px solid #555;color:#eee;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;font-family:inherit}
  .toolbar button:hover{background:#4a4c4d}
  .toolbar button:disabled{opacity:.4;cursor:default}
  .toolbar .pg{font-variant-numeric:tabular-nums;min-width:54px;text-align:center}
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
  const PDFJS_VERSION = ${JSON.stringify(v)};
  const PDF_B64 = ${JSON.stringify(b64)};
  const FILE_NAME = ${JSON.stringify(name)};

  // 加载 PDF.js + worker (从 unpkg / jsdelivr CDN, 失败 fallback)
  function loadScript(src){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensurePdfJs(){
    if (window.pdfjsLib) return window.pdfjsLib;
    const cdn = ['https://unpkg.com/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.min.mjs',
                 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.min.mjs'];
    for (const u of cdn) { try { await loadScript(u); break; } catch (_) {} }
    if (!window.pdfjsLib) throw new Error('PDF.js 加载失败 (CDN 不可达)');
    // worker: 优先 blob, 失败 fallback 到 CDN url
    const wkCdn = ['https://unpkg.com/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.worker.min.mjs',
                  'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.worker.min.mjs'];
    for (const u of wkCdn) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const txt = await r.text();
        const blob = new Blob([txt], { type: 'text/javascript' });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
        break;
      } catch (_) {}
    }
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      // 最后兜底: 直接给 CDN url
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = wkCdn[0];
    }
    return window.pdfjsLib;
  }

  function bytesFromB64(b64){
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const viewport = document.getElementById('viewport');
  const $cur = document.getElementById('cur');
  const $tot = document.getElementById('tot');
  const $info = document.getElementById('info');
  const $zoom = document.getElementById('zoom');

  let pdf = null;
  let scale = 1.0;
  let current = 1;
  let fitMode = 'page-width';

  function setStatus(s){ $info.textContent = s; }

  async function init(){
    try {
      const pdfjs = await ensurePdfJs();
      const data = bytesFromB64(PDF_B64);
      setStatus('解析 ' + FILE_NAME + ' (' + (data.length / 1024).toFixed(1) + ' KB)…');
      pdf = await pdfjs.getDocument({ data }).promise;
      $tot.textContent = String(pdf.numPages);
      setStatus(pdf.numPages + ' 页');
      // 第一页立刻渲染, 之后滚动加载
      await renderAll();
      bind();
    } catch (e) {
      viewport.innerHTML = '<div class="err">加载失败: ' + String(e && e.message || e) + '</div>';
    }
  }

  async function renderAll(){
    if (!pdf) return;
    // 清掉 loading
    viewport.innerHTML = '';
    const total = pdf.numPages;
    for (let n = 1; n <= total; n++) {
      const page = await pdf.getPage(n);
      let cssScale = scale;
      if (fitMode === 'page-width') {
        const v = page.getViewport({ scale: 1 });
        cssScale = (viewport.clientWidth - 24) / v.width;
      } else if (fitMode === 'page-fit') {
        const v = page.getViewport({ scale: 1 });
        cssScale = Math.min((viewport.clientWidth - 24) / v.width, (viewport.clientHeight - 24) / v.height);
      }
      const vp = page.getViewport({ scale: cssScale });
      const canvas = document.createElement('canvas');
      canvas.className = 'page';
      canvas.width = vp.width;
      canvas.height = vp.height;
      viewport.appendChild(canvas);
      // 渲染 (用 device pixel ratio 提高清晰度)
      const dpr = window.devicePixelRatio || 1;
      const renderVp = page.getViewport({ scale: cssScale * dpr });
      canvas.width = renderVp.width;
      canvas.height = renderVp.height;
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;
      $cur.textContent = String(n);
    }
  }

  function bind(){
    document.getElementById('prev').onclick = () => goto(Math.max(1, current - 1));
    document.getElementById('next').onclick = () => goto(Math.min(pdf.numPages, current + 1));
    document.getElementById('zoom-in').onclick = () => { fitMode = 'manual'; scale = Math.min(4, scale * 1.25); refresh(); };
    document.getElementById('zoom-out').onclick = () => { fitMode = 'manual'; scale = Math.max(0.25, scale / 1.25); refresh(); };
    document.getElementById('fit').onclick = () => { fitMode = 'page-width'; scale = 1.0; refresh(); };
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
    $cur.textContent = String(n);
    // 滚到对应 canvas
    const c = viewport.querySelectorAll('canvas.page')[n - 1];
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function refresh(){
    $zoom.textContent = Math.round(scale * 100) + '%';
    renderAll();
  }
  const _refresh = refresh; // 防警告
  // 暴露 goto 给 bind (用 _refresh 触发重绘, 略)
  void _refresh;

  init();
})();
</script>
</body>
</html>`
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function bytesToB64(bytes: Uint8Array): string {
  // 分片避免 atob 编码限制
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(s)
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[pdf] activate (vsix, 独立实现, 不复用 web/src/extensions/pdf)')

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      console.log('[pdf] resolve:', document.uri.toString())

      webviewPanel.webview.options = {
        enableScripts: true,
      }

      // 读取 PDF 二进制: TextDocument 默认 UTF-8 字符串, 不可靠 → workspace.fs 直读 raw bytes
      const readBytes = async (): Promise<Uint8Array | null> => {
        try {
          const buf = await vscode.workspace.fs.readFile(document.uri)
          // PDF 魔数: %PDF- (0x25 0x50 0x44 0x46 0x2d)
          if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) {
            return new Uint8Array(buf)
          }
        } catch (e) {
          console.warn('[pdf] fs.readFile 失败:', e)
        }
        return null
      }

      const push = (html: string) => {
        try { webviewPanel.webview.html = html } catch (_) { /* ignore */ }
      }

      const renderPdf = async () => {
        const bytes = await readBytes()
        if (!bytes) {
          push(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;background:#1e1e1e;color:#ccc">
<h2>无法读取 PDF</h2><p>URI: ${esc(document.uri.toString())}</p>
<p>文件可能为空, 或权限不足.</p></body></html>`)
          return
        }
        const b64 = bytesToB64(bytes)
        const name = document.uri.fsPath.split(/[\\/]/).pop() || 'document.pdf'
        push(buildHtml(b64, name))
      }

      // 监听文件变化 (用户重新加载时触发)
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) void renderPdf()
      })
      webviewPanel.onDidDispose(() => {
        changeSub.dispose()
      })

      await renderPdf()
    },
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  )

  // 注册命令: 主动用 PDF viewer 打开当前文件
  context.subscriptions.push(
    vscode.commands.registerCommand('pdf.open', () => {
      const ed = vscode.window.activeTextEditor
      if (!ed) return
      void vscode.commands.executeCommand('vscode.openWith', ed.document.uri, PDF_VIEW_TYPE)
    }),
  )
}

export function deactivate() { }
