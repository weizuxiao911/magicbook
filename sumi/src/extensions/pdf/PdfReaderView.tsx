/**
 * PdfReaderView — animbook PDF 阅读器
 *
 * 模式 (全量重建 + 单页按需):
 *   1. 加载 PDF 后: rebuildViewer 全量创建所有页 div + canvas (canvas 透明度 0→1 渐显).
 *   2. 滚动条由 div 高度撑开, 滚动位置天然对应页面位置, 不需要手动翻页.
 *   3. sidecar 标注变化 → rebuildSinglePage(当前页), 不全量 rebuild (100 页 PDF 无感知).
 *   4. 键盘/页码输入跳转 (scrollIntoView).
 *
 * 读取走 FS API (__ANIMBOOK_FS_API__.readBinaryAbsolute).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-file-service';
import { notification } from '@opensumi/ide-components/lib/notification';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';
import { getWorkspace } from '../../infra/url';

// @ts-ignore — pdfjs-dist v4 ships ESM types, loose import
import * as pdfjsLib from 'pdfjs-dist';

import { toAnnotMeta, runAnnotAction, sidecarToAnnotMeta, type PdfAnnotMeta, type AnnotHandlers } from './annotations';
import { AnnotationActions } from './AnnotationActions';
import { AnnotPopover, type PopoverState, type AnnotToolId } from './AnnotPopover';
import { readSidecar, SidecarWriter, contentHash } from './sidecar';
import type { SidecarAnnot } from './annotations';
import { getChatPanelApi } from '../chat/commands/chatApi';
import { ask } from '../ask/AskService';

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
 * 解析 OpenSumi 路径 → 宿主机绝对路径.
 *
 * WORKSPACE_ROOT patch (codeblitz constant.js) 后 codeUri.fsPath 已是真实绝对路径
 * (如 /Users/.../数据结构.pdf). 兼容旧虚拟 `/workspace/...` 前缀: 剥掉换成当前
 * 工作目录 (getWorkspace = URL ?directory). 返回宿主机绝对路径 (不带 file://).
 *
 * fallback: 拿不到目录时直接用原路径 (真实路径模式).
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
  // 拿当前工作目录 (URL ?directory source-of-truth)
  const cwd = getWorkspace();
  if (cwd) {
    const cwdNorm = cwd.replace(/\/+$/, '');
    // codeblitz 根路径 (WORKSPACE_ROOT 运行时取真实 cwd; 兼容旧虚拟 /workspace) 才拼 cwd
    // 绝对路径 (cbr/...) 直接用
    const wsRoot = (window as any).__APP_CONFIG__?.workspaceDir || '/workspace';
    if (p === wsRoot || p.startsWith(`${wsRoot}/`)) {
      return cwdNorm + p.slice(wsRoot.length);
    }
    if (p.startsWith(`file://${wsRoot}`)) {
      return cwdNorm + p.slice(`file://${wsRoot}`.length);
    }
  }
  return p;
}

/** file:// URI 或 (相对/绝对) 路径 → 裸绝对文件系统路径. */
function toBarePath(p: string): string {
  if (p.startsWith('file://')) return decodeURIComponent(p.slice('file://'.length));
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

/* ===== 动画演示生成 (ask → 保存 html) ===== */

/** 提取 rect (PDF 原坐标, 左下原点) 内文本: pdf.js textContent 按文本项 bbox 与 rect 相交过滤.
 *  用 bbox 相交而非"左下角点在 rect 内": 长句子左下角点常不在圈选区内但文本主体在 (实测踩坑). */
async function extractTextInRect(
  pdf: any,
  pageIdx: number,
  pdfX1: number,
  pdfY1: number,
  pdfX2: number,
  pdfY2: number,
): Promise<string> {
  try {
    const page = await pdf.getPage(pageIdx);
    const content = await page.getTextContent();
    const x1 = Math.min(pdfX1, pdfX2);
    const x2 = Math.max(pdfX1, pdfX2);
    const y1 = Math.min(pdfY1, pdfY2);
    const y2 = Math.max(pdfY1, pdfY2);
    console.log('[pdf-extract] rect:', pageIdx, [pdfX1, pdfY1, pdfX2, pdfY2]);
    const lines: string[] = [];
    for (const it of (content.items || []) as any[]) {
      if (!it?.transform || typeof it.str !== 'string') continue;
      const [a, , , , e, f] = it.transform; // e/f = 文本项左下角 (PDF 坐标, 左下原点)
      const h = it.height || 10;
      const w = it.width || 0;
      // 文本项 bbox (忽略旋转): [e, f] 左下 → [e+w, f+h] 左上
      const tx1 = e;
      const ty1 = f;
      const tx2 = e + w;
      const ty2 = f + h;
      const overlapX = Math.min(tx2, x2) > Math.max(tx1, x1);
      const overlapY = Math.min(ty2, y2) > Math.max(ty1, y1);
      if (overlapX && overlapY) {
        lines.push(it.str);
      }
    }
    console.log('[pdf-extract] items:', content.items.length, 'matched:', lines.length);
    return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
  } catch (e) {
    console.warn('[pdf-extract] fail:', e);
    return '';
  }
}

/**
 * 保存 AI 生成的 html: PDF 同目录, 文件名 {pdfBase}-动画演示-{n}.html (n 自增不覆盖).
 * @param hostPath PDF 宿主机绝对路径 (resolveHostPath 结果)
 * @returns IDE 相对路径 (如 /电子图书/数据结构-动画演示-1.html)
 */
async function saveDemoHtml(hostPath: string, html: string, fileService: IFileServiceClient): Promise<string> {
  return saveGeneratedFile(hostPath, '动画演示', 'html', html, fileService);
}

/** 保存 AI 生成的代码文件: {pdfBase}-代码示例-{n}.{ext} */
async function saveCodeFile(hostPath: string, code: string, ext: string, fileService: IFileServiceClient): Promise<string> {
  return saveGeneratedFile(hostPath, '代码示例', ext, code, fileService);
}

/** 通用保存: PDF 同目录, 前缀自增不覆盖. @returns 绝对路径 */
async function saveGeneratedFile(
  hostPath: string,
  prefix: string,
  ext: string,
  content: string,
  fileService: IFileServiceClient,
): Promise<string> {
  // hostPath 是宿主机绝对路径 (resolveHostPath 结果). PDF 可能不在 cwd 内, 直接用绝对路径.
  let hp = hostPath.startsWith('file://') ? hostPath.slice('file://'.length) : hostPath;
  const parts = hp.split('/');
  const fileName = parts.pop() || '';
  const base = fileName.replace(/\.pdf$/i, '') || 'pdf';
  const dir = parts.join('/');
  // n 自增: 列目录已有文件
  let n = 1;
  try {
    const dirUri = `file://${dir}`;
    const stat = await fileService.getFileStat(dirUri).catch(() => null);
    const names = (stat?.children || []).map((c) => (c.uri || '').split('/').pop() || '');
    while (names.includes(`${base}-${prefix}-${n}.${ext}`)) n++;
  } catch { /* 列目录失败, 从 1 开始 */ }
  const uri = `file://${dir}/${base}-${prefix}-${n}.${ext}`;
  const st = await fileService.getFileStat(uri).catch(() => null);
  if (st) await fileService.setContent(st, content);
  else await fileService.createFile(uri, { content } as any);
  console.log(`[pdf] ${prefix} 已保存:`, uri);
  return uri;
}

/** 从 codeUri 拿 PDF basename + 所在目录, 拼 sidecar 绝对路径 `{dir}/.{basename}.annotation` (PDF 同目录).
 *  PDF 可能不在当前 workspace (cwd) 内, 返回绝对路径由 sidecar.ts file:// 直连 (headerPath 跨 cwd). */
function sidecarPathFromResource(resource: any): string {
  const u = resource?.uri;
  let fsPath = '';
  if (u?.codeUri?.fsPath) fsPath = String(u.codeUri.fsPath);
  else if (typeof u?.path === 'string') fsPath = u.path;
  if (!fsPath) return '';
  // 归一化成裸绝对路径 (去 file:// 前缀)
  let p = fsPath.startsWith('file://') ? fsPath.slice('file://'.length) : fsPath;
  // 旧虚拟 /workspace 前缀 → 换成真实 cwd
  const cwd = getWorkspace();
  if (p.startsWith('/workspace')) {
    p = cwd ? `${cwd.replace(/\/+$/, '')}${p.slice('/workspace'.length)}` : p;
  }
  const parts = p.split(/[\\/]/).filter(Boolean);
  const base = parts.pop() || '';
  if (!base) return '';
  const dir = parts.length > 0 ? `/${parts.join('/')}` : '';
  return `${dir}/.${base}.annotation`;
}

export const PdfReaderView: React.FC<Props> = ({ resource }) => {
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<any>(null);
  const fileService = useInjectable<IFileServiceClient>(IFileServiceClient);
  /** 已渲染完成的 page idx 集合 */
  const renderedRef = useRef<Set<number>>(new Set());
  /** 正在渲染中的 page idx 集合 (防并发) */
  const inFlightRef = useRef<Set<number>>(new Set());
  /** 用户缩放档位: 0..4 对应 [50%, 75%, 100%, 125%, 150%]
   *  高度主导缩放: div 高度 = viewer 视口高 × 档位, 宽度按 PDF aspect-ratio 算. */
  const [userScaleIdx, setUserScaleIdx] = useState(2);
  const USER_SCALES = [0.5, 0.75, 1.0, 1.25, 1.5];
  /** 每页占位 div 引用 */
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  /** 懒加载防抖 timer */
  const lazyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** rebuildViewer 并发守卫: 每次 rebuildViewer 入口 +1, await 后检查; 不一致 → 旧 build bail.
   *  防止连续 click 缩放按钮时, 上一次 build 在 await 链里又 appendChild 老 div, 跟新 build 撞车. */
  const buildIdRef = useRef(0);
  /** sidecar 标注 (按 page 索引). 加载完 PDF 后异步读, 后续圈选/写盘合并到这份. */
  const sidecarAnnotsRef = useRef<Map<number, SidecarAnnot[]>>(new Map());
  /** 触发渲染刷新: sidecar 变化 (读/写/外部同步) 时 +1. */
  const [sidecarTick, setSidecarTick] = useState(0);
  /** sidecar IDE 相对路径, 加载完 PDF 后算一次. */
  const sidecarPathRef = useRef<string>('');
  /** sidecar 写盘器 (debounce + 自写去重). 初始化在 sidecarPath 算完之后. */
  const sidecarWriterRef = useRef<SidecarWriter | null>(null);
  /** 写盘未保存标记 (红点). */
  const [dirty, setDirty] = useState(false);
  /** popover 状态: null = 隐藏. */
  const [popoverState, setPopoverState] = useState<PopoverState | null>(null);
  /** 文本选择监听是否启用 (避免其他 popover 打开时误触发). */
  const popoverOpenRef = useRef(false);

  const hostPath = useMemo(() => resolveHostPath(resource), [resource]);

  const [loading, setLoading] = useState(true);
  /** 缩放重建中: 全量重建 274 页需数秒, 期间盖遮罩 (否则用户看到内容清空/第一页闪烁) */
  const [zooming, setZooming] = useState(false);
  const [error, setError] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  /** 当前页码 (ref, 避免放入 rebuildViewer deps 触发死循环) */
  const currentPageRef = useRef<number>(1);
  /** 缩放锚点页: 点击缩放按钮瞬间记录真实页 (rebuild 异步触发, 期间 onScroll 会污染 currentPageRef 成 1) */
  const zoomAnchorPageRef = useRef<number | null>(null);
  /** rebuild 进行中 (计数): 期间 onScroll 不更新 currentPageRef (防 innerHTML='' 后 scrollTop 归零污染成 1) */
  const rebuildingRef = useRef(0);
  const [currentPage, _setCurrentPage] = useState(1);
  /** 缩放按钮点击: 记录锚点页 + 同步回写 currentPageRef (连续缩放时各 build 都能拿到真实页) */
  const markZoomAnchor = () => {
    const p = currentPageRef.current;
    zoomAnchorPageRef.current = p;
    currentPageRef.current = p;
  };
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
        const cwd = getWorkspace();
        console.log('[pdf] resource.uri.toString(true):', u?.toString?.(true));

        // 候选 URI: codeblitz 原生 file://{WORKSPACE_ROOT}/... (真实路径) 或旧虚拟 file:///workspace/...
        // 注意: fsPath 已是绝对路径 (真实路径模式) 时不能再拼 cwd (会重复拼接成不存在路径)
        const candidates: string[] = [];
        if (u?.toString) candidates.push(u.toString(true));
        if (u?.codeUri?.fsPath) {
          const fsPath = String(u.codeUri.fsPath);
          if (fsPath.startsWith('/workspace')) {
            // 旧虚拟路径: 拼 cwd
            if (cwd) candidates.push(`file://${cwd.replace(/\/+$/, '')}${fsPath.slice('/workspace'.length)}`);
          } else if (fsPath.startsWith('/')) {
            // 绝对路径 (真实路径模式): 直接 file://
            candidates.push(`file://${fsPath}`);
          }
        }
        console.log('[pdf] candidates:', candidates);

        // readFile 返回 BinaryBuffer (内部 this.buffer 是 Buffer 或 Uint8Array)
        // 正确转 Uint8Array: 拿 data.buffer (ArrayBuffer 视图) + .byteOffset + .byteLength
        let content: Uint8Array | undefined;
        let lastErr: any = null;
        for (const cand of candidates) {
          try {
            // 预检: 文件不存在 (移动/删除后旧 tab 恢复) 跳过, 避免读到错误内容 (Invalid PDF structure)
            const st = await fileServiceApi.getFileStat(cand).catch(() => null);
            if (!st || st.isDirectory) {
              console.log('[pdf] skip (not a file):', cand);
              continue;
            }
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
        if (!content) {
          // 所有候选都失败: 大概率文件被移动/删除 (旧 tab 恢复旧路径) — 明确提示
          throw lastErr || new Error('PDF 读取失败: 文件不存在或已被移动, 请从 explorer 重新打开');
        }
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
        // 异步读 sidecar 标注 (失败/不存在静默, 用空 items). 算 sidecar 路径 + 初始化 writer.
        try {
          const sp = sidecarPathFromResource(resource);
          sidecarPathRef.current = sp;
          if (sp) {
            const file = await readSidecar(sp, fileService);
            if (cancelled) return;
            // 按 page 索引填 ref
            const m = new Map<number, SidecarAnnot[]>();
            for (const a of file.items) {
              if (!m.has(a.page)) m.set(a.page, []);
              m.get(a.page)!.push(a);
            }
            sidecarAnnotsRef.current = m;
            sidecarWriterRef.current = new SidecarWriter(sp, fileService, (err) => {
              setDirty(true);
              notification.error({ message: `标注保存失败: ${err.message}`, type: 'error', duration: 5 });
            });
            setSidecarTick((t) => t + 1);
          }
        } catch (e) {
          console.warn('[pdf] sidecar init failed:', e);
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

  // ---------- 懒加载单页真实内容 (canvas + 内嵌 + sidecar 标注) ----------
  // 骨架已建 page div; 此函数只在 div 上补 canvas + 标注 (幂等: 已渲染过直接返回).
  // myBuildId: 并发守卫, 全 rebuild 期间新 build 来了, 旧 build bail.
  const rebuildSinglePage = useCallback(async (pageIdx: number, myBuildId?: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pdf = pdfDocRef.current;
    if (!pdf) return;
    if (pageIdx < 1 || pageIdx > numPages) return;
    // 已渲染过 (懒加载缓存), 跳过
    if (renderedRef.current.has(pageIdx)) return;

    const div = pageElsRef.current.get(pageIdx);
    if (!div || div.parentNode !== viewer) return;

    const edEl = document.getElementById('opensumi-editor');
    const viewBaseH = Math.max((edEl?.clientHeight ?? viewer.clientHeight) || 1, 1);
    const viewH = viewBaseH * USER_SCALES[userScaleIdx];
    const dpr = window.devicePixelRatio || 1;

    // 拿 page
    const p = await pdf.getPage(pageIdx);
    if (myBuildId !== undefined && buildIdRef.current !== myBuildId) return;
    const pb = p.getViewport({ scale: 1 });

    // canvas (占位 div 尺寸已定, 按它渲染)
    const pageW = div.clientWidth || div.offsetWidth;
    const pageH = div.clientHeight || div.offsetHeight;
    const renderScale = (pageW / pb.width) * dpr;
    const viewport = p.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.className = 'ab-pdf-canvas';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.cssText = 'width:100%;height:100%;display:block;opacity:0;transition:opacity 0.12s ease;';
    div.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx) await p.render({ canvasContext: ctx, viewport }).promise;
    if (myBuildId !== undefined && buildIdRef.current !== myBuildId) return;
    canvas.style.opacity = '1';
    div.classList.remove('ab-pdf-page--skeleton');

    // 标注 (内嵌 + sidecar)
    const embeddedMetas: PdfAnnotMeta[] = (await p.getAnnotations() || [])
      .map((a: any) => toAnnotMeta(a, pageIdx))
      .filter((m: PdfAnnotMeta) => m.action && m.raw?.rect);
    const sidecarMetas: PdfAnnotMeta[] = (sidecarAnnotsRef.current.get(pageIdx) || [] as SidecarAnnot[])
      .map(sidecarToAnnotMeta)
      .filter((m: PdfAnnotMeta) => m.raw?.rect);
    if (embeddedMetas.length > 0 || sidecarMetas.length > 0) {
      const overlay = document.createElement('div');
      overlay.className = 'ab-pdf-annot-layer';
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
      div.appendChild(overlay);
      renderAnnotsForPage(overlay, pageIdx, embeddedMetas, sidecarMetas, canvas, pb, renderScale);
    }
    renderedRef.current.add(pageIdx);
  }, [numPages, userScaleIdx]);

  // ---------- 懒加载可见页 ±5 (滚动/缩放后调度) ----------
  const lazyLoadRange = useCallback(async (centerPage: number, myBuildId?: number) => {
    if (!numPages) return;
    const LOAD_RADIUS = 5;
    const from = Math.max(1, centerPage - LOAD_RADIUS);
    const to = Math.min(numPages, centerPage + LOAD_RADIUS);
    for (let i = from; i <= to; i++) {
      try {
        await rebuildSinglePage(i, myBuildId);
      } catch (e) {
        console.warn('[pdf] lazy render failed, page=', i, e);
      }
    }
  }, [numPages, rebuildSinglePage]);

  // ---------- 标注热区渲染 (内嵌 + sidecar, 给 rebuildSinglePage 用) ----------
  const renderAnnotsForPage = useCallback((overlay: HTMLDivElement, pageIdx: number, embeddedMetas: PdfAnnotMeta[], sidecarMetas: PdfAnnotMeta[], canvas: HTMLCanvasElement, pb: any, renderScale: number) => {
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const pageH0 = pb.height;

    const renderMeta = (meta: PdfAnnotMeta, opts: { withTip: boolean; withClick: boolean; withDelete?: boolean }) => {
      const rect = meta.raw.rect as [number, number, number, number];
      if (!rect || rect.length !== 4) return;
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
      el.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;pointer-events:auto;background:rgba(${r},${g},${b},0.08);border:1px dashed rgba(${r},${g},${b},0.25);`;
      if (opts.withTip) el.title = meta.preview || meta.title;
      if (opts.withTip) {
        el.addEventListener('mouseenter', () => {
          el.style.background = `rgba(${r},${g},${b},0.35)`;
          el.style.boxShadow = `0 0 0 2px rgba(${r},${g},${b},0.6)`;
          showAnnotTip(el, meta);
        });
        el.addEventListener('mouseleave', () => {
          el.style.background = `rgba(${r},${g},${b},0.08)`;
          el.style.boxShadow = 'none';
          hideAnnotTip();
        });
      } else if (opts.withDelete) {
        const delBtn = document.createElement('span');
        // 交互能力: 已注册类型渲染右下角按钮行 (本次: demo → 动画演示). 旧 comment/prompt 数据保留但 UI 不再渲染.
        const interactions: Array<{ type: string; htmlPath?: string; codePath?: string; runner?: string; install?: string; text?: string; filePath?: string }> = meta.raw?.interactions || [];
        // 交互按钮注册表: 展示类 (modal) / 文件类 (打开) / 特殊 (播放动画/运行代码)
        const TEXT_LABELS: Record<string, string> = { explain: '讲解', translate: '译文', summary: '摘要', analysis: '考点' };
        const FILE_LABELS: Record<string, string> = { note: '笔记', exercise: '练习', mindmap: '导图', flashcard: '闪卡', ppt: '大纲' };
        const demo = interactions.find((i) => i.type === 'demo' && i.htmlPath);
        const code = interactions.find((i) => i.type === 'code' && i.codePath);
        // 按钮行容器: absolute 右下角, flex 一行右对齐 (flex-wrap 防溢出)
        const btnRow = document.createElement('div');
        btnRow.className = 'ab-pdf-annot__actions';
        btnRow.style.cssText = `
          position: absolute; right: 4px; bottom: 4px; z-index: 5; display: flex;
          flex-direction: row; flex-wrap: wrap; justify-content: flex-end; gap: 4px; align-items: center;
          max-width: calc(100% - 8px);
        `;
        const actionBtns: HTMLButtonElement[] = [];
        for (const it of interactions) {
          if (TEXT_LABELS[it.type] && it.text) actionBtns.push(createTextModalBtn(TEXT_LABELS[it.type], it.text));
          else if (FILE_LABELS[it.type] && it.filePath) actionBtns.push(createOpenFileBtn(FILE_LABELS[it.type], it.filePath));
        }
        if (code) actionBtns.push(createCodeRunBtn(code.codePath!, code.runner || 'python3', code.install || ''));
        if (demo) actionBtns.push(createDemoOpenBtn(demo.htmlPath!));
        actionBtns.forEach((b) => { b.style.display = 'none'; btnRow.appendChild(b); });
        el.appendChild(btnRow);
        el.addEventListener('mouseenter', () => {
          el.style.background = `rgba(${r},${g},${b},0.18)`;
          el.style.boxShadow = `0 0 0 1.5px rgba(${r},${g},${b},0.5)`;
          if (delBtn) delBtn.style.opacity = '1';
          actionBtns.forEach((b) => { b.style.display = 'inline-block'; });
        });
        el.addEventListener('mouseleave', () => {
          el.style.background = `rgba(${r},${g},${b},0.08)`;
          el.style.boxShadow = 'none';
          if (delBtn) delBtn.style.opacity = '0';
          actionBtns.forEach((b) => { b.style.display = 'none'; });
        });
        // 双击 → 编辑标注 (从 ref 反查完整 annot)
        el.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const m = sidecarAnnotsRef.current;
          let annot: SidecarAnnot | null = null;
          for (const [, arr] of m) {
            const found = arr.find((a) => a.id === meta.id);
            if (found) { annot = found; break; }
          }
          if (!annot) return;
          const r = el.getBoundingClientRect();
          currentAnnotIdRef.current = annot.id;
          setGenerating(false);
          setPopoverState({
            x: r.right,
            y: r.top,
            page: annot.page,
            rect: annot.rect,
            selectedText: annot.selectedText,
            existing: annot,
          });
          popoverOpenRef.current = true;
        });
        delBtn.className = 'ab-pdf-annot__del';
        delBtn.textContent = '×';
        delBtn.title = '取消标注';
        delBtn.style.cssText = `position:absolute;right:-7px;top:-7px;width:14px;height:14px;line-height:12px;font-size:12px;font-weight:600;color:#fff;background:rgba(220,60,60,0.95);border-radius:50%;text-align:center;cursor:pointer;opacity:0;pointer-events:auto;transition:opacity 0.12s, transform 0.12s;z-index:3;user-select:none;`;
        delBtn.addEventListener('mouseenter', () => { delBtn.style.transform = 'scale(1.2)'; });
        delBtn.addEventListener('mouseleave', () => { delBtn.style.transform = 'scale(1)'; });
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          handleDeleteAnnot(meta.id);
        });
        el.appendChild(delBtn);
      }
      if (opts.withClick) {
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hideAnnotTip();
          if (meta.action) void runAnnotAction(meta.action, annotHandlersRef.current);
        });
      }
      overlay.appendChild(el);
    };

    for (const meta of embeddedMetas) {
      renderMeta(meta, { withTip: true, withClick: true });
    }
    for (const meta of sidecarMetas) {
      renderMeta(meta, { withTip: false, withClick: false, withDelete: true });
    }
  }, [setPopoverState]);

  // ---------- 占位骨架 + 视口懒加载 (size/scale 变化才重建骨架) ----------
  // 1) 建 274 个占位 page div (仅尺寸, 无 canvas) — 秒级, 滚动结构立即可用
  // 2) 滚动/缩放时懒加载可见页 ±5 页 (pdf.getPage + render canvas + 标注), 离开不释放
  // 3) 缩放只重建骨架 + 重懒加载当前页 (不再全量渲染, 4s → 即时)
  const rebuildViewer = useCallback(async () => {
    if (!numPages) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pdf = pdfDocRef.current;
    if (!pdf) return;
    // 并发守卫: 入口拿 myBuildId, 后续 await 后检查; 不一致 → 旧 build bail, 不再 appendChild.
    // 否则连续 click 缩放时, 上一次 build 在 await 链里又 appendChild 老 div, 跟新 build 撞车.
    const myBuildId = ++buildIdRef.current;
    console.log('[pdf] rebuild skeleton myBuildId=', myBuildId, 'scrollTop=', viewer.scrollTop);

    // 高度主导缩放: div 高度 = viewer 视口高 × userScale, 宽度按 PDF aspect-ratio 算.
    const edEl = document.getElementById('opensumi-editor');
    const viewBaseH = Math.max((edEl?.clientHeight ?? viewer.clientHeight) || 1, 1);
    const viewH = viewBaseH * USER_SCALES[userScaleIdx];
    const pageGap = 8;

    // 用局部变量记当前页: 优先缩放锚点 (点击瞬间真实页), 否则 currentPageRef.
    const prevPage = zoomAnchorPageRef.current ?? currentPageRef.current;
    zoomAnchorPageRef.current = null;
    // 记"页内偏移", 重建后精确恢复
    const prevPageEl = pageElsRef.current.get(prevPage);
    const prevOffset = prevPageEl ? viewer.scrollTop - prevPageEl.offsetTop : 0;
    // 重建期间屏蔽 onScroll 页码更新 (防污染 currentPageRef; 结束后恢复)
    rebuildingRef.current++;
    try {
      viewer.innerHTML = '';
      pageElsRef.current.clear();
      renderedRef.current.clear();

      // 骨架: 第一页拿真实宽高比 (所有页同比例), 其余页直接复用 → 不用逐页 getPage
      let aspect: number | null = null;
      for (let i = 1; i <= numPages; i++) {
        if (aspect === null) {
          try {
            const p0 = await pdf.getPage(1);
            const pb0 = p0.getViewport({ scale: 1 });
            aspect = pb0.width / pb0.height;
          } catch {
            aspect = 0.75; // A4 兜底
          }
        }
        const pageH = viewH;
        const pageW = viewH * aspect;
        const div = document.createElement('div');
        div.className = 'ab-pdf-page ab-pdf-page--skeleton';
        div.dataset['page'] = String(i);
        div.style.cssText = `width:${pageW}px;height:${pageH}px;margin:0 auto ${pageGap}px;`;
        viewer.appendChild(div);
        pageElsRef.current.set(i, div);
      }

      // 懒加载当前可见页 ±5 (重建后立即渲染视口附近, 不空白)
      await lazyLoadRange(prevPage, myBuildId);
    } finally {
      rebuildingRef.current--;
    }

    // 重建后恢复滚动位置
    if (prevPage > 1) {
      console.log('[pdf] restore scroll to page', prevPage, 'myBuildId=', myBuildId);
      requestAnimationFrame(() => {
        // 并发守卫: 期间又有新 build (快速连点缩放) → 旧 build 的 restore 放弃
        if (buildIdRef.current !== myBuildId) {
          console.log('[pdf] restore skipped (newer build)', prevPage, 'myBuildId=', myBuildId);
          return;
        }
        const target = pageElsRef.current.get(prevPage);
        if (target) {
          viewer.scrollTop = target.offsetTop + prevOffset;
          console.log('[pdf] restored to page', prevPage, 'offset=', prevOffset, 'myBuildId=', myBuildId);
        }
      });
    }
  }, [numPages, rebuildTick, syncPageDisplay, rebuildSinglePage, lazyLoadRange]);

  // ---------- 滚动同步当前页码 ----------
  useEffect(() => {
    if (!numPages) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const onScroll = () => {
      // 重建期间 (innerHTML='' 后 scrollTop 归零) 不更新页码 — 防污染 currentPageRef 成 1
      if (rebuildingRef.current > 0) return;
      // 用 viewer 可视区中点的 y 找当前页: 中点下方第一页 = 当前页
      const midY = viewer.scrollTop + viewer.clientHeight / 2;
      // 按 DOM 顺序 (offsetTop) 遍历, 不依赖 Map 插入序 —
      // rebuildSinglePage 重建页会 delete+set 把该页挪到 Map 末尾, 用插入序会导致页码错乱
      const pages = Array.from(pageElsRef.current.entries())
        .filter(([, el]) => !!el)
        .sort((a, b) => (a[1] as HTMLElement).offsetTop - (b[1] as HTMLElement).offsetTop);
      let current = 1;
      for (const [idx, el] of pages) {
        const top = el.offsetTop;
        if (midY >= top) current = idx;
      }
      if (currentPageRef.current !== current) {
        currentPageRef.current = current;
        _setCurrentPage(current);
        console.log('[pdf] onScroll -> currentPage=', current, 'midY=', midY);
        // 懒加载: 当前页 ±5 (防抖, 快速滚动只渲染最终页附近)
        if (lazyTimerRef.current) clearTimeout(lazyTimerRef.current);
        lazyTimerRef.current = setTimeout(() => {
          void lazyLoadRange(current);
        }, 120);
      }
      syncPageDisplay(current);
    };
    viewer.addEventListener('scroll', onScroll);
    return () => {
      viewer.removeEventListener('scroll', onScroll);
      if (lazyTimerRef.current) clearTimeout(lazyTimerRef.current);
    };
  }, [numPages, syncPageDisplay, lazyLoadRange]);

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

    return () => {
      disposed = true;
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

  // ---------- sidecar 变化 (保存/删除/外部同步) → 重建对应页 ----------
  // rebuildViewer 只在 size 变化触发, 不全 rebuild. 保存/删除时记目标页, 这里重建它.
  // 外部修改 (fs:changed) 不记页 → 重建当前页兜底.
  const pendingRebuildPageRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sidecarTick || !numPages) return;
    const target = pendingRebuildPageRef.current;
    pendingRebuildPageRef.current = null;
    const page = target && target >= 1 && target <= numPages ? target : currentPageRef.current;
    if (page < 1 || page > numPages) return;
    // 强制重渲染该页: 清 renderedRef + 移除旧 canvas/标注层, 让懒加载重建
    renderedRef.current.delete(page);
    const div = pageElsRef.current.get(page);
    if (div) {
      div.querySelectorAll('canvas.ab-pdf-canvas, .ab-pdf-annot-layer').forEach((el) => el.remove());
      div.classList.add('ab-pdf-page--skeleton');
    }
    void rebuildSinglePage(page);
  }, [sidecarTick, numPages, rebuildSinglePage]);

  // ---------- 监听 sidecar 外部修改 (fs:changed) ----------
  // 已有 PTY node:fs.watch + opencode SSE 双层基础设施, 业务用 window 'fs:changed'.
  useEffect(() => {
    const onFsChanged = async (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const path: string = String(detail.path || '');
      const sp = sidecarPathRef.current;
      if (!sp || path !== sp) return;
      console.log('[pdf] fs:changed received for', path);
      // 自写去重: 跟当前 writer.lastWrittenHash 比, 相同则跳过
      const writer = sidecarWriterRef.current;
      if (writer && path === writer.path) {
        // 重新读最新内容, 算 hash, 跟 lastWrittenHash 比
        const fs = (window as any).__APP_FS__;
        try {
          const bytes: Uint8Array = await fs.read(sp);
          if (!bytes || bytes.byteLength === 0) return;
          const text = new TextDecoder().decode(bytes);
          const hash = await contentHash(text);
          if (hash === writer.lastWrittenHash) return;
        } catch { /* 读失败: 当成外部修改 */ }
      }
      // 外部修改: 读最新 → 合并到 ref → 触发重建
      try {
        const file = await readSidecar(sp, fileService);
        const m = new Map<number, SidecarAnnot[]>();
        for (const a of file.items) {
          if (!m.has(a.page)) m.set(a.page, []);
          m.get(a.page)!.push(a);
        }
        sidecarAnnotsRef.current = m;
        setDirty(false);
        setSidecarTick((t) => t + 1);
      } catch (err) {
        console.warn('[pdf] sidecar reload failed:', err);
      }
    };
    window.addEventListener('fs:changed', onFsChanged);
    return () => window.removeEventListener('fs:changed', onFsChanged);
  }, [hostPath]);

  // ---------- Rect 矩形选择: mousedown/move/up 画矩形 → 弹 popover ----------
  // 跨页全屏 overlay (跟 viewer 同级), 临时矩形 div 跟随鼠标, mouseup 算 PDF 原坐标.
  // 弹窗时矩形保留显示 (data-active="1") 提示用户"这是要标注的区域", 保存/取消时清理.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    let drawing = false;
    let startX = 0, startY = 0;
    let rectEl: HTMLDivElement | null = null;
    let startPageEl: HTMLElement | null = null;

    const ensureRectEl = () => {
      if (rectEl && document.body.contains(rectEl)) return rectEl;
      const el = document.createElement('div');
      el.className = 'ab-pdf-selection-rect';
      el.style.cssText = 'position:fixed;pointer-events:none;background:rgba(55,148,255,0.18);border:1.5px solid rgba(55,148,255,0.9);border-radius:2px;z-index:50;display:none;';
      document.body.appendChild(el);
      rectEl = el;
      return el;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (popoverOpenRef.current) return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.ab-pdf-annot')) return;
      if (target.closest('.ab-annot-popover')) return;
      const pageEl = target.closest('.ab-pdf-page') as HTMLElement | null;
      if (!pageEl) return;
      // 清理之前的旧矩形 (如果残留, 比如上次取消失败)
      if (rectEl) { rectEl.remove(); rectEl = null; }
      drawing = true;
      startX = e.clientX;
      startY = e.clientY;
      startPageEl = pageEl;
      const el = ensureRectEl();
      el.dataset['active'] = '0';
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
      el.style.width = '0px';
      el.style.height = '0px';
      el.style.display = 'block';
      el.style.pointerEvents = 'none';  // 画的过程不接收 click, 避免误触
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!drawing) return;
      const el = ensureRectEl();
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };

    const onMouseUp = async (e: MouseEvent) => {
      if (!drawing) return;
      drawing = false;
      const el = rectEl;
      const endPageEl = (e.target as HTMLElement).closest('.ab-pdf-page') as HTMLElement | null;
      const pageEl = startPageEl;
      if (!pageEl) { if (el) el.remove(); rectEl = null; return; }
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      if (w < 5 || h < 5) {
        if (el) el.remove();
        rectEl = null;
        return;
      }
      if (endPageEl && endPageEl !== pageEl) {
        console.warn('[pdf] 跨页选区暂不支持');
        if (el) el.remove();
        rectEl = null;
        return;
      }
      const pageIdx = Number(pageEl.dataset.page);
      if (!Number.isInteger(pageIdx) || pageIdx < 1) { if (el) el.remove(); rectEl = null; return; }
      const pageRect = pageEl.getBoundingClientRect();
      const cssX1 = Math.min(startX, e.clientX) - pageRect.left;
      const cssX2 = Math.max(startX, e.clientX) - pageRect.left;
      const cssY1 = Math.min(startY, e.clientY) - pageRect.top;
      const cssY2 = Math.max(startY, e.clientY) - pageRect.top;
      const cssW = pageEl.clientWidth;
      const cssH = pageEl.clientHeight;
      const pdf = pdfDocRef.current;
      if (!pdf) { if (el) el.remove(); rectEl = null; return; }
      const p = await pdf.getPage(pageIdx);
      const pb = p.getViewport({ scale: 1 });
      const pdfX1 = (cssX1 / cssW) * pb.width;
      const pdfX2 = (cssX2 / cssW) * pb.width;
      const pdfY1 = pb.height - (cssY2 / cssH) * pb.height;
      const pdfY2 = pb.height - (cssY1 / cssH) * pb.height;
      // 需求 1: 圈定后矩形锚定到页面内 (absolute, 随滚动/缩放跟随, 不钉视口)
      if (el) {
        el.style.position = 'absolute';
        el.style.left = `${Math.min(cssX1, cssX2)}px`;
        el.style.top = `${Math.min(cssY1, cssY2)}px`;
        el.style.width = `${Math.abs(cssX2 - cssX1)}px`;
        el.style.height = `${Math.abs(cssY2 - cssY1)}px`;
        el.dataset['active'] = '1';
        el.style.pointerEvents = 'none';
        pageEl.appendChild(el);  // 从 body 移到页面内, 随页滚动/缩放
        rectEl = el;
      }
      // 需求 1/3: 提取 rect 内选中文本 (异步)
      const selectedText = await extractTextInRect(pdf, pageIdx, pdfX1, pdfY1, pdfX2, pdfY2);
      // rect 即标记: 圈定后立即保存为标注 (默认蓝), popover 是快捷操作条 (动画演示/颜色/删除)
      const newAnnot: SidecarAnnot = {
        id: 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        page: pageIdx,
        rect: [pdfX1, pdfY1, pdfX2, pdfY2],
        selectedText,
        note: '',
        color: [55, 148, 255],
        createdAt: new Date().toISOString(),
      };
      handlePopoverSave(newAnnot);
      currentAnnotIdRef.current = newAnnot.id;
      setGenerating(false);  // 新标注复位 busy (旧生成后台继续, 完成有通知)
      setPopoverState({
        x: Math.max(e.clientX, startX),
        y: Math.min(startY, e.clientY),
        page: pageIdx,
        rect: [pdfX1, pdfY1, pdfX2, pdfY2],
        selectedText,
        existing: newAnnot,
      });
      popoverOpenRef.current = true;
    };

    viewer.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      viewer.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (rectEl) {
        rectEl.remove();
        rectEl = null;
      }
    };
  }, [hostPath, numPages]);

  // ---------- 删除已存在标注 (sidecar) ----------
  // 从 in-memory ref 移除 + 标记 pushDelete (写盘过滤) + 触发 rebuild.
  const handleDeleteAnnot = useCallback((id: string) => {
    // 1. 从 ref 移除
    const m = sidecarAnnotsRef.current;
    let removedPage: number | null = null;
    for (const [page, arr] of m) {
      const idx = arr.findIndex((a) => a.id === id);
      if (idx >= 0) {
        arr.splice(idx, 1);
        if (arr.length === 0) m.delete(page);
        removedPage = page;
      }
    }
    // 2. 写盘 (read-merge-write 过滤被删 id)
    if (sidecarWriterRef.current) {
      sidecarWriterRef.current.pushDelete(id);
    }
    // 3. 触发 rebuild (重建被删标注所在页)
    if (removedPage !== null) pendingRebuildPageRef.current = removedPage;
    setSidecarTick((t) => t + 1);
  }, []);

  // ---------- popover 保存: 写 sidecar + 触发 rebuild + 清空选择矩形蒙层 (keepOpen: 圈定即标记时不关) ----------
  const handlePopoverSave = useCallback((annot: SidecarAnnot, opts?: { keepOpen?: boolean }) => {
    // 1. 写盘 (debounce 500ms; mergeItems 按 id 幂等, 编辑已有 id 时覆盖)
    if (sidecarWriterRef.current) {
      sidecarWriterRef.current.push([annot]);
    }
    // 2. 更新 in-memory ref (编辑已有 id → 替换; 新建 → 追加)
    const m = sidecarAnnotsRef.current;
    const arr = m.get(annot.page);
    if (arr) {
      const idx = arr.findIndex((a) => a.id === annot.id);
      if (idx >= 0) arr[idx] = annot;
      else arr.push(annot);
    } else {
      m.set(annot.page, [annot]);
    }
    // 3. 触发 rebuild (重建标注所在页, 而非当前页 — 修复跨页新增不显示)
    pendingRebuildPageRef.current = annot.page;
    setSidecarTick((t) => t + 1);
    setDirty(false);
    if (opts?.keepOpen) return;
    // 4. 仅当 popover 是当前标注 (用户未切到新标注) 才关闭; 后台完成的旧生成不打扰新标注
    if (currentAnnotIdRef.current === annot.id) {
      setPopoverState(null);
      popoverOpenRef.current = false;
      const old = document.querySelector('.ab-pdf-selection-rect[data-active="1"]');
      if (old) old.remove();
    }
  }, []);

  /** 轻量关闭: 关工具栏不删标注 (点击外部/Esc/生成中✕); 生成后台继续, 完成有通知 */
  const handlePopoverClose = useCallback(() => {
    setPopoverState(null);
    popoverOpenRef.current = false;
    const old = document.querySelector('.ab-pdf-selection-rect[data-active="1"]');
    if (old) old.remove();
  }, []);

  /** ✕: 删除刚标记的标注 (rect 即标记, 取消 = 删除) */
  const handlePopoverCancel = useCallback(() => {
    const ex = popoverState?.existing;
    if (ex) handleDeleteAnnot(ex.id);
    setPopoverState(null);
    popoverOpenRef.current = false;
    const old = document.querySelector('.ab-pdf-selection-rect[data-active="1"]');
    if (old) old.remove();
  }, [popoverState, handleDeleteAnnot]);

  /** 颜色: 实时更新标注颜色 (rect 已标记) */
  const handleColorChange = useCallback((color: [number, number, number]) => {
    const ex = popoverState?.existing;
    if (!ex) return;
    const updated = { ...ex, color };
    handlePopoverSave(updated, { keepOpen: true });
  }, [popoverState, handlePopoverSave]);

  // ---------- 生成中状态 (动画/代码) + 取消 ----------
  const [generating, setGenerating] = useState(false);
  const generateReqRef = useRef<{ cancel: () => Promise<void> } | null>(null);
  /** 当前 popover 对应的标注 id (生成完成只关自己的 popover, 不影响新标注) */
  const currentAnnotIdRef = useRef<string>('');

  /** 取消当前生成 (ask cancel) */
  const handleCancelGenerate = useCallback(() => {
    const req = generateReqRef.current;
    generateReqRef.current = null;
    if (req) void req.cancel().catch(() => {});
  }, []);

  /** 标注信息 → 提示词 (文件名/页码/rect/选中文本) */
  const annotPrompt = useCallback((base: SidecarAnnot): string => {
    const pdfName = hostPath.split('/').pop() || '';
    return [
      `PDF 圈选内容:`,
      `- 源文件: ${pdfName}`,
      `- 页码: ${base.page}`,
      `- 圈选区域 (PDF 坐标): [${base.rect.map((n) => n.toFixed(1)).join(', ')}]`,
      `- 圈选内容:`,
      base.selectedText ? base.selectedText.slice(0, 1500) : '(未提取到文本, 按圈选区域上下文生成)',
    ].join('\n');
  }, [hostPath]);

  /** ask 包装: 返回 promise + 记录 handle 供取消; 失败抛错 (宿主 notification 提示) */
  const askWithCancel = useCallback((prompt: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      let settled = false;
      void ask(prompt, (text) => {
        if (settled) return;
        settled = true;
        generateReqRef.current = null;
        resolve(text);
      }, {
        onError: (err) => {
          if (settled) return;
          settled = true;
          generateReqRef.current = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      })
        .then((req) => {
          generateReqRef.current = req;
          // 兜底超时 (ask 内部有 90s 看门狗, 这里再兜一层)
          setTimeout(() => {
            if (settled || generateReqRef.current !== req) return;
            settled = true;
            generateReqRef.current = null;
            try { void req.cancel(); } catch { /* */ }
            reject(new Error('生成超时, 请重试'));
          }, 120_000);
        })
        .catch(() => { /* request 抛错 → onError 已触发 */ });
    });
  }, []);

  /** 生成动画: ask → 保存 html → sidecar demo → rebuild (失败 notification, 成功关 popover) */
  const handleGenerateDemo = useCallback(async (base: SidecarAnnot) => {
    setGenerating(true);
    setPopoverState((s) => (s ? { ...s } : s));
    try {
      const finalPrompt =
        `${annotPrompt(base)}\n\n` +
        '请根据以上 PDF 圈选内容生成一个**可交互**的 HTML5 算法/知识动画演示:\n' +
        '要求:\n' +
        '1. 页面顶部提供**数据输入框** (如逗号分隔的数字, 用户可输入任意数据/文本);\n' +
        '2. 点击「开始演示」后用动画逐步演示过程 (如排序: 每一步比较/交换/插入高亮标注);\n' +
        '3. 控制按钮: 输入数据 / 开始 / 暂停 / 重置;\n' +
        '4. 输出单个完整 HTML5 代码 (以 <!DOCTYPE html 开头, 内联 CSS/JS, 无外部依赖, 双击可直接打开), 紧扣圈选内容。' +
        '不要创建文件, 不要输出任何解释文字。';
      const reply = await askWithCancel(finalPrompt);
      if (!reply || !reply.trim()) throw new Error('AI 未返回内容');
      // 剥离 markdown 代码围栏 (```html ... ```)
      let content = reply;
      const fence = reply.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
      if (fence) content = fence[1];
      // 兜底: 模型可能用工具创建了 html 文件并返回说明文字 (如 "已生成 `/path.html`") → 读回该文件内容
      const genMatch = reply.match(/已生成\s*[`'"]?(\/[^\s`'"]+\.html)/i);
      if (!/<!DOCTYPE|<!doctype|<html/i.test(content) && genMatch) {
        try {
          const p = genMatch[1].replace(/^\/+/, '');
          const uri = `file://${WORKSPACE_ROOT}/${p}`;
          const stat = await fileService.getFileStat(uri).catch(() => null);
          if (stat) {
            const { content: c } = await fileService.readFile(uri);
            const text: string = typeof (c as any)?.toString === 'function' ? (c as any).toString('utf8') : String(c);
            if (/<!DOCTYPE|<!doctype|<html/i.test(text)) {
              content = text;
              console.log('[pdf] demo: 读回 AI 生成的文件', p);
            }
          }
        } catch { /* 读回失败 → 保留 reply */ }
      }
      // 保存 html (PDF 同目录, 自增)
      const htmlPath = await saveDemoHtml(hostPath, content, fileService);
      // 更新 annot interactions (demo, 同 type 覆盖) → 保存 + 关 popover
      const annot: SidecarAnnot = {
        ...base,
        interactions: [
          ...(base.interactions || []).filter((i) => i.type !== 'demo'),
          { type: 'demo', htmlPath, createdAt: new Date().toISOString() },
        ],
      };
      handlePopoverSave(annot);
      notification.info({ message: `动画演示已生成: ${htmlPath.split('/').pop()}`, type: 'info', duration: 4 });
    } catch (e: any) {
      notification.error({ message: `生成动画失败: ${e?.message || e}`, type: 'error', duration: 5 });
    } finally {
      setGenerating(false);
    }
  }, [annotPrompt, askWithCancel, hostPath, fileService, handlePopoverSave]);

  /** 代码示例: ask → 识别课程语言 → 同语言可运行代码 + 环境安装指令 → 保存 → 终端执行 */
  const handleGenerateCode = useCallback(async (base: SidecarAnnot) => {
    setGenerating(true);
    try {
      const finalPrompt =
        `${annotPrompt(base)}\n\n` +
        '请根据以上 PDF 圈选内容生成一个可运行的代码示例:\n' +
        '要求:\n' +
        '1. **识别圈选内容涉及的编程语言, 代码必须用同一种语言编写** (如课程讲 C 就用 C, 讲 Python 就用 Python);\n' +
        '2. 输出分两部分, 第一部分以 `#INSTALL#` 开头: 环境准备命令 (一行, 如 `pip install numpy` / `npm install lodash` / `apt-get install gcc`; 无需安装则写 `#INSTALL# none`);\n' +
        '3. 第二部分为完整可运行代码 (首行标注语言, 如 `#!/usr/bin/env python3` 或 `#include <stdio.h>` 或 `// node`), 完整无省略, 依赖仅必要库。\n' +
        '不要创建文件, 不要输出任何解释文字。';
      const reply = await askWithCancel(finalPrompt);
      if (!reply || !reply.trim()) throw new Error('AI 未返回内容');
      // 解析环境安装指令 (#INSTALL# xxx)
      let install = '';
      const installMatch = reply.match(/#INSTALL#\s*([^\n]+)/i);
      if (installMatch && installMatch[1].trim().toLowerCase() !== 'none') install = installMatch[1].trim();
      // 提取代码 (剥离 install 段 + markdown 围栏)
      let code = reply.replace(/#INSTALL#[^\n]*\n?/i, '');
      const fence = code.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
      if (fence) code = fence[1];
      if (!code.trim()) throw new Error('AI 未返回代码');
      // 语言判断 (基于圈选内容/代码首行)
      const head = (code.slice(0, 300) + '\n' + reply.slice(0, 300)).toLowerCase();
      const ext = /#include|\.c\b|\bc语言/.test(head) ? 'c'
        : /python|\.py\b|def |print\(/.test(head) ? 'py'
        : /node|javascript|\.js\b|const |function /.test(head) ? 'js'
        : /java\b|public class/.test(head) ? 'java'
        : 'py';
      const runner = ext === 'py' ? 'python3' : ext === 'js' ? 'node' : ext === 'c' ? 'gcc' : ext === 'java' ? 'java' : 'python3';
      // 保存代码文件 (PDF 同目录, 自增)
      const codePath = await saveCodeFile(hostPath, code, ext, fileService);
      // 更新 annot interactions (code, 记录 runner + install) → 保存 + 关 popover
      const annot: SidecarAnnot = {
        ...base,
        interactions: [
          ...(base.interactions || []).filter((i) => i.type !== 'code'),
          { type: 'code', codePath, runner, install, createdAt: new Date().toISOString() },
        ],
      };
      handlePopoverSave(annot);
      notification.info({ message: `代码示例已生成并在终端执行: ${codePath.split('/').pop()}`, type: 'info', duration: 4 });
      // 终端执行: 先环境安装, 再运行代码
      const bare = toBarePath(codePath);
      const codeDir = bare.slice(0, bare.lastIndexOf('/'));
      const fileName = bare.split('/').pop() || '';
      const runCmd = ext === 'c'
        ? `gcc "${fileName}" -o "${fileName}.out" && "./${fileName}.out"`
        : `${runner} "${fileName}"`;
      const cmd = `cd "${codeDir}"${install ? ` && ${install}` : ''} && ${runCmd}`;
      window.dispatchEvent(new CustomEvent('animbook:pdf-annot-terminal', {
        detail: { command: cmd, source: hostPath },
      }));
    } catch (e: any) {
      notification.error({ message: `代码示例生成失败: ${e?.message || e}`, type: 'error', duration: 5 });
    } finally {
      setGenerating(false);
    }
  }, [annotPrompt, askWithCancel, hostPath, fileService, handlePopoverSave]);

  /** AI 讲解/翻译/总结/考点: ask → 文本 → interaction → modal 展示 */
  const handleTextTool = useCallback(async (base: SidecarAnnot, tool: 'explain' | 'translate' | 'summary' | 'analysis') => {
    setGenerating(true);
    const labels: Record<string, string> = { explain: 'AI 讲解', translate: '翻译', summary: '总结摘要', analysis: '考点分析' };
    const prompts: Record<string, string> = {
      explain: '请用通俗易懂的语言讲解这段内容 (面向初学者, 分点说明, 配合例子)。直接输出讲解文本。',
      translate: '将这段内容翻译成目标语言: 原文是中文则译为简洁英文, 原文是英文则译为中文。直接输出译文。',
      summary: '为这段内容生成要点总结 (5-8 条, 每条一句话, 结构清晰)。直接输出总结。',
      analysis: '分析这段内容涉及的考试考点与易错点 (面向考试复习, 分点列出考点+易错点+提示)。直接输出分析。',
    };
    try {
      const finalPrompt = `${annotPrompt(base)}\n\n${prompts[tool]}不要创建文件, 不要其他解释。`;
      const text = await askWithCancel(finalPrompt);
      if (!text || !text.trim()) throw new Error('AI 未返回内容');
      const annot: SidecarAnnot = {
        ...base,
        interactions: [
          ...(base.interactions || []).filter((i) => i.type !== tool),
          { type: tool, text, createdAt: new Date().toISOString() },
        ],
      };
      handlePopoverSave(annot);
      notification.info({ message: `${labels[tool]}已生成`, type: 'info', duration: 4 });
      window.dispatchEvent(new CustomEvent('animbook:pdf-annot-modal', {
        detail: { title: labels[tool], content: text, source: hostPath },
      }));
    } catch (e: any) {
      notification.error({ message: `${labels[tool]}失败: ${e?.message || e}`, type: 'error', duration: 5 });
    } finally {
      setGenerating(false);
    }
  }, [annotPrompt, askWithCancel, hostPath, handlePopoverSave]);

  /** 生成笔记/练习/导图/闪卡/PPT: ask → markdown → 保存 .md → interaction → 打开 */
  const handleMdTool = useCallback(async (base: SidecarAnnot, tool: 'note' | 'exercise' | 'mindmap' | 'flashcard' | 'ppt') => {
    setGenerating(true);
    const labels: Record<string, string> = { note: '学习笔记', exercise: '练习题', mindmap: '思维导图', flashcard: '记忆闪卡', ppt: 'PPT大纲' };
    const prompts: Record<string, string> = {
      note: '请根据圈选内容生成学习笔记 (markdown, 分节清晰, 含要点与例子, 紧扣内容)。直接输出 markdown。',
      exercise: '请根据圈选内容生成练习题 (markdown, 含 5 道选择题 + 3 道简答题, 附答案与解析)。直接输出 markdown。',
      mindmap: '请根据圈选内容生成思维导图 (markdown 大纲, 用 - 缩进层级表达树状结构, 主题明确)。直接输出 markdown。',
      flashcard: '请根据圈选内容生成记忆闪卡 (markdown, 每张卡格式: **问题** + 换行 + 答案, 共 10 张, 覆盖核心概念)。直接输出 markdown。',
      ppt: '请根据圈选内容生成 PPT 演示大纲 (markdown, 每页: ## 页标题 + 要点列表, 5-8 页, 逻辑递进)。直接输出 markdown。',
    };
    try {
      const finalPrompt = `${annotPrompt(base)}\n\n${prompts[tool]}不要创建文件, 不要其他解释。`;
      const md = await askWithCancel(finalPrompt);
      if (!md || !md.trim()) throw new Error('AI 未返回内容');
      const filePath = await saveGeneratedFile(hostPath, labels[tool], 'md', md, fileService);
      const annot: SidecarAnnot = {
        ...base,
        interactions: [
          ...(base.interactions || []).filter((i) => i.type !== tool),
          { type: tool, filePath, createdAt: new Date().toISOString() },
        ],
      };
      handlePopoverSave(annot);
      notification.info({ message: `${labels[tool]}已生成: ${filePath.split('/').pop()}`, type: 'info', duration: 4 });
      window.dispatchEvent(new CustomEvent('animbook:pdf-annot-openfile', {
        detail: { name: labels[tool], path: filePath },
      }));
    } catch (e: any) {
      notification.error({ message: `${labels[tool]}生成失败: ${e?.message || e}`, type: 'error', duration: 5 });
    } finally {
      setGenerating(false);
    }
  }, [annotPrompt, askWithCancel, hostPath, fileService, handlePopoverSave]);

  /** 统一工具入口 (工具栏按钮 → 对应能力) */
  const handleRunTool = useCallback(async (tool: AnnotToolId, base: SidecarAnnot) => {
    if (tool === 'demo') return handleGenerateDemo(base);
    if (tool === 'code') return handleGenerateCode(base);
    if (tool === 'explain' || tool === 'translate' || tool === 'summary' || tool === 'analysis') return handleTextTool(base, tool);
    if (tool === 'note' || tool === 'exercise' || tool === 'mindmap' || tool === 'flashcard' || tool === 'ppt') return handleMdTool(base, tool);
  }, [handleGenerateDemo, handleGenerateCode, handleTextTool, handleMdTool]);


  // ---------- 跳转到指定页 ----------
  const jumpToPage = useCallback((n: number) => {
    const clamped = Math.min(numPages, Math.max(1, n));
    currentPageRef.current = clamped;
    _setCurrentPage(clamped);
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
              <span className="ab-pdf__toc-pageno">{currentPage} / {numPages}</span>
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
        {/* 缩放档位: 底部垂直排列 3 个浮动按钮 (-/100%/+), 切 fitScale */}
        {!loading && !error && (
          <div className="ab-pdf__zoom">
            <button
              className="ab-pdf__zoom-btn"
              title="缩小"
              disabled={userScaleIdx === 0}
              onClick={() => {
                zoomAnchorPageRef.current = currentPageRef.current;
                setUserScaleIdx((prev) => Math.max(0, prev - 1));
                setRebuildTick((t) => t + 1);
              }}
            >−</button>
            <button
              className="ab-pdf__zoom-btn ab-pdf__zoom-btn--current"
              title="当前缩放比例"
              disabled
            >{Math.round(USER_SCALES[userScaleIdx] * 100)}%</button>
            <button
              className="ab-pdf__zoom-btn"
              title="放大"
              disabled={userScaleIdx === USER_SCALES.length - 1}
              onClick={() => {
                zoomAnchorPageRef.current = currentPageRef.current;
                setUserScaleIdx((prev) => Math.min(USER_SCALES.length - 1, prev + 1));
                setRebuildTick((t) => t + 1);
              }}
            >+</button>
          </div>
        )}
      </div>
      <AnnotationActions />
      <AnnotPopover
        state={popoverState}
        onCancel={handlePopoverCancel}
        onClose={handlePopoverClose}
        onTool={handleRunTool}
        onCancelGenerate={handleCancelGenerate}
        generating={generating}
        onColorChange={handleColorChange}
      />
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

      {/* 缩放重建遮罩: 全量重建期间盖住, 避免看到内容清空/第一页闪烁 */}
      {zooming && (
        <div className="ab-pdf__loading" style={{ zIndex: 60 }}>
          <div className="ab-pdf__loadingText">缩放中…</div>
          <div className="ab-pdf__progress">
            <div className="ab-pdf__progressBar" style={{ width: '40%', animation: 'ab-pdf-indet 1.2s ease-in-out infinite' }} />
          </div>
        </div>
      )}

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

/** 显示标注 tip. contentOnly=true 时只显示内容 (批注场景, 不显示标题) */
function showAnnotTip(anchor: HTMLElement, meta: PdfAnnotMeta, contentOnly = false) {
  const tip = ensureAnnotTip();
  const actionLabel = meta.action ? ACTION_LABEL[meta.action.type] : '';
  tip.innerHTML = '';
  if (!contentOnly) {
    const title = document.createElement('div');
    title.className = 'ab-pdf-tip__title';
    title.textContent = meta.title || meta.subtype;
    tip.appendChild(title);
  }
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

/* ========== AI讲解 按钮 (右下角按钮行, hover 显示) ========== */
/** 创建"AI讲解"按钮 (放按钮行容器内, flex 一行排列). 显示由 hover 控制. */
/* ========== 播放动画按钮 (rect 右下角, hover 显示) ==========
 * 点击派发 animbook:pdf-annot-openfile → AnnotationActions → editorService.open (tab 打开 html). */
function createDemoOpenBtn(htmlPath: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ab-pdf-demo-open';
  btn.textContent = '播放动画';
  btn.style.cssText = `
    display: none;
    font: 600 11px/1 -apple-system, "PingFang SC", sans-serif;
    color: #fff; background: #2d8f4e; border: none; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    pointer-events: auto; white-space: nowrap;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.1)'; });
  btn.addEventListener('mouseleave', () => { btn.style.filter = 'none'; });
  btn.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    window.dispatchEvent(new CustomEvent('animbook:pdf-annot-openfile', {
      detail: { name: '动画演示', path: htmlPath },
    }));
  };
  return btn;
}

/* ========== 运行代码按钮 (rect 右下角, hover 显示) ==========
 * 点击派发 animbook:pdf-annot-terminal → 终端执行. */
function createCodeRunBtn(codePath: string, runner: string, install: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ab-pdf-code-run';
  btn.textContent = '运行代码';
  btn.style.cssText = `
    display: none;
    font: 600 11px/1 -apple-system, "PingFang SC", sans-serif;
    color: #fff; background: #3794ff; border: none; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    pointer-events: auto; white-space: nowrap;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.1)'; });
  btn.addEventListener('mouseleave', () => { btn.style.filter = 'none'; });
  btn.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    const bare = toBarePath(codePath);
    const codeDir = bare.slice(0, bare.lastIndexOf('/'));
    const fileName = bare.split('/').pop() || '';
    const runCmd = /\.c$/.test(fileName) ? `gcc "${fileName}" -o "${fileName}.out" && "./${fileName}.out"` : `${runner} "${fileName}"`;
    const cmd = `cd "${codeDir}"${install ? ` && ${install}` : ''} && ${runCmd}`;
    window.dispatchEvent(new CustomEvent('animbook:pdf-annot-terminal', {
      detail: { command: cmd, source: '' },
    }));
  };
  return btn;
}

/* ========== 文本展示按钮 (讲解/译文/摘要/考点, rect 右下角, hover 显示) ==========
 * 点击派发 animbook:pdf-annot-modal → AnnotationActions 渲染 modal 展示文本. */
function createTextModalBtn(label: string, text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ab-pdf-text-open';
  btn.textContent = label;
  btn.style.cssText = `
    display: none;
    font: 600 11px/1 -apple-system, "PingFang SC", sans-serif;
    color: #fff; background: #8b5cf6; border: none; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    pointer-events: auto; white-space: nowrap;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.1)'; });
  btn.addEventListener('mouseleave', () => { btn.style.filter = 'none'; });
  btn.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    window.dispatchEvent(new CustomEvent('animbook:pdf-annot-modal', {
      detail: { title: label, content: text },
    }));
  };
  return btn;
}

/* ========== 打开文件按钮 (笔记/练习, rect 右下角, hover 显示) ========== */
function createOpenFileBtn(label: string, filePath: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ab-pdf-file-open';
  btn.textContent = label;
  btn.style.cssText = `
    display: none;
    font: 600 11px/1 -apple-system, "PingFang SC", sans-serif;
    color: #fff; background: #e67e22; border: none; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    pointer-events: auto; white-space: nowrap;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.1)'; });
  btn.addEventListener('mouseleave', () => { btn.style.filter = 'none'; });
  btn.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    window.dispatchEvent(new CustomEvent('animbook:pdf-annot-openfile', {
      detail: { name: label, path: filePath },
    }));
  };
  return btn;
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
.ab-pdf__toc-pageno {
  font-size: 11px; font-weight: 400;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  white-space: nowrap;
}
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
/* ===== 缩放控件 (浮在 viewer 右下角) =====
   - 水平一排: 缩小 | 比例 (主色突出, 独立) | 放大
   - 按钮组去 border, 用泛化柔和阴影 (多层, 远近叠加) 替代硬边框
   - hover/active 反馈: 背景色 + scale 变化
   - 主题色: 用 vscode theme CSS 变量 + 兜底色, 暗/亮主题自适应 */
.ab-pdf__zoom {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 30;  /* 高于 toc, 不被遮挡 */
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--editorWidget-background, var(--vscode-editorWidget-background, #2d2d30));
  /* 泛化阴影: 近距 ambient + 中距扩散 + 远距 glow, 替代硬边 border */
  border-radius: 10px;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 4px 12px rgba(0, 0, 0, 0.12),
    0 16px 40px rgba(0, 0, 0, 0.20),
    0 0 0 1px rgba(0, 0, 0, 0.04);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.ab-pdf__zoom-btn {
  width: 26px;
  height: 24px;
  padding: 0;
  background: transparent;
  color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb));
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease, transform 0.12s ease, color 0.12s ease;
}
.ab-pdf__zoom-btn:hover:not(:disabled) {
  background: var(--button-hoverBackground, var(--vscode-button-hoverBackground, rgba(255, 255, 255, 0.1)));
  transform: scale(1.05);
}
.ab-pdf__zoom-btn:active:not(:disabled) {
  background: var(--button-activeBackground, var(--vscode-button-activeBackground, rgba(255, 255, 255, 0.18)));
  transform: scale(0.94);
}
.ab-pdf__zoom-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* 比例按钮: 独立显示, 主题色 (蓝) 突出, 稍宽, 左右分割线 */
.ab-pdf__zoom-btn--current {
  width: 42px;
  height: 24px;
  font-size: 11px;
  font-weight: 600;
  color: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  position: relative;
  margin: 0 2px;
}
.ab-pdf__zoom-btn--current::before,
.ab-pdf__zoom-btn--current::after {
  content: '';
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 1px;
  height: 60%;
  background: var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
}
.ab-pdf__zoom-btn--current::before { left: -2px; }
.ab-pdf__zoom-btn--current::after { right: -2px; }
.ab-pdf__zoom-btn--current:hover:not(:disabled) {
  background: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  color: var(--editor-background, var(--vscode-editor-background, #1e1e1e));
  transform: scale(1.05);
}
.ab-pdf__zoom-btn--current:hover:not(:disabled)::before,
.ab-pdf__zoom-btn--current:hover:not(:disabled)::after {
  background: transparent;
}
/* ab-pdf__toolbar / __btn / __pageno / __pagenoInput 已按需求去掉 */
`;
