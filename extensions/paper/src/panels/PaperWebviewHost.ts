import * as vscode from 'vscode'
import manifestJson from '../../webview/dist/.vite/manifest.json'
import { saveQuestion } from '../services/bankService'
import { savePaper } from '../services/paperService'
import { getPluginConfig, updateScopeLabCode } from '../services/config'
import { requestJson } from '../services/http'
import type { PaperViewState, RpcRequestMessage, RpcResponseMessage } from '../state/types'
import { normalizeQuestionForSave } from '../utils/transform'

type Manifest = Record<string, { file: string; css?: string[]; imports?: string[] }>
const manifest = manifestJson as unknown as Manifest
const decoder = new TextDecoder('utf-8')

interface PaperWebviewHostOptions {
  panel: vscode.WebviewPanel
  extensionUri: vscode.Uri
  context: vscode.ExtensionContext
  paperState: PaperViewState
  onDispose?: () => void
}

/**
 * 统一承载试卷 Webview 的注入、消息通信和数据刷新逻辑。
 * 命令面板与自定义编辑器都复用这里，避免出现两套页面实现。
 */
export class PaperWebviewHost {
  private readonly panel: vscode.WebviewPanel
  private readonly extensionUri: vscode.Uri
  private readonly context: vscode.ExtensionContext
  private paperState: PaperViewState
  private readonly onDispose?: () => void
  private readonly disposables: vscode.Disposable[] = []
  private disposed = false

  constructor(options: PaperWebviewHostOptions) {
    this.panel = options.panel
    this.extensionUri = options.extensionUri
    this.context = options.context
    this.paperState = options.paperState
    this.onDispose = options.onDispose

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message as RpcRequestMessage), null, this.disposables)
    void this.initializeWebview()
    this.panel.title = getPaperStateTitle(this.paperState)
  }

  private async initializeWebview() {
    try {
      const webview = this.panel.webview
      const distUri = vscode.Uri.joinPath(this.extensionUri, 'webview', 'dist')
      const entry = manifest['index.html']
      if (!entry) {
        throw new Error('webview manifest 缺少 index.html 入口')
      }
      const cssFiles = collectAllCssFromManifest(manifest, 'index.html')
      const cssContent = await readCssFiles(distUri, cssFiles)
      const scriptUri = webview.asWebviewUri(joinUriPath(distUri, entry.file)).toString()
      this.panel.webview.html = this.buildHtml(webview, scriptUri, cssContent)
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 webview 资源失败'
      this.panel.webview.html = `<!DOCTYPE html><html><body><pre style="color:red;padding:16px;font-family:monospace">${escapeHtml(message)}</pre></body></html>`
    }
  }

  public async updatePaperState(paperState: PaperViewState) {
    this.paperState = paperState
    this.panel.title = getPaperStateTitle(paperState)
    await this.panel.webview.postMessage({
      type: 'paper:update',
      data: this.paperState
    })
  }

  public dispose() {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.onDispose?.()

    while (this.disposables.length) {
      const item = this.disposables.pop()
      item?.dispose()
    }
  }

  private async handleMessage(message: RpcRequestMessage) {
    if (message.type !== 'rpc-request') {
      return
    }

    try {
      const config = getPluginConfig()

      switch (message.action) {
        case 'search-labs': {
          const { keywords } = message.payload as { keywords?: string }
          const url = `${config.api.communityBaseUrl}/lab/recent/query`
          const result = await requestJson<{ rows: Array<{ code: string; name: string }>; hasNext: boolean }>(url, {
            method: 'POST',
            body: {
              current: 1,
              size: 30,
              types: ['PERSONAL','EDUCATION'],
              ...(keywords ? { keywords } : {})
            }
          })
          await this.respond(message.requestId, true, result)
          return
        }
        case 'update-lab-code': {
          const { labCode } = message.payload as { labCode: string }
          updateScopeLabCode(labCode)
          await this.context.globalState.update('scope.labCode', labCode)
          await this.respond(message.requestId, true, { ok: true })
          return
        }
        case 'join-question-bank': {
          await saveQuestion({
            questions: ((message.payload as { questions: unknown[] }).questions ?? []).map((item) =>
              normalizeQuestionForSave(item, config.scope.labCode)
            )
          })
          await this.respond(message.requestId, true, { ok: true })
          return
        }
        case 'save-paper': {
          await savePaper({
            name: (message.payload as { name: string }).name,
            questions: ((message.payload as { questions: unknown[] }).questions ?? []).map((item) =>
              normalizeQuestionForSave(item, config.scope.labCode)
            )
          })
          await this.respond(message.requestId, true, { ok: true })
          return
        }
        case 'open-community-page': {
          const target = (message.payload as { page?: string } | undefined)?.page
          if (!config.api.communityPageBaseUrl || !config.scope.labCode) {
            throw new Error('请配置 communityPageBaseUrl 与 scope.labCode（来自 globalState 或 settings.json）')
          }
          const origin = safeOrigin(config.api.communityPageBaseUrl)
          const url = buildCommunityPageUrl(origin, config.scope.labCode, config.scope.courseCode, target === 'paper' ? 'paper' : 'questionbank')
          // 用 vscode.env.openExternal 走系统默认浏览器, 不要用 vscode.open — CodeBlitz 容器里
          // vscode.open 会把外部 URL 当编辑器 tab 打开, 报 INVALID tab.
          await vscode.env.openExternal(vscode.Uri.parse(url))
          await this.respond(message.requestId, true, { ok: true })
          return
        }
        case 'close-panel':
          this.panel.dispose()
          this.respond(message.requestId, true, { ok: true })
          return
        default:
          await this.respond(message.requestId, false, undefined, '不支持的操作')
          return
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '操作失败'
      await this.respond(message.requestId, false, undefined, errorMessage)
    }
  }

  private async respond(requestId: string, success: boolean, data?: unknown, error?: string) {
    const message: RpcResponseMessage = {
      type: 'rpc-response',
      requestId,
      success,
      data,
      error
    }
    try {
      await this.panel.webview.postMessage(message)
    } catch {
      // Webview 可能已销毁，忽略发送失败
    }
  }

  private buildHtml(webview: vscode.Webview, scriptUri: string, cssContent: string): string {
    const nonce = getNonce()
    const config = getPluginConfig()
    const initialState = JSON.stringify(this.paperState).replace(/</g, '\\u003c')
    const runtimeConfig = JSON.stringify({
      codeTestUrl: config.api.codeTestUrl,
      codePlayerUrl: config.api.codePlayerUrl,
      labCode: config.scope.labCode,
      communityBaseUrl: config.api.communityBaseUrl
    }).replace(/</g, '\\u003c')
    const frameSrc = buildCspSourceList([
      safeOrigin(config.api.codeTestUrl),
      safeOrigin(config.api.codePlayerUrl)
    ])

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} data: https:; frame-src ${frameSrc};"
    />
    <meta http-equiv="Permissions-Policy" content="clipboard-read=(self), clipboard-write=(self)" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${cssContent}</style>
    <title>题目</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__PAPER_INITIAL_STATE__ = ${initialState};window.__WEBVIEW_RUNTIME_CONFIG__ = ${runtimeConfig};</script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }
}

