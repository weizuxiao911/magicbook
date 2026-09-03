/**
 * AnnotPopover — 画矩形后悬浮工具栏 (Word 选中文本风格: 一行紧凑图标按钮)
 *
 * rect 圈定即标记, popover 提供快捷工具 (每个工具是**直接动作按钮**, 无表单):
 *   - 生成动画: ask opencode 生成 HTML5 动画 → 关联标注 (rect 显示"播放动画"按钮)
 *   - 代码示例: ask opencode 生成可运行代码 → 保存 → 终端执行
 *   - 颜色: 色板面板 (选色实时更新标注)
 *   - ✕: 删除该标注
 *
 * 生成中: 按钮变 loading, 提供「取消生成」; 失败由宿主用 codeblitz notification 提示.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SidecarAnnot } from './annotations';

export interface PopoverState {
  /** 弹窗左上角 client 坐标 */
  x: number;
  y: number;
  /** PDF 页 (1-based) */
  page: number;
  /** 选区 PDF 原坐标 */
  rect: [number, number, number, number];
  /** 选中文本快照 */
  selectedText: string;
  /** 编辑模式: 双击已有标注时传入 */
  existing?: SidecarAnnot;
}

/** 交互能力工具 id */
export type AnnotToolId = 'demo' | 'code' | 'explain' | 'translate' | 'summary' | 'analysis'
  | 'note' | 'exercise' | 'mindmap' | 'flashcard' | 'ppt';

export interface AnnotPopoverProps {
  state: PopoverState | null;
  /** ✕: 非生成中删除标注 + 关闭; 生成中仅关闭 (标注保留, 生成后台继续) */
  onCancel: () => void;
  /** 轻量关闭: 关闭工具栏不删标注 (点击外部 / Esc / 生成中 ✕) */
  onClose: () => void;
  /** 执行交互能力工具 (直接动作, 宿主执行 ask → 产物 → sidecar) */
  onTool: (tool: AnnotToolId, base: SidecarAnnot) => Promise<void>;
  /** 取消当前生成 */
  onCancelGenerate: () => void;
  /** 生成中 (任一工具进行中) */
  generating: boolean;
  /** 更新标注颜色 */
  onColorChange: (color: [number, number, number]) => void;
}

/** 工具注册表 (可扩展): 工具栏按钮顺序即此数组顺序 (AI 辅助学习工具集) */
const TOOLS: Array<{ id: AnnotToolId; label: string }> = [
  { id: 'demo', label: '动画演示' },
  { id: 'code', label: '代码示例' },
  { id: 'explain', label: 'AI讲解' },
  { id: 'translate', label: '翻译' },
  { id: 'summary', label: '总结摘要' },
  { id: 'analysis', label: '考点分析' },
  { id: 'note', label: '生成笔记' },
  { id: 'exercise', label: '生成练习' },
  { id: 'mindmap', label: '思维导图' },
  { id: 'flashcard', label: '记忆闪卡' },
  { id: 'ppt', label: 'PPT大纲' },
];

const COLORS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: '蓝', rgb: [55, 148, 255] },
  { name: '黄', rgb: [255, 200, 60] },
  { name: '绿', rgb: [80, 200, 120] },
  { name: '红', rgb: [240, 90, 90] },
  { name: '紫', rgb: [160, 100, 240] },
  { name: '橙', rgb: [255, 140, 40] },
  { name: '青', rgb: [40, 200, 200] },
  { name: '粉', rgb: [240, 120, 170] },
];

/** 当前展开的面板: main = 工具栏 */
type Panel = 'main' | 'color';

