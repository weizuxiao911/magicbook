/**
 * Mindmap 视图 — web/src/extensions/mindmap/MindmapView.tsx
 *
 * 基于 @xyflow/react 渲染右侧树状脑图. 树来自 parser.ts 解析的 markdown.
 *
 * 资源加载: 走 codeblitz IFileServiceClient (HTTP 走 opencode server fs API, 无长连接).
 *   跟 explorer / 其他 editor 走同一条路. 不依赖 service 层 FsPty.
 *   依据 AGENTS.md 分层架构铁律: extensions 不得直连 service.
 *
 * 功能:
 *   - 自动布局 (自实现树布局, 不依赖 dagre)
 *   - 分支配色: 一级分支按 COLOR_PALETTE 顺序分配; 子级继承; @color 覆盖
 *   - 数字徽标: 节点 @count → 圆形彩色徽标
 *   - 批注框: own summary + group summary, 渲染为最右矩形
 *   - 操作: 右键菜单 (增子/增兄/编辑/删除/换色), 拖拽改父, 双击编辑
 *   - 保存: 序列化为 markdown, 写回 fs
 *   - 导入/导出 md (本地, 不写 fs)
 *
 * 节点位置: 内存维护 (拖动后不写回 .md); 重开文件会重新布局.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-file-service';
import { URI } from '@opensumi/ide-core-common';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type EdgeProps,
  BaseEdge,
  getBezierPath,
  Panel,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  parseMindmapMarkdown,
  serializeMindmapMarkdown,
  COLOR_PALETTE,
  COLOR_HEX,
  type MindmapDoc,
  type MindmapNode,
  type MindmapColor,
  type MindmapGroupSummary,
} from './parser';
import { layoutMindmap, type LaidOutChild, type LaidOutSummary, type NodeSize } from './layout';
import {
  nodeTypes,
  type MindmapNodeData,
  type MindmapNodeKind,
} from './nodes';
import './MindmapView.css';

export interface MindmapViewProps {
  /** 文件资源 (opensumi IResource). 从 resource.uri 读文件内容. */
  resource: { uri: URI; name: string };
}

interface MindmapState {
  doc: MindmapDoc;
  /** 节点 id → 手动覆盖的位置 (拖动后); 缺省 = null = 走自动布局 */
  positions: Record<string, { x: number; y: number }>;
}

