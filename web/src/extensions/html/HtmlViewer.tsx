/**
 * HtmlViewer — animbook HTML 预览/编辑组件
 *
 * 默认 webview (iframe srcDoc) 渲染 HTML 页面, 工具栏可切换为 monaco 文本编辑模式:
 *   - 预览模式: iframe 渲染 (sandbox=allow-scripts), 支持刷新
 *   - 编辑模式: monaco editor (html language), 支持 Cmd/Ctrl+S 保存 + 切换回预览自动更新
 *
 * 读写走 OpenSumi file service (IFileServiceClient):
 *   插件 → OpenSumi (OverlayFS) → onDidChangeFiles 钩子 → 宿主机 (opencode)
 * 不再直接使用 __ANIMBOOK_FS_API__ 的 PTY 通道.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-file-service';

// @ts-ignore — monaco fork standalone api
import * as monaco from '@opensumi/monaco-editor-core/esm/vs/editor/editor.api';

interface Props {
  resource: {
    uri: { codeUri: { fsPath: string; path: string } } | { path: string };
  };
}

type Mode = 'preview' | 'edit';

function getUriString(resource: any): string {
  const uri = resource?.uri;
  if (!uri) return '';
  if (typeof uri.toString === 'function') return uri.toString(true);
  if (uri.codeUri?.fsPath) return `file://${uri.codeUri.fsPath}`;
  return '';
}

/**
 * 从 URI 字符串取文件名 (仅展示用)
 */
function getFileName(uriStr: string): string {
  const clean = uriStr.replace(/^file:\/\//, '').split('?')[0];
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

export const HtmlViewer: React.FC<Props> = ({ resource }) => {
  const fileService = useInjectable<IFileServiceClient>(IFileServiceClient);
  const uriStr = useMemo(() => getUriString(resource), [resource]);
  const fileName = useMemo(() => getFileName(uriStr), [uriStr]);

  const [html, setHtml] = useState('');
  const [mode, setMode] = useState<Mode>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [savedTip, setSavedTip] = useState(false);

  const editRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const htmlRef = useRef('');
  const loadedUriRef = useRef('');   // 已加载完成的 uri (防止旧内容/旧 editor 串台)
  const editorUriRef = useRef('');   // editor 绑定的 uri
  useEffect(() => { htmlRef.current = html; }, [html]);

  // uri 切换 (组件实例被 OpenSumi 复用时): 立即重置状态, 丢弃旧内容/旧 editor
  useEffect(() => {
    setMode('preview');
    setHtml('');
    setError('');
    setLoading(true);
    setRefreshTick((t) => t + 1);
  }, [uriStr]);

  // 重新加载文件 (OpenSumi file service, 内部 OverlayFS → 宿主); 刷新按钮/uri 变化共用.
  // 发起后若 uri 已切换, 丢弃结果 (防旧请求覆盖新文件内容)
  const uriStrRef = useRef(uriStr);
  useEffect(() => { uriStrRef.current = uriStr; }, [uriStr]);

  const reload = useCallback(async () => {
    const target = uriStr;
    if (!target) return;
    setLoading(true);
    setError('');
    try {
      const { content } = await fileService.readFile(target);
      const text = typeof (content as any)?.toString === 'function'
        ? (content as any).toString()
        : String(content);
      if (uriStrRef.current !== target) return; // uri 已切换, 丢弃
      loadedUriRef.current = target;
      setHtml(text);
    } catch (e) {
      if (uriStrRef.current !== target) return;
      setError(String((e as any)?.message || e));
    } finally {
      if (uriStrRef.current === target) setLoading(false);
    }
  }, [uriStr, fileService]);

  // 首次加载
  useEffect(() => {
    if (!uriStr) return;
    void reload();
  }, [uriStr, reload]);

  // 编辑模式: 创建 monaco editor (仅加载完成后, 绑定当前 uri)
  useEffect(() => {
    if (mode !== 'edit' || !editRef.current || loading || error) return;
    const editor = (monaco as any).editor.create(editRef.current, {
      value: htmlRef.current,
      language: 'html',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      tabSize: 2,
    });
    editorRef.current = editor;
    editorUriRef.current = uriStr;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave(editor.getValue());
    });
    return () => {
      editorRef.current = null;
      editorUriRef.current = '';
      editor.dispose();
    };
  }, [mode, loading, error, uriStr]);

  // 保存 (走 OpenSumi file service → OverlayFS 写层 → onDidChangeFiles 钩子 → 宿主机)
  // 三重防呆: 未加载完成/加载失败不保存; editor 绑定的 uri 与当前 uri 不一致不保存
  const handleSave = useCallback(async (content: string) => {
    if (loading || error) {
      console.warn('[html] skip save: not loaded yet', { loading, error });
      return;
    }
    if (loadedUriRef.current !== uriStr) {
      console.warn('[html] skip save: uri mismatch', { loaded: loadedUriRef.current, current: uriStr });
      return;
    }
    if (editorUriRef.current && editorUriRef.current !== uriStr) {
      console.warn('[html] skip save: editor bound to other file', { bound: editorUriRef.current, current: uriStr });
      return;
    }
    try {
      const stat = await fileService.getFileStat(uriStr);
      if (!stat) throw new Error('file stat not found');
      await fileService.setContent(stat, content);
      setHtml(content);
    } catch (e) {
      console.warn('[html] save failed:', uriStr, e);
    } finally {
      setSavedTip(true);
      setTimeout(() => setSavedTip(false), 1200);
    }
  }, [uriStr, fileService, loading, error]);

  const switchToEdit = useCallback(() => {
    if (editorRef.current) {
      handleSave(editorRef.current.getValue());
    }
    setMode('edit');
  }, [handleSave]);

  const switchToPreview = useCallback(() => {
    if (editorRef.current && editorUriRef.current === uriStr) {
      handleSave(editorRef.current.getValue());
      setMode('preview');
      setRefreshTick((t) => t + 1);
    } else {
      setMode('preview');
    }
  }, [handleSave, uriStr]);

  const toolbarBtn = (active: boolean, label: string, onClick: () => void) => (
    <button
      className={active ? 'ab-html__btn ab-html__btn--active' : 'ab-html__btn'}
      onClick={onClick}
    >{label}</button>
  );

  return (
    <div className="ab-html">
      <style>{STYLES}</style>
      <div className="ab-html__toolbar">
        <span className="ab-html__name">📄 {fileName}</span>
        <span className="ab-html__spacer" />
        {savedTip && <span className="ab-html__saved">✓ 已保存</span>}
        <button className="ab-html__btn" onClick={() => void reload()} disabled={mode !== 'preview'}>⟳ 刷新</button>
        {mode === 'preview'
          ? toolbarBtn(true, '👁 预览', () => {})
          : toolbarBtn(false, '👁 预览', switchToPreview)}
        {mode === 'preview'
          ? toolbarBtn(false, '✏️ 编辑', switchToEdit)
          : toolbarBtn(true, '✏️ 编辑', () => {})}
      </div>
      <div className="ab-html__body">
        {loading ? (
          <div className="ab-html__msg">正在加载 {fileName}…</div>
        ) : error ? (
          <div className="ab-html__msg ab-html__msg--error">加载失败: {error}</div>
        ) : mode === 'preview' ? (
          <iframe
            key={refreshTick}
            className="ab-html__frame"
            srcDoc={html}
            sandbox="allow-scripts allow-modals allow-popups allow-forms"
          />
        ) : (
          <div ref={editRef} className="ab-html__editor" />
        )}
      </div>
    </div>
  );
};

