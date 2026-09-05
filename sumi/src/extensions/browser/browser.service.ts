/**
 * extensions/browser/browser.service.ts — 内置浏览器服务实现 (DI 单例)
 *
 * 职责:
 *   - URL 归一化: 用户输入补 http(s)://; 本地服务 (localhost/127.0.0.1:<port>)
 *     默认改写为 opencode 反代 `${base}/proxy/<port>/...` (同源 → iframe 可调试)
 *   - 多窗口管理: 窗口 = 编辑器 tab, viewId = 首次打开 URL 的 hash
 *     (`numas-browser://<urlHash>`; 空窗口 host=browser). 各窗口独立注册 BrowserViewApi,
 *     导航/调试 API 作用于最近打开的窗口 (active).
 *   - debugger: executeJs / queryDom 仅同源可用 (iframe.contentWindow 可访问);
 *     跨域抛 BrowserCrossOriginError; 另提供 postMessage 桥接合作跨域页
 *
 * 详见 docs/内置浏览器扩展设计.md.
 */

import { Injectable } from '@opensumi/di';
import { URI } from '@opensumi/ide-core-browser';

import { appBaseUrl } from '../../infra/url';
import {
  BROWSER_EMPTY_HOST,
  BROWSER_SCHEME,
  type IBrowserService,
  type BrowserViewApi,
  type BrowserDomSnapshot,
  type BrowserDomNode,
} from './browser.interface';

/** 跨域不可调试错误 (executeJs/queryDom 对跨域 iframe 调用时抛) */
export class BrowserCrossOriginError extends Error {
  constructor(url: string) {
    super(`内置浏览器: 目标为跨域地址 (${url}), 浏览器同源策略禁止读取 DOM/执行 JS. ` +
      '可调试场景: AI 生成 HTML(srcDoc) 或经 /proxy 反代的本地服务; 跨域合作页请用 postMessage.');
    this.name = 'BrowserCrossOriginError';
  }
}

/**
 * url → 窗口唯一标识 (fnv1a 32bit hex). 多开唯一性: 同 url 复用 tab, 不同 url 多开.
 * 空/无 url → '' (默认空窗口).
 */
