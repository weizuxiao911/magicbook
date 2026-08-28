/**
 * PdfReaderView — animbook PDF 阅读器
 *
 * 模式 (滚动位置与页面一致 + 懒加载):
 *   1. 加载 PDF 后: 算出 fitScale, 为所有页创建占位 div (高度 = 页高×fitScale + margin)
 *      → 滚动条完整, 滚动位置天然对应页面位置, 不需要手动翻页
 *   2. IntersectionObserver 监听占位 div: 进入视口 → 渲染该页 canvas (+ 标注层)
 *   3. 已渲染的页不重复渲染 (缓存标记)
 *   4. 滚动到哪页, 哪页自动加载显示, 位置一致
 *   5. 键盘/页码输入仍可跳转 (scrollIntoView)
 *
 * 读取走 FS API (__ANIMBOOK_FS_API__.readBinaryAbsolute).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-file-service';

// @ts-ignore — pdfjs-dist v4 ships ESM types, loose import
import * as pdfjsLib from 'pdfjs-dist';

import { toAnnotMeta, runAnnotAction, type PdfAnnotMeta, type AnnotHandlers } from './annotations';
import { AnnotationActions } from './AnnotationActions';

const PDF_WORKER_CACHE_KEY = '__ANIMBOOK_PDF_WORKER_URL__';
function setupPdfWorker() {
  if (typeof window === 'undefined') return;
  if ((pdfjsLib as any).GlobalWorkerOptions.workerSrc) return;
  const cached = (window as any)[PDF_WORKER_CACHE_KEY];
  if (cached) { (pdfjsLib as any).GlobalWorkerOptions.workerSrc = cached; return; }
  const version = (pdfjsLib as any).version || '4.10.38';
  const candidates = [
    `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
  ];
  const tryOne = (url: string) => fetch(url)
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then((text) => {
      const blob = new Blob([text], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      (window as any)[PDF_WORKER_CACHE_KEY] = blobUrl;
      (pdfjsLib as any).GlobalWorkerOptions.workerSrc = blobUrl;
    });
  (async () => {
    for (const u of candidates) {
      try { await tryOne(u); return; } catch { /* next */ }
    }
  })();
}
setupPdfWorker();

interface Props {
  resource: {
    uri: { codeUri: { fsPath: string; path: string } } | { path: string };
  };
}

/**
 * 解析 OpenSumi 虚拟路径 → 宿主机绝对路径.
 *
 * codeblitz 框架 hardcode `WORKSPACE_ROOT = '/workspace'`, codeUri.fsPath 形如
 * `/workspace/数据结构.pdf`. numas `__APP_CONFIG__.cwd` 是 user 选的真实工作目录
 * (如 `/Users/.../运营阵地/`), 文件实际在 cwd 下的 workspace/ 子目录
 * (如 `/Users/.../运营阵地/workspace/数据结构.pdf`).
 *
 * 真实路径 = `__APP_CONFIG__.cwd + codeUri.path` (直接拼, codeblitz 的 /workspace/
 * 段就是 cwd 下的子目录, 不能再剥). 给 `__APP_FS__.readBinary` 内部 `absPath = cwd + '/' + rel` 用.
 *
 * fallback: 拿不到 cwd 时用 localStorage APP_CWD; 再不行扫描 hostPath 找 /workspace/ 段.
 */
function resolveHostPath(resource: any): string {
  const uri = resource?.uri;
  if (!uri) return '';
  // 1) 优先用 codeUri.fsPath (codeblitz 给的虚拟路径, 直接拼 cwd 即可)
  let p = '';
  if (uri.codeUri?.fsPath) p = uri.codeUri.fsPath;
  else if (typeof uri.path === 'string') p = uri.path;
  else if (typeof uri.toString === 'function') {
    const s = uri.toString();
    if (s.startsWith('file://')) p = decodeURIComponent(s.slice('file://'.length));
    else p = s;
  }
  if (!p) return '';
  // 拿 numas 真实 cwd
  const cwd = (window as any).__APP_FS__?.getWorkspaceDir?.()
    || (window as any).__APP_CONFIG__?.cwd
    || (() => { try { return window.localStorage.getItem('APP_CWD') || ''; } catch { return ''; } })()
    || '';
  if (cwd) {
    const cwdNorm = cwd.replace(/\/+$/, '');
    // 仅 codeblitz 虚拟路径 (以 /workspace/ 开头, WORKSPACE_ROOT 硬编码) 才拼 cwd
    // 绝对路径 (cbr/...) 直接用
    if (p.startsWith('/workspace/') || p === '/workspace') {
      return cwdNorm + p;
    }
    if (p.startsWith('file:///workspace/')) {
      return cwdNorm + p.slice('file:///workspace/'.length - 1);
    }
  }
  return p;
}

