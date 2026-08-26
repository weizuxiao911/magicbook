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

    window.addEventListener('animbook:pdf-annot-modal', onModal);
    window.addEventListener('animbook:pdf-annot-tab', onTab);
    window.addEventListener('animbook:pdf-annot-terminal', onTerminal);
    return () => {
      window.removeEventListener('animbook:pdf-annot-modal', onModal);
      window.removeEventListener('animbook:pdf-annot-tab', onTab);
      window.removeEventListener('animbook:pdf-annot-terminal', onTerminal);
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
          <pre className="ab-annot-modal__content">{modal.content}</pre>
          {modal.source && <div className="ab-annot-modal__source">{modal.source}</div>}
        </div>
      </div>
    </div>
  );
};

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
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; line-height: 1.6;
  color: #e5e7eb;
  white-space: pre-wrap; word-break: break-word;
}
.ab-annot-modal__source {
  margin-top: 12px;
  font-size: 11px; color: #6b7280;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`;
