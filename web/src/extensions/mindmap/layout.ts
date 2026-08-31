/**
 * Mindmap 自动布局 — web/src/extensions/mindmap/layout.ts
 *
 * 树状右向布局 (无 dagre 依赖, 纯 JS):
 *   - 根在左, 一级分支向右扇开
 *   - 每个分支的子树在该分支右侧继续向右递归展开
 *   - 兄弟节点垂直堆叠, 居中于父节点 y
 *   - 摘要 (summary) 位于最右, 垂直居中于其覆盖的兄弟
 *
 * 节点尺寸:
 *   - 缺省按类型估算 (root/branch/leaf/summary)
 *   - 调用方可注入实测尺寸 (来自 react-flow node.measured) 提升精度
 */

import type { Edge } from '@xyflow/react';
import type { MindmapNodeData } from './nodes';
import type { MindmapColor } from './parser';

export interface NodeSize {
  width: number;
  height: number;
}

const DEFAULT_SIZE: NodeSize = { width: 120, height: 32 };

const KIND_SIZE: Record<MindmapNodeData['kind'], NodeSize> = {
  root: { width: 160, height: 56 },
  branch: { width: 120, height: 36 },
  leaf: { width: 100, height: 28 },
  summary: { width: 200, height: 44 },
};

const H_GAP = 56; // 父子水平间距
const V_GAP = 12; // 兄弟垂直间距
const SUMMARY_GAP = 48; // summary 框与最右节点的间距
const ROOT_GAP = 96; // 根到一级分支的水平距离

export interface LaidOutNode {
  id: string;
  position: { x: number; y: number };
  size: NodeSize;
  data: MindmapNodeData;
}

export interface LaidOutGraph {
  nodes: LaidOutNode[];
  edges: Edge[];
  bounds: { width: number; height: number };
}

export interface LayoutInput {
  root: { id: string; name: string; children: LaidOutChild[] };
  summaries: LaidOutSummary[];
}

export interface LaidOutChild {
  id: string;
  name: string;
  color: MindmapColor;
  count?: number;
  ownSummary?: string;
  children: LaidOutChild[];
}

export interface LaidOutSummary {
  id: string;
  text: string;
  childIds: string[];
  color: MindmapColor;
}

