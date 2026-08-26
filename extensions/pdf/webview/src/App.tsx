import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

// pdf.js worker: 用 vite ?raw 把 worker 源码打成字符串, webview 里转 blob URL.
// 不走网络请求 (无 404), 兼容 CSP blob: 白名单.
import pdfWorkerRaw from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

let workerConfigured = false
function ensureWorker() {
  if (workerConfigured) return
  const blob = new Blob([pdfWorkerRaw], { type: 'text/javascript' })
  ;(pdfjsLib as any).GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
  workerConfigured = true
}

/** 递归找 window.__APP_CONFIG__ (webview iframe 层级: pdf → active-frame → container → main) */
function findAppConfig(): any {
  // 先试 top (main window, 有 __APP_CONFIG__)
  try {
    const t: any = window.top as any
    if (t?.__APP_CONFIG__?.appBaseUrl) return t.__APP_CONFIG__
  } catch { /* ignore */ }
  // 再递归 parent
  let w: any = window
  const seen = new Set<Window>()
  while (w && !seen.has(w)) {
    seen.add(w)
    if (w.__APP_CONFIG__?.appBaseUrl) return w.__APP_CONFIG__
    try { w = w.parent } catch { break }
  }
  return null
}

function getBaseUrl(): string {
  return findAppConfig()?.appBaseUrl || ''
}

function getCwd(): string {
  // localStorage 走 main window (隔离 iframe 的 localStorage 不同源)
  try {
    const t: any = window.top as any
    const v = t?.localStorage?.getItem?.('APP_CWD')
    if (v) return v
  } catch { /* ignore */ }
  const cfg = findAppConfig()
  return cfg?.cwd || ''
}

