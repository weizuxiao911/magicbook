/**
 * AnnotPopover — 画矩形后悬浮操作窗口
 *
 * 在矩形区域右上角弹小 popover, 选颜色 + 交互能力, 保存触发 onSave, 取消触发 onCancel.
 *
 * 颜色: 8 色快速选择, 主题色自适应.
 * 交互能力 (可选, 至少选 1 个才允许保存):
 *   - 批注  (comment) : 悬停显示批注文本
 *   - AI讲解 (prompt) : 悬停显示"AI讲解"按钮
 *   - 文件  (file)    : 悬停显示"打开{文件名}"按钮
 *
 * 编辑模式: 双击已有标注时传入 existing, 预填并保存覆盖.
 *
 * 注意: 2026-08-30 起, 标注不再有"类型"维度 (highlight/note 全部统一为高亮矩形).
 *   此处 "type-btn" 类名是历史命名, 实际指交互能力按钮 (comment/prompt/file), 不要被误导.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';
import { notification } from '@opensumi/ide-components/lib/notification';
import type { SidecarAnnot, SidecarInteraction } from './annotations';
import { requestFilePicker } from '../filepicker/FilePicker';

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
  /** 交互 toggle: 多选 (comment/prompt/file), 点击选中再点取消. 选中后下面分组显示输入 (可 × 删除). */
  const [commentOn, setCommentOn] = useState(false);
  const [promptOn, setPromptOn] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [promptText, setPromptText] = useState('');
  /** 文件交互 (可选): 选中后从服务器文件树选文件 */
  const [fileOn, setFileOn] = useState(false);
  const [fileRef, setFileRef] = useState<{ name: string; path: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 每次 state 变化时重置 (新建) 或预填 (编辑 existing)
  useEffect(() => {
    if (state) {
      const ex = state.existing;
      // 找颜色索引 (编辑时按现有色匹配)
      const ci = ex?.color ? COLORS.findIndex((c) => c.rgb[0] === ex.color![0] && c.rgb[1] === ex.color![1] && c.rgb[2] === ex.color![2]) : -1;
      setColorIdx(ci >= 0 ? ci : 0);
      const inter = ex?.interactions || [];
      const comment = inter.find((i) => i.type === 'comment');
      const prompt = inter.find((i) => i.type === 'prompt');
      setCommentOn(!!comment);
      setPromptOn(!!prompt);
      setCommentText(comment?.text || '');
      setPromptText(prompt?.text || '');
      setFileOn(!!ex?.file);
      setFileRef(ex?.file || null);
    }
  }, [state]);

  /** toggle 点击: 选中/取消该交互; file 选中时清 fileRef. */
  const toggleInteract = (type: 'comment' | 'prompt' | 'file') => {
    if (type === 'comment') setCommentOn((v) => !v);
    else if (type === 'prompt') setPromptOn((v) => !v);
    else {
      setFileOn((v) => {
        if (!v) setFileRef(null);
        return !v;
      });
    }
  };

  /** 移除该交互 (× 按钮): 取消 toggle + 清状态. */
  const removeInteract = (type: 'comment' | 'prompt' | 'file') => {
    if (type === 'comment') { setCommentOn(false); setCommentText(''); }
    else if (type === 'prompt') { setPromptOn(false); setPromptText(''); }
    else { setFileOn(false); setFileRef(null); }
  };

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

  // 定位: 紧贴标注位置 (锚点 = 标注右上角 state.x/y), 按可视区上下左右 4 向自适应.
  // 先用 MAX_H 估算选方向渲染 (不闪), 再 useLayoutEffect 用实际高度重选方向 (单帧内到位).
  const W = 340;
  const PAD = 8;
  const MAX_H = typeof window !== 'undefined' ? Math.min(window.innerHeight * 0.8, 720) : 480;
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
  }, [state, commentOn, promptOn, fileOn, commentText, promptText]);
  const left = state ? pos.left : 0;
  const top = state ? pos.top : 0;

  if (!state) return null;

  const color = COLORS[colorIdx].rgb;

  /** 打开服务器文件选择器 (复用 filepicker, 仅文件模式, 限定工作目录) */
  const openPicker = () => {
    const cwdAbs = (() => {
      try { return localStorage.getItem('APP_CWD') || ''; } catch { return ''; }
    })() || (window as any).__APP_CONFIG__?.cwd || '';
    requestFilePicker({
      mode: 'files',
      root: cwdAbs, // 限定在工作目录内选择
      onPick: (f) => {
        // 绝对路径 → codeblitz 源路径: /Users/.../cwd/index.html → file:///workspace/index.html
        const rel = cwdAbs && f.path.startsWith(cwdAbs)
          ? f.path.slice(cwdAbs.length)
          : f.path;
        const idePath = rel.startsWith('/') ? rel : `/${rel}`;
        setFileRef({ name: f.name, path: `file://${WORKSPACE_ROOT}${idePath}` });
      },
    });
  };

  const handleSave = () => {
    // 至少选择一种交互类型, 否则不让保存 (停留 popover + codeblitz 提示)
    const hasInteraction =
      (commentOn && commentText.trim()) ||
      (promptOn && promptText.trim()) ||
      (fileOn && fileRef);
    if (!hasInteraction) {
      notification.error({ message: '请至少选择一种交互类型', type: 'error', duration: 3 });
      return;
    }
    const ex = state.existing;
    const annot: SidecarAnnot = {
      id: ex?.id || 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      page: state.page,
      rect: state.rect,
      selectedText: state.selectedText,
      note: '',
      color,
      createdAt: ex?.createdAt || new Date().toISOString(),
    };
    // 多交互: 有文本才带
    const interactions: SidecarInteraction[] = [];
    if (commentOn && commentText.trim()) interactions.push({ type: 'comment', text: commentText.trim() });
    if (promptOn && promptText.trim()) interactions.push({ type: 'prompt', text: promptText.trim() });
    if (interactions.length > 0) annot.interactions = interactions;
    // 文件交互
    if (fileOn && fileRef) annot.file = fileRef;
    onSave(annot);
  };

  return createPortal(
    <div
      ref={ref}
      className="ab-annot-popover"
      style={{ left, top, width: W, zIndex: 10001, maxHeight: 'min(80vh, 720px)' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <style>{POPOVER_STYLES}</style>
      <div className="ab-annot-popover__head">
        <span className="ab-annot-popover__title">
          {state.existing ? `编辑标注 (第 ${state.page} 页)` : `第 ${state.page} 页`}
        </span>
      </div>
      {/* 交互类型 toggle (多选): 批注说明 / AI讲解 / 示例演示; 选中的全部在下面分组显示 (可 × 删除) */}
      <div className="ab-annot-popover__behavior">
        <span className="ab-annot-popover__behavior-label">交互</span>
        <span className="ab-annot-popover__behavior-toggle">
          <button
            type="button"
            className={`ab-annot-popover__type-btn ${commentOn ? 'is-active' : ''}`}
            onClick={() => toggleInteract('comment')}
          >批注说明</button>
          <button
            type="button"
            className={`ab-annot-popover__type-btn ${promptOn ? 'is-active' : ''}`}
            onClick={() => toggleInteract('prompt')}
          >AI讲解</button>
          <button
            type="button"
            className={`ab-annot-popover__type-btn ${fileOn ? 'is-active' : ''}`}
            onClick={() => toggleInteract('file')}
          >示例演示</button>
        </span>
      </div>
      {/* 分组显示选中的交互输入 (可 × 删除) */}
      {commentOn && (
        <div className="ab-annot-popover__group">
          <div className="ab-annot-popover__group-head">
            <span className="ab-annot-popover__group-label">批注说明</span>
            <button
              type="button"
              className="ab-annot-popover__group-clear"
              onClick={() => removeInteract('comment')}
              title="移除批注说明"
            >×</button>
          </div>
          <textarea
            className="ab-annot-popover__note"
            placeholder="在这里输入说明内容"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            rows={2}
            autoFocus={!state.existing}
          />
        </div>
      )}
      {promptOn && (
        <div className="ab-annot-popover__group">
          <div className="ab-annot-popover__group-head">
            <span className="ab-annot-popover__group-label">AI讲解</span>
            <button
              type="button"
              className="ab-annot-popover__group-clear"
              onClick={() => removeInteract('prompt')}
              title="移除 AI讲解"
            >×</button>
          </div>
          <textarea
            className="ab-annot-popover__note"
            placeholder="在这里输入发送给AI的提示词"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            rows={2}
          />
        </div>
      )}
      {fileOn && (
        <div className="ab-annot-popover__group">
          <div className="ab-annot-popover__group-head">
            <span className="ab-annot-popover__group-label">示例演示 {fileRef ? `· ${fileRef.name}` : ''}</span>
            <button
              type="button"
              className="ab-annot-popover__group-clear"
              onClick={() => removeInteract('file')}
              title="移除示例演示"
            >×</button>
          </div>
          <div className="ab-annot-popover__file">
            <button type="button" className="ab-annot-popover__btn ab-annot-popover__btn--pick" onClick={openPicker}>
              {fileRef ? `更换: ${fileRef.name}` : '选择文件'}
            </button>
          </div>
        </div>
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
.ab-annot-popover__file {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ab-annot-popover__file-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.ab-annot-popover__file-label {
  font-size: 11px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9ca3af));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ab-annot-popover__btn--pick {
  background: rgba(128,128,128,0.12);
  color: inherit;
  padding: 4px 10px;
  text-align: center;
}
.ab-annot-popover__btn--pick:hover {
  background: rgba(128,128,128,0.2);
}
.ab-annot-popover__btn--gen {
  background: linear-gradient(135deg, #8b5cf6 0%, #3794ff 100%);
  color: #fff;
  font-weight: 600;
  padding: 4px 10px;
  text-align: center;
  align-self: stretch;
  font-size: 11px;
  transition: opacity 0.12s, filter 0.12s;
}
.ab-annot-popover__btn--gen:hover:not(:disabled) {
  filter: brightness(1.1);
}
.ab-annot-popover__btn--gen:disabled {
  background: rgba(128,128,128,0.4);
  color: rgba(255,255,255,0.7);
  cursor: not-allowed;
  filter: none;
}
.ab-annot-popover__btn--gen-cancel {
  background: rgba(220,60,60,0.9);
  color: #fff;
  font-weight: 600;
  padding: 4px 10px;
  text-align: center;
  align-self: stretch;
  font-size: 11px;
  transition: opacity 0.12s, filter 0.12s;
}
.ab-annot-popover__btn--gen-cancel:hover {
  filter: brightness(1.1);
}
.ab-annot-popover__file-clear {
  font: 600 12px/1 sans-serif;
  width: 18px; height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(220,60,60,0.9);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
}
/* ===== 选中的交互分组 (可 × 删除) ===== */
.ab-annot-popover__group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  background: rgba(128,128,128,0.06);
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.18)));
  border-radius: 6px;
}
.ab-annot-popover__group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.ab-annot-popover__group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--textLink-foreground, var(--vscode-textLink-foreground, #3794ff));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.ab-annot-popover__group-clear {
  font: 600 12px/1 sans-serif;
  width: 16px; height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(220,60,60,0.85);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.12s, transform 0.12s;
}
.ab-annot-popover__group-clear:hover {
  background: rgba(220,60,60,1);
  transform: scale(1.1);
}
`;
