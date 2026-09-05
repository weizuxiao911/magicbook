/**
 * extensions/browser/BrowserView.tsx — 内置浏览器主编辑区组件
 *
 * 布局: 顶部 URL 栏 (输入地址回车导航 / 刷新 / 在真实浏览器打开) +
 *       下方 <iframe> 撑满 main slot (宽高 100%).
 *
 * 运行时同步:
 *   - 监听 iframe.onload → 注入同源脚本拦截 a[href$=.pdf] 点击, 派 __numas_open_file__ postMessage
 *   - 轮询 iframe.contentWindow.location (同源) → deproxyUrl 还原成用户视角地址, 写回地址栏
 *
 * iframe sandbox 允许脚本/同源/表单/弹窗; 本地服务永远经 /proxy 反代 = 同源可调试.
 * 挂载时向 IBrowserService 注册 BrowserViewApi (导航/刷新/取 iframe), 卸载注销.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';

// @ts-ignore — pdfjs-dist v4 ships ESM types, loose import
import * as pdfjsLib from 'pdfjs-dist';

import { BrowserToken, type IBrowserService, type BrowserViewApi } from './browser.interface';
import { normalizeUrl, deproxyUrl } from './browser.service';
import { PortsToken, type IPortsService } from '../../service/ports/ports.interface';
import { normalizeSep } from '../../infra/path';

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, flexShrink: 0, cursor: 'pointer',
  background: 'transparent', border: 'none', borderRadius: 6,
  color: 'var(--editor-foreground, #e5e7eb)',
};

/** pdf.js worker 兜底: 用本地 node_modules 的 mjs (webpack 不打包, 我们运行时 fetch
 *  opencode 反代路径 /proxy/<port>/...). 但开发模式 numas 主进程跑 24096, 本地文件在 sumi/dist
 *  不可直接 URL 访问. 兜底走 unpkg/jsdelivr CDN (与 PdfReaderView 一致). */
