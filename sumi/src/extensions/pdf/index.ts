/**
 * PDF 阅读器拓展 — extensions/pdf/ (按 animbook 方式)
 *
 * OpenSumi 原生: BrowserModule + BrowserEditorContribution,
 * 双击 .pdf 走 pdf.js 流式分页渲染. 读取走 fs.readBinaryAbsolute (fetch arrayBuffer, 无损).
 */
export { PdfReaderModule, PdfReaderContribution } from './module';
export { PdfReaderView } from './PdfReaderView';