export function layoutMindmap(
  input: LayoutInput,
  getNodeSize?: (id: string, kind: MindmapNodeData['kind']) => NodeSize,
): LaidOutGraph {
  const sizeOf = (id: string, kind: MindmapNodeData['kind']) =>
    (getNodeSize && getNodeSize(id, kind)) || KIND_SIZE[kind] || DEFAULT_SIZE;

  const out: LaidOutNode[] = [];
  const edges: Edge[] = [];

  // 1) 递归布局子树, 返回 { width, height, rightX, ids }
  //    rightX = 子树最右节点的 x + width (供父级计算)
  //    width/height = 子树总尺寸 (含所有后代)
  //    ids = 子树内所有节点 id (用于父级调整 y)
  const layoutSubtree = (
    c: LaidOutChild,
    depth: number,
    parentRightX: number,
    color: string,
  ): { width: number; height: number; rightX: number; ids: string[] } => {
    const isBranch = depth === 1 || (c.children && c.children.length > 0);
    const kind: MindmapNodeData['kind'] = depth === 0 ? 'branch' : isBranch ? 'branch' : 'leaf';
    const sz = sizeOf(c.id, kind);
    const ids: string[] = [c.id];

    if (!c.children || c.children.length === 0) {
      // 叶子节点
      out.push({
        id: c.id,
        position: { x: parentRightX + H_GAP, y: 0 },
        size: sz,
        data: {
          label: c.name,
          color: c.color || color,
          count: c.count,
          depth,
          kind,
          nodeId: c.id,
          ownSummary: c.ownSummary,
        },
      });
      return {
        width: H_GAP + sz.width,
        height: sz.height,
        rightX: parentRightX + H_GAP + sz.width,
        ids,
      };
    }

    // 有子节点: 递归布局子节点
    const childBoxes: { box: ReturnType<typeof layoutSubtree>; c: LaidOutChild }[] = [];
    for (const gc of c.children) {
      const box = layoutSubtree(gc, depth + 1, parentRightX + sz.width, c.color || color);
      childBoxes.push({ box, c: gc });
      edges.push({
        id: `e_${c.id}_${gc.id}`,
        source: c.id,
        target: gc.id,
        type: 'mindmapEdge',
        data: { color: c.color || color },
      });
    }
    const totalChildH = childBoxes.reduce((acc, b, i) => acc + b.box.height + (i > 0 ? V_GAP : 0), 0);
    const myH = Math.max(sz.height, totalChildH);
    const myW = sz.width + H_GAP + Math.max(0, ...childBoxes.map((b) => b.box.width - H_GAP));

    // 放置自身
    out.push({
      id: c.id,
      position: { x: parentRightX, y: 0 },
      size: sz,
      data: {
        label: c.name,
        color: c.color || color,
        count: c.count,
        depth,
        kind,
        nodeId: c.id,
        ownSummary: c.ownSummary,
      },
    });

    // 放置子节点: y 依次累加, 整体居中于 myH
    let yCursor = (myH - totalChildH) / 2;
    for (const { box } of childBoxes) {
      const yCentered = yCursor + box.height / 2;
      const node = out.find((n) => n.id === box.ids[0])!;
      node.position.y = yCentered - node.size.height / 2;
      yCursor += box.height + V_GAP;
      // 累计 ids
      for (const id of box.ids) ids.push(id);
    }
    const selfNode = out.find((n) => n.id === c.id)!;
    selfNode.position.y = myH / 2 - sz.height / 2;

    const rightX = Math.max(
      parentRightX + sz.width,
      ...childBoxes.map((b) => b.box.rightX),
    );

    return { width: myW, height: myH, rightX, ids };
  };

  // 2) 布局根 + 一级分支
  const rootSize = sizeOf(input.root.id, 'root');
  const branchBoxes: { box: ReturnType<typeof layoutSubtree>; c: LaidOutChild }[] = [];
  for (const c of input.root.children) {
    const box = layoutSubtree(c, 1, rootSize.width + ROOT_GAP, 'gray');
    branchBoxes.push({ box, c });
    edges.push({
      id: `e_root_${c.id}`,
      source: input.root.id,
      target: c.id,
      type: 'mindmapEdge',
      data: { color: c.color || 'gray' },
    });
  }

  // 3) 根节点位置
  const totalBranchH = branchBoxes.reduce((acc, b, i) => acc + b.box.height + (i > 0 ? V_GAP : 0), 0);
  out.push({
    id: input.root.id,
    position: { x: 40, y: totalBranchH / 2 - rootSize.height / 2 },
    size: rootSize,
    data: { label: input.root.name, color: 'gray', depth: 0, kind: 'root', nodeId: input.root.id },
  });

  // 4) 一级分支位置 (在 root 右侧, 各垂直居中于 slot)
  let yCursor = 0;
  for (const branchInfo of branchBoxes) {
    const box = branchInfo.box;
    const slotH = box.height;
    // 分支节点居中于 slot
    const branchNode = out.find((n) => n.id === box.ids[0])!;
    const desiredY = yCursor + slotH / 2 - branchNode.size.height / 2;
    const yOffset = desiredY - branchNode.position.y;
    // 整棵子树 y 平移
    for (const id of box.ids) {
      const node = out.find((n) => n.id === id);
      if (node) node.position.y += yOffset;
    }
    yCursor += slotH + V_GAP;
  }

  // 5) summaries: 位于最右, 垂直居中于覆盖兄弟
  let maxRight = 0;
  for (const n of out) {
    maxRight = Math.max(maxRight, n.position.x + n.size.width);
  }
  for (const sum of input.summaries) {
    const coveredNodes = out.filter((n) => sum.childIds.includes(n.id));
    if (coveredNodes.length === 0) continue;
    const rightmostX = Math.max(...coveredNodes.map((n) => n.position.x + n.size.width));
    const yMin = Math.min(...coveredNodes.map((n) => n.position.y));
    const yMax = Math.max(...coveredNodes.map((n) => n.position.y + n.size.height));
    const sz = sizeOf(sum.id, 'summary');
    const sx = rightmostX + SUMMARY_GAP;
    const sy = (yMin + yMax) / 2 - sz.height / 2;
    out.push({
      id: sum.id,
      position: { x: sx, y: sy },
      size: sz,
      data: {
        label: '',
        color: sum.color as any,
        depth: 99,
        kind: 'summary',
        nodeId: sum.id,
        summaryText: sum.text,
      },
    });
    // 用一根边把最右被覆盖节点连到 summary
    const lastCovered = coveredNodes.reduce((acc, n) =>
      n.position.x + n.size.width > acc.position.x + acc.size.width ? n : acc,
    );
    edges.push({
      id: `e_sum_${sum.id}`,
      source: lastCovered.id,
      target: sum.id,
      type: 'mindmapEdge',
      data: { color: sum.color, dashed: true, kind: 'summary' },
    });
    maxRight = Math.max(maxRight, sx + sz.width);
  }

  return {
    nodes: out,
    edges,
    bounds: { width: maxRight + 40, height: totalBranchH + 40 },
  };
}