export function hashWindowUrl(url?: string): string {
  const s = (url || '').trim();
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 窗口 URI: 带 url → numas-browser://<hash>; 空 → numas-browser://browser (默认窗). */
export function browserUriFor(url?: string): URI {
  const hash = hashWindowUrl(url);
  return new URI(`${BROWSER_SCHEME}://${hash || BROWSER_EMPTY_HOST}`);
}

/** 从窗口 URI 解析 viewId (= host 段). 供 BrowserView 挂载时注册/查初始 url. */
export function viewIdFromUri(uri: unknown): string {
  const host = (uri as { authority?: string })?.authority || BROWSER_EMPTY_HOST;
  return host;
}

/** 把用户输入归一化为完整 URL; 返回 { real, src, external }.
 *  强制规则: localhost / 127.0.0.1 / [::1] 任意端口 → iframe src 永远走 opencode 反代 (同源可调试).
 *  - real:    用户输入归一化后的原始地址 (供地址栏展示, 保持用户视角: http://localhost:8000)
 *  - src:     iframe 实际加载地址 (本地服务时 = 反代地址; 跨域/失败时 = real)
 *  - external: 在系统真实浏览器新标签打开的地址 (本地服务时 = 反代地址, 用户的真实浏览器看到的也是
 *             "${hostname}/proxy/<port>" 实际跳到 localhost:<port>; 跨域 = real)
 *
 *  设计动机:
 *   1. 内置地址栏不变, 用户看到的始终是 "我输入的地址", 不被反代地址污染 (调试窗口里写 localhost:8000
 *      和看到 localhost:8000 是同义的, 不会疑惑 "我明明写 8000 怎么变 24096/proxy/8000").
 *   2. 在真实浏览器新标签打开时, 由于 numas 浏览器是主进程的, 直连 localhost 不可达; 必须用反代地址
 *      (用户看到的地址栏是反代 URL, 实际代理到本地服务). */
export function normalizeUrl(input: string): { real: string; src: string; external: string } {
  let raw = (input || '').trim();
  if (!raw) return { real: '', src: '', external: '' };
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && !raw.startsWith('about:')) {
    raw = 'http://' + raw;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { real: raw, src: raw, external: raw };
  }
  const real = u.toString();
  const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (isLocal && u.port) {
    // 已是反代形态 (…/proxy/<port>/…): 直接加载, 不再二次包裹 (否则 /proxy/24102/proxy/8123/)
    if (/^\/proxy\/\d+(\/|$)/.test(u.pathname)) {
      return { real, src: real, external: real };
    }
    const base = appBaseUrl();
    if (base) {
      const rest = u.pathname.replace(/^\//, '') + u.search + u.hash;
      const proxied = `${base.replace(/\/+$/, '')}/proxy/${u.port}/${rest}`;
      return { real, src: proxied, external: proxied };
    }
  }
  return { real, src: real, external: real };
}

/** 把反代地址 (${base}/proxy/<port>/rest) 还原为用户视角的原始地址 (http://localhost:<port>/rest).
 *  用于: iframe 内部跳转后, 父窗口把 iframe.contentWindow.location 同步到地址栏展示.
 *  解析失败 (非本工具产生的反代 URL) 返回原始值. */
export function deproxyUrl(src: string): string {
  if (!src) return src;
  try {
    const u = new URL(src);
    const m = u.pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
    if (!m) return src;
    const port = m[1];
    const rest = m[2] || '/';
    return `http://localhost:${port}${rest}${u.search}${u.hash}`;
  } catch {
    return src;
  }
}

/** 窗口标签名: url 有则取 域名(:端口) (多开直观, 如 localhost:8000), 否则 '内置浏览器' */
export function windowTitleFor(url?: string): string {
  if (!url) return '内置浏览器';
  try {
    const u = new URL(url.startsWith('http') ? url : 'http://' + url);
    const host = u.hostname || '内置浏览器';
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return '内置浏览器';
  }
}

@Injectable()
export class BrowserServiceImpl implements IBrowserService {
  /** 窗口集合: viewId (url hash / '' 空窗口) → 视图句柄. 多开每窗口独立注册. */
  private views = new Map<string, BrowserViewApi>();
  /** 最近注册/打开的窗口 (active): debugger/导航 API 的默认目标 */
  private activeViewId: string | null = null;
  /** 待打开 URL (open 到 tab 挂载之间暂存); 以及 hash→url 映射 (供标签名/复用) */
  private pendingByHash = new Map<string, string>();
  private knownUrls = new Map<string, string>();
  /** 每窗口最后地址 (组件卸载时上报): 编辑器 tab 非激活被 unmount, 切回重挂时恢复导航 */
  private rememberedUrls = new Map<string, string>();

  _registerView(api: BrowserViewApi, viewId: string): void {
    this.views.set(viewId, api);
    this.activeViewId = viewId;
    // 包装可选回调: 把视图层 notifyLocationChange 落到本服务的 currentReal/currentSrc,
    // 供 debugger (activeUrl/activeSrc) 实时返回 iframe 内部跳转后的地址.
    const origNotify = api.notifyLocationChange?.bind(api);
    const origFileOpen = api.notifyFileOpen?.bind(api);
    (api as any).notifyLocationChange = (real: string, src: string) => {
      try { origNotify?.(real, src); } catch { /* 视图层 handler 容错 */ }
    };
    (api as any).notifyFileOpen = (absPath: string) => {
      try { origFileOpen?.(absPath); } catch { /* 视图层 handler 容错 */ }
    };
  }
  _unregisterView(viewId: string): void {
    this.views.delete(viewId);
    if (this.activeViewId === viewId) {
      // active 关闭 → 切到剩余最后注册的窗口
      this.activeViewId = this.views.size > 0 ? Array.from(this.views.keys()).pop()! : null;
    }
  }
  _consumePendingUrl(viewId: string): string | undefined {
    const u = this.pendingByHash.get(viewId);
    this.pendingByHash.delete(viewId);
    return u;
  }
  /** 窗口重挂时取初始导航 url: open 待导航优先, 其次上次地址 (卸载时 remembered) */
  _takeStartUrl(viewId: string): string | undefined {
    const p = this._consumePendingUrl(viewId);
    if (p) return p;
    const r = this.rememberedUrls.get(viewId);
    this.rememberedUrls.delete(viewId);
    return r;
  }
  /** @internal 组件卸载时上报当前地址, 供重挂恢复 (tab 切换非激活组件会被 unmount) */
  _rememberUrl(viewId: string, url: string): void {
    if (url && url !== 'about:blank') this.rememberedUrls.set(viewId, url);
  }

  /** hash → url 注册 (open 时); 供标签名解析 */
  private noteUrl(hash: string, url: string): void {
    if (hash && url) this.knownUrls.set(hash, url);
  }
  /** 已知窗口 url (供 module 标签名), 无则空 */
  knownUrlFor(hash: string): string | undefined {
    return this.knownUrls.get(hash);
  }

  /** active 视图; 无则抛错 */
  private activeView(): BrowserViewApi {
    const v = this.activeViewId ? this.views.get(this.activeViewId) : undefined;
    if (!v) throw new Error('内置浏览器: 没有打开的窗口');
    return v;
  }

  async open(url?: string): Promise<void> {
    // 窗口唯一标识 = url 的 hash: 同 url 再 open → 编辑器聚焦已有 tab (同 URI);
    // 不同 url → 各自 tab (多开). 无 url → 默认空窗口 (host=browser).
    const hash = hashWindowUrl(url);
    if (url) {
      this.pendingByHash.set(hash, url);
      this.noteUrl(hash, url);
    }
    await this.opener?.(browserUriFor(url));
  }

  /** @internal 由 module 注入: 打开指定窗口 URI 的编辑器标签 */
  opener: ((uri: URI) => Promise<void>) | null = null;
  /** @internal 由 module 注入: 打开一个本地文件 (file:// URI), 由 file scheme 编辑器组件接管 (PDF 等) */
  fileOpener: ((absPath: string) => Promise<void>) | null = null;

  navigate(url: string): void {
    const hash = hashWindowUrl(url);
    if (url) this.noteUrl(hash, url);
    // 目标窗口: 已存在该 url 的窗口 → 导航它并聚焦其 tab; 否则导航 active
    const target = this.views.get(hash);
    if (target) {
      this.activeViewId = hash;
      target.navigate(url);
      return;
    }
    this.activeView().navigate(url);
  }
  reload(): void {
    this.activeView().reload();
  }
  openExternal(url?: string): void {
    const target = url || this.activeView().getRealUrl() || '';
    if (!target) return;
    const { external } = normalizeUrl(target);
    window.open(external, '_blank', 'noopener');
  }
  activeUrl(): string {
    try {
      return this.activeView().getRealUrl();
    } catch {
      return '';
    }
  }
  activeSrc(): string {
    try {
      return this.activeView().getSrc();
    } catch {
      return '';
    }
  }
  postMessage(data: unknown): void {
    this.activeView().postMessage(data);
  }

  async openFile(absPath: string): Promise<void> {
    if (!absPath) return;
    if (this.fileOpener) {
      await this.fileOpener(absPath);
      return;
    }
    // 兜底: 没注入 fileOpener 时走通用 anchor 触发 (file:// 浏览器原生打开, 配合 _blank)
    // 实际产品里 fileOpener 必被注入, 此分支为防御性 fallback
    window.open('file://' + absPath, '_blank', 'noopener');
  }

  /** 取最近打开窗口同源 iframe 的 contentWindow; 跨域/无视图抛错 */
  private sameOriginWindow(): { win: Window; url: string } {
    const frame = this.activeView().getIframe();
    const url = this.activeView().getRealUrl() || frame?.src || '';
    if (!frame || !frame.contentWindow) throw new Error('内置浏览器: 没有活动页面');
    // 跨域时访问 contentDocument 会抛 SecurityError
    try {
      const doc = frame.contentWindow.document;
      if (!doc) throw new Error('no document');
      return { win: frame.contentWindow, url };
    } catch {
      throw new BrowserCrossOriginError(url);
    }
  }

  async executeJs(code: string): Promise<unknown> {
    const { win } = this.sameOriginWindow();
    // 间接 eval (方法调用) → 在目标窗口全局作用域执行; eval 返回最后表达式语句的完成值,
    // 天然兼容表达式 (`document.title`) 与语句 (`const x=1; x+1` → 2). 调试 API, 调用方受信.
    return (win as unknown as { eval: (code: string) => unknown }).eval(code);
  }

  async queryDom(selector?: string): Promise<BrowserDomSnapshot> {
    const { win, url } = this.sameOriginWindow();
    const doc = win.document;
    const serialize = (el: Element): BrowserDomNode => {
      const rect = el.getBoundingClientRect();
      const attributes: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) attributes[attr.name] = attr.value;
      const node: BrowserDomNode = {
        tag: el.tagName.toLowerCase(),
        attributes,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
      if (el.id) node.id = el.id;
      const cls = (el.getAttribute('class') || '').trim();
      if (cls) node.className = cls;
      const text = (el.textContent || '').trim().slice(0, 200);
      if (text) node.text = text;
      return node;
    };
    let els: Element[];
    if (selector) {
      els = Array.from(doc.querySelectorAll(selector));
    } else {
      // 默认: 可交互元素
      els = Array.from(doc.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]'));
    }
    return {
      url,
      title: doc.title,
      sameOrigin: true,
      nodes: els.slice(0, 200).map(serialize),
    };
  }
}