/** 从 opencode 拉 PDF 二进制 (arrayBuffer, 无损), 转 base64 dataUrl */
async function fetchPdfDataUrl(uriPath: string): Promise<string> {
  const base = getBaseUrl()
  const cwd = getCwd()
  const name = decodeURIComponent(uriPath.split('/').pop() || '')
  if (!base || !name) throw new Error('pdf: 缺少 baseUrl 或文件名')
  const r = await fetch(`${base}/api/fs/read/${encodeURIComponent(name)}`, {
    headers: cwd ? { 'x-opencode-directory': encodeURIComponent(cwd) } : {},
  })
  if (!r.ok) throw new Error(`pdf: HTTP ${r.status}`)
  const buf = await r.arrayBuffer() // 二进制, 无损
  const bytes = new Uint8Array(buf)
  // base64
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:application/pdf;base64,${btoa(bin)}`
}

interface Props {
  dataUrl: string | null
}

/**
 * PDF 流式分页加载:
 *   - 加载 PDF 后, 为所有页建占位 div (高度 = 页高 × scale), 滚动条完整
 *   - IntersectionObserver 监听占位: 进入视口 → 渲染该页 canvas (懒加载)
 *   - 已渲染页缓存, 不重复渲染
 *   - 滚动/页码跳转 scrollIntoView
 */
export function App({ dataUrl }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.2)
  const [error, setError] = useState<string | null>(null)

  // PDF 实例 + 已渲染页缓存 (ref 保持跨 render)
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const renderedRef = useRef<Set<number>>(new Set())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const scaleRef = useRef(scale)

  // 渲染单页 (懒加载)
  const renderPage = useCallback(async (pageNum: number) => {
    const pdf = pdfRef.current
    const container = containerRef.current
    if (!pdf || !container || renderedRef.current.has(pageNum)) return

    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: scaleRef.current })

    // 找对应占位 div
    const placeholder = container.querySelector<HTMLDivElement>(`.pdf-placeholder[data-page="${pageNum}"]`)
    if (!placeholder) return

    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-page'
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    canvas.style.display = 'block'

    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport } as any).promise
    placeholder.innerHTML = ''
    placeholder.appendChild(canvas)
    renderedRef.current.add(pageNum)
  }, [])

  // 首次渲染: 建占位 div + 观察器
  const initPdf = useCallback(async (url: string) => {
    setError(null)
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''

    ensureWorker() // 先配置 workerSrc (data URL, 无网络请求)
    const loadingTask = pdfjsLib.getDocument({ url })
    const pdf = await loadingTask.promise
    pdfRef.current = pdf
    setPageCount(pdf.numPages)
    setCurrentPage(1)
    renderedRef.current.clear()

    // 为所有页建占位 div (高度按 scale 预估), 滚动条完整
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const viewport = page.getViewport({ scale: scaleRef.current })
      const placeholder = document.createElement('div')
      placeholder.className = 'pdf-placeholder'
      placeholder.dataset.page = String(p)
      placeholder.style.height = `${viewport.height}px`
      placeholder.style.margin = '8px auto'
      placeholder.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)'
      placeholder.style.background = '#fff'
      container.appendChild(placeholder)
    }

    // IntersectionObserver: 占位进入视口 → 渲染该页
    observerRef.current?.disconnect()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = parseInt((entry.target as HTMLElement).dataset.page || '0', 10)
            if (pageNum) void renderPage(pageNum)
          }
        }
      },
      { root: container, rootMargin: '200px 0px' }, // 预加载上下 200px
    )
    observerRef.current = observer
    for (const ph of container.querySelectorAll('.pdf-placeholder')) {
      observer.observe(ph)
    }
  }, [renderPage])

  // 接收扩展消息
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'pdf:load' && msg.uriPath) {
        // 从 opencode fetch 二进制 (arrayBuffer 无损) → dataUrl → 流式分页渲染
        console.log('[pdf-webview] pdf:load uriPath=', msg.uriPath, 'base=', getBaseUrl(), 'cwd=', getCwd())
        void fetchPdfDataUrl(msg.uriPath)
          .then((dataUrl) => initPdf(dataUrl))
          .catch((err) => {
            console.error('[pdf-webview] fetch err', err)
            setError(err instanceof Error ? err.message : String(err))
          })
      } else if (msg.type === 'pdf:error' && msg.message) {
        setError(String(msg.message))
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [initPdf])

  useEffect(() => () => { observerRef.current?.disconnect(); pdfRef.current?.destroy?.().catch?.(() => undefined) }, [])

  function goPage(n: number) {
    setCurrentPage(Math.max(1, Math.min(n, pageCount)))
    const container = containerRef.current
    if (!container) return
    const ph = container.querySelector<HTMLDivElement>(`.pdf-placeholder[data-page="${n}"]`)
    ph?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function zoom(delta: number) {
    setScale((s) => {
      const next = Math.max(0.5, Math.min(4, +(s * delta).toFixed(2)))
      scaleRef.current = next
      return next
    })
    // 缩放后重渲染已加载页 (占位高度自适应)
    setTimeout(() => {
      const container = containerRef.current
      const pdf = pdfRef.current
      if (!container || !pdf) return
      // 已渲染的重新按新 scale 渲染; 简单起见: 清空所有, 重新 init (懒加载会重新渲染可视页)
      renderedRef.current.clear()
      const placeholders = Array.from(container.querySelectorAll<HTMLDivElement>('.pdf-placeholder'))
      // 重建占位高度 (异步)
      void (async () => {
        for (const ph of placeholders) {
          const p = parseInt(ph.dataset.page || '0', 10)
          try {
            const page = await pdf.getPage(p)
            const vp = page.getViewport({ scale: scaleRef.current })
            ph.style.height = `${vp.height}px`
            ph.innerHTML = ''
            renderedRef.current.delete(p)
          } catch { /* ignore */ }
        }
      })()
    }, 50)
  }

  return (
    <div className="pdf-root">
      <style>{`
        .pdf-root { display: flex; flex-direction: column; height: 100%; background: #2a2a2a; color: #eee; font-family: system-ui, -apple-system, sans-serif; }
        .pdf-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #1f1f1f; border-bottom: 1px solid #444; flex-shrink: 0; }
        .pdf-toolbar button { background: #3a3a3a; color: #eee; border: 1px solid #555; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 13px; }
        .pdf-toolbar button:hover { background: #4a4a4a; }
        .pdf-toolbar input { background: #2a2a2a; color: #eee; border: 1px solid #555; padding: 3px 6px; border-radius: 3px; width: 50px; text-align: center; }
        .pdf-toolbar .spacer { flex: 1; }
        .pdf-toolbar .status { font-size: 12px; color: #aaa; }
        .pdf-pages { flex: 1; overflow: auto; padding: 12px; text-align: center; }
        .pdf-pages canvas { max-width: 100%; height: auto !important; }
        .pdf-placeholder { position: relative; max-width: 100%; overflow: hidden; }
        .pdf-error { padding: 24px; color: #f87171; }
        .pdf-empty { padding: 60px; color: #888; text-align: center; }
      `}</style>
      <div className="pdf-toolbar">
        <button onClick={() => goPage(1)} title="首页">⏮</button>
        <button onClick={() => goPage(currentPage - 1)} title="上一页">◀</button>
        <input
          type="number"
          min={1}
          max={pageCount}
          value={currentPage}
          onChange={(e) => goPage(parseInt(e.target.value, 10) || 1)}
        />
        <span className="status">/ {pageCount}</span>
        <button onClick={() => goPage(currentPage + 1)} title="下一页">▶</button>
        <button onClick={() => goPage(pageCount)} title="末页">⏭</button>
        <div className="spacer" />
        <button onClick={() => zoom(0.8)} title="缩小">−</button>
        <span className="status">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoom(1.25)} title="放大">+</button>
      </div>
      <div className="pdf-pages" ref={containerRef}>
        {error ? (
          <div className="pdf-error">加载失败: {error}</div>
        ) : dataUrl ? null : (
          <div className="pdf-empty">等待加载 PDF...</div>
        )}
      </div>
    </div>
  )
}
