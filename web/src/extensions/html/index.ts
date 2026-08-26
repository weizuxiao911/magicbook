/**
 * HTML 预览/编辑拓展 — extensions/html/
 *
 * OpenSumi 拓展:
 *   - module.ts        HtmlModule + HtmlContribution (注册 editor component)
 *   - HtmlViewer.tsx   iframe 预览 + monaco 编辑切换
 *
 * 双击资源管理器中的 .html/.htm 文件默认 webview 渲染, 工具栏可切换文本编辑.
 */
export { HtmlModule, HtmlContribution } from './module';
export { HtmlViewer } from './HtmlViewer';