async function readCssFiles(distUri: vscode.Uri, cssFiles: string[]): Promise<string> {
  const parts = await Promise.all(
    cssFiles.map(async (file) => {
      const uri = joinUriPath(distUri, file)
      const data = await vscode.workspace.fs.readFile(uri)
      return decoder.decode(data)
    })
  )
  return parts.join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getPaperStateTitle(paperState: PaperViewState) {
  return paperState.title
}

function joinUriPath(base: vscode.Uri, ...segments: string[]): vscode.Uri {
  return vscode.Uri.joinPath(base, ...segments)
}

function collectAllCssFromManifest(
  manifest: Manifest,
  entryName: string
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

function buildCommunityPageUrl(origin: string, labCode: string, courseCode: string | undefined, page: 'questionbank' | 'paper') {
  const route =
    page === 'questionbank'
      ? (courseCode ? `/courseadmin/assess/questionbank?labCode=${encodeURIComponent(labCode)}&courseCode=${encodeURIComponent(courseCode)}` : `/admin/examlab/questionbank?labCode=${encodeURIComponent(labCode)}`)
      : (courseCode ? `/courseadmin/assess/paper?labCode=${encodeURIComponent(labCode)}&courseCode=${encodeURIComponent(courseCode)}` : `/admin/examlab/exampaper?labCode=${encodeURIComponent(labCode)}`)
  return `${origin}${route}`
}

function buildCspSourceList(values: string[]) {
  const filtered = values.filter((item) => !!item)
  return filtered.length > 0 ? filtered.join(' ') : `'none'`
}