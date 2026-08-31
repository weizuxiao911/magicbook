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

/* ========== 外部 sidecar JSON 标注 ==========
 *
 * 文件名: `.{pdfBasename}.annotation` (e.g. `数据结构.pdf` → `.数据结构.pdf.annotation`)
 * 位置: PDF 同目录, IDE 相对路径 = `/.{basename}.annotation` (前导 dot 隐藏, 仍可读)
 * 路径转换: sidecarPath() in PdfReaderView.tsx
 *
 * 用途: 用户在 PDF 上画矩形圈选区域, 弹出 popover (AI ask 风格) 选择交互能力, 持久化到 sidecar.
 *
 * Schema (version 1, 2026-09-01 扩展 interactions 加 demo 类型, 版本号不升):
 *   {
 *     "version": 1,
 *     "items": [
 *       {
 *         "id": "uuid-xxx",             // 客户端生成, 幂等写
 *         "page": 1,                    // 1-based
 *         "rect": [x1, y1, x2, y2],     // PDF 原坐标 (左下原点)
 *         "selectedText": "...",        // 圈选文本 (rect 内 pdf.js textContent 提取)
 *         "color": [55, 148, 255],      // rgb 0-255, 默认蓝
 *         "createdAt": "2026-08-29T..." // ISO
 *         "interactions": [             // 交互能力列表 (可扩展, 每 type 最多 1 个)
 *           { "type": "comment", "text": "..." },       // v1 遗留: 批注 (读盘保留, UI 暂不渲染)
 *           { "type": "prompt",  "text": "..." },       // v1 遗留: AI讲解
 *           { "type": "demo", "htmlPath": "...", "createdAt": "..." }  // v2: 动画演示产物
 *         ]
 *       }
 *     ]
 *   }
 *
 * 概念: interactions 是"标注能做什么"的可扩展列表, 每种 type 有注册表 (交互渲染/动作),
 *   本次先注册 demo (生成动画演示), 后续按需加新 type.
 */

/** 单个交互能力: comment = 悬停显示批注文本; prompt = 悬停显示"AI讲解"按钮; demo = 动画演示产物; code = 代码示例 */
export interface SidecarInteraction {
  type: 'comment' | 'prompt' | 'demo' | 'code';
  text?: string;
  /** demo: 生成的 html IDE 相对路径 */
  htmlPath?: string;
  /** code: 生成的代码文件 IDE 相对路径 + 运行器 */
  codePath?: string;
  runner?: string;
  /** 生成时间 */
  createdAt?: string;
}

/** 文件交互 (v1 遗留: 读盘兼容保留, UI 暂不渲染) */
export interface SidecarFileRef {
  /** 文件名 (显示用) */
  name: string;
  /** IDE 相对路径 (打开用, 如 /docs/a.txt) */
  path: string;
}

export interface SidecarAnnot {
  id: string;
  page: number;
  rect: [number, number, number, number];
  selectedText: string;
  note: string;
  color: [number, number, number];
  createdAt: string;
  /** 交互能力 (可多选: 批注/AI讲解), 无则纯高亮 */
  interactions?: SidecarInteraction[];
  /** 文件交互 (可选) */
  file?: SidecarFileRef;
  /** 旧版单交互字段 (兼容读, 读时合并到 interactions) */
  behavior?: SidecarInteraction;
}

export interface SidecarAnnotFile {
  version: 1;
  items: SidecarAnnot[];
}

const DEFAULT_COLOR: [number, number, number] = [55, 148, 255];

/** 校验单条 sidecar annot, 字段缺失/类型错时返回 null. 容错为主.
 *  type 字段: 历史遗留 (highlight/note), 2026-08-30 起已弃用, 读时静默 strip, 不入 in-memory. */
