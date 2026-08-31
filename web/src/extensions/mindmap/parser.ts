/**
 * Mindmap Markdown 解析/序列化 — web/src/extensions/mindmap/parser.ts
 *
 * 格式: 嵌套 markdown 树 (与 markmap 库输入一致)
 *   # 根节点
 *   ## 子节点
 *   ### 孙节点
 *   ## 另一个子节点
 *   ...
 *
 * 解析: markdown 文本 → 树 (数组嵌套 {name, children})
 * 序列化: 树 → markdown 文本 (用于保存回 .md)
 *
 * 限制 (v1):
 *   - 节点文本 = 一行 markdown heading text (无内联格式, 无链接)
 *   - 层级 = heading 缩进深度 (#/##/###/...)
 *   - 同一 heading 级别 = 兄弟节点
 */

export interface MindmapNode {
  /** 节点显示文本 (heading 文本, 不含 #) */
  name: string;
  /** 子节点 (嵌套) */
  children: MindmapNode[];
}

/** 解析 markdown 文本 → 树. 空文本 → 空树. */
export function parseMindmapMarkdown(md: string): MindmapNode[] {
  if (!md || !md.trim()) return [];
  const lines = md.split(/\r?\n/);
  // 收集所有 heading 行 (跳过其它, 严格按 heading 树)
  const headings: { level: number; name: string }[] = [];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      headings.push({ level: m[1].length, name: m[2].trim() });
    }
  }
  if (headings.length === 0) return [];
  return buildTree(headings);
}

/** 由扁平 heading 列表 (按文件顺序, 层级) 构建嵌套树. 第一个 heading 必须是根 (最小层级). */
function buildTree(headings: { level: number; name: string }[]): MindmapNode[] {
  if (headings.length === 0) return [];
  // 找根的层级 (最小 level, 通常 1 即 #); root 可以是多个 (兄弟根) — 但 markmap 单根, 我们允许多个作为多个根
  // 简化: 按文件顺序建栈式树
  type Stack = { node: MindmapNode; level: number }[];
  const roots: MindmapNode[] = [];
  const stack: Stack = [];
  for (const h of headings) {
    const node: MindmapNode = { name: h.name, children: [] };
    // 弹栈直到栈顶 level < 当前 level (栈顶是父或祖先)
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, level: h.level });
  }
  return roots;
}

/** 树 → markdown 文本. 空树 → 空字符串. */
export function serializeMindmapMarkdown(roots: MindmapNode[]): string {
  if (!roots || roots.length === 0) return '';
  const lines: string[] = [];
  const walk = (nodes: MindmapNode[], level: number) => {
    for (const n of nodes) {
      if (!n.name) continue;
      lines.push('#'.repeat(Math.min(6, Math.max(1, level))) + ' ' + n.name);
      if (n.children && n.children.length > 0) walk(n.children, level + 1);
    }
  };
  walk(roots, 1);
  return lines.join('\n') + '\n';
}
