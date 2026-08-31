/**
 * AnnotPopover — 画矩形后悬浮工具栏 + 按需表单
 *
 * 结构: rect 圈定后弹出**工具栏** (工具按钮行), 点击工具项才展开对应表单/面板:
 *   - 「动画演示」: 提示词表单 (AI ask 风格, 生成动画演示)
 *   - 「颜色」: 色板面板 (选择标注颜色)
 *   - 「取消」
 *
 * 工具栏可扩展: TOOL_ITEMS 注册表, 每个工具 id → label + 面板内容.
 * 生成动作由宿主 (PdfReaderView) 实现: ask → 保存 html → sidecar 更新 → 关闭.
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
  /** 编辑模式: 双击已有标注时传入, 预填 + 保存覆盖 */
  existing?: SidecarAnnot;
}

export interface AnnotPopoverProps {
  state: PopoverState | null;
  /** ✕: 删除刚标记的标注 + 关闭 */
  onCancel: () => void;
  /** 执行交互能力 (动画演示: 生成). 抛错 = 失败 (面板内提示, 可重试). */
  onGenerate: (prompt: string, base: SidecarAnnot) => Promise<void>;
  /** 更新标注颜色 (rect 已标记, 实时改色) */
  onColorChange: (color: [number, number, number]) => void;
}

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
type Panel = 'main' | 'demo' | 'color';

/** 默认提示词: 圈选文本 + 生成指令 */
function defaultPrompt(selectedText: string): string {
  const text = (selectedText || '').trim();
  return text
    ? `请根据以下内容生成 HTML5 动画演示:\n\n${text}`
    : '请根据圈选区域的内容生成 HTML5 动画演示';
}

