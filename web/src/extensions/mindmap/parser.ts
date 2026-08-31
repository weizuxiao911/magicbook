/**
 * Mindmap Markdown 解析/序列化 — web/src/extensions/mindmap/parser.ts
 *
 * 格式 (v2):
 *   # 主题                 (有且只有一个, 作为根节点)
 *   - 一级节点 A
 *     - 二级节点 A1
 *     - 二级节点 A2
 *   - 一级节点 B
 *     - 二级节点 B1
 *   @summary: 节点 A 的批注   (单独一行, 覆盖上面同级的连续兄弟; 在哪一级缩进就覆盖哪一级的兄弟)
 *   - 一级节点 C @count: 31   (行内修饰符, 可多个)
 *     @color: purple          (缩进修饰符, 必须大于父节点缩进, 等同上一行的行内修饰)
 *
 * 缩进: 1 个 tab = 1 级; 2 个空格 = 1 级 (兼容空格). 混用时按 tab=2 空格归一.
 * 修饰符:
 *   - @count: N    数字徽标
 *   - @color: name 颜色覆盖 (purple|blue|teal|green|red|orange|pink|gray|cyan)
 *   - @summary: x  单节点批注 (作为该节点的 ownSummary 渲染为节点级 summary box)
 *
 * Group summary (覆盖多个兄弟): 单独一行无 `-` 前缀, 与被覆盖兄弟同级缩进, 覆盖自上一个
 * group summary 或该层第一个节点起的连续兄弟.
 *
 * 限制 (v2):
 *   - 节点文本不允许内联 markdown (无链接/无强调)
 *   - 根必须有且只有一个 #, 否则回退为空根
 */

export type MindmapColor =
  | 'purple'
  | 'blue'
  | 'teal'
  | 'green'
  | 'red'
  | 'orange'
  | 'pink'
  | 'gray'
  | 'cyan';

export const COLOR_PALETTE: MindmapColor[] = [
  'purple',
  'blue',
  'teal',
  'green',
  'red',
  'orange',
  'pink',
  'cyan',
];

export const COLOR_HEX: Record<MindmapColor, string> = {
  purple: '#8b5cf6',
  blue: '#3b82f6',
  teal: '#14b8a6',
  green: '#22c55e',
  red: '#ef4444',
  orange: '#f97316',
  pink: '#ec4899',
  gray: '#6b7280',
  cyan: '#06b6d4',
};

export interface MindmapNode {
  /** 稳定 id (用于 react-flow 节点 key + 拖拽追踪). 由 parser 生成, 序列化时丢弃. */
  id: string;
  /** 节点显示文本 (去掉 `-` 和所有 `@xxx:` 修饰符) */
  name: string;
  /** 数字徽标 (可选) */
  count?: number;
  /** 颜色覆盖 (可选, 不指定则由所在一级分支决定) */
  color?: MindmapColor;
  /** 节点自身批注 (可选, 渲染为紧贴节点的 summary box) */
  ownSummary?: string;
  /** 子节点 */
  children: MindmapNode[];
  /**
   * Group summaries 挂在父节点上, 每个覆盖一组连续兄弟:
   *   summaries: [{ id, text, childIds: [child.id, ...] }, ...]
   * 不参与序列化, 仅运行期使用.
   */
  summaries?: MindmapGroupSummary[];
}

export interface MindmapGroupSummary {
  id: string;
  text: string;
  /** 覆盖的子节点 id 列表 (有序, 渲染时按此顺序画 bracket) */
  childIds: string[];
  /**
   * 显式覆盖数 (用户写的 `@summary(N):`). 缺省 = null, 表示覆盖"自上一个 summary 起的全部连续兄弟".
   * 序列化时: 若 N 等于实际 childIds 长度, 省略; 否则写 `@summary(N):` 保留.
   */
  count?: number | null;
}