export const AnnotPopover: React.FC<AnnotPopoverProps> = ({
  state,
  onCancel,
  onClose,
  onTool,
  onCancelGenerate,
  generating,
  onColorChange,
}) => {
  const [panel, setPanel] = useState<Panel>('main');
  const [colorIdx, setColorIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // 每次 state 变化时重置 (新建) 或预填 (编辑 existing)
  useEffect(() => {
    if (state) {
      setPanel('main');
      const ex = state.existing;
      const ci = ex?.color ? COLORS.findIndex((c) => c.rgb[0] === ex.color![0] && c.rgb[1] === ex.color![1] && c.rgb[2] === ex.color![2]) : -1;
      setColorIdx(ci >= 0 ? ci : 0);
    }
  }, [state]);

  // Esc: 颜色面板返回工具栏; 工具栏轻量关闭 (标注保留)
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (panel !== 'main') setPanel('main');
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, panel, onClose]);

  // 点击外部: 轻量关闭 (标注保留), 生成中也可关 (生成后台继续, 完成有通知)
  useEffect(() => {
    if (!state) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.ab-annot-popover') || t.closest('.ab-pdf-annot')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [state, onClose]);

  // 定位: 紧贴标注位置 (锚点 = 标注右上角 state.x/y), 按可视区上下左右 4 向自适应.
  const W = 300;
  const PAD = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const pickPos = (ax: number, ay: number, h: number) => {
    const candidates: Array<{ left: number; top: number }> = [
      { left: ax + PAD, top: ay + PAD },           // 右下 (默认)
      { left: ax - W - PAD, top: ay + PAD },       // 左下
      { left: ax + PAD, top: ay - h - PAD },       // 右上
      { left: ax - W - PAD, top: ay - h - PAD },   // 左上
    ];
    let pos = candidates[0];
    for (const c of candidates) {
      if (c.left >= 4 && c.left + W <= vw - 4 && c.top >= 4 && c.top + h <= vh - 4) {
        pos = c;
        break;
      }
    }
    return {
      left: Math.max(4, Math.min(pos.left, vw - W - 4)),
      top: Math.max(4, Math.min(pos.top, vh - h - 4)),
    };
  };
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!state) return;
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (!h) return;
    const next = pickPos(state.x, state.y, h);
    setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [state, panel, generating, colorIdx]);

  if (!state) return null;

  const baseAnnot = (): SidecarAnnot => {
    const ex = state.existing;
    return {
      id: ex?.id || 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      page: state.page,
      rect: state.rect,
      selectedText: state.selectedText,
      note: ex?.note || '',
      color: COLORS[colorIdx].rgb,
      createdAt: ex?.createdAt || new Date().toISOString(),
      interactions: ex?.interactions,
    };
  };

  return createPortal(
    <div
      ref={ref}
      className="ab-annot-popover"
      style={{ left: pos.left, top: pos.top, width: W, zIndex: 10001 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{POPOVER_STYLES}</style>

      {/* ===== 工具栏 (main) — 一行文字按钮 ===== */}
      {panel === 'main' && (
        <>
          <div className="ab-annot-popover__toolbar">
            {generating ? (
              <button type="button" className="ab-annot-popover__tbtn ab-annot-popover__tbtn--busy" onClick={onCancelGenerate}>
                取消生成
              </button>
            ) : (
              TOOLS.map((t) => (
                <button key={t.id} type="button" className="ab-annot-popover__tbtn" onClick={() => { void onTool(t.id, baseAnnot()); }}>
                  {t.label}
                </button>
              ))
            )}
            <button
              type="button"
              className="ab-annot-popover__tbtn"
              onClick={() => setPanel('color')}
              style={{ borderLeft: `3px solid rgb(${COLORS[colorIdx].rgb.join(',')})` }}
            >
              颜色
            </button>
            <span className="ab-annot-popover__tbtn-sep" />
            <button type="button" className="ab-annot-popover__tbtn ab-annot-popover__tbtn--cancel" onClick={generating ? onClose : onCancel} title={generating ? '关闭 (生成继续)' : '删除标注'}>
              ✕
            </button>
          </div>
          {generating && (
            <div className="ab-annot-popover__busy">
              <span className="ab-annot-popover__spinner" />
              生成中…
            </div>
          )}
        </>
      )}

      {/* ===== 颜色面板 (color) ===== */}
      {panel === 'color' && (
        <>
          <div className="ab-annot-popover__panel-title">
            <button type="button" className="ab-annot-popover__back" onClick={() => setPanel('main')}>←</button>
            标注颜色
          </div>
          <div className="ab-annot-popover__palette">
            {COLORS.map((c, i) => (
              <button
                key={c.name}
                type="button"
                title={c.name}
                className={`ab-annot-popover__swatch ${i === colorIdx ? 'is-active' : ''}`}
                style={{ background: `rgb(${c.rgb.join(',')})` }}
                onClick={() => {
                  setColorIdx(i);
                  onColorChange(c.rgb);
                }}
              />
            ))}
          </div>
          <div className="ab-annot-popover__foot">
            <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--save" onClick={() => setPanel('main')}>
              确定
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
};

const POPOVER_STYLES = `
.ab-annot-popover {
  position: fixed;
  z-index: 10001;
  background: var(--editorWidget-background, var(--vscode-editorWidget-background, rgba(30,30,36,0.96)));
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.28)));
  border-radius: 12px;
  box-shadow:
    0 2px 6px rgba(0,0,0,0.10),
    0 8px 24px rgba(0,0,0,0.18),
    0 24px 64px rgba(0,0,0,0.28);
  padding: 6px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  font-size: 12px;
  color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb));
  display: flex;
  flex-direction: column;
  gap: 5px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.ab-annot-popover__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  background: rgba(128,128,128,0.10);
  border-radius: 9px;
}
.ab-annot-popover__tbtn {
  height: 28px;
  padding: 0 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--editor-foreground, var(--vscode-editor-foreground, #d8dbe0));
  cursor: pointer;
  transition: background 0.14s, color 0.14s, transform 0.08s;
  font-size: 12px;
  white-space: nowrap;
}
.ab-annot-popover__tbtn:hover:not(:disabled) {
  background: rgba(255,255,255,0.14);
  color: #fff;
}
.ab-annot-popover__tbtn:active:not(:disabled) {
  transform: scale(0.96);
}
.ab-annot-popover__tbtn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ab-annot-popover__tbtn--cancel:hover:not(:disabled) {
  background: rgba(220,60,60,0.22);
  color: #ff8f8f;
}
.ab-annot-popover__tbtn--busy {
  background: rgba(55,148,255,0.18);
  color: #7db8ff;
  font-weight: 600;
}
.ab-annot-popover__tbtn--busy:hover {
  background: rgba(55,148,255,0.28);
}
.ab-annot-popover__tbtn-sep {
  width: 1px;
  height: 18px;
  background: rgba(128,128,128,0.35);
  margin: 0 3px;
}
.ab-annot-popover__busy {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  padding: 2px 4px;
}
.ab-annot-popover__spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(128,128,128,0.25);
  border-top-color: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  border-radius: 50%;
  animation: ab-annot-spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes ab-annot-spin {
  to { transform: rotate(360deg); }
}
.ab-annot-popover__panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12px;
}
.ab-annot-popover__back {
  font: 600 14px/1 sans-serif;
  width: 20px; height: 20px;
  border-radius: 50%;
  border: none;
  background: rgba(128,128,128,0.15);
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ab-annot-popover__back:hover {
  background: rgba(128,128,128,0.3);
}
.ab-annot-popover__palette {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  flex-wrap: wrap;
}
.ab-annot-popover__swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  outline: none;
  transition: transform 0.12s, border-color 0.12s;
}
.ab-annot-popover__swatch:hover { transform: scale(1.15); }
.ab-annot-popover__swatch.is-active {
  border-color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb));
  transform: scale(1.15);
}
.ab-annot-popover__foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 2px;
}
.ab-annot-popover__btn {
  font: inherit;
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 5px;
  border: none;
  cursor: pointer;
  transition: background 0.12s, filter 0.12s;
}
.ab-annot-popover__btn--save {
  background: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  color: #fff;
  font-weight: 600;
}
.ab-annot-popover__btn--save:hover {
  filter: brightness(1.1);
}
`;
