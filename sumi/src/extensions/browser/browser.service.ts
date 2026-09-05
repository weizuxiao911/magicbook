/**
 * extensions/browser/browser.service.ts — 内置浏览器服务实现 (DI 单例)
 *
 * 职责:
 *   - URL 归一化: 用户输入补 http(s)://; 本地服务 (localhost/127.0.0.1:<port>)
 *     默认改写为 opencode 反代 `${base}/proxy/<port>/...` (同源 → iframe 可调试)
 *   - 视图桥接: BrowserView 挂载时注册 BrowserViewApi; 导航/刷新/取值转发给视图
 *   - debugger: executeJs / queryDom 仅同源可用 (iframe.contentWindow 可访问);
 *     跨域抛 BrowserCrossOriginError; 另提供 postMessage 桥接合作跨域页
 *
 * 详见 docs/内置浏览器扩展设计.md.
 */

import { Injectable } from '@opensumi/di';

import { appBaseUrl } from '../../infra/url';
import type {
  IBrowserService,
  BrowserViewApi,
  BrowserDomSnapshot,
  BrowserDomNode,
} from './browser.interface';

/** 跨域不可调试错误 (executeJs/queryDom 对跨域 iframe 调用时抛) */
export class BrowserCrossOriginError extends Error {
  constructor(url: string) {
    super(`内置浏览器: 目标为跨域地址 (${url}), 浏览器同源策略禁止读取 DOM/执行 JS. ` +
      '可调试场景: AI 生成 HTML(srcDoc) 或经 /proxy 反代的本地服务; 跨域合作页请用 postMessage.');
    this.name = 'BrowserCrossOriginError';
  }
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
    const base = appBaseUrl();
    if (base) {
      const rest = u.pathname.replace(/^\//, '') + u.search + u.hash;
      const proxied = `${base.replace(/\/+$/, '')}/proxy/${u.port}/${rest}`;
      return { real, src: proxied, external: proxied };
    }
  }
  return { real, src: real, external: real };
}

@Injectable()
export class BrowserServiceImpl implements IBrowserService {
  private view: BrowserViewApi | null = null;
  private pendingUrl: string | undefined;

  _registerView(api: BrowserViewApi): void {
    this.view = api;
  }
  _unregisterView(api: BrowserViewApi): void {
    if (this.view === api) this.view = null;
  }
  _consumePendingUrl(): string | undefined {
    const u = this.pendingUrl;
    this.pendingUrl = undefined;
    return u;
  }

  async open(url?: string): Promise<void> {
    // 触发打开内置浏览器标签; 由 module 的 CommandContribution / actions 按钮调 WorkbenchEditorService
    // service 层不直接依赖 editor service (避免循环), 通过模块注册的 opener 回调解耦
    this.pendingUrl = url;
    await this.opener?.();
  }

  /** @internal 由 module 注入: 打开 numas-browser:// 标签 */
  opener: (() => Promise<void>) | null = null;

  navigate(url: string): void {
    this.pendingUrl = url;
    this.view?.navigate(url);
  }
  reload(): void {
    this.view?.reload();
  }
  openExternal(url?: string): void {
    const target = url || this.view?.getRealUrl() || '';
    if (!target) return;
    const { external } = normalizeUrl(target);
    window.open(external, '_blank', 'noopener');
  }
  activeUrl(): string {
    return this.view?.getRealUrl() || this.pendingUrl || '';
  }
  activeSrc(): string {
    return this.view?.getSrc() || '';
  }
  postMessage(data: unknown): void {
    this.view?.postMessage(data);
  }

  /** 取同源 iframe 的 contentWindow; 跨域/无视图抛错 */
  private sameOriginWindow(): { win: Window; url: string } {
    const frame = this.view?.getIframe();
    const url = this.view?.getRealUrl() || frame?.src || '';
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