const PDF_WORKER_CACHE_KEY = '__NUMAS_BROWSER_PDF_WORKER_URL__';
function ensurePdfWorker(): void {
  if (typeof window === 'undefined') return;
  const lib = pdfjsLib as any;
  if (lib.GlobalWorkerOptions?.workerSrc) return;
  const cached = (window as any)[PDF_WORKER_CACHE_KEY];
  if (cached) { lib.GlobalWorkerOptions.workerSrc = cached; return; }
  const version = lib.version || '4.10.38';
  const candidates = [
    `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
  ];
  (async () => {
    for (const u of candidates) {
      try {
        const r = await fetch(u);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const text = await r.text();
        const blob = new Blob([text], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        (window as any)[PDF_WORKER_CACHE_KEY] = blobUrl;
        lib.GlobalWorkerOptions.workerSrc = blobUrl;
        return;
      } catch { /* next */ }
    }
  })();
}
ensurePdfWorker();

/** 注入到同源 iframe 的拦截脚本. 拦截 .pdf (后续可扩展 .mp4/.html) 链接点击, 通过 postMessage
 *  通知父窗口在 numas 主编辑区打开, 避免 Chrome 在 iframe 内降级为下载. */
const HOOK_SRC = `(function(){
  if (window.__numas_patched__) return;
  window.__numas_patched__ = true;
  function isPreviewable(href) {
    if (!href) return false;
    var u; try { u = new URL(href, location.href); } catch { return false; }
    if (u.origin !== location.origin) return false;
    return /\\.pdf(\\?.*)?$/i.test(u.pathname) || /\\.pdf(\\?.*)?$/i.test(u.search);
  }
  document.addEventListener('click', function(e) {
    var a = e.target && (e.target.closest ? e.target.closest('a') : null);
    if (!a || !a.href) return;
    if (!isPreviewable(a.href)) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ type: '__numas_open_file__', href: a.href, pathname: new URL(a.href, location.href).pathname }, '*');
  }, true);
})();`;

/** 判定 URL 是否指向 PDF (pathname/query 含 .pdf, 或 content-type 是 application/pdf). */
function isPdfUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /\.pdf(\?.*)?$/i.test(u.pathname) || /\.pdf(\?.*)?$/i.test(u.search);
  } catch {
    return /\.pdf(\?.*)?$/i.test(url);
  }
}

/** PDF 渲染模式:
 *  - embed:  <embed type="application/pdf" src=blob> — 真实 Chrome 可渲染, headless / 无 PDF plugin 失败
 *  - pdfjs:  pdf.js (js实现的 PDF 解析+canvas 渲染) — 跨环境可靠, 但首屏需 fetch 全部 bytes
 /** 极简 pdf.js 多页渲染器: 拉 bytes → getDocument → 顺序渲染每页到 <canvas>, 自适应宽度. */
const PdfjsPages: React.FC<{ src: string }> = ({ src }) => {
  const [doc, setDoc] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setErr(null);
    setNumPages(0);
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const task = (pdfjsLib as any).getDocument({
          data: new Uint8Array(buf),
          cMapUrl: 'https://unpkg.com/pdfjs-dist@4.10.38/cmaps/',
          cMapPacked: true,
          isEvalSupported: false,
        });
        const d = await task.promise;
        if (cancelled) return;
        setDoc(d);
        setNumPages(d.numPages);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    if (!doc || !containerRef.current) return;
    const root = containerRef.current;
    root.innerHTML = '';
    const maxWidth = root.clientWidth || 800;
    (async () => {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const baseVp = page.getViewport({ scale: 1 });
        const scale = Math.min(maxWidth / baseVp.width, 2);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto 12px';
        canvas.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
        root.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }
    })();
  }, [doc]);

  if (err) return (
    <div style={{ padding: 24, color: '#e88' }}>
      PDF.js 渲染失败: {err}
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        可尝试: 1) 刷新; 2) 切回浏览器内置渲染; 3) 在系统真实浏览器中打开
      </div>
    </div>
  );
  if (!doc) return <div style={{ padding: 24, color: '#aaa' }}>PDF.js 加载中...</div>;
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'auto', background: '#2a2a2a', padding: 12 }}>
      <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>PDF.js 渲染 · 共 {numPages} 页</div>
    </div>
  );
};;

export const BrowserView: React.FC<{ resource?: any }> = () => {
  const browser = useInjectable<IBrowserService>(BrowserToken as any);
  const portsService = useInjectable<IPortsService>(PortsToken as any);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [addr, setAddr] = useState('');          // 地址栏文本: 用户输入的真实地址 (跟随 iframe 内部跳转)
  const [src, setSrc] = useState('about:blank'); // iframe 实际加载地址
const [nonce, setNonce] = useState(0);         // 刷新用 (改 key 强制重载)
  // PDF 模式: src 是 PDF 时, 不渲染 iframe (Chrome iframe 不渲染 PDF), 改用 PdfjsPages 渲染
  const [isPdf, setIsPdf] = useState(false);
  // refs: 供 mount 时注册的视图句柄读取最新值 (避免闭包过期)
  const addrRef = useRef('');
  const srcRef = useRef('about:blank');
  addrRef.current = addr;
  srcRef.current = src;
  // 跨 effect 共享的 view api 句柄 (注册用 effect 写入, message handler / syncAddr 读取)
  const viewApiRef = useRef<BrowserViewApi | null>(null);

  const doNavigate = useCallback((input: string) => {
    const norm = normalizeUrl(input);
    setAddr(norm.real || input);   // 地址栏展示用户输入的真实地址, 不暴露反代
    setSrc(norm.src || 'about:blank'); // iframe 实际加载地址 (本地服务 = 反代)
    // PDF 检测: 切到 PdfjsPages 渲染 (不依赖 Chrome PDF plugin, 跨环境可靠)
    setIsPdf(isPdfUrl(norm.src) && norm.src !== 'about:blank');
  }, []);
  // 始终指向最新 doNavigate (供 mount 时注册的句柄调用, 避免闭包过期)
  const doNavigateRef = useRef(doNavigate);
  doNavigateRef.current = doNavigate;

  // 同步地址栏: 把 iframe 内部地址变化映射回用户视角 (deproxy)
  const syncAddrFromIframe = useCallback(() => {
    const f = iframeRef.current;
    if (!f) return;
    let real: string;
    try {
      // 同源时 location 可读; 跨域时抛错被 catch
      real = f.contentWindow ? f.contentWindow.location.href : '';
    } catch {
      // 跨域: 用 iframe.src (已经是反代地址), 没法还原成原 user URL, 跳过同步
      return;
    }
    if (!real || real === 'about:blank') return;
    // PDF 模式: iframe 不渲染, 跳过地址同步 (addr 已经在 doNavigate 时设置)
    if (isPdf) return;
    const deproxied = deproxyUrl(real);
    if (deproxied !== addrRef.current) {
      setAddr(deproxied);
      viewApiRef.current?.notifyLocationChange?.(deproxied, real);
    }
  }, [isPdf]);

  // 挂载: 注册视图句柄 + 消费待打开 URL
  useEffect(() => {
    const api: BrowserViewApi = {
      navigate: (url: string) => doNavigateRef.current(url),
      reload: () => setNonce((n) => n + 1),
      getRealUrl: () => addrRef.current,
      getSrc: () => srcRef.current,
      getIframe: () => iframeRef.current,
      postMessage: (data: unknown) => {
        try { iframeRef.current?.contentWindow?.postMessage(data, '*'); } catch { /* 跨域降级 */ }
      },
      notifyLocationChange: (_real: string, _src: string) => {
        // 服务层收到后已更新 currentReal/currentSrc; 视图层 addr 由 syncAddrFromIframe 维护, 避免循环
      },
      notifyFileOpen: (absPath: string) => {
        void browser.openFile(absPath);
      },
    };
    viewApiRef.current = api;
    browser._registerView(api);
    const pending = browser._consumePendingUrl();
    if (pending) doNavigateRef.current(pending);
    return () => {
      browser._unregisterView(api);
      viewApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听 iframe.onload: 注入同源拦截脚本 + 同步地址栏
  useEffect(() => {
    const f = iframeRef.current;
    if (!f) return;
    const onLoad = () => {
      try {
        const doc = f.contentDocument;
        if (doc && doc.body) {
          const s = doc.createElement('script');
          s.textContent = HOOK_SRC;
          doc.body.appendChild(s);
        }
      } catch { /* 跨域, 跳过注入 */ }
      // 同步地址栏 (iframe 已导航到新页, location 反映当前 URL)
      syncAddrFromIframe();
    };
    f.addEventListener('load', onLoad);
    return () => f.removeEventListener('load', onLoad);
  }, [syncAddrFromIframe, src, nonce]);

  // 轮询同源 iframe.location (兜底覆盖 pushState/replaceState/锚点跳转等 onload 不触发的情况)
  useEffect(() => {
    if (src === 'about:blank') return;
    const id = window.setInterval(syncAddrFromIframe, 600);
    return () => window.clearInterval(id);
  }, [src, syncAddrFromIframe]);

// 接收 iframe 的 __numas_open_file__ 消息, 派给服务的 notifyFileOpen
  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const d: any = e.data;
      if (!d || d.type !== '__numas_open_file__') return;
      const href: string = d.href || '';
      const pathname: string = d.pathname || '';
      // 推断本地绝对路径: deproxyUrl 给的视角是 http://localhost:<port>/<path>.
      // 需要拿到 <port> 对应服务的监听 cwd (后端 lsof/readlink /proc 探测) → 拼接 file://.
      const real = deproxyUrl(href);
      let absPath: string | undefined;
      let port: number | undefined;
      try {
        const u = new URL(real);
        port = u.port ? Number(u.port) : undefined;
      } catch { /* ignore */ }
      if (port && portsService) {
        try {
          let entry = (await portsService.list()).find((x) => x.port === port);
          if (!entry?.cwd) {
            const cwd = await fetchAllPortsCwd(port);
            if (cwd) entry = { ...(entry || { port, detectedAt: 0 }), cwd };
          }
          if (entry?.cwd) {
            const root = normalizeSep(entry.cwd).replace(/\/+$/, '');
            absPath = root + (pathname || '/');
          }
        } catch { /* 容错, 走 fallback */ }
      }
      // 仅当路径在当前 workspace 下, 才用 PdfReaderView (file scheme → numas fs reader, 受 workspace 沙盒约束).
      // 路径在 workspace 外 (如 /Users/weizuxiao/Documents/鲸海拾贝/.../x.pdf, workspace 是 numas):
      //   numas fs 读不到 (500) → 兜底: 让 iframe 直接导航到 PDF URL, Chrome 内置 PDF viewer 渲染或下载.
      const workspace = normalizeSep(((window as any).__APP_CONFIG__?.workspaceDir || '').replace(/\/+$/, ''));
      const isInWorkspace = absPath && workspace && (normalizeSep(absPath) === workspace || normalizeSep(absPath).startsWith(workspace + '/'));
      if (absPath && isInWorkspace) {
        viewApiRef.current?.notifyFileOpen?.(absPath);
        return;
      }
      // 兜底: 路径在 workspace 外 → 让 iframe 导航到原始 href (deproxy 后), PdfjsPages 直接 fetch 渲染
      if (iframeRef.current && real) {
        const cw = iframeRef.current.contentWindow;
        if (cw) {
          try {
            // iframe.location.href 同源, 可写; 同时同步地址栏
            cw.location.href = real;
            setAddr(real);
            // src 由 iframe 导航驱动, 无需手动 set; 但跨端口路径仍走反代, 故 normalize 后给 src:
            const norm = normalizeUrl(real);
            setSrc(norm.src);
            setIsPdf(isPdfUrl(norm.src));
          } catch {
            /* 跨域时无法 navigate, 静默 */
          }
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [portsService]);

/** 兜底: 直接 fetch /ports 不带 workspace header (opencode 返回用户项目服务全集),
 *  用于内置浏览器跨工作区端口 → cwd 反查. 仅取目标端口的 cwd, 最小化数据传输. */
async function fetchAllPortsCwd(port: number): Promise<string | undefined> {
  try {
    const base = (window as any).__APP_CONFIG__?.appBaseUrl ?? '';
    const url = `${String(base).replace(/\/+$/, '')}/ports`;
    // 故意不带 x-opencode-directory header → 服务端返回用户项目服务全集 (无 workspace 过滤)
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const list = await res.json();
    if (!Array.isArray(list)) return undefined;
    const entry = list.find((x: any) => x.port === port);
    return entry?.cwd;
  } catch {
    return undefined;
  }
}

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doNavigate(addr);
  };

  const reload = () => {
    if (isPdf) {
      // PDF: 增加 nonce 让 PdfjsPages 重新加载 (fetch + render)
      setNonce((n) => n + 1);
      return;
    }
    try { iframeRef.current?.contentWindow?.location.reload(); } catch { setNonce((n) => n + 1); }
    setNonce((n) => n + 1);
  };

  const openExternal = () => {
    if (!addr) return;
    const { external } = normalizeUrl(addr);
    if (external) window.open(external, '_blank', 'noopener');
  };

  // 地址栏显示的是用户输入的真实地址, 不展示反代; 但 iframe 是反代的
  const iframeProxied = src.includes('/proxy/');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: 'var(--editor-background, #1e1e1e)' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          borderBottom: '1px solid var(--panel-border, rgba(255,255,255,0.08))',
          background: 'var(--editorWidget-background, #252526)',
        }}
      >
        <button type="button" title="刷新" style={iconBtn} onClick={reload}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <form onSubmit={onSubmit} style={{ flex: 1, display: 'flex' }}>
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="输入网址, 回车访问 (localhost 服务自动经 /proxy 反代, 同源可调试)"
            style={{
              flex: 1, height: 28, padding: '0 10px', fontSize: 13,
              color: 'var(--editor-foreground, #e5e7eb)',
              background: 'var(--input-background, rgba(255,255,255,0.06))',
              border: '1px solid var(--panel-border, rgba(255,255,255,0.12))',
              borderRadius: 6, outline: 'none', minWidth: 0,
            }}
          />
        </form>
        <button type="button" title="在系统真实浏览器新标签打开" style={iconBtn} onClick={openExternal}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {isPdf ? (
          // PDF 走 pdf.js 渲染 (跨环境可靠; 不依赖 Chrome PDF plugin)
          <PdfjsPages key={nonce} src={src} />
        ) : (
          <iframe
            key={nonce}
            ref={iframeRef}
            src={src}
            title="numas-browser"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          />
        )}
        {iframeProxied && !isPdf && (
          <div style={{ position: 'absolute', right: 8, bottom: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(0,0,0,0.55)', color: '#9ae6b4', pointerEvents: 'none' }}>
            反代同源 · 可调试
          </div>
        )}
      </div>
    </div>
  );
};