export const AnnotPopover: React.FC<AnnotPopoverProps> = ({ state, onCancel, onGenerate, onColorChange }) => {
  const [panel, setPanel] = useState<Panel>('main');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // 每次 state 变化时重置 (新建) 或预填 (编辑 existing)
  useEffect(() => {
    if (state) {
      setPrompt(defaultPrompt(state.selectedText));
      setBusy(false);
      setError('');
      setPanel('main');
      const ex = state.existing;
      const ci = ex?.color ? COLORS.findIndex((c) => c.rgb[0] === ex.color![0] && c.rgb[1] === ex.color![1] && c.rgb[2] === ex.color![2]) : -1;
      setColorIdx(ci >= 0 ? ci : 0);
    }
  }, [state]);

  // Esc 取消 (面板内返回工具栏; 工具栏取消整个)
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        e.preventDefault();
        if (panel !== 'main') setPanel('main');
        else onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, busy, panel, onCancel]);

  // 定位: 紧贴标注位置 (锚点 = 标注右上角 state.x/y), 按可视区上下左右 4 向自适应.
  const W = 340;
  const PAD = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const pickPos = (ax: number, ay: number, h: number) => {
    const candidates: Array<{ left: number; top: number }> = [
      { left: ax + PAD, top: ay + PAD },           // 右下 (默认)
      { left: ax - W - PAD, top: ay + PAD },       // 左下 (右边放不下)
      { left: ax + PAD, top: ay - h - PAD },       // 右上 (下边放不下)
      { left: ax - W - PAD, top: ay - h - PAD },   // 左上 (右下都不够)
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
  }, [state, panel, busy, error, prompt, colorIdx]);

  if (!state) return null;

  const handleGenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    // 构造 base annot (编辑模式沿用 existing, 新建生成新 id; color 用当前选择)
    const ex = state.existing;
    const base: SidecarAnnot = {
      id: ex?.id || 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      page: state.page,
      rect: state.rect,
      selectedText: state.selectedText,
      note: ex?.note || '',
      color: COLORS[colorIdx].rgb,
      createdAt: ex?.createdAt || new Date().toISOString(),
      interactions: ex?.interactions,
    };
    try {
      await onGenerate(prompt.trim() || defaultPrompt(state.selectedText), base);
      // 成功: 宿主侧已关 popover
    } catch (e: any) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="ab-annot-popover"
      style={{ left: pos.left, top: pos.top, width: W, zIndex: 10001, maxHeight: 'min(80vh, 720px)' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{POPOVER_STYLES}</style>
      <div className="ab-annot-popover__head">
        <span className="ab-annot-popover__title">
          {state.existing ? `编辑标注 (第 ${state.page} 页)` : `第 ${state.page} 页`}
        </span>
      </div>

      {/* ===== 工具栏 (main) — Word 选中文本风格: 一行紧凑图标按钮 ===== */}
      {panel === 'main' && (
        <>
          <div className="ab-annot-popover__toolbar">
            <button type="button" className="ab-annot-popover__tbtn" title="动画演示" onClick={() => setPanel('demo')}>
              <span className="ab-annot-popover__tbtn-icon">▶</span>
            </button>
            <button
              type="button"
              className="ab-annot-popover__tbtn"
              title="标注颜色"
              onClick={() => setPanel('color')}
              style={{ background: `rgb(${COLORS[colorIdx].rgb.join(',')})` }}
            />
            <span className="ab-annot-popover__tbtn-sep" />
            <button type="button" className="ab-annot-popover__tbtn ab-annot-popover__tbtn--cancel" title="取消" onClick={onCancel}>
              <span className="ab-annot-popover__tbtn-icon">✕</span>
            </button>
          </div>
          {state.selectedText && (
            <div className="ab-annot-popover__sel">
              {state.selectedText.slice(0, 120)}{state.selectedText.length > 120 ? '…' : ''}
            </div>
          )}
        </>
      )}

      {/* ===== 动画演示表单 (demo) ===== */}
      {panel === 'demo' && (
        <>
          <div className="ab-annot-popover__panel-title">
            <button type="button" className="ab-annot-popover__back" onClick={() => { if (!busy) setPanel('main'); }} title="返回工具栏">←</button>
            动画演示
          </div>
          {state.selectedText && (
            <div className="ab-annot-popover__sel">
              {state.selectedText.slice(0, 120)}{state.selectedText.length > 120 ? '…' : ''}
            </div>
          )}
          <textarea
            className="ab-annot-popover__note"
            placeholder="输入给 AI 的指令, 如: 用卡片轮播演示这三个概念"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            autoFocus
            disabled={busy}
          />
          {error && <div className="ab-annot-popover__error">{error}</div>}
          <div className="ab-annot-popover__foot">
            <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--cancel" onClick={() => setPanel('main')} disabled={busy}>
              返回
            </button>
            <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--gen" onClick={handleGenerate} disabled={busy}>
              {busy ? '生成中…' : '生成动画演示'}
            </button>
          </div>
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
  background: var(--editorWidget-background, var(--vscode-editorWidget-background, #2d2d30));
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.25)));
  border-radius: 10px;
  box-shadow:
    0 1px 2px rgba(0,0,0,0.06),
    0 4px 12px rgba(0,0,0,0.12),
    0 16px 40px rgba(0,0,0,0.20);
  padding: 10px 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  font-size: 12px;
  color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb));
  display: flex;
  flex-direction: column;
  gap: 8px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.ab-annot-popover__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ab-annot-popover__title {
  font-weight: 600;
}
.ab-annot-popover__sel {
  font-size: 11px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  background: rgba(128,128,128,0.08);
  border-radius: 5px;
  padding: 4px 6px;
  max-height: 48px;
  overflow: hidden;
  line-height: 1.4;
}
.ab-annot-popover__note {
  font: inherit;
  font-size: 12px;
  background: rgba(128,128,128,0.08);
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
  border-radius: 5px;
  padding: 5px 7px;
  color: inherit;
  resize: vertical;
  outline: none;
  font-family: inherit;
}
.ab-annot-popover__note:focus {
  border-color: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
}
.ab-annot-popover__error {
  font-size: 11px;
  color: #f87171;
  background: rgba(220,60,60,0.12);
  border: 1px solid rgba(220,60,60,0.3);
  border-radius: 5px;
  padding: 4px 6px;
  word-break: break-all;
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
.ab-annot-popover__toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  background: rgba(128,128,128,0.08);
  border-radius: 8px;
}
.ab-annot-popover__tbtn {
  width: 30px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.12s, filter 0.12s;
  font-size: 12px;
}
.ab-annot-popover__tbtn:hover {
  background: rgba(128,128,128,0.25);
}
.ab-annot-popover__tbtn-icon {
  font-size: 12px;
  line-height: 1;
}
.ab-annot-popover__tbtn--cancel:hover {
  background: rgba(220,60,60,0.25);
  color: #f87171;
}
.ab-annot-popover__tbtn-sep {
  width: 1px;
  height: 16px;
  background: rgba(128,128,128,0.3);
  margin: 0 2px;
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
.ab-annot-popover__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ab-annot-popover__btn--cancel {
  background: transparent;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
}
.ab-annot-popover__btn--cancel:hover:not(:disabled) {
  background: rgba(128,128,128,0.12);
}
.ab-annot-popover__btn--gen {
  background: linear-gradient(135deg, #8b5cf6 0%, #3794ff 100%);
  color: #fff;
  font-weight: 600;
}
.ab-annot-popover__btn--gen:hover:not(:disabled) {
  filter: brightness(1.1);
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
