/**
 * MindmapView — 思维脑图查看/编辑组件
 *
 * 嵌入 vsix 的 markmap UMD bundle (markmap-view@0.18.12 + markmap-toolbar@0.18.12).
 * 与 EditorComponent 路由对接: 打开 .mindmap / .mm 文件时框架路由到这里.
 *
 * 行为 (v1, 最小可用 + 右键/双击):
 *   - 初始加载: 从 fs 读文件 (来自 resource), parseMindmapMarkdown → 树 → 喂给 markmap 渲染
 *   - 切换节点折叠: markmap 内置 (click 节点)
 *   - 工具栏: markmap 工具栏 (zoom, expand all, etc.)
 *   - 导出/导入: markmap 支持 → 用户可下载 .md / 加载 .md
 *   - 保存: 暂未实现 (markmap 编辑会改内部树, 需要时由 markmap 自身 toolbar 操作或重新读 fs)
 *     简化: 工具栏"保存"按钮 (自实现) 调 fs.write 写回; markmap 的导出 markdown 通过 edit textarea 实现
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  parseMindmapMarkdown,
  serializeMindmapMarkdown,
  type MindmapNode,
} from './parser';

// Markmap 库 UMD (vsix 自带, copy 到 assets/mindmap 目录)
// markmap-view 暴露全局 window.markmap (含 Markmap, transformMarkdown, deriveOptions)
// markmap-toolbar 暴露 window.markmapToolbar (Toolbar)
declare global {
  interface Window {
    markmap?: any;
    markmapToolbar?: any;
  }
}

export interface MindmapViewProps {
  /** 文件原始内容 (markdown), 从 resource / fs 读 */
  content?: string;
  /** 文件路径 (用于保存回 fs) */
  resourcePath?: string;
  /** 内容变更回调 (供宿主在 debounce 后调 fs.write 写回) */
  onChange?: (md: string) => void;
}

