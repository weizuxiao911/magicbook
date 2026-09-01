/**
 * 标注行为执行器 — 监听 PdfReaderView 派发的事件, 执行 modal / tab / terminal 行为.
 *
 * 由 PdfReaderView 内部渲染 (不占用额外模块), 保持扩展自包含.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { ITerminalController } from '@opensumi/ide-terminal-next/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser/doc-model/types';
import { URI } from '@opensumi/ide-core-common';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';

interface AnnotModalState {
  title: string;
  content: string;
  source: string;
}

export const AnnotationActions: React.FC = () => {
  const terminalController = useInjectable<ITerminalController>(ITerminalController);
  const editorService = useInjectable<WorkbenchEditorService>(WorkbenchEditorService);
  const documentModelService = useInjectable<IEditorDocumentModelService>(IEditorDocumentModelService);
  const [modal, setModal] = useState<AnnotModalState | null>(null);

  /** 已创建的终端 id (复用: 已存在直接使用) */
  const terminalIdsRef = useRef<string[]>([]);

  useEffect(() => {
    // ---------- modal ----------
    const onModal = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setModal({ title: d.title || '标注内容', content: d.content || '', source: d.source || '' });
    };

    // ---------- tab ----------
    const onTab = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const title = d.title || '标注';
      const content = d.content || '';
      void (async () => {
        try {
          // untitled tab: uri 带 name query (标题), 写内容后打开
          const qName = encodeURIComponent(title);
          const uri = new URI(`untitled://annot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}?name=${qName}`);
          const ref = await documentModelService.createModelReference(uri, 'pdf-annot');
          try {
            const model = ref.instance as any;
            model?.setContent?.(content);
          } finally {
            ref.dispose();
          }
          await editorService.open(uri, { preview: false, focus: true });
        } catch (err) {
          console.warn('[annot] open tab failed:', err);
        }
      })();
    };

    // ---------- terminal ----------
    const onTerminal = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const command = d.command || '';
      void (async () => {
        try {
          // 已存在的终端直接使用, 否则新建
          const existing = terminalIdsRef.current;
          let client: any = null;
          if (existing.length > 0) {
            client = terminalController.clients.get(existing[existing.length - 1]);
          }
          if (!client) {
            client = await terminalController.createTerminal({});
            const id = (client as any)?.id || (client as any)?.sessionId;
            if (id) terminalIdsRef.current.push(id);
          }
          terminalController.showTerminalPanel();
          terminalController.focus();
          const id = (client as any)?.id || (client as any)?.sessionId;
          if (id && command) {
            const svc = (terminalController as any).terminalService;
            if (svc?.sendText) {
              await svc.sendText(id, command + '\r');
            } else {
              (client as any)?.sendData?.(command + '\r');
            }
          }
        } catch (err) {
          console.warn('[annot] open terminal failed:', err);
        }
      })();
    };

    // ---------- openfile: 打开 workspace 文件 (标注文件交互) ----------
    const onOpenFile = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const path: string = d.path || '';
      if (!path) return;
      void (async () => {
        try {
          // path 是 codeblitz 源路径 (file://{WORKSPACE_ROOT}/...) 或 IDE 相对路径 (/docs/a.txt)
          let uri: URI;
          if (path.startsWith('file://')) {
            uri = new URI(path);
          } else {
            uri = new URI(`file://${WORKSPACE_ROOT}${path.startsWith('/') ? path : `/${path}`}`);
          }
          await editorService.open(uri, { preview: false, focus: true });
        } catch (err) {
          console.warn('[annot] open file failed:', path, err);
        }
      })();
    };

    window.addEventListener('animbook:pdf-annot-modal', onModal);
    window.addEventListener('animbook:pdf-annot-tab', onTab);
    window.addEventListener('animbook:pdf-annot-terminal', onTerminal);
    window.addEventListener('animbook:pdf-annot-openfile', onOpenFile);
    return () => {
      window.removeEventListener('animbook:pdf-annot-modal', onModal);
      window.removeEventListener('animbook:pdf-annot-tab', onTab);
      window.removeEventListener('animbook:pdf-annot-terminal', onTerminal);
      window.removeEventListener('animbook:pdf-annot-openfile', onOpenFile);
    };
  }, [terminalController, editorService]);

  // ---------- modal UI ----------
  if (!modal) return null;
  return (
    <div className="ab-annot-modal-overlay" onClick={() => setModal(null)}>
      <style>{MODAL_STYLES}</style>
      <div className="ab-annot-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ab-annot-modal__head">
          <span className="ab-annot-modal__title">{modal.title}</span>
          <button className="ab-annot-modal__close" onClick={() => setModal(null)}>×</button>
        </div>
        <div className="ab-annot-modal__body">
          <div className="ab-annot-modal__content ab-annot-modal__content--md"
            dangerouslySetInnerHTML={{ __html: renderLightMarkdown(modal.content) }} />
          {modal.source && <div className="ab-annot-modal__source">{modal.source}</div>}
        </div>
      </div>
    </div>
  );
};

