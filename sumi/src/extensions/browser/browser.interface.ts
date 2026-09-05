/**
 * extensions/browser/browser.interface.ts — 内置浏览器服务契约
 *
 * 内置浏览器是一个主编辑区(main slot)的自定义 scheme 编辑器, 内部用 <iframe> 渲染网页.
 * 本服务对外暴露两类能力:
 *   1. 导航控制: open / navigate / reload / openExternal / activeUrl
 *   2. debugger (同源限制): executeJs / queryDom — 仅对同源内容 (AI 生成 HTML 的 srcDoc、
 *      走 opencode /proxy/<port>/ 反代的本地服务) 有效; 跨域外部网站受浏览器同源策略
 *      限制无法读取 DOM/执行 JS, 会抛明确错误.
 *
 * 暴露方式 (双通道, 见 docs/内置浏览器扩展设计.md):
 *   - DI token BrowserToken: 内置拓展 useInjectable(BrowserToken) 直接调
 *   - 全局命令 numas.browser.*: vsix / 其他拓展用 vscode 标准 executeCommand 调
 */

/** 内置浏览器自定义 scheme (仿 welcome, 主编辑区单实例标签) */
export const BROWSER_SCHEME = 'numas-browser';
export const BROWSER_VIEW_ID = 'numas.browser-view';

export const BrowserToken: symbol = Symbol('IBrowserService');

/** 序列化后的 DOM 元素信息 (JSON-safe, 供 debugger 返回) */
export interface BrowserDomNode {
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  attributes?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
}

/** queryDom 返回的页面快照 */
export interface BrowserDomSnapshot {
  url: string;
  title: string;
  /** 是否同源 (同源才可进一步调试) */
  sameOrigin: boolean;
  /** 命中的元素 (有 selector 时为匹配结果; 默认为可交互元素) */
  nodes: BrowserDomNode[];
}

export interface IBrowserService {
  /** 打开内置浏览器标签 (main 编辑器区); 带 url 则打开后导航到该地址 */
  open(url?: string): Promise<void>;
  /** 导航当前浏览器标签到 url (自动归一化; localhost 走反代) */
  navigate(url: string): void;
  /** 刷新当前页 */
  reload(): void;
  /** 在系统真实浏览器新标签打开当前页(或指定 url) */
  openExternal(url?: string): void;
  /** 当前真实地址 (反代前用户输入/站点的 URL) */
  activeUrl(): string;
  /** 当前 iframe 实际加载地址 (可能是 /proxy/... 反代地址) */
  activeSrc(): string;
  /** 在页面上下文执行 JS 并返回结果 (仅同源; 跨域抛错) */
  executeJs(code: string): Promise<unknown>;
  /** 查询页面 DOM (仅同源; selector 缺省返回可交互元素) */
  queryDom(selector?: string): Promise<BrowserDomSnapshot>;
  /** 向合作页面 postMessage (跨域页面的桥接通道) */
  postMessage(data: unknown): void;
  /** 在 numas 主编辑区打开本地文件 (file://); 由浏览器拦截到 PDF/可预览文件链接时调.
   *  内部: 解析 host workspace root → 拼接 file path → editorService.open(file://...) →
   *  由 PdfReaderView 等已注册的 file-scheme 组件接管. */
  openFile(absPath: string): Promise<void>;

  /** @internal 视图注册/注销 (BrowserView 挂载时调, 外部勿用) */
  _registerView(api: BrowserViewApi): void;
  _unregisterView(api: BrowserViewApi): void;
  /** @internal 取出待打开 URL (视图挂载时消费一次) */
  _consumePendingUrl(): string | undefined;
}

/** 视图向服务注册的控制句柄 (由 BrowserView 实现) */
export interface BrowserViewApi {
  navigate(url: string): void;
  reload(): void;
  getRealUrl(): string;
  getSrc(): string;
  getIframe(): HTMLIFrameElement | null;
  postMessage(data: unknown): void;
  /** 通知服务: iframe 内部地址已变 (供 debugger.activeUrl/activeSrc 实时返回) */
  notifyLocationChange?(real: string, src: string): void;
  /** 通知服务: 用户在 iframe 内点击了 .pdf (或可预览) 链接, absPath 是推断出的本地绝对路径 */
  notifyFileOpen?(absPath: string): void;
}