const MindmapViewInner: React.FC<MindmapViewProps> = ({ resource }) => {
  const fileService = useInjectable<IFileServiceClient>(IFileServiceClient);
  const [state, setState] = useState<MindmapState>(() => {
    const initialDoc: MindmapDoc = { root: { id: 'n_initial', name: '加载中…', children: [] } };
    return { doc: initialDoc, positions: {} };
  });
  const [loaded, setLoaded] = useState(false);
  const [rfNodes, setRfNodes] = useState<Node<MindmapNodeData>[]>([]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [editing, setEditing] = useState<{ nodeId: string; value: string } | null>(null);
  const [colorPicker, setColorPicker] = useState<{ nodeId: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  const measuredSizes = useRef<Record<string, NodeSize>>({});
  const initialContentRef = useRef<string | null>(null);
  const lastLoadedUriRef = useRef<string>('');

  // 1) 加载文件内容
  useEffect(() => {
    const uri = resource.uri.toString();
    if (lastLoadedUriRef.current === uri) return; // 同文件不重读
    lastLoadedUriRef.current = uri;
    (async () => {
      try {
        const stat = await fileService.getFileStat(resource.uri.toString());
        if (!stat) {
          setLoaded(true);
          return;
        }
        const { content } = await fileService.readFile(resource.uri.toString());
        const text = typeof (content as any)?.toString === 'function'
          ? (content as any).toString('utf8')
          : String(content || '');
        initialContentRef.current = text;
        setState({ doc: parseMindmapMarkdown(text), positions: {} });
        setLoaded(true);
      } catch (e: any) {
        setError(`加载失败: ${e?.message || e}`);
        setLoaded(true);
      }
    })();
  }, [resource.uri, fileService]);

  // 2) doc 变化 → 分配颜色 + 计算布局 + 更新 nodes/edges
  const buildRf = useCallback((doc: MindmapDoc, positions: Record<string, { x: number; y: number }>) => {
    // 2.1 一级分支分配色 (按 COLOR_PALETTE 顺序, @color 覆盖)
    const rootColor: MindmapColor = 'gray';
    for (let i = 0; i < doc.root.children.length; i++) {
      const c = doc.root.children[i];
      if (!c.color) {
        c.color = COLOR_PALETTE[i % COLOR_PALETTE.length];
      }
    }
    // 子级继承: 递归
    const inheritColor = (n: MindmapNode, color: MindmapColor) => {
      if (!n.color) n.color = color;
      for (const gc of n.children) inheritColor(gc, n.color as MindmapColor);
    };
    for (const c of doc.root.children) inheritColor(c, c.color as MindmapColor);

    // 2.2 收集 summaries
    const allSummaries: LaidOutSummary[] = [];
    const collectSum = (n: MindmapNode) => {
      for (const s of n.summaries || []) {
        allSummaries.push({ id: s.id, text: s.text, childIds: s.childIds, color: n.color as MindmapColor });
      }
      for (const c of n.children) collectSum(c);
    };
    collectSum(doc.root);

    // 2.3 转换为 layout input
    const toChild = (n: MindmapNode): LaidOutChild => ({
      id: n.id,
      name: n.name,
      color: n.color as MindmapColor,
      count: n.count,
      ownSummary: n.ownSummary,
      children: n.children.map(toChild),
    });
    const input = {
      root: { id: doc.root.id, name: doc.root.name, children: doc.root.children.map(toChild) },
      summaries: allSummaries,
    };

    // 2.4 布局
    const getSize = (id: string, kind: MindmapNodeKind): NodeSize => {
      const m = measuredSizes.current[id];
      if (m) return m;
      // 缺省估算 (与 layout.ts KIND_SIZE 同步)
      switch (kind) {
        case 'root': return { width: 160, height: 56 };
        case 'branch': return { width: 120, height: 36 };
        case 'leaf': return { width: 100, height: 28 };
        case 'summary': return { width: 200, height: 44 };
      }
    };
    let laid = layoutMindmap(input, getSize);

    // 2.5 应用手动位置覆盖
    if (Object.keys(positions).length > 0) {
      laid = {
        ...laid,
        nodes: laid.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
      };
    }

    // 2.6 转 react-flow nodes/edges
    const rfNodes: Node<MindmapNodeData>[] = laid.nodes.map((n) => ({
      id: n.id,
      type: n.data.kind,
      position: n.position,
      data: n.data,
      draggable: true,
      selectable: true,
    }));
    const rfEdges: Edge[] = laid.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'mindmapEdge',
      data: e.data,
      selectable: false,
    }));
    return { rfNodes, rfEdges };
  }, []);

  // 3) doc/positions 变化时重建
  useEffect(() => {
    const { rfNodes: n, rfEdges: e } = buildRf(state.doc, state.positions);
    setRfNodes(n);
    setRfEdges(e);
    // 自动 fitView (仅首次)
    requestAnimationFrame(() => {
      try {
        fitView({ padding: 0.2, duration: 200 });
      } catch { /* ignore */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.doc, state.positions, buildRf]);

  // 4) nodes 变化回调: 应用位置变更
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => {
      const next = applyNodeChanges(changes, nds) as Node<MindmapNodeData>[];
      // 同步位置到 state.positions
      const newPositions: Record<string, { x: number; y: number }> = { ...state.positions };
      let dirty = false;
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) {
          newPositions[ch.id] = ch.position;
          dirty = true;
        }
      }
      if (dirty) setState((s) => ({ ...s, positions: newPositions }));
      return next;
    });
  }, [state.positions]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setRfEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  // 5) 节点尺寸测量 (用于精确布局)
  const onNodesInitialized = useCallback((nodes: Node[]) => {
    let dirty = false;
    for (const n of nodes) {
      const w = (n as any).measured?.width || n.width;
      const h = (n as any).measured?.height || n.height;
      if (w && h && (!measuredSizes.current[n.id] ||
          measuredSizes.current[n.id].width !== w ||
          measuredSizes.current[n.id].height !== h)) {
        measuredSizes.current[n.id] = { width: w, height: h };
        dirty = true;
      }
    }
    if (dirty) {
      // 触发重新布局 (用精确尺寸)
      setState((s) => ({ ...s }));
    }
  }, []);

  // 6) 拖拽结束: 检测是否落在某个节点上 → 改父
  const onNodeDragStop = useCallback((_: any, dragged: Node) => {
    if (dragged.data.kind === 'root' || dragged.data.kind === 'summary') return;
    const draggedPos = dragged.position;
    const draggedW = (dragged as any).measured?.width || 100;
    const draggedH = (dragged as any).measured?.height || 28;
    const draggedCx = draggedPos.x + draggedW / 2;
    const draggedCy = draggedPos.y + draggedH / 2;

    // 找落点所在的节点 (除了自己, 且不是 summary)
    let targetId: string | null = null;
    for (const n of rfNodes) {
      if (n.id === dragged.id) continue;
      if (n.data.kind === 'summary') continue;
      const w = (n as any).measured?.width || 120;
      const h = (n as any).measured?.height || 36;
      const x1 = n.position.x;
      const y1 = n.position.y;
      const x2 = x1 + w;
      const y2 = y1 + h;
      // 拖动节点的中心在目标节点的边界内
      if (draggedCx >= x1 && draggedCx <= x2 && draggedCy >= y1 && draggedCy <= y2) {
        targetId = n.id;
        break;
      }
    }
    if (!targetId) return; // 落到空地, 不改父
    if (targetId === dragged.id) return;

    // 防止成环: target 不能是 dragged 的后代
    const isDescendant = (parentId: string, suspectId: string): boolean => {
      const find = (n: MindmapNode): boolean => {
        if (n.id === parentId) {
          // 在 parentId 子树中找 suspectId
          const inSub = (m: MindmapNode): boolean => m.id === suspectId || (m.children || []).some(inSub);
          return (n.children || []).some(inSub);
        }
        return false;
      };
      const findRoot = (n: MindmapNode): boolean => {
        if (n.id === parentId) return find(n);
        return (n.children || []).some(findRoot);
      };
      return findRoot(state.doc.root);
    };
    if (isDescendant(dragged.id, targetId)) return; // 成环, 拒绝

    // 执行改父
    setState((s) => {
      const next: MindmapDoc = { root: cloneNode(s.doc.root) };
      // 1. 从原父移除
      const removeFromParent = (parent: MindmapNode, id: string): MindmapNode | null => {
        const idx = parent.children.findIndex((c) => c.id === id);
        if (idx >= 0) {
          return parent.children.splice(idx, 1)[0];
        }
        for (const c of parent.children) {
          const r = removeFromParent(c, id);
          if (r) return r;
        }
        return null;
      };
      const moved = removeFromParent(next.root, dragged.id);
      if (!moved) return s;
      // 2. 插入到新父
      const insertInto = (parent: MindmapNode, id: string, node: MindmapNode) => {
        if (parent.id === id) {
          parent.children.push(node);
          return true;
        }
        for (const c of parent.children) {
          if (insertInto(c, id, node)) return true;
        }
        return false;
      };
      insertInto(next.root, targetId, moved);
      // 3. 清理: 重新分配颜色 (一级分支按顺序)
      // 清空颜色覆盖
      const clearColors = (n: MindmapNode) => {
        // 保留用户显式指定的颜色 (有 ownSummary 等)
        // 简化: 全部清掉, 由分配阶段重置
        // 但用户可能 @color 显式指定 — 区分:
        // 策略: 保留, 但一级分支按 palette 重新分配时仍用
        for (const c of n.children) clearColors(c);
      };
      void clearColors; // 不动
      // 4. 清理手动位置
      return { ...s, doc: next, positions: {} };
    });
  }, [rfNodes, state.doc.root]);

  // 7) 右键菜单
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  // 8) 双击编辑
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node<MindmapNodeData>) => {
    if (node.data.kind === 'root' || node.data.kind === 'summary') {
      // 根和 summary 双击 = 编辑 (summary 编辑文本)
      setEditing({ nodeId: node.id, value: node.data.label || node.data.summaryText || '' });
      return;
    }
    setEditing({ nodeId: node.id, value: node.data.label });
  }, []);

  // 9) 节点操作
  const findById = (n: MindmapNode, id: string): MindmapNode | null => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const r = findById(c, id);
      if (r) return r;
    }
    return null;
  };
  const findParent = (n: MindmapNode, id: string, parent: MindmapNode | null = null): MindmapNode | null => {
    if (n.id === id) return parent;
    for (const c of n.children) {
      const r = findParent(c, id, n);
      if (r) return r;
    }
    return null;
  };

  const addChild = (parentId: string) => {
    setState((s) => {
      const next = { doc: { root: cloneNode(s.doc.root) }, positions: { ...s.positions } };
      const p = findById(next.doc.root, parentId);
      if (!p) return s;
      const newNode: MindmapNode = { id: newId(), name: '新节点', children: [], color: p.color };
      p.children.push(newNode);
      return next;
    });
    setContextMenu(null);
  };

  const addSibling = (nodeId: string) => {
    if (nodeId === state.doc.root.id) return;
    setState((s) => {
      const next = { doc: { root: cloneNode(s.doc.root) }, positions: { ...s.positions } };
      const p = findParent(next.doc.root, nodeId);
      if (!p) return s;
      const idx = p.children.findIndex((c) => c.id === nodeId);
      const sib = p.children[idx];
      const newNode: MindmapNode = { id: newId(), name: '新节点', children: [], color: sib.color };
      p.children.splice(idx + 1, 0, newNode);
      return next;
    });
    setContextMenu(null);
  };

  const deleteNode = (nodeId: string) => {
    if (nodeId === state.doc.root.id) return;
    setState((s) => {
      const next = { doc: { root: cloneNode(s.doc.root) }, positions: { ...s.positions } };
      const p = findParent(next.doc.root, nodeId);
      if (!p) return s;
      p.children = p.children.filter((c) => c.id !== nodeId);
      return next;
    });
    setContextMenu(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    setState((s) => {
      const next = { doc: { root: cloneNode(s.doc.root) }, positions: { ...s.positions } };
      // 找节点 (可能在 root 或 summary)
      const n = findById(next.doc.root, editing.nodeId);
      if (n) {
        if (n.id === next.doc.root.id) next.doc.root.name = editing.value;
        else n.name = editing.value;
      } else {
        // 可能是 summary
        const sum = findSummary(next.doc.root, editing.nodeId);
        if (sum) sum.text = editing.value;
      }
      return next;
    });
    setEditing(null);
  };

  const setNodeColor = (nodeId: string, color: MindmapColor) => {
    setState((s) => {
      const next = { doc: { root: cloneNode(s.doc.root) }, positions: { ...s.positions } };
      const n = findById(next.doc.root, nodeId);
      if (n) n.color = color;
      return next;
    });
    setColorPicker(null);
  };

  // 10) 保存
  const onSave = async () => {
    const md = serializeMindmapMarkdown(state.doc);
    try {
      const stat = await fileService.getFileStat(resource.uri.toString());
      if (!stat) {
        setError('文件不存在');
        return;
      }
      const buf = new TextEncoder().encode(md);
      await fileService.setContent(stat, md, { encoding: 'utf8' });
      initialContentRef.current = md;
      setSaveHint('已保存');
      setTimeout(() => setSaveHint(null), 1500);
    } catch (e: any) {
      setError(`保存失败: ${e?.message || e}`);
    }
  };

  // 11) 导出
  const onExport = () => {
    const md = serializeMindmapMarkdown(state.doc);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (resource.name || 'mindmap').replace(/\.(mindmap|md|markdown)$/i, '') + '.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  // 12) 导入
  const onImport = () => {
    const doc = parseMindmapMarkdown(importText);
    setState({ doc, positions: {} });
    setImportOpen(false);
    setImportText('');
  };

  // 13) 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+S
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
      // Esc 关闭菜单/弹窗
      if (e.key === 'Escape') {
        setContextMenu(null);
        setColorPicker(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.doc, resource.uri]);

  const memoNodeTypes = useMemo(() => nodeTypes, []);
  const memoEdgeTypes = useMemo(() => ({ mindmapEdge: MindmapEdge }), []);

  if (error) {
    return <div style={{ padding: 20, color: '#f87171' }}>Mindmap 加载失败: {error}</div>;
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={memoNodeTypes}
        edgeTypes={memoEdgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeClick={(_, n) => setSelectedId(n.id)}
        onPaneClick={() => { setSelectedId(null); setContextMenu(null); }}
        fitView
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={20} color="#334155" />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* 顶部工具栏 */}
      <Panel position="top-left" style={{ display: 'flex', gap: 4 }}>
        <button className="mm-btn" onClick={onSave} title="保存 (Cmd/Ctrl+S)">保存</button>
        <button className="mm-btn" onClick={onExport}>导出</button>
        <button className="mm-btn" onClick={() => { setImportOpen(true); setImportText(serializeMindmapMarkdown(state.doc)); }}>导入</button>
        {saveHint && <span style={{ color: '#22c55e', fontSize: 12, alignSelf: 'center' }}>{saveHint}</span>}
      </Panel>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="mm-menu"
          style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => addChild(contextMenu.nodeId)}>+ 子节点</button>
          {contextMenu.nodeId !== state.doc.root.id && (
            <button onClick={() => addSibling(contextMenu.nodeId)}>+ 兄弟</button>
          )}
          <button onClick={() => { const n = findById(state.doc.root, contextMenu.nodeId); setEditing({ nodeId: contextMenu.nodeId, value: n?.name || '' }); setContextMenu(null); }}>编辑</button>
          {contextMenu.nodeId !== state.doc.root.id && (
            <button onClick={() => setColorPicker({ nodeId: contextMenu.nodeId })}>换色</button>
          )}
          {contextMenu.nodeId !== state.doc.root.id && (
            <button className="mm-danger" onClick={() => deleteNode(contextMenu.nodeId)}>删除</button>
          )}
        </div>
      )}

      {/* 颜色选择器 */}
      {colorPicker && (
        <div
          className="mm-menu mm-color-picker"
          style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mm-title">选择颜色 (覆盖该节点及子树)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => setNodeColor(colorPicker.nodeId, c)}
                style={{
                  background: COLOR_HEX[c],
                  color: '#fff',
                  padding: '6px 8px',
                  fontSize: 11,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                {c}
              </button>
            ))}
          </div>
          <button className="mm-btn" style={{ marginTop: 8, width: '100%' }} onClick={() => setColorPicker(null)}>取消</button>
        </div>
      )}

      {/* 编辑弹窗 */}
      {editing && (
        <div className="mm-modal" onClick={() => setEditing(null)}>
          <div className="mm-modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="mm-title">编辑节点</div>
            <input
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                else if (e.key === 'Escape') setEditing(null);
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="mm-btn" onClick={() => setEditing(null)}>取消</button>
              <button className="mm-btn mm-primary" onClick={saveEdit}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 导入弹窗 */}
      {importOpen && (
        <div className="mm-modal" onClick={() => setImportOpen(false)}>
          <div className="mm-modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="mm-title">导入 Markdown (覆盖当前)</div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              style={{
                width: '100%', height: 200, background: '#0f172a', color: '#e2e8f0',
                border: '1px solid #334155', borderRadius: 4, padding: 6, fontFamily: 'monospace',
                fontSize: 12,
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="mm-btn" onClick={() => setImportOpen(false)}>取消</button>
              <button className="mm-btn mm-primary" onClick={onImport}>导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** 自定义边: 贝塞尔曲线, 颜色继承 source 分支色, summary 边为虚线 */
const MindmapEdge: React.FC<EdgeProps> = ({
  id, sourceX, sourceY, targetX, targetY, data,
}) => {
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY });
  const color = (data as any)?.color || '#475569';
  const dashed = (data as any)?.dashed;
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: 1.5,
        strokeDasharray: dashed ? '4 4' : undefined,
        fill: 'none',
        opacity: 0.7,
      }}
    />
  );
};

// 工具函数
let _idCounter = 0;
function newId(): string {
  return `n_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;
}

function cloneNode(n: MindmapNode): MindmapNode {
  return {
    ...n,
    children: n.children.map(cloneNode),
    summaries: n.summaries ? n.summaries.map((s) => ({ ...s, childIds: [...s.childIds] })) : undefined,
  };
}

function findSummary(n: MindmapNode, sumId: string): MindmapGroupSummary | null {
  for (const s of n.summaries || []) {
    if (s.id === sumId) return s;
  }
  for (const c of n.children) {
    const r = findSummary(c, sumId);
    if (r) return r;
  }
  return null;
}

export const MindmapView: React.FC<MindmapViewProps> = (props) => (
  <ReactFlowProvider>
    <MindmapViewInner {...props} />
  </ReactFlowProvider>
);