const STYLES = `
.ab-html {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  background: var(--editor-background, var(--vscode-editor-background));
  color: var(--editor-foreground, var(--vscode-editor-foreground));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
}
.ab-html__toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px;
  background: var(--tc-surface-muted, var(--vscode-editorWidget-background));
  border-bottom: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
  font-size: 13px;
}
.ab-html__name {
  font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ab-html__spacer { flex: 1; }
.ab-html__saved { color: var(--terminal-ansiGreen, #22c55e); font-size: 12px; }
.ab-html__btn {
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.25)));
  background: var(--button-secondaryBackground, rgba(128,128,128,0.12));
  color: inherit;
  padding: 3px 10px; border-radius: 6px;
  font-size: 12px; cursor: pointer;
}
.ab-html__btn:hover { background: var(--list-hoverBackground, rgba(128,128,128,0.2)); }
.ab-html__btn:disabled { opacity: 0.4; cursor: default; }
.ab-html__btn--active {
  background: color-mix(in srgb, var(--button-background, #2563eb) 20%, transparent);
  border-color: color-mix(in srgb, var(--button-background, #2563eb) 50%, transparent);
  color: var(--button-background, #2563eb);
}
.ab-html__body { flex: 1; min-height: 0; position: relative; }
.ab-html__frame {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  border: none; background: #fff;
}
.ab-html__editor { position: absolute; inset: 0; }
.ab-html__msg {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground));
  font-size: 13px;
}
.ab-html__msg--error { color: var(--errorForeground, var(--vscode-errorForeground, #f87171)); }
`;
