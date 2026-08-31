/**
 * Mindmap 节点/边类型定义 — web/src/extensions/mindmap/nodes.tsx
 *
 * 渲染层次:
 *   - 根节点 (RootNode): 一行大字, 浅色背景圆角矩形, 居中
 *   - 分支节点 (BranchNode): 一级分支, 带分支色边框/底色, 中等字号
 *   - 叶子节点 (LeafNode): 深层节点, 较小字号, 可选 count 圆形徽标
 *   - 批注节点 (SummaryNode): 右侧批注框, 浅色描边, 多个子节点用 bracket 连接到
 */
import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  COLOR_HEX,
  type MindmapColor,
} from './parser';

export type MindmapNodeKind = 'root' | 'branch' | 'leaf' | 'summary';

export interface MindmapNodeData extends Record<string, unknown> {
  /** 节点显示名 */
  label: string;
  /** 分支色 (从父级继承或自身覆盖) */
  color: MindmapColor;
  /** 数字徽标 (可选) */
  count?: number;
  /** 节点深度 (0 = 根, 1 = 一级, 2+ = 叶子) */
  depth: number;
  /** 节点类型 */
  kind: MindmapNodeKind;
  /** 节点稳定 id (与 node.id 一致, 供双击编辑等使用) */
  nodeId: string;
  /** 节点 own summary (批注, 可选) */
  ownSummary?: string;
  /** group summary 文本 (仅 summary 节点有) */
  summaryText?: string;
  /** group summary 覆盖的子节点 label 列表 (用于 bracket 渲染说明, 可选) */
  coverLabels?: string[];
}

/** 根节点 */
export const RootNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as MindmapNodeData;
  return (
    <div
      style={{
        padding: '12px 24px',
        background: '#1e293b',
        color: '#f1f5f9',
        borderRadius: 8,
        fontSize: 18,
        fontWeight: 600,
        border: selected ? '2px solid #60a5fa' : '1px solid #475569',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        minWidth: 80,
        textAlign: 'center',
      }}
    >
      {d.label}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
};

/** 分支节点 (一级子节点) */
export const BranchNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as MindmapNodeData;
  const color = COLOR_HEX[d.color];
  return (
    <div
      style={{
        padding: '8px 14px',
        background: hexToRgba(color, 0.15),
        color: '#e2e8f0',
        borderRadius: 6,
        fontSize: 14,
        fontWeight: 500,
        border: selected ? `2px solid ${color}` : `1.5px solid ${color}`,
        minWidth: 60,
        textAlign: 'center',
        whiteSpace: 'nowrap',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      {d.label}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
};

/** 叶子节点 (二级及以下) */
export const LeafNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as MindmapNodeData;
  const color = COLOR_HEX[d.color];
  return (
    <div
      style={{
        position: 'relative',
        padding: '4px 10px',
        background: 'transparent',
        color: '#e2e8f0',
        fontSize: 12,
        fontWeight: 400,
        minWidth: 40,
        maxWidth: 200,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'left',
      }}
      title={d.label}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>{d.label}</span>
      {d.count != null && (
        <span
          style={{
            display: 'inline-block',
            marginLeft: 6,
            minWidth: 18,
            height: 18,
            lineHeight: '18px',
            padding: '0 5px',
            background: color,
            color: '#fff',
            borderRadius: 9,
            fontSize: 10,
            fontWeight: 600,
            textAlign: 'center',
            verticalAlign: 'middle',
          }}
        >
          {d.count}
        </span>
      )}
      {selected && (
        <span
          style={{
            position: 'absolute',
            left: -2,
            top: -2,
            right: -2,
            bottom: -2,
            border: `1.5px dashed ${color}`,
            borderRadius: 4,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
};

/** 批注框节点 (group summary) */
export const SummaryNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as MindmapNodeData;
  const color = COLOR_HEX[d.color];
  return (
    <div
      style={{
        padding: '8px 12px',
        background: '#0f172a',
        color: '#cbd5e1',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 400,
        border: selected ? `2px solid ${color}` : `1px solid #475569`,
        maxWidth: 220,
        lineHeight: 1.5,
        textAlign: 'left',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <span style={{ color, fontWeight: 500, marginRight: 4 }}>●</span>
      {d.summaryText}
    </div>
  );
};

export const nodeTypes = {
  root: RootNode,
  branch: BranchNode,
  leaf: LeafNode,
  summary: SummaryNode,
};

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
