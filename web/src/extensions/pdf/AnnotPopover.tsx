/**
 * AnnotPopover — 文本圈选后悬浮操作窗口
 *
 * 在文本选区右上角弹小 popover, 选类型 / 颜色 / 交互行为, 保存触发 onSave, 取消触发 onCancel.
 * 类型: highlight (默认) / note.
 * 颜色: 8 色快速选择, 主题色自适应.
 * 交互行为 (可选): comment = 批注 (悬停显示文本); prompt = 提示词 (悬停显示"发送给AI"按钮).
 * 编辑模式: 双击已有标注时传入 existing, 预填并保存覆盖.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SidecarAnnot, SidecarAnnotBehavior } from './annotations';

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
  onSave: (annot: SidecarAnnot) => void;
  onCancel: () => void;
}

export const AnnotPopover: React.FC<AnnotPopoverProps> = ({ state, onSave, onCancel }) => {
  const [colorIdx, setColorIdx] = useState(0);
  /** 交互行为: null = 无; 'comment' = 批注; 'prompt' = 提示词 */
  const [behavior, setBehavior] = useState<'comment' | 'prompt' | null>(null);
  const [behaviorText, setBehaviorText] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // 每次 state 变化时重置 (新建) 或预填 (编辑 existing)
  useEffect(() => {
    if (state) {
      const ex = state.existing;
      // 找颜色索引 (编辑时按现有色匹配)
      const ci = ex?.color ? COLORS.findIndex((c) => c.rgb[0] === ex.color![0] && c.rgb[1] === ex.color![1] && c.rgb[2] === ex.color![2]) : -1;
      setColorIdx(ci >= 0 ? ci : 0);
      setBehavior(ex?.behavior?.type || null);
      setBehaviorText(ex?.behavior?.text || '');
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
  const H = 300;
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
    const ex = state.existing;
    const annot: SidecarAnnot = {
      id: ex?.id || 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      page: state.page,
      type: ex?.type || 'highlight',
      rect: state.rect,
      selectedText: state.selectedText,
      note: '',
      color,
      createdAt: ex?.createdAt || new Date().toISOString(),
    };
    // 行为: 有文本才带, 无文本 = 无行为
    const bText = behaviorText.trim();
    if (behavior && bText) {
      annot.behavior = { type: behavior, text: bText } as SidecarAnnotBehavior;
    }
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
        <span className="ab-annot-popover__title">
          {state.existing ? '编辑标注' : `第 ${state.page} 页`}
        </span>
      </div>
      {previewText && (
        <div className="ab-annot-popover__preview" title={state.selectedText}>
          {previewText}
        </div>
      )}
      {/* 交互行为: 无 / 批注 / 提示词 */}
      <div className="ab-annot-popover__behavior">
        <span className="ab-annot-popover__behavior-label">交互</span>
        <span className="ab-annot-popover__behavior-toggle">
          <button
            type="button"
            className={`ab-annot-popover__type-btn ${behavior === null ? 'is-active' : ''}`}
            onClick={() => { setBehavior(null); setBehaviorText(''); }}
          >无</button>
          <button
            type="button"
            className={`ab-annot-popover__type-btn ${behavior === 'comment' ? 'is-active' : ''}`}
            onClick={() => setBehavior('comment')}
          >批注</button>
          <button
            type="button"
            className={`ab-annot-popover__type-btn ${behavior === 'prompt' ? 'is-active' : ''}`}
            onClick={() => setBehavior('prompt')}
          >提示词</button>
        </span>
      </div>
      {behavior === 'comment' && (
        <textarea
          className="ab-annot-popover__note"
          placeholder="批注内容 (悬停显示)"
          value={behaviorText}
          onChange={(e) => setBehaviorText(e.target.value)}
          rows={2}
        />
      )}
      {behavior === 'prompt' && (
        <textarea
          className="ab-annot-popover__note"
          placeholder="提示词 (悬停显示「发送给AI」按钮)"
          value={behaviorText}
          onChange={(e) => setBehaviorText(e.target.value)}
          rows={2}
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
          {state.existing ? '保存修改' : '保存'}
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
.ab-annot-popover__behavior {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ab-annot-popover__behavior-label {
  font-size: 10px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  white-space: nowrap;
}
.ab-annot-popover__behavior-toggle {
  display: inline-flex;
  background: rgba(128,128,128,0.12);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
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
