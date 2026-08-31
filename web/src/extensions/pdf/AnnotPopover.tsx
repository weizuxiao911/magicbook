/**
 * AnnotPopover — 画矩形后悬浮操作窗口 (AI ask 风格)
 *
 * 在矩形区域右上角弹小 popover:
 *   - 头部: 页码 + 圈选文本预览
 *   - 主体: 提示词输入框 (默认预填: 圈选文本 + 生成指令)
 *   - 动作区: 交互能力按钮 (本次: 「生成动画演示」) + 取消
 *   - 生成中: loading 态, 失败提示可重试
 *
 * 交互能力 = 可扩展列表, 本次注册 demo (生成动画演示).
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
  onCancel: () => void;
  /** 执行交互能力 (本次: 生成动画演示). 抛错 = 失败 (popover 内提示, 可重试). */
  onGenerate: (prompt: string, base: SidecarAnnot) => Promise<void>;
}

/** 默认提示词: 圈选文本 + 生成指令 */
function defaultPrompt(selectedText: string): string {
  const text = (selectedText || '').trim();
  return text
    ? `请根据以下内容生成 HTML5 动画演示:\n\n${text}`
    : '请根据圈选区域的内容生成 HTML5 动画演示';
}

export const AnnotPopover: React.FC<AnnotPopoverProps> = ({ state, onCancel, onGenerate }) => {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // 每次 state 变化时重置 (新建) 或预填 (编辑 existing)
  useEffect(() => {
    if (state) {
      setPrompt(defaultPrompt(state.selectedText));
      setBusy(false);
      setError('');
    }
  }, [state]);

  // Esc 取消
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, busy, onCancel]);

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
  }, [state, busy, error, prompt]);

  if (!state) return null;

  const handleGenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    // 构造 base annot (编辑模式沿用 existing, 新建生成新 id)
    const ex = state.existing;
    const base: SidecarAnnot = {
      id: ex?.id || 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      page: state.page,
      rect: state.rect,
      selectedText: state.selectedText,
      note: ex?.note || '',
      color: ex?.color || [55, 148, 255],
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
      {/* 圈选文本预览 */}
      {state.selectedText && (
        <div className="ab-annot-popover__sel">
          {state.selectedText.slice(0, 120)}{state.selectedText.length > 120 ? '…' : ''}
        </div>
      )}
      {/* 提示词输入 (AI ask 形态) */}
      <textarea
        className="ab-annot-popover__note"
        placeholder="输入给 AI 的指令, 如: 用卡片轮播演示这三个概念"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        autoFocus={!state.existing}
        disabled={busy}
      />
      {error && <div className="ab-annot-popover__error">{error}</div>}
      <div className="ab-annot-popover__foot">
        <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--cancel" onClick={onCancel} disabled={busy}>
          取消
        </button>
        {/* 交互能力动作区: 本次注册「生成动画演示」 */}
        <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--gen" onClick={handleGenerate} disabled={busy}>
          {busy ? '生成中…' : '生成动画演示'}
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
`;