export const MindmapView: React.FC<MindmapViewProps> = ({
  content = '',
  resourcePath,
  onChange,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mmRef = useRef<any>(null);
  const toolbarRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [root, setRoot] = useState<MindmapNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: number[] } | null>(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  // 加载脚本: CDN 优先 (与 PDF 拓展同样的回退策略). markmap-view@0.18.12 + markmap-toolbar@0.18.12 + d3@7.9.0
  useEffect(() => {
    if (window.markmap && window.markmapToolbar) return;
    const version = '0.18.12';
    const d3Version = '7.9.0';
    const sources: { name: string; src: string; blob?: string }[] = [
      {
        name: 'd3',
        src: `https://cdn.jsdelivr.net/npm/d3@${d3Version}/dist/d3.min.js`,
      },
      {
        name: 'markmap',
        src: `https://cdn.jsdelivr.net/npm/markmap-view@${version}/dist/browser/index.js`,
      },
      {
        name: 'markmapToolbar',
        src: `https://cdn.jsdelivr.net/npm/markmap-toolbar@${version}/dist/index.js`,
      },
    ];
    const tryAttach = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('failed: ' + src));
        document.head.appendChild(s);
      });
    (async () => {
      for (const src of sources) {
        try {
          await tryAttach(src.src);
        } catch {
          // 失败保留 error 状态, 后续渲染时再报错
        }
      }
      if (window.markmap) render();
      else setError('markmap 库加载失败, 请检查网络 (或 cdn 配置)');
    })();
    return () => {
      // 不卸载, 单例
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 解析 markdown → 树
  useEffect(() => {
    const roots = parseMindmapMarkdown(content);
    setRoot(roots[0] || { name: '根', children: [] });
  }, [content]);

  const render = useCallback(() => {
    const mm = window.markmap;
    const tlb = window.markmapToolbar;
    const svg = svgRef.current;
    const wrap = wrapRef.current;
    if (!mm || !svg || !wrap) return;
    // 清旧
    if (mmRef.current) {
      try {
        mmRef.current.destroy?.();
      } catch { /* ignore */ }
      mmRef.current = null;
    }
    if (toolbarRef.current?.el) {
      try { wrap.removeChild(toolbarRef.current.el); } catch { /* ignore */ }
    }
    // 渲染
    const opts = mm.deriveOptions({ ...mm.defaultOptions, duration: 200 });
    mmRef.current = mm.Markmap(svg, opts);
    const md = serializeMdFromTree(root || { name: '根', children: [] });
    try {
      mmRef.current.renderData(mm.transformMarkdown(md, opts));
    } catch (e: any) {
      setError(e?.message || '渲染失败');
      return;
    }
    // 工具栏
    if (tlb) {
      const tb = new tlb.Toolbar();
      toolbarRef.current = tb;
      tb.attach(mmRef.current);
      // 挂到 wrap 顶部
      const el = (tb as any).el;
      if (el && el.parentNode !== wrap) {
        el.style.position = 'absolute';
        el.style.top = '8px';
        el.style.right = '8px';
        el.style.zIndex = '10';
        wrap.appendChild(el);
      }
    }
  }, [root]);

  useEffect(() => {
    if (window.markmap && root !== null) render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // 右键菜单: 增删改/导出 md
  const onContextMenu = (e: React.MouseEvent, path: number[] = []) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path });
  };

  // 路径查找 (DFS 索引 → 节点)
  const findNodeByPath = (nodes: MindmapNode[], path: number[]): MindmapNode | null => {
    let cur: MindmapNode | undefined = { name: '_root', children: nodes };
    for (const idx of path) {
      cur = cur!.children?.[idx];
      if (!cur) return null;
    }
    return cur === undefined || cur.name === '_root' ? (cur.children?.[0] as MindmapNode) || null : cur;
  };

  const setNodeByPath = (nodes: MindmapNode[], path: number[], newNode: MindmapNode) => {
    let cur: MindmapNode = { name: '_', children: nodes };
    for (let i = 0; i < path.length; i++) {
      const idx = path[i];
      if (i === path.length - 1) {
        cur.children[idx] = newNode;
      } else {
        cur = cur.children[idx];
      }
    }
  };

  const updateRoot = (mut: (root: MindmapNode) => void) => {
    setRoot((prev) => {
      if (!prev) return { name: '根', children: [] };
      const cloned = JSON.parse(JSON.stringify(prev));
      mut(cloned);
      return cloned;
    });
  };

  const onAddChild = (path: number[]) => {
    updateRoot((r) => {
      const p = findNodeByPath(r.children, path) || r;
      p.children = p.children || [];
      p.children.push({ name: '新节点', children: [] });
    });
  };

  const onAddSibling = (path: number[]) => {
    if (path.length === 0) return;
    updateRoot((r) => {
      const parentPath = path.slice(0, -1);
      const idx = path[path.length - 1];
      const parent = findNodeByPath(r.children, parentPath) || r;
      parent.children = parent.children || [];
      parent.children.splice(idx + 1, 0, { name: '新节点', children: [] });
    });
  };

  const onDelete = (path: number[]) => {
    if (path.length === 0) return;
    updateRoot((r) => {
      const parentPath = path.slice(0, -1);
      const idx = path[path.length - 1];
      const parent = findNodeByPath(r.children, parentPath) || r;
      parent.children?.splice(idx, 1);
    });
  };

  const onEditStart = (path: number[]) => {
    setEditingIdx(path.length > 0 ? path[path.length - 1] : -1);
  };
  const onEditSave = (path: number[], newName: string) => {
    updateRoot((r) => {
      const parentPath = path.slice(0, -1);
      const idx = path[path.length - 1];
      const parent = findNodeByPath(r.children, parentPath) || r;
      if (parent.children && parent.children[idx]) {
        parent.children[idx].name = newName;
      }
    });
    setEditingIdx(null);
  };

  // 保存: 序列化 → 通知宿主 (由宿主调 fs.write)
  const onSave = () => {
    if (!root) return;
    const md = serializeMdFromTree(root);
    onChange?.(md);
  };

  // 导出 md (给用户下载)
  const onExport = () => {
    if (!root) return;
    const md = serializeMdFromTree(root);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (resourcePath?.split('/').pop() || 'mindmap') + '.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  // 导入 (从 textarea 文本替换)
  const onImport = () => {
    const roots = parseMindmapMarkdown(importText);
    if (roots.length > 0) {
      setRoot(roots[0]);
      setShowImport(false);
      setImportText('');
    }
  };

  if (error) {
    return (
      <div style={{ padding: 20, color: '#f87171', fontFamily: 'sans-serif' }}>
        Mindmap 加载失败: {error}
        <br />
        请确认 assets/mindmap/ 下有 d3.min.js / markmap.min.js / markmap-toolbar.min.js
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      <svg
        ref={svgRef}
        style={{ width: '100%', height: '100%' }}
        onContextMenu={(e) => onContextMenu(e, [])}
      />
      {/* 工具栏 (markmap toolbar 自动挂入 + 顶栏额外按钮) */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 9,
          display: 'flex',
          gap: 4,
        }}
      >
        <button onClick={onSave} title="保存">保存</button>
        <button onClick={onExport} title="导出 md">导出</button>
        <button
          onClick={() => {
            setShowImport(true);
            setImportText(serializeMdFromTree(root || { name: '根', children: [] }));
          }}
          title="导入 md"
        >
          导入
        </button>
      </div>

      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 4,
            padding: 4,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 120,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { onAddChild(contextMenu.path); setContextMenu(null); }}>+ 子节点</button>
          {contextMenu.path.length > 0 && (
            <button onClick={() => { onAddSibling(contextMenu.path); setContextMenu(null); }}>+ 兄弟</button>
          )}
          <button onClick={() => { onEditStart(contextMenu.path); setContextMenu(null); }}>编辑</button>
          {contextMenu.path.length > 0 && (
            <button onClick={() => { onDelete(contextMenu.path); setContextMenu(null); }} style={{ color: '#f87171' }}>删除</button>
          )}
        </div>
      )}

      {editingIdx !== null && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 8,
            padding: 16,
            zIndex: 1001,
            minWidth: 320,
          }}
        >
          <div style={{ marginBottom: 8, color: '#9ca3af', fontSize: 12 }}>编辑节点</div>
          <EditForm
            initialValue={getNodeNameByPath(root, editingIdx === -1 ? [] : [editingIdx])}
            onSave={(v) => onEditSave(editingIdx === -1 ? [] : [editingIdx], v)}
            onCancel={() => setEditingIdx(null)}
          />
        </div>
      )}

      {showImport && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 8,
            padding: 16,
            zIndex: 1001,
            minWidth: 480,
          }}
        >
          <div style={{ marginBottom: 8, color: '#9ca3af', fontSize: 12 }}>导入 Markdown (覆盖当前树)</div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            style={{ width: '100%', height: 200, background: '#111827', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 4, padding: 4, fontFamily: 'monospace' }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowImport(false)}>取消</button>
            <button onClick={onImport}>导入</button>
          </div>
        </div>
      )}
    </div>
  );
};

/** 由路径 [i,j,...] 取节点 name (用于编辑弹窗初值) */
function getNodeNameByPath(root: MindmapNode | null, path: number[]): string {
  if (!root) return '';
  let cur: MindmapNode = root;
  for (const idx of path) {
    cur = cur.children?.[idx];
    if (!cur) return '';
  }
  return cur.name;
}

/** 序列化单根树 (内部用, 与 parser.serializeMindmapMarkdown 等价但单根) */
function serializeMdFromTree(root: MindmapNode): string {
  return serializeMindmapMarkdown([root]);
}

/** 编辑弹窗内嵌表单 */
const EditForm: React.FC<{ initialValue: string; onSave: (v: string) => void; onCancel: () => void }> = ({
  initialValue,
  onSave,
  onCancel,
}) => {
  const [v, setV] = useState(initialValue);
  return (
    <div>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(v);
          else if (e.key === 'Escape') onCancel();
        }}
        autoFocus
        style={{ width: '100%', padding: 6, background: '#111827', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 4 }}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel}>取消</button>
        <button onClick={() => onSave(v)}>保存</button>
      </div>
    </div>
  );
};
