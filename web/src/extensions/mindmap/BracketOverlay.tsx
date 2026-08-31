/**
 * Mindmap Bracket Overlay — web/src/extensions/mindmap/BracketOverlay.tsx
 *
 * 渲染 group summary 的 `{` 形 bracket:
 *   - 垂直 spine 在 covered children 右侧
 *   - 每个被覆盖 child 拉一根短横线到 spine
 *   - spine 中心点拉一根横线到 summary 框左边
 *
 * 用 @xyflow/react 的 ViewportPortal 让 SVG 跟着 canvas 一起 pan/zoom.
 * 节点位置从 useStore 实时拿 (支持拖动时 bracket 跟着走).
 */

import React, { useMemo } from 'react';
import { ViewportPortal, useStore, type ReactFlowState } from '@xyflow/react';
import { COLOR_HEX, type MindmapColor } from './parser';

export interface BracketSpec {
  /** summary 节点 id (用于查找位置) */
  summaryId: string;
  /** summary 颜色 (决定 bracket 颜色) */
  color: MindmapColor;
  /** 被覆盖的子节点 id 列表 */
  coveredIds: string[];
}

interface BracketOverlayProps {
  brackets: BracketSpec[];
}

const nodesSel = (s: ReactFlowState) => s.nodes;

/** bracket 边距: 从 rightmost child 右边缘到 spine 的水平距离 */
const BRACKET_GAP = 16;

export const BracketOverlay: React.FC<BracketOverlayProps> = ({ brackets }) => {
  const nodes = useStore(nodesSel);

  // 计算每个 bracket 的 SVG 路径
  const paths = useMemo(() => {
    if (!brackets.length) return [];
    // 用 layout 默认 size (根 KIND_SIZE), 而不是 measured (text 短会让 measured 远小于 layout 预留宽度)
    const layoutSize = (kind?: string): { w: number; h: number } => {
      switch (kind) {
        case 'root': return { w: 160, h: 56 };
        case 'branch': return { w: 120, h: 36 };
        case 'leaf': return { w: 200, h: 28 };
        case 'summary': return { w: 220, h: 44 };
        default: return { w: 100, h: 30 };
      }
    };
    const byId = new Map<string, { x: number; y: number; w: number; h: number; kind: string }>();
    for (const n of nodes as any[]) {
      const sz = layoutSize(n.type);
      byId.set(n.id, { x: n.position.x, y: n.position.y, w: sz.w, h: sz.h, kind: n.type || '' });
    }
    return brackets
      .map((b) => {
        const summary = byId.get(b.summaryId);
        if (!summary) return null;
        const covered: { x: number; y: number; h: number }[] = [];
        for (const id of b.coveredIds) {
          const c = byId.get(id);
          if (c) covered.push({ x: c.x + c.w, y: c.y + c.h / 2, h: c.h });
        }
        if (covered.length === 0) return null;
        const spineX = Math.max(...covered.map((c) => c.x)) + BRACKET_GAP;
        const yMin = Math.min(...covered.map((c) => c.y - c.h / 2));
        const yMax = Math.max(...covered.map((c) => c.y + c.h / 2));
        const yCenter = (yMin + yMax) / 2;
        const summaryLeftX = summary.x;
        const summaryCenterY = summary.y + summary.h / 2;

        const segs: string[] = [];
        for (const c of covered) {
          segs.push(`M ${c.x} ${c.y} L ${spineX} ${c.y}`);
        }
        segs.push(`M ${spineX} ${yMin} L ${spineX} ${yMax}`);
        segs.push(`M ${spineX} ${yCenter} L ${summaryLeftX} ${summaryCenterY}`);
        return { id: b.summaryId, color: COLOR_HEX[b.color], d: segs.join(' ') };
      })
      .filter(Boolean) as { id: string; color: string; d: string }[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brackets, nodes]);

  if (paths.length === 0) return null;

  return (
    <ViewportPortal>
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '1px',
          height: '1px',
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      >
        {/* 注意: ViewportPortal 已经在父级应用了 viewport transform,
            这里不要再套 <g transform>, 否则会 double-transform (位置偏 viewport 大小).
            path 坐标直接用 layout 坐标, viewport transform 自动转换. */}
        {paths.map((p) => (
          <path
            key={p.id}
            d={p.d}
            stroke={p.color}
            strokeWidth={1.5}
            fill="none"
            opacity={0.7}
          />
        ))}
      </svg>
    </ViewportPortal>
  );
};

