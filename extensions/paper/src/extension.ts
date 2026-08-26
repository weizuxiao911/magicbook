import * as vscode from 'vscode'
import { resolvePaperFromContent } from './paperFileService'

export const PAPER_CUSTOM_EDITOR_VIEW_TYPE = 'paperEditor'

/**
 * 试卷阅读器扩展 (.paper → 直接 HTML webview, 不用 vite)
 *
 * 刷新恢复:
 *   - onStartupFinished 启动即激活 (provider 先注册, 恢复 tab 能 resolve)
 *   - resolve 读 .paper → 解析 → HTML 展示; document 空 → fs 兜底 + 延迟重试
 *   - self-heal: 激活后延迟检查打开中的 .paper tab (textDocuments + tabGroups),
 *     未 resolve 则 openWith 重开触发渲染
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('[paper] activate')

  const panels = new Map<string, vscode.WebviewPanel>()

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, webviewPanel, _token) {
      console.log('[paper] resolve:', document.uri.toString())
      panels.set(document.uri.toString(), webviewPanel)
      webviewPanel.webview.options = { enableScripts: true }

      // 读 .paper 内容: document 优先, 空则 fs 兜底
      const readContent = async (): Promise<string> => {
        const t = document.getText()
        if (t.trim()) return t
        try {
          const bytes = await vscode.workspace.fs.readFile(document.uri)
          const text = new TextDecoder('utf-8').decode(bytes)
          if (text.trim()) return text
        } catch (e) {
          console.warn('[paper] fs read fallback 失败:', e)
        }
        return ''
      }

      // 渲染 HTML (每次读内容 → 解析 → 重设 webview.html)
      let timers: ReturnType<typeof setTimeout>[] = []
      const push = (html: string) => {
        timers.forEach((t) => clearTimeout(t))
        timers = []
        // 多档延迟重发, 覆盖 opensumi webview listening 空窗期 (参照 html-preview)
        ;[0, 300, 1000, 2500, 5000].forEach((delay) => {
          timers.push(setTimeout(() => { try { webviewPanel.webview.html = html } catch { /* ignore */ } }, delay))
        })
      }
      const render = async () => {
        const text = await readContent()
        if (text.trim()) push(buildHtml(resolvePaperFromContent(document.uri.fsPath, text)))
      }

      // 恢复/懒加载: document 可能未加载完 → 延迟重试
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      const ensureRendered = (attempt: number) => {
        void readContent().then((text) => {
          if (text.trim()) {
            push(buildHtml(resolvePaperFromContent(document.uri.fsPath, text)))
            return
          }
          if (attempt < 60) retryTimer = setTimeout(() => ensureRendered(attempt + 1), 500)
        })
      }
      ensureRendered(0)

      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) void render()
      })
      webviewPanel.onDidDispose(() => {
        if (retryTimer) clearTimeout(retryTimer)
        timers.forEach((t) => clearTimeout(t))
        panels.delete(document.uri.toString())
        changeSub.dispose()
      })
    },
  }

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PAPER_CUSTOM_EDITOR_VIEW_TYPE, provider, {
      webviewOptions: { enableScripts: true },
    }),
  )

  // self-heal: 刷新后恢复的 .paper tab 未 resolve → openWith 重开
  let selfHealTimer: ReturnType<typeof setTimeout> | undefined
  const selfHealCheck = (attempt: number) => {
    const uris = new Set<string>()
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.path.toLowerCase().endsWith('.paper')) uris.add(d.uri.toString())
    }
    try {
      for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
          const uri = (t.input as any)?.uri
          if (uri && String(uri.path || '').toLowerCase().endsWith('.paper')) uris.add(uri.toString())
        }
      }
    } catch { /* not supported */ }
    const pending = Array.from(uris).filter((u) => !panels.has(u))
    console.log(`[paper] self-heal attempt=${attempt} uris=${uris.size} pending=${pending.length}`)
    if (pending.length) {
      void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(pending[0]), PAPER_CUSTOM_EDITOR_VIEW_TYPE)
      return
    }
    if (attempt < 10) selfHealTimer = setTimeout(() => selfHealCheck(attempt + 1), 3000)
  }
  selfHealTimer = setTimeout(() => selfHealCheck(0), 5000)
  context.subscriptions.push({ dispose: () => selfHealTimer && clearTimeout(selfHealTimer) })
}

// ---- 解析 → HTML ----

function buildHtml(state: any): string {
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

  if (state.status === 'empty') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:system-ui,sans-serif;background:#fff;color:#666;padding:60px 20px;text-align:center}</style></head><body>${esc(state.description || '空')}</body></html>`
  }
  if (state.status === 'error') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:system-ui,sans-serif;background:#fff;color:#d93026;padding:60px 20px;text-align:center}</style></head><body>${esc(state.description || '错误')}</body></html>`
  }

  const qs: any[] = state.paper?.questions || []
  const optText = (o: unknown) => (typeof o === 'string' ? o : JSON.stringify(o))
  const ansOf = (a: unknown) => (Array.isArray(a) ? a.map(String) : a == null ? [] : [String(a)])

  const cards = qs.map((q: any, i: number) => {
    const ans = ansOf(q.answer)
    const opts = Array.isArray(q.options) && q.options.length
      ? q.options.map((o: unknown) => `<div class="opt${ans.includes(String(o)) ? ' ans' : ''}">${esc(optText(o))}</div>`).join('')
      : ''
    const topic = q.topic != null ? q.topic : q.text
    return `<div class="q"><div class="q-h"><span class="no">${i + 1}</span>${q.score != null ? `<span class="score">${q.score} 分</span>` : ''}</div>
      <div class="topic">${esc(topic)}</div>${opts}
      ${ans.length ? `<div class="ans">答案: ${esc(ans.join(', '))}</div>` : ''}</div>`
  }).join('')

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<style>
  *{box-sizing:border-box} body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:16px;background:#fff;color:#222}
  .head{display:flex;align-items:baseline;gap:12px;border-bottom:2px solid #1677ff;padding-bottom:8px;margin-bottom:16px}
  .title{font-size:20px;font-weight:700} .meta{color:#666;font-size:13px}
  .q{border:1px solid #e5e5e5;border-radius:8px;padding:12px 14px;margin-bottom:12px}
  .q-h{display:flex;justify-content:space-between;margin-bottom:6px} .no{color:#1677ff;font-weight:600} .score{color:#999;font-size:13px}
  .topic{margin-bottom:8px;line-height:1.6} .opt{margin:4px 0;font-size:14px} .opt.ans{color:#389e0d;font-weight:600}
  .ans{margin-top:6px;font-size:13px;color:#389e0d}
</style></head>
<body><div class="head"><span class="title">${esc(state.paper?.title || '试卷')}</span>
  <span class="meta">总分 ${state.paper?.totalScore ?? 0} · 共 ${state.paper?.questionCount ?? 0} 题</span></div>
${cards}</body></html>`
}