export interface MindmapDoc {
  /** 根节点 (有且只有一个). 缺省时 name='', children=[]. */
  root: MindmapNode;
}

let _idSeq = 0;
const nextId = () => `n_${Date.now().toString(36)}_${(_idSeq++).toString(36)}`;

/** 解析 markdown 文本 → 树. 异常输入回退为 name='', children=[] 的空根. */
export function parseMindmapMarkdown(md: string): MindmapDoc {
  _idSeq = 0;
  const doc: MindmapDoc = { root: makeNode('') };
  if (!md || !md.trim()) return doc;

  const lines = md.split(/\r?\n/);
  // 路径栈: [{ indent: number, node: MindmapNode }]
  // 栈底 = 根 (indent = -1, 表示根的"内部缩进 = -1"比所有内容都浅)
  const stack: { indent: number; node: MindmapNode }[] = [
    { indent: -1, node: doc.root },
  ];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const indent = measureIndent(raw);
    const content = raw.slice(indent.rawLen);

    // 根标题: `# xxx` 只能出现在最顶层 (indent=0)
    if (indent.level === 0) {
      const h = /^#\s+(.+?)\s*#*\s*$/.exec(content);
      if (h) {
        doc.root.name = h[1].trim();
        // 重置栈: 根之下重新开始
        stack.length = 1;
        stack[0] = { indent: -1, node: doc.root };
        continue;
      }
    }

    // 列表项: `- xxx`
    const li = /^-\s+(.+)$/.exec(content);
    if (li) {
      // 弹栈直到栈顶 indent < 当前 indent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent.level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].node;
      const node = makeNode('');
      parseInlineModifiers(li[1], node);
      parent.children.push(node);
      stack.push({ indent: indent.level, node });
      continue;
    }

    // 修饰符行: `@xxx: ...` (无 `-` 前缀)
    // 支持 `@summary(N): text` 显式指定覆盖最近 N 个兄弟; 缺省 N 时覆盖自上一个 summary 起的全部连续兄弟
    const mod = /^@(\w+)(?:\((\d+)\))?\s*:\s*(.+)$/.exec(content);
    if (mod) {
      if (mod[1] === 'summary') {
        // Group summary: 弹栈到 indent.level <= top, 即把同层最后子节点也弹出, 落在父节点上
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent.level) {
          stack.pop();
        }
        const parent = stack[stack.length - 1].node;
        const count = mod[2] != null ? Number(mod[2]) : null;
        attachGroupSummary(parent, mod[3].trim(), count);
      } else {
        // 单节点修饰 (color / count): 弹栈到 indent.level < top, 保留同层最后子节点
        while (stack.length > 1 && stack[stack.length - 1].indent > indent.level) {
          stack.pop();
        }
        if (stack.length >= 2) {
          applyModifier(stack[stack.length - 1].node, mod[1], mod[3].trim());
        }
      }
      continue;
    }
    // 其它行 (空行/纯文本/未识别) 忽略
  }

  return doc;
}

function makeNode(name: string): MindmapNode {
  return { id: nextId(), name, children: [] };
}

interface Indent {
  /** 归一化层级 (0 = 顶层) */
  level: number;
  /** 原始缩进字符数 (用于后续 slice content) */
  rawLen: number;
}

function measureIndent(line: string): Indent {
  let spaces = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') spaces += 1;
    else if (c === '\t') spaces += 2; // 1 tab = 2 spaces
    else break;
    i++;
  }
  return { level: Math.floor(spaces / 2), rawLen: i };
}