/**
 * 轻量 markdown 渲染 (避免依赖 marked — 其全局实例被 chat 的 shiki 插件改成 async).
 * 支持: 标题 / 粗体 / 列表 / 代码块 / 引用 / 换行. 输入先 HTML 转义, 防注入.
 */
function renderLightMarkdown(text: string): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const inline = (s: string) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = (text || '').split('\n');
  const out: string[] = [];
  let i = 0;
  const closeList = (list: string[] | null) => { if (list) { out.push(`</${list[0]}>`); } };
  let curList: string[] | null = null;
  while (i < lines.length) {
    const line = lines[i];
    const codeMatch = line.match(/^```(\w*)\s*$/);
    if (codeMatch) {
      closeList(curList); curList = null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList(curList); curList = null;
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList(curList); curList = null;
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      i++;
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!curList) { curList = ['ul']; out.push('<ul>'); }
      out.push(`<li>${inline(li[1])}</li>`);
      i++;
      continue;
    }
    const li2 = line.match(/^\d+\.\s+(.*)$/);
    if (li2) {
      if (!curList) { curList = ['ol']; out.push('<ol>'); }
      out.push(`<li>${inline(li2[1])}</li>`);
      i++;
      continue;
    }
    if (line.trim() === '') { closeList(curList); curList = null; i++; continue; }
    closeList(curList); curList = null;
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList(curList);
  return out.join('');
}

const MODAL_STYLES = `
.ab-annot-modal-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.ab-annot-modal {
  width: 560px; max-width: 100%;
  max-height: min(calc(100vh - 48px), 640px);
  background: #1c1c22;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  display: flex; flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
}
.ab-annot-modal__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.ab-annot-modal__title {
  font-size: 15px; font-weight: 600; color: #f3f4f6;
}
.ab-annot-modal__close {
  background: transparent; border: none; color: #9ca3af;
  font-size: 18px; cursor: pointer; line-height: 1;
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 5px;
}
.ab-annot-modal__close:hover { background: rgba(255,255,255,0.06); color: #f3f4f6; }
.ab-annot-modal__body {
  padding: 16px 18px;
  overflow-y: auto;
}
.ab-annot-modal__content {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  font-size: 13px; line-height: 1.7;
  color: #e5e7eb;
  word-break: break-word;
}
.ab-annot-modal__content--md h1, .ab-annot-modal__content--md h2, .ab-annot-modal__content--md h3 {
  color: #f3f4f6;
  margin: 12px 0 6px;
  line-height: 1.35;
}
.ab-annot-modal__content--md h1 { font-size: 16px; }
.ab-annot-modal__content--md h2 { font-size: 15px; }
.ab-annot-modal__content--md h3 { font-size: 14px; }
.ab-annot-modal__content--md p { margin: 6px 0; }
.ab-annot-modal__content--md ul, .ab-annot-modal__content--md ol {
  margin: 6px 0; padding-left: 22px;
}
.ab-annot-modal__content--md li { margin: 3px 0; }
.ab-annot-modal__content--md strong { color: #f3f4f6; }
.ab-annot-modal__content--md code {
  background: rgba(128,128,128,0.18);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.ab-annot-modal__content--md pre {
  background: rgba(0,0,0,0.35);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
}
.ab-annot-modal__content--md pre code { background: transparent; padding: 0; }
.ab-annot-modal__content--md blockquote {
  border-left: 3px solid rgba(55,148,255,0.5);
  margin: 8px 0;
  padding: 4px 12px;
  color: #b6bcc6;
  background: rgba(55,148,255,0.06);
  border-radius: 0 6px 6px 0;
}
.ab-annot-modal__content--md table {
  border-collapse: collapse;
  margin: 8px 0;
}
.ab-annot-modal__content--md th, .ab-annot-modal__content--md td {
  border: 1px solid rgba(128,128,128,0.3);
  padding: 4px 10px;
}
.ab-annot-modal__content--md th { background: rgba(128,128,128,0.15); }
.ab-annot-modal__source {
  margin-top: 12px;
  font-size: 11px; color: #6b7280;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`;
