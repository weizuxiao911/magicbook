import * as vscode from 'vscode'

// 浏览器兼容: esbuild --define 注入 manifest, 不读文件
declare const __PDF_MANIFEST__: string

interface PdfWebviewHostOptions {
  panel: vscode.WebviewPanel
  extensionUri: vscode.Uri
}

/**
 * PDF Webview 承载:
 *  - extension host 只注入「读文件方式」到 webview: baseUrl + cwd + 文件相对路径
 *  - webview 里直接 fetch(opencode /api/fs/read + arrayBuffer) 拿干净二进制,
 *    不经过 codeblitz workspace.fs (它对二进制 PDF 做 UTF-8 解码会破坏)
 *  - 转 base64 dataUrl 给 pdf.js
 */
export class PdfWebviewHost {
  private readonly panel: vscode.WebviewPanel
  private readonly extensionUri: vscode.Uri
  private readonly disposables: vscode.Disposable[] = []
  private currentDocUri: string | null = null

  constructor(options: PdfWebviewHostOptions) {
    this.panel = options.panel
    this.extensionUri = options.extensionUri

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview)
  }

  /** 注入当前文档信息到 webview (baseUrl/cwd/相对路径), webview 自己 fetch */
  public async loadDocument(document: vscode.TextDocument): Promise<void> {
    try {
      this.currentDocUri = document.uri.toString()
      this.panel.title = basename(document.uri.fsPath)
      // 从全局 runtime 读 opencode baseUrl (由 client service/agent 挂 window.__APP_CONFIG__,
      // 但扩展 worker 无 window; 这里从注入的 script 拿, 见 getHtmlForWebview)
      await this.panel.webview.postMessage({
        type: 'pdf:load',
        filePath: document.uri.fsPath,
        uriPath: document.uri.path,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.panel.webview.postMessage({ type: 'pdf:error', message: msg })
    }
  }

  /** 文档变化, 重新加载 */
  public async reload(): Promise<void> {
    if (!this.currentDocUri) return
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.currentDocUri)
    if (doc) await this.loadDocument(doc)
  }

  public dispose() {
    while (this.disposables.length) {
      const item = this.disposables.pop()
      item?.dispose()
    }
  }

  private getHtmlForWebview(webview: vscode.Webview) {
    const manifest = JSON.parse(__PDF_MANIFEST__) as Record<string, { file: string; css?: string[]; imports?: string[] }>
    const entry = manifest['index.html']
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.parse(`${this.extensionUri.toString().replace(/\/$/, '')}/webview/dist/${entry.file}`),
    )
    const cssFiles = collectAllCssFromManifest(manifest, 'index.html')
    const styleUris = cssFiles.map((file) =>
      webview.asWebviewUri(
        vscode.Uri.parse(`${this.extensionUri.toString().replace(/\/$/, '')}/webview/dist/${file}`),
      ).toString(),
    )
    const nonce = getNonce()
    const resourceOrigins = buildCspSourceList([
      safeOrigin(this.extensionUri.toString()),
      ...styleUris.map((u) => safeOrigin(u)),
      ...(scriptUri ? [safeOrigin(scriptUri.toString())] : []),
    ])

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} ${resourceOrigins} https: data: blob:; style-src ${webview.cspSource} ${resourceOrigins} 'unsafe-inline'; script-src ${webview.cspSource} ${resourceOrigins} 'nonce-${nonce}' 'unsafe-eval'; font-src ${webview.cspSource} ${resourceOrigins} data:; worker-src ${webview.cspSource} ${resourceOrigins} blob: data:; connect-src ${webview.cspSource} ${resourceOrigins} blob: data: http://127.0.0.1:24096 http://localhost:24096 https:; frame-src ${webview.cspSource} ${resourceOrigins};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${styleUris.map((uri) => `<link rel="stylesheet" href="${uri}" />`).join('\n')}
    <title>PDF</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function getNonce() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

function safeOrigin(baseUrl: string) {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

function buildCspSourceList(values: string[]) {
  const filtered = values.filter((item) => !!item)
  return filtered.length > 0 ? filtered.join(' ') : `'none'`
}

function collectAllCssFromManifest(
  manifest: Record<string, { file: string; css?: string[]; imports?: string[] }>,
  entryName: string,
): string[] {
  const collected = new Set<string>()
  const visited = new Set<string>()
  const walk = (name: string) => {
    if (visited.has(name)) return
    visited.add(name)
    const chunk = manifest[name]
    if (!chunk) return
    for (const css of chunk.css ?? []) {
      collected.add(css)
    }
    for (const imp of chunk.imports ?? []) {
      walk(imp)
    }
  }
  walk(entryName)
  return Array.from(collected)
}
