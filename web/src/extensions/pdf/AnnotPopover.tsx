/**
 * AnnotPopover — 文本圈选后悬浮操作窗口
 *
 * 在文本选区右上角弹小 popover, 选类型 / 颜色 / 备注, 保存触发 onSave, 取消触发 onCancel.
 * 一期类型: highlight (默认) / note.
 * 颜色: 4 色快速选择 (蓝/黄/绿/红), 主题色自适应.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SidecarAnnot, SidecarAnnotType } from './annotations';

const COLORS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: '蓝', rgb: [55, 148, 255] },
  { name: '黄', rgb: [255, 200, 60] },
  { name: '绿', rgb: [80, 200, 120] },
  { name: '红', rgb: [240, 90, 90] },
];

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
}

export interface AnnotPopoverProps {
  state: PopoverState | null;
  onSave: (annot: SidecarAnnot) => void;
  onCancel: () => void;
}

export const AnnotPopover: React.FC<AnnotPopoverProps> = ({ state, onSave, onCancel }) => {
  const [type, setType] = useState<SidecarAnnotType>('highlight');
  const [colorIdx, setColorIdx] = useState(0);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // 每次 state 变化时重置
  useEffect(() => {
    if (state) {
      setType('highlight');
      setColorIdx(0);
      setNote('');
    }
  }, [state]);

  // Esc 取消
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, onCancel]);

  if (!state) return null;

  // 边界修正: 选区下方居中, 超出视口时调整
  const W = 320;
  const H = type === 'note' ? 260 : 180;
  const PAD = 8;
  // 默认: 选区下方居中
  let left = state.x - W / 2;
  let top = state.y + PAD;
  if (typeof window !== 'undefined') {
    if (left < 4) left = 4;
    if (left + W > window.innerWidth - 4) left = window.innerWidth - W - 4;
    if (top + H > window.innerHeight - 4) top = Math.max(4, state.y - H - PAD);
  }

  const color = COLORS[colorIdx].rgb;

  const handleSave = () => {
    const annot: SidecarAnnot = {
      id: 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      page: state.page,
      type,
      rect: state.rect,
      selectedText: state.selectedText,
      note: type === 'note' ? note.trim() : '',
      color,
      createdAt: new Date().toISOString(),
    };
    onSave(annot);
  };

  const previewText = state.selectedText.length > 100
    ? state.selectedText.slice(0, 100) + '…'
    : state.selectedText;

  return createPortal(
    <div
      ref={ref}
      className="ab-annot-popover"
      style={{ left, top, width: W, zIndex: 99999 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{POPOVER_STYLES}</style>
      <div className="ab-annot-popover__head">
        <span className="ab-annot-popover__type-toggle">
          <button
            className={`ab-annot-popover__type-btn ${type === 'highlight' ? 'is-active' : ''}`}
            onClick={() => setType('highlight')}
            type="button"
          >高亮</button>
          <button
            className={`ab-annot-popover__type-btn ${type === 'note' ? 'is-active' : ''}`}
            onClick={() => setType('note')}
            type="button"
          >便签</button>
        </span>
        <span className="ab-annot-popover__hint">第 {state.page} 页</span>
      </div>
      <div className="ab-annot-popover__preview" title={state.selectedText}>
        {previewText || <em className="ab-annot-popover__preview-empty">区域标注 (第 {state.page} 页)</em>}
      </div>
      {type === 'note' && (
        <textarea
          className="ab-annot-popover__note"
          placeholder="备注内容 (可空)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          autoFocus
        />
      )}
      <div className="ab-annot-popover__palette">
        {COLORS.map((c, i) => (
          <button
            key={c.name}
            type="button"
            title={c.name}
            className={`ab-annot-popover__swatch ${i === colorIdx ? 'is-active' : ''}`}
            style={{ background: `rgb(${c.rgb.join(',')})` }}
            onClick={() => setColorIdx(i)}
          />
        ))}
      </div>
      <div className="ab-annot-popover__foot">
        <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--cancel" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--save" onClick={handleSave}>
           保存
        </button>
      </div>
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
.ab-annot-popover__type-toggle {
  display: inline-flex;
  background: rgba(128,128,128,0.12);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
}
.ab-annot-popover__type-btn {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.ab-annot-popover__type-btn.is-active {
  background: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  color: #fff;
  font-weight: 600;
}
.ab-annot-popover__hint {
  font-size: 10px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
}
.ab-annot-popover__preview {
  font-size: 11px;
  line-height: 1.5;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  background: rgba(128,128,128,0.08);
  border-radius: 5px;
  padding: 6px 8px;
  max-height: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre-wrap;
  word-break: break-word;
}
.ab-annot-popover__preview-empty {
  opacity: 0.5;
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
.ab-annot-popover__palette {
  display: flex;
  gap: 6px;
  padding: 2px 0;
}
.ab-annot-popover__swatch {
  width: 18px;
  height: 18px;
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
  transition: background 0.12s;
}
.ab-annot-popover__btn--cancel {
  background: transparent;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
}
.ab-annot-popover__btn--cancel:hover {
  background: rgba(128,128,128,0.12);
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