export function parseSidecarAnnot(raw: any): SidecarAnnot | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const page = Number(raw.page);
  if (!Number.isInteger(page) || page < 1) return null;
  const rect = raw.rect;
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const r: [number, number, number, number] = [
    Number(rect[0]) || 0,
    Number(rect[1]) || 0,
    Number(rect[2]) || 0,
    Number(rect[3]) || 0,
  ];
  // interactions: [{type:'comment'|'prompt'|'demo', ...}] (每 type 最多 1 个 — 读盘归一化去重)
  let interactions: SidecarInteraction[] | undefined;
  if (Array.isArray(raw.interactions)) {
    const list: SidecarInteraction[] = [];
    const seen = new Set<string>();
    for (const it of raw.interactions) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'comment' || it.type === 'prompt') {
        if (typeof it.text !== 'string') continue;
        if (seen.has(it.type)) continue;
        seen.add(it.type);
        list.push({ type: it.type, text: it.text });
      } else if (it.type === 'demo') {
        if (typeof it.htmlPath !== 'string' || !it.htmlPath) continue;
        if (seen.has('demo')) continue;
        seen.add('demo');
        list.push({ type: 'demo', htmlPath: it.htmlPath, createdAt: String(it.createdAt || '') });
      } else if (it.type === 'code') {
        if (typeof it.codePath !== 'string' || !it.codePath) continue;
        if (seen.has('code')) continue;
        seen.add('code');
        list.push({ type: 'code', codePath: it.codePath, runner: String(it.runner || 'python3'), createdAt: String(it.createdAt || '') });
      }
    }
    if (list.length > 0) interactions = list;
  }
  // 兼容旧版单 behavior 字段
  if (!interactions && raw.behavior && typeof raw.behavior === 'object' &&
      (raw.behavior.type === 'comment' || raw.behavior.type === 'prompt') &&
      typeof raw.behavior.text === 'string') {
    interactions = [{ type: raw.behavior.type, text: raw.behavior.text }];
  }
  // file: {name, path}
  let file: SidecarFileRef | undefined;
  const rawFile = raw.file;
  if (rawFile && typeof rawFile === 'object' && typeof rawFile.path === 'string' && rawFile.path) {
    file = { name: String(rawFile.name || rawFile.path.split('/').pop() || rawFile.path), path: rawFile.path };
  }
  return {
    id,
    page,
    rect: r,
    selectedText: typeof raw.selectedText === 'string' ? raw.selectedText : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    color: Array.isArray(raw.color) && raw.color.length >= 3
      ? [Number(raw.color[0]) || DEFAULT_COLOR[0], Number(raw.color[1]) || DEFAULT_COLOR[1], Number(raw.color[2]) || DEFAULT_COLOR[2]]
      : DEFAULT_COLOR,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    interactions,
    file,
    behavior: interactions?.[0],
  };
}

export function parseSidecarFile(raw: any): SidecarAnnotFile {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    return { version: 1, items: [] };
  }
  const items: SidecarAnnot[] = [];
  for (const it of raw.items) {
    const parsed = parseSidecarAnnot(it);
    if (parsed) items.push(parsed);
  }
  return { version: 1, items };
}

/** sidecar annot → 跟内嵌 PdfAnnotMeta 同形, 复用现有渲染热区代码.
 *  有交互能力时 title/preview 取首个 comment/prompt 文本; raw 带完整 interactions + file 供渲染. */
export function sidecarToAnnotMeta(s: SidecarAnnot): PdfAnnotMeta {
  const firstText = s.interactions?.find((i) => i.text)?.text || '';
  return {
    id: s.id,
    subtype: 'Highlight',
    page: s.page,
    title: firstText || s.note || (s.selectedText ? s.selectedText.split('\n')[0].slice(0, 60) : '已批注'),
    preview: firstText || s.note || s.selectedText.slice(0, 120),
    action: null,
    raw: {
      id: s.id,
      subtype: 'Highlight',
      rect: s.rect,
      contentsObj: { str: firstText || s.note || s.selectedText },
      color: new Uint8ClampedArray(s.color),
      interactions: s.interactions,
      file: s.file,
    },
  };
}