async function openPdfFromBytes(bytes: Uint8Array): Promise<any> {
  return await (pdfjsLib as any).getDocument({
    data: bytes.slice(0),
    cMapUrl: 'https://unpkg.com/pdfjs-dist@4.10.38/cmaps/',
    cMapPacked: true,
    isEvalSupported: false,
    // 禁用 annotation 渲染: 高亮/交互全部由我们的渲染端负责, canvas 只画内容
    annotationMode: 0, // AnnotationMode.DISABLE
  }).promise;
}

export const PdfReaderView: React.FC<Props> = ({ resource }) => {
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<any>(null);
  const fileService = useInjectable<IFileServiceClient>(IFileServiceClient);
  /** 已渲染完成的 page idx 集合 */
  const renderedRef = useRef<Set<number>>(new Set());
  /** 正在渲染中的 page idx 集合 (防并发) */
  const inFlightRef = useRef<Set<number>>(new Set());
  /** fitScale (所有页共用) */
  const fitScaleRef = useRef<number>(1);
  /** page 原始尺寸 */
  const pageBaseRef = useRef<{ width: number; height: number } | null>(null);
  /** 每页占位 div 引用 */
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  const hostPath = useMemo(() => resolveHostPath(resource), [resource]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [currentPage, setCurrentPage] = useState(1);
  /** PDF 目录树 (pdf.getOutline() 嵌套结构) */
  const [outline, setOutline] = useState<any[]>([]);
  /** 目录面板是否展开 */
  const [tocOpen, setTocOpen] = useState(true);
  /** resize 触发重建的 tick (每次宽度变化 +1, 触发 effect 重跑) */
  const [rebuildTick, setRebuildTick] = useState(0);
  /** 页码输入框 (非受控, 输入时不被滚动同步抢走) */
  const pageInputRef = useRef<HTMLInputElement>(null);
  /** 输入框是否聚焦中 (聚焦时不更新它的值) */
  const inputFocusedRef = useRef(false);
  /** 标注行为处理器 (组件挂载后赋值) */
  const annotHandlersRef = useRef<AnnotHandlers>({ modal: () => {}, tab: () => {}, terminal: () => {} });

  /** 同步页码显示 (滚动/跳转时更新输入框, 但聚焦中不抢) */
  const syncPageDisplay = useCallback((n: number) => {
    if (inputFocusedRef.current) return;
    const el = pageInputRef.current;
    if (el) el.value = String(n);
  }, []);

  /** 渲染单页: 在占位 div 里插入 canvas + 标注层 */
  const renderPage = useCallback(async (pageIdx: number) => {
    if (pageIdx < 1 || pageIdx > numPages) return;
    if (renderedRef.current.has(pageIdx)) return;
    if (inFlightRef.current.has(pageIdx)) return;
    const pdf = pdfDocRef.current;
    const pageEl = pageElsRef.current.get(pageIdx);
    if (!pdf || !pageEl) return;
    if (!pageBaseRef.current) return; // 等 fitScale 算好

    inFlightRef.current.add(pageIdx);
    try {
      const page = await pdf.getPage(pageIdx);
      // 每页自己的 fitScale: 宽度适配 div 实际宽度 (div width:100% = viewer 内容宽)
      const pb = page.getViewport({ scale: 1 });
      const containerW = Math.max(pageEl.clientWidth, 60);
      const fitScale = containerW / pb.width;
      const dpr = window.devicePixelRatio || 1;
      const renderScale = fitScale * dpr;
      const viewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement('canvas');
      canvas.className = 'ab-pdf-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      pageEl.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;

      // 标注: 自定义渲染 (hover tip + 点击行为), 不用 pdf.js AnnotationLayer
      try {
        const annots = await page.getAnnotations();
        if (annots && annots.length > 0) {
          const metas = annots
            .map((a: any) => toAnnotMeta(a, pageIdx))
            // 只渲染有行为的热区 (纯信息标注无 action 不渲染, 避免旧标注干扰)
            .filter((m: PdfAnnotMeta) => m.action && m.raw?.rect);

          if (metas.length > 0) {
            const overlay = document.createElement('div');
            overlay.className = 'ab-pdf-annot-layer';
            overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
            pageEl.appendChild(overlay);

            // 用 canvas 实际渲染比例换算: PDF 坐标 × renderScale = canvas 内部像素,
            // ÷ (canvas.width / clientWidth) = CSS 像素 (精确对齐 canvas 内容)
            const scaleX = canvas.width / canvas.clientWidth;
            const scaleY = canvas.height / canvas.clientHeight;
            const pageH = pb.height; // 当前页自己的高度 (y 翻转用)
            for (const meta of metas) {
              const rect = meta.raw.rect as [number, number, number, number];
              if (!rect || rect.length < 4) continue;
              const [x1, y1, x2, y2] = rect;
              // PDF 坐标 (左下原点) → canvas 内部像素 (y 翻转) → CSS 像素
              const px1 = x1 * renderScale / scaleX;
              const py1 = (pageH - y1) * renderScale / scaleY;
              const px2 = x2 * renderScale / scaleX;
              const py2 = (pageH - y2) * renderScale / scaleY;
              const left = Math.min(px1, px2);
              const top = Math.min(py1, py2);
              const w = Math.abs(px2 - px1);
              const h = Math.abs(py2 - py1);

              // 高亮 = 标注颜色 (annotation C 字段: pdf.js 返回 Uint8ClampedArray [r,g,b] 0-255)
              const c: any = meta.raw?.color;
              let r = 153, g = 153, b = 255;
              if (c && c.length >= 3) {
                r = Number(c[0]) || r;
                g = Number(c[1]) || g;
                b = Number(c[2]) || b;
              }

              const el = document.createElement('button');
              el.className = 'ab-pdf-annot';
              el.dataset['page'] = String(pageIdx);
              el.dataset['annotId'] = meta.id;
              el.dataset['r'] = String(r);
              el.dataset['g'] = String(g);
              el.dataset['b'] = String(b);
              // 默认极淡 (几乎透明, 只提示位置), hover 时显示标注色高亮
              // 像素定位: viewport 渲染坐标直接对应页面 div 显示尺寸
              el.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;pointer-events:auto;background:rgba(${r},${g},${b},0.08);border:1px dashed rgba(${r},${g},${b},0.25);`;
              el.title = meta.preview || meta.title; // 原生 title 兜底

              // hover: 显示标注色高亮 (JS 直接设色, 兼容性好)
              el.addEventListener('mouseenter', () => {
                el.style.background = `rgba(${r},${g},${b},0.35)`;
                el.style.boxShadow = `0 0 0 2px rgba(${r},${g},${b},0.6)`;
                showAnnotTip(el, meta);
              });
              el.addEventListener('mouseleave', () => {
                el.style.background = 'transparent';
                el.style.boxShadow = 'none';
                hideAnnotTip();
              });
              el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                hideAnnotTip();
                if (meta.action) {
                  void runAnnotAction(meta.action, annotHandlersRef.current);
                }
              });

              overlay.appendChild(el);
            }
          }
        }
      } catch (e) {
        console.warn('[pdf] annotation overlay page', pageIdx, 'failed:', e);
      }

      renderedRef.current.add(pageIdx);
    } catch (e) {
      if ((e as any)?.name !== 'RenderingCancelledException') {
        console.warn('[pdf] render page', pageIdx, 'failed:', e);
      }
    } finally {
      inFlightRef.current.delete(pageIdx);
    }
  }, [numPages]);

  // ---------- 加载 PDF ----------
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      setLoading(true);
      setError('');
      setProgress({ loaded: 0, total: 0 });
      try {
        const fileServiceApi = fileService as any;
        const u: any = resource?.uri;
        const cwd = (window as any).__APP_CONFIG__?.cwd || '';
        console.log('[pdf] resource.uri.toString(true):', u?.toString?.(true));
        console.log('[pdf] __APP_CONFIG__.cwd:', cwd);

        // 候选 URI: codeblitz 原生 file:///workspace/... (BrowserFS 自动映射),
        // 失败用 numas cwd 拼真实路径 (避开 fs.readBinary 的 cwd 重复拼接)
        const candidates: string[] = [];
        if (u?.toString) candidates.push(u.toString(true));
        if (cwd && u?.codeUri?.fsPath) {
          const fsPath = String(u.codeUri.fsPath);
          candidates.push(`file://${cwd.replace(/\/+$/, '')}${fsPath}`);
        }
        console.log('[pdf] candidates:', candidates);

        // readFile 返回 BinaryBuffer (内部 this.buffer 是 Buffer 或 Uint8Array)
        // 正确转 Uint8Array: 拿 data.buffer (ArrayBuffer 视图) + .byteOffset + .byteLength
        let content: Uint8Array | undefined;
        let lastErr: any = null;
        for (const cand of candidates) {
          try {
            const r = await fileServiceApi.readFile(cand);
            const data: any = r?.content;
            const byteLen = data?.byteLength ?? 0;
            console.log('[pdf] try', cand, '→ size:', byteLen, 'type:', data?.constructor?.name,
              'innerBuffer:', data?.buffer?.constructor?.name);
            if (data && byteLen > 0) {
              // BinaryBuffer.buffer 是 Buffer (Node) 或 Uint8Array, 都暴露 .buffer (ArrayBuffer 视图)
              const inner = data.buffer;
              if (inner instanceof ArrayBuffer) {
                content = new Uint8Array(inner);
              } else if (inner && typeof inner.buffer !== 'undefined') {
                // Buffer / Uint8Array 都有 .buffer (ArrayBuffer) + .byteOffset + .byteLength
                content = new Uint8Array(inner.buffer, inner.byteOffset || 0, inner.byteLength);
              } else {
                // 兜底: 字符串 (utf-8 文本), 用 TextEncoder
                content = new TextEncoder().encode(typeof data === 'string' ? data : String(data));
              }
              break;
            }
          } catch (e) {
            console.log('[pdf] try', cand, '→ err:', String(e));
            lastErr = e;
          }
        }
        if (!content) throw lastErr || new Error('PDF readFile returned empty content');
        console.log('[pdf] loaded', content.byteLength, 'bytes');

        const pdf = await openPdfFromBytes(content);
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);
        // 目录: pdf.getOutline() 拿嵌套书签树
        try {
          const o = await (pdf as any).getOutline();
          if (!cancelled) setOutline(Array.isArray(o) ? o : []);
        } catch {
          if (!cancelled) setOutline([]);
        }
      } catch (e) {
        if (!cancelled) setError(String((e as any)?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      try { pdfDocRef.current?.destroy?.(); } catch { /* */ }
    };
  }, [hostPath]);

  // ---------- 重建占位 + 一次性渲染所有页 (不懒加载, 避免滚动空白) ----------
  const rebuildViewer = useCallback(async () => {
    if (!numPages) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pdf = pdfDocRef.current;
    if (!pdf) return;

    // 算 fitScale (用第 1 页原生尺寸)
    const firstPage = await pdf.getPage(1);
    const base = firstPage.getViewport({ scale: 1 });
    pageBaseRef.current = { width: base.width, height: base.height };
    const containerW = Math.max(viewer.clientWidth, 60);
    fitScaleRef.current = containerW / base.width;

    // 清空, 建所有页 (占位 div + canvas + 标注热区)
    const prevScrollTop = viewer.scrollTop;
    viewer.innerHTML = '';
    pageElsRef.current.clear();
    renderedRef.current.clear();
    const pageGap = 8;
    const dpr = window.devicePixelRatio || 1;

    for (let i = 1; i <= numPages; i++) {
      const p = await pdf.getPage(i);
      const pb = p.getViewport({ scale: 1 });
      // 每页独立 fitScale: 宽度适配容器, 高度按该页比例
      const fit = containerW / pb.width;
      const pageH = pb.height * fit;

      const div = document.createElement('div');
      div.className = 'ab-pdf-page';
      div.dataset['page'] = String(i);
      // fit-to-height: canvas 高度占可视窗口 (100vh), 宽度按 PDF 原始宽高比
      // aspect-ratio 自动算; max-height: 100vh 防止超窗口. canvas 100%×100% 自然保持比例.
      div.style.cssText = `width:auto;height:100vh;max-height:100vh;aspect-ratio:${pb.width}/${pb.height};margin:0 auto ${pageGap}px;`;
      viewer.appendChild(div);
      pageElsRef.current.set(i, div);

      // 渲染 canvas (串行, 一次性全部渲染)
      const renderScale = fit * dpr;
      const viewport = p.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.className = 'ab-pdf-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.cssText = 'width:100%;height:100%;display:block;';
      div.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      if (ctx) await p.render({ canvasContext: ctx, viewport }).promise;

      // 标注热区
      try {
        const annots = await p.getAnnotations();
        if (annots && annots.length > 0) {
          const metas = annots
            .map((a: any) => toAnnotMeta(a, i))
            .filter((m: PdfAnnotMeta) => m.action && m.raw?.rect);
          if (metas.length > 0) {
            const overlay = document.createElement('div');
            overlay.className = 'ab-pdf-annot-layer';
            overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
            div.appendChild(overlay);

            const scaleX = canvas.width / canvas.clientWidth;
            const scaleY = canvas.height / canvas.clientHeight;
            const pageH0 = pb.height;
            for (const meta of metas) {
              const rect = meta.raw.rect as [number, number, number, number];
              if (!rect || rect.length < 4) continue;
              const [x1, y1, x2, y2] = rect;
              const px1 = x1 * renderScale / scaleX;
              const py1 = (pageH0 - y1) * renderScale / scaleY;
              const px2 = x2 * renderScale / scaleX;
              const py2 = (pageH0 - y2) * renderScale / scaleY;
              const left = Math.min(px1, px2);
              const top = Math.min(py1, py2);
              const w = Math.abs(px2 - px1);
              const h = Math.abs(py2 - py1);

              const c: any = meta.raw?.color;
              let r = 153, g = 153, b = 255;
              if (c && c.length >= 3) {
                r = Number(c[0]) || r;
                g = Number(c[1]) || g;
                b = Number(c[2]) || b;
              }

              const el = document.createElement('button');
              el.className = 'ab-pdf-annot';
              el.dataset['page'] = String(i);
              el.dataset['annotId'] = meta.id;
              // 存原始 canvas 内部像素坐标 (resize 后按新 scale 重算)
              el.dataset['origLeft'] = String(left * scaleX);
              el.dataset['origTop'] = String(top * scaleY);
              el.dataset['origW'] = String(w * scaleX);
              el.dataset['origH'] = String(h * scaleY);
              el.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;pointer-events:auto;background:rgba(${r},${g},${b},0.08);border:1px dashed rgba(${r},${g},${b},0.25);`;
              el.title = meta.preview || meta.title;
              el.addEventListener('mouseenter', () => {
                el.style.background = `rgba(${r},${g},${b},0.35)`;
                el.style.boxShadow = `0 0 0 2px rgba(${r},${g},${b},0.6)`;
                showAnnotTip(el, meta);
              });
              el.addEventListener('mouseleave', () => {
                el.style.background = 'rgba(' + r + ',' + g + ',' + b + ',0.08)';
                el.style.boxShadow = 'none';
                hideAnnotTip();
              });
              el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                hideAnnotTip();
                if (meta.action) void runAnnotAction(meta.action, annotHandlersRef.current);
              });
              overlay.appendChild(el);
            }
          }
        }
      } catch (e) {
        console.warn('[pdf] annot overlay page', i, 'failed:', e);
      }
    }

    renderedRef.current = new Set(Array.from({ length: numPages }, (_, k) => k + 1));
    syncPageDisplay(currentPage);
    if (viewer.scrollHeight > prevScrollTop) viewer.scrollTop = prevScrollTop;
  }, [numPages, currentPage, syncPageDisplay]);

  // ---------- 初始加载 (一次性渲染, 不懒加载, 滚动不会空白) ----------
  useEffect(() => {
    if (!numPages) return;
    const viewer = viewerRef.current;
    if (!viewer) return;

    let disposed = false;
    (async () => {
      await rebuildViewer();
      if (disposed) return;
      setLoading(false);
    })();

    // resize 只重算热区位置 (canvas 100% 自适应不丢内容, 热区是像素定位需按新比例重算)
    // 用父容器宽度 (viewer 内滚动条出现/消失不影响, 避免滚动误触发)
    const parentEl = viewer.parentElement as HTMLElement | null;
    const widthSource = parentEl || viewer;
    let lastWidth = widthSource.getBoundingClientRect().width;
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const w = widthSource.getBoundingClientRect().width;
      if (Math.abs(w - lastWidth) < 2) return;
      lastWidth = w;
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        // 每个 page 的热区按该页 canvas 新比例重算
        for (const el of pageElsRef.current.values()) {
          const canvas = el.querySelector('canvas') as HTMLCanvasElement | null;
          if (!canvas) continue;
          const annots = el.querySelectorAll('.ab-pdf-annot');
          if (!annots.length) continue;
          const scaleX = canvas.width / canvas.clientWidth;
          const scaleY = canvas.height / canvas.clientHeight;
          for (const a of Array.from(annots) as HTMLElement[]) {
            const origLeft = parseFloat(a.dataset['origLeft'] || '0');
            const origTop = parseFloat(a.dataset['origTop'] || '0');
            const origW = parseFloat(a.dataset['origW'] || '0');
            const origH = parseFloat(a.dataset['origH'] || '0');
            if (!a.dataset['origLeft']) continue;
            a.style.left = `${origLeft / scaleX}px`;
            a.style.top = `${origTop / scaleY}px`;
            a.style.width = `${origW / scaleX}px`;
            a.style.height = `${origH / scaleY}px`;
          }
        }
      }, 300);
    });
    ro.observe(widthSource);

    return () => {
      disposed = true;
      ro.disconnect();
      if (roTimer) clearTimeout(roTimer);
    };
  }, [numPages, rebuildViewer]);

  // ---------- 标注行为处理器 (modal / tab / terminal) ----------
  useEffect(() => {
    // modal: 用全局事件打开 (由 App 层监听渲染模态框, 保持 PdfReaderView 独立)
    annotHandlersRef.current.modal = (title, content) => {
      window.dispatchEvent(new CustomEvent('animbook:pdf-annot-modal', {
        detail: { title, content, source: hostPath },
      }));
    };
    // tab: 编辑区打开 untitled tab, 内容写入
    annotHandlersRef.current.tab = (title, content) => {
      window.dispatchEvent(new CustomEvent('animbook:pdf-annot-tab', {
        detail: { title, content, source: hostPath },
      }));
    };
    // terminal: 打开/聚焦终端并执行命令
    annotHandlersRef.current.terminal = (command) => {
      window.dispatchEvent(new CustomEvent('animbook:pdf-annot-terminal', {
        detail: { command, source: hostPath },
      }));
    };
  }, [hostPath]);

  // ---------- 跳转到指定页 ----------
  const jumpToPage = useCallback((n: number) => {
    const clamped = Math.min(numPages, Math.max(1, n));
    setCurrentPage(clamped);
    syncPageDisplay(clamped);
    const el = pageElsRef.current.get(clamped);
    if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
  }, [numPages, syncPageDisplay]);

  // ---------- 目录项点击: 解析 dest → 页号 → 跳转 ----------
  const jumpToOutlineDest = useCallback(async (dest: any) => {
    const pdf = pdfDocRef.current;
    if (!pdf || !dest) return;
    try {
      let resolved: any = dest;
      if (typeof dest === 'string') {
        const explicit = (pdf as any).getDestination ? await (pdf as any).getDestination(dest) : null;
        if (explicit) resolved = explicit;
      }
      if (Array.isArray(resolved) && resolved[0]) {
        const pageIndex = (pdf as any).getPageIndex ? await (pdf as any).getPageIndex(resolved[0]) : -1;
        if (pageIndex >= 0) jumpToPage(pageIndex + 1);
      }
    } catch {
      /* 解析失败静默 */
    }
  }, [jumpToPage]);

  // ---------- 键盘翻页 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        jumpToPage(currentPage - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        jumpToPage(currentPage + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, jumpToPage]);

  return (
    <div className="ab-pdf">
      <style>{STYLES}</style>
      <div className="ab-pdf__body">
        {/* 目录侧边栏 (可折叠); 折叠时 width:0 完全隐藏 */}
        {!loading && !error && (
          <div className={tocOpen ? 'ab-pdf__toc ab-pdf__toc--open' : 'ab-pdf__toc'}>
            <div className="ab-pdf__toc-head">
              <span className="ab-pdf__toc-title">目录</span>
              <button
                className="ab-pdf__toc-toggle"
                title="折叠目录"
                onClick={() => setTocOpen(false)}
              >‹</button>
            </div>
            {tocOpen && (
              <div className="ab-pdf__toc-tree">
                {outline.length === 0
                  ? <div className="ab-pdf__toc-empty">暂无目录</div>
                  : <TocTree
                      items={outline}
                      depth={0}
                      defaultCollapsed={new Set<string>()}
                      onJump={jumpToOutlineDest}
                    />}
              </div>
            )}
          </div>
        )}
        {/* viewer div: 永不包含 React children, page DOM 全部手动插入 */}
        <div className="ab-pdf__viewerContainer" ref={viewerRef} />
        {/* 折叠后的展开入口: viewer 左上角浮动按钮 */}
        {!tocOpen && !loading && !error && (
          <button className="ab-pdf__toc-open-btn" title="展开目录" onClick={() => setTocOpen(true)}>☰ 目录</button>
        )}
      </div>
      <AnnotationActions />
      {loading && (
        <div className="ab-pdf__loading">
          <div className="ab-pdf__loadingText">
            加载 PDF 中… {progress.total > 0 && (
              <span>
                {Math.round((progress.loaded / progress.total) * 100)}%
                {' '}({formatBytes(progress.loaded)} / {formatBytes(progress.total)})
              </span>
            )}
          </div>
          <div className="ab-pdf__progress">
            <div
              className="ab-pdf__progressBar"
              style={{
                width: progress.total > 0
                  ? `${Math.min(100, (progress.loaded / progress.total) * 100)}%`
                  : '40%',
                animation: progress.total > 0 ? 'none' : 'ab-pdf-indet 1.2s ease-in-out infinite',
              }}
            />
          </div>
        </div>
      )}

      {error && <div className="ab-pdf__error">无法加载: {error}</div>}

      {/* ab-pdf__toolbar (页码跳转 ‹ ›) 已按需求去掉 */}
      {/* {!loading && !error && (
        <div className="ab-pdf__toolbar">
          <button className="ab-pdf__btn" disabled={currentPage <= 1} onClick={() => jumpToPage(currentPage - 1)}>‹</button>
          <span className="ab-pdf__pageno">
            <input
              ref={pageInputRef}
              className="ab-pdf__pagenoInput"
              defaultValue={currentPage}
              onFocus={() => { inputFocusedRef.current = true; }}
              onBlur={() => {
                inputFocusedRef.current = false;
                const v = parseInt(pageInputRef.current?.value || '', 10);
                if (!Number.isNaN(v) && v !== currentPage) {
                  jumpToPage(v);
                } else {
                  syncPageDisplay(currentPage);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = parseInt(pageInputRef.current?.value || '', 10);
                  if (!Number.isNaN(v)) {
                    inputFocusedRef.current = false;
                    jumpToPage(v);
                    (e.target as HTMLInputElement).blur();
                  }
                }
              }}
            />{' '}/ {numPages}
          </span>
          <button className="ab-pdf__btn" disabled={currentPage >= numPages} onClick={() => jumpToPage(currentPage + 1)}>›</button>
        </div>
      )} */}
    </div>
  );
};

/* ========== 目录树 (TOC) 递归组件 ========== */
function TocTree({ items, depth, defaultCollapsed, onJump }: {
  items: any[];
  depth: number;
  defaultCollapsed: Set<string>;
  onJump: (dest: any) => void;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(defaultCollapsed));
  const toggle = (title: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  };
  return (
    <ul className="ab-pdf__toc-list" style={{ paddingLeft: depth * 12 }}>
      {items.map((item, i) => {
        const key = `${depth}-${i}-${item.title || ''}`;
        const hasChildren = Array.isArray(item.items) && item.items.length > 0;
        const isCollapsed = hasChildren && collapsed.has(item.title || key);
        return (
          <li key={key} className="ab-pdf__toc-item">
            <div className="ab-pdf__toc-row" style={{ paddingLeft: hasChildren ? 0 : 14 }}>
              {hasChildren ? (
                <button
                  className="ab-pdf__toc-caret"
                  onClick={() => toggle(item.title || key)}
                  title={isCollapsed ? '展开' : '折叠'}
                >{isCollapsed ? '▸' : '▾'}</button>
              ) : <span className="ab-pdf__toc-dot" />}
              <button
                className="ab-pdf__toc-label"
                title={item.title || ''}
                onClick={() => { if (item.dest) onJump(item.dest); }}
              >{item.title || '(无标题)'}</button>
            </div>
            {hasChildren && !isCollapsed && (
              <TocTree
                items={item.items}
                depth={depth + 1}
                defaultCollapsed={defaultCollapsed}
                onJump={onJump}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ========== 标注 tooltip (模块级单例) ========== */
let annotTipEl: HTMLDivElement | null = null;

const ACTION_LABEL: Record<string, string> = {
  modal: '打开内容',
  tab: '在编辑区打开',
  terminal: '在终端运行',
};

function ensureAnnotTip() {
  if (annotTipEl) return annotTipEl;
  const el = document.createElement('div');
  el.className = 'ab-pdf-tip';
  document.body.appendChild(el);
  annotTipEl = el;
  return el;
}

function showAnnotTip(anchor: HTMLElement, meta: PdfAnnotMeta) {
  const tip = ensureAnnotTip();
  const actionLabel = meta.action ? ACTION_LABEL[meta.action.type] : '';
  tip.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'ab-pdf-tip__title';
  title.textContent = meta.title || meta.subtype;
  tip.appendChild(title);
  if (meta.preview) {
    const preview = document.createElement('div');
    preview.className = 'ab-pdf-tip__preview';
    preview.textContent = meta.preview;
    tip.appendChild(preview);
  }
  if (actionLabel) {
    const act = document.createElement('div');
    act.className = 'ab-pdf-tip__action';
    act.textContent = `点击: ${actionLabel}`;
    tip.appendChild(act);
  }
  tip.style.display = 'block';

  // 定位: 在标注元素上方
  const rect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  let top = rect.top - tipRect.height - 8;
  // 边界修正
  left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
  if (top < 4) top = rect.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  anchor.classList.add('is-hover');
}

function hideAnnotTip() {
  if (annotTipEl) {
    annotTipEl.style.display = 'none';
  }
  document.querySelectorAll('.ab-pdf-annot.is-hover').forEach((el) => el.classList.remove('is-hover'));
}

const STYLES = `
.ab-pdf {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  background: transparent;
  color: var(--editor-foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  overflow: hidden;
}
.ab-pdf__body {
  flex: 1; min-height: 0;
  display: flex; flex-direction: row;
  overflow: hidden;
  position: relative;
}
/* ===== 目录侧边栏 ===== */
.ab-pdf__toc {
  flex-shrink: 0;
  display: flex; flex-direction: column;
  width: 0;
  background: transparent;
  overflow: hidden;
  transition: width .18s ease;
}
.ab-pdf__toc--open { width: 240px; }
.ab-pdf__toc-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px;
  font-size: 12.5px; font-weight: 600;
  white-space: nowrap; overflow: hidden;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
.ab-pdf__toc-toggle {
  width: 22px; height: 22px;
  background: var(--button-secondaryBackground, rgba(128,128,128,0.15));
  color: inherit;
  border: none; border-radius: 5px;
  cursor: pointer; font-size: 13px; line-height: 1;
  flex-shrink: 0;
}
.ab-pdf__toc-toggle:hover { background: var(--button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
.ab-pdf__toc-title { flex: 1; text-align: left; }
.ab-pdf__toc-tree {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 4px 0;
}
.ab-pdf__toc-empty { padding: 12px 10px; font-size: 12px; color: var(--descriptionForeground, #888); }
.ab-pdf__toc-list { list-style: none; margin: 0; padding: 0; }
.ab-pdf__toc-item { margin: 0; }
.ab-pdf__toc-row { display: flex; align-items: center; min-height: 24px; }
.ab-pdf__toc-caret {
  width: 20px; height: 24px;
  background: none; border: none; color: inherit;
  cursor: pointer; font-size: 10px; line-height: 1;
  flex-shrink: 0; padding: 0;
}
.ab-pdf__toc-dot { width: 20px; flex-shrink: 0; }
.ab-pdf__toc-label {
  flex: 1; min-width: 0;
  background: none; border: none; color: inherit;
  text-align: left; font: inherit; font-size: 12.5px;
  cursor: pointer; padding: 3px 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-radius: 4px;
}
.ab-pdf__toc-label:hover { background: var(--list-hoverBackground, rgba(128,128,128,0.2)); }
.ab-pdf__toc-open-btn {
  position: absolute;
  top: 8px; left: 8px;
  z-index: 10;
  padding: 4px 10px;
  background: var(--button-secondaryBackground, rgba(128,128,128,0.15));
  color: inherit;
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
  border-radius: 6px;
  font-size: 12px; cursor: pointer;
}
.ab-pdf__toc-open-btn:hover { background: var(--button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
.ab-pdf__viewerContainer {
  flex: 1; min-height: 0;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px 0;
  display: block;
  background: transparent;
}
.ab-pdf-page {
  position: relative;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  flex-shrink: 0;
  overflow: hidden;
}
.ab-pdf-canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.ab-pdf-annot-layer {
  position: absolute;
  top: 0; left: 0;
  pointer-events: none;
  overflow: hidden;
}
.ab-pdf-annot {
  border: none;
  cursor: pointer;
  background: transparent;
  transition: background .15s, box-shadow .15s;
}
.ab-pdf-tip {
  position: fixed;
  z-index: 10000;
  display: none;
  max-width: 320px;
  padding: 8px 10px;
  background: var(--editorWidget-background, var(--vscode-editorWidget-background, #2d2d30));
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.25)));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  font-size: 12px;
  color: var(--editorWidget-foreground, var(--vscode-editorWidget-foreground, #e5e7eb));
  pointer-events: none;
  word-break: break-word;
}
.ab-pdf-tip__title {
  font-weight: 600;
  margin-bottom: 3px;
}
.ab-pdf-tip__preview {
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  white-space: pre-wrap;
  max-height: 120px;
  overflow: hidden;
}
.ab-pdf-tip__action {
  margin-top: 5px;
  color: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  font-weight: 500;
}
.ab-pdf__error {
  position: absolute; inset: 0;
  margin: auto;
  color: var(--errorForeground, var(--vscode-errorForeground, #f87171)); font-size: 14px; padding: 20px;
  text-align: center;
  display: flex; align-items: center; justify-content: center;
}
.ab-pdf__loading {
  position: absolute; inset: 0;
  margin: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af)); font-size: 13px;
  background: var(--editor-background, var(--vscode-editor-background));
  z-index: 5;
}
.ab-pdf__loadingText { font-variant-numeric: tabular-nums; }
.ab-pdf__loadingText span { color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb)); }
.ab-pdf__progress { width: min(360px, 60%); height: 4px; background: var(--progressBar-inactiveBackground, rgba(128,128,128,0.2)); border-radius: 2px; overflow: hidden; }
.ab-pdf__progressBar { height: 100%; background: var(--progressBar-background, var(--vscode-progressBar-background, #2563eb)); transition: width .12s linear; }
@keyframes ab-pdf-indet { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
/* ab-pdf__toolbar / __btn / __pageno / __pagenoInput 已按需求去掉 */
`;