function parseInlineModifiers(text: string, node: MindmapNode) {
  // 形如 `基础语法 @count:31 @color:purple @summary:基础语法总结`
  // 节点 name = 第一个修饰符之前的所有文本 (trim)
  // 每个修饰符值 = 该 `@xxx:` 后到下一个 `@xxx:` 或行尾之间的文本 (trim)
  const tokenRe = /@(\w+)\s*:/g;
  const tokens: { key: string; start: number; valueStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const colonIdx = m.index + m[0].length - 1; // ':' 位置
    const valueStart = colonIdx + 1;
    tokens.push({ key: m[1], start: m.index, valueStart });
  }
  if (tokens.length === 0) {
    node.name = text.trim();
    return;
  }
  node.name = text.slice(0, tokens[0].start).trim();
  for (let i = 0; i < tokens.length; i++) {
    const end = i + 1 < tokens.length ? tokens[i + 1].start : text.length;
    const value = text.slice(tokens[i].valueStart, end).trim();
    applyModifier(node, tokens[i].key, value);
  }
}

function applyModifier(node: MindmapNode, key: string, value: string) {
  switch (key) {
    case 'count': {
      const n = Number(value);
      if (!Number.isNaN(n) && n >= 0) node.count = n;
      break;
    }
    case 'color': {
      const c = value.toLowerCase() as MindmapColor;
      if (c in COLOR_HEX) node.color = c;
      break;
    }
    case 'summary': {
      node.ownSummary = value;
      break;
    }
    default:
      // 未知修饰符忽略
      break;
  }
}

function attachGroupSummary(parent: MindmapNode, text: string, count: number | null) {
  if (!parent.children.length) return;
  // count=null → 覆盖自上一个 group summary 之后的所有连续兄弟
  // count=N → 覆盖最近 N 个兄弟
  const used = new Set<string>();
  for (const s of parent.summaries || []) {
    for (const id of s.childIds) used.add(id);
  }
  const range: string[] = [];
  if (count != null) {
    const n = Math.max(1, Math.min(count, parent.children.length));
    for (let i = parent.children.length - 1; i >= 0 && range.length < n; i--) {
      const c = parent.children[i];
      if (used.has(c.id)) continue; // 跳过已被覆盖的
      range.unshift(c.id);
    }
  } else {
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const c = parent.children[i];
      if (used.has(c.id)) break; // 遇到已 used 的就停 (代表上一个 summary 的边界)
      range.unshift(c.id);
    }
  }
  if (range.length === 0) return;
  parent.summaries = parent.summaries || [];
  parent.summaries.push({ id: nextId(), text, childIds: range, count });
}

/** 树 → markdown 文本. 空根 → 空字符串. */
export function serializeMindmapMarkdown(doc: MindmapDoc): string {
  if (!doc || !doc.root) return '';
  const out: string[] = [];
  const root = doc.root;
  if (root.name) out.push(`# ${root.name}`);
  // 递归写 children + 父级 group summaries (写在 children 末尾, 缩进与 children 一致)
  const writeLevel = (children: MindmapNode[], summaries: MindmapGroupSummary[] | undefined, depth: number) => {
    for (const n of children) {
      if (!n.name && !n.children.length) continue;
      const ind = '  '.repeat(depth);
      const mods: string[] = [];
      if (n.count != null) mods.push(`@count:${n.count}`);
      if (n.color) mods.push(`@color:${n.color}`);
      if (n.ownSummary) mods.push(`@summary:${n.ownSummary}`);
      const inline = mods.length ? ' ' + mods.join(' ') : '';
      out.push(`${ind}- ${n.name}${inline}`);
      if (n.children.length) writeLevel(n.children, n.summaries, depth + 1);
    }
    if (summaries && summaries.length) {
      const ind = '  '.repeat(depth);
      for (const s of summaries) {
        // count != null 表示用户显式写了 `@summary(N):`, 必须保留 (即使 N == childIds.length)
        // count == null 表示默认"覆盖自上一个 summary 起的全部", 简写
        const n = s.count != null ? s.count : null;
        out.push(`${ind}@summary${n != null ? `(${n})` : ''}: ${s.text}`);
      }
    }
  };
  writeLevel(root.children, root.summaries, 1);
  return out.join('\n') + (out.length ? '\n' : '');
}
