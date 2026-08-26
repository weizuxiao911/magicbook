/**
 * PDF 标注交互 — 类型定义与行为约定
 *
 * 标注数据来源: PDF 内嵌 annotation (Text/Highlight 等) 的 contents 字段.
 * 约定 contents 格式:
 *
 *   [modal:标题] 内容...
 *   [tab:标题] 内容...
 *   [terminal] 命令...
 *
 * 即: [行为:标题] + 内容/命令. 无前缀的 annotation 视为纯信息 (仅 hover tip, 无点击行为).
 *
 * 交互行为:
 *   - modal    : 点击以模态框方式加载内容
 *   - tab      : 点击在编辑区新增 Tab 加载内容
 *   - terminal : 点击打开终端 (已存在则聚焦使用), 执行命令
 *   - 无行为   : hover 显示 tip (标题/内容预览)
 */

export type AnnotActionType = 'modal' | 'tab' | 'terminal';

export interface AnnotAction {
  type: AnnotActionType;
  title: string;
  /** modal/tab 的内容, 或 terminal 的命令 */
  payload: string;
}

export interface PdfAnnotMeta {
  /** pdf.js annotation id */
  id: string;
  /** 原始 subtype (Text/Highlight/...) */
  subtype: string;
  /** 所在页 (1-based) */
  page: number;
  /** 标题 (tip 用) */
  title: string;
  /** 内容摘要 (tip 用) */
  preview: string;
  /** 解析出的行为 (可能无) */
  action: AnnotAction | null;
  /** 原始 annotation 对象 */
  raw: any;
}

const ACTION_RE = /^\[(modal|tab|terminal)(?::([^\]]+))?\]\s*([\s\S]*)$/;

/**
 * 解析 annotation contents → 行为.
 * contents 为空时返回纯信息标注 (无行为).
 */
export function parseAnnotContents(contents: string | undefined): { title: string; action: AnnotAction | null } {
  const text = (contents || '').trim();
  if (!text) {
    return { title: '', action: null };
  }
  const m = text.match(ACTION_RE);
  if (m) {
    const type = m[1] as AnnotActionType;
    const title = m[2] || '';
    const payload = m[3] || '';
    return { title, action: { type, title, payload } };
  }
  // 无前缀: 纯信息标注, title 取第一行
  const firstLine = text.split('\n')[0].slice(0, 60);
  return { title: firstLine, action: null };
}

/**
 * 把 pdf.js annotation 转成统一元数据.
 * raw.contentsObj?.str 是 pdf.js 4.x 的 contents 字段位置.
 */
export function toAnnotMeta(annot: any, pageNum: number): PdfAnnotMeta {
  const contents = String(annot?.contentsObj?.str ?? annot?.contents ?? '');
  const { title, action } = parseAnnotContents(contents);
  return {
    id: String(annot?.id ?? ''),
    subtype: String(annot?.subtype ?? ''),
    page: pageNum,
    title: title || annot?.titleObj?.str || annot?.title || annot?.subtype || '标注',
    preview: contents.slice(0, 120),
    action,
    raw: annot,
  };
}

/**
 * 执行标注行为 (由 PdfReaderView 调用).
 * @param action  解析出的行为
 * @param handlers 各行为的处理器 (由宿主注入, 避免组件间耦合)
 */
export interface AnnotHandlers {
  modal: (title: string, content: string) => void;
  tab: (title: string, content: string) => void;
  terminal: (command: string) => void;
}

export async function runAnnotAction(action: AnnotAction, handlers: AnnotHandlers): Promise<void> {
  switch (action.type) {
    case 'modal':
      handlers.modal(action.title, action.payload);
      break;
    case 'tab':
      handlers.tab(action.title, action.payload);
      break;
    case 'terminal':
      handlers.terminal(action.payload);
      break;
  }
}
