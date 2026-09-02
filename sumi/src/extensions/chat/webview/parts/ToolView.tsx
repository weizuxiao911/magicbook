import React, { useState, useMemo, useEffect, useRef } from 'react';

function safeStringify(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * V2 ToolStateCompleted.output 是 string, V1 ToolStateCompleted.content[] 是
 * ToolContent 数组, V1 也有 result (Unknown). 三者兼容: 优先 output, 再 content
 * 文本, 最后 result.
 */
function contentToText(content: any): string {
  if (!Array.isArray(content) || content.length === 0) return '';
  return content
    .map((c: any) => {
      if (!c) return '';
      if (typeof c === 'string') return c;
      if (c.type === 'text' && typeof c.text === 'string') return c.text;
      if (c.type === 'file') {
        const name = c.name || c.uri || '';
        return `[file] ${name} (${c.mime || ''})`;
      }
      return safeStringify(c);
    })
    .filter(Boolean)
    .join('\n');
}

function pickOutStr(state: any): string {
  if (!state) return '';
  const direct = state.output;
  if (direct != null && direct !== '') return safeStringify(direct);
  const fromContent = contentToText(state.content);
  if (fromContent) return fromContent;
  if (state.result != null) return safeStringify(state.result);
  return '';
}

function pickErrStr(state: any): string {
  const e = state?.error;
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e?.message) return String(e.message);
  return safeStringify(e);
}

const TOOL_ICON: Record<string, string> = {
  bash: '⌘',
  read: '📖',
  write: '✎',
  edit: '✎',
  glob: '🔍',
  grep: '🔍',
  list: '📁',
  webfetch: '🌐',
  task: '🤖',
  subagent: '🤖',
  todowrite: '✓',
  question: '?',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '执行中',
  completed: '成功',
  error: '失败',
};

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  error: '✕',
};

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tool__copy"
      title="复制"
      onClick={(e) => {
        e.stopPropagation();
        try {
          navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch { /* ignore */ }
      }}
    >
      {copied ? '已复制' : label || '复制'}
    </button>
  );
}

/** OpenCode 风格工具调用卡片: 标题=工具名+状态, body=完整 input (可复制) + output + error */
export const ToolView: React.FC<{ part: any; done?: boolean }> = ({ part, done }) => {
  const tool: string = part?.tool || 'tool';
  const status: string = part?.state?.status || 'pending';
  const state = part?.state;
  const input = state?.input;
  const attachments = state?.attachments;
  const [open, setOpen] = useState(!done);
  // 只在 done 翻转 (running→completed) 时折叠一次, 避免覆盖用户手动展开
  const prevDoneRef = useRef(done);
  useEffect(() => {
    if (done && !prevDoneRef.current) setOpen(false);
    prevDoneRef.current = done;
  }, [done]);

  const inStr = useMemo(() => safeStringify(input), [input]);
  const outStr = useMemo(() => pickOutStr(state), [state]);
  const errStr = useMemo(() => pickErrStr(state), [state]);

  const icon = TOOL_ICON[tool] || '⚙';
  const displayName = tool === 'bash' ? 'Shell' : tool;
  const statusText = STATUS_LABEL[status] || status;
  const statusIcon = STATUS_ICON[status] || '·';

  return (
    <div className={`tool is-${status}`}>
      <button type="button" className="tool__head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool__icon is-${status}`}>{icon}</span>
        <span className="tool__name">{displayName}</span>
        <span className={`tool__status is-${status}`}>
          <span className="tool__status-icon">{statusIcon}</span>
          <span className="tool__status-text">{statusText}</span>
        </span>
        <span className="tool__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool__body">
          <div className="tool__section">
            <div className="tool__section-head">
              <span className="tool__section-label">输入</span>
              {inStr && <CopyButton text={inStr} />}
            </div>
            <pre className="tool__code">{inStr}</pre>
          </div>
          {outStr && (
            <div className="tool__section">
              <div className="tool__section-head">
                <span className="tool__section-label">输出</span>
                <CopyButton text={outStr} />
              </div>
              <pre className="tool__code">{outStr.slice(0, 4000)}</pre>
            </div>
          )}
          {errStr && (
            <div className="tool__section is-error">
              <div className="tool__section-head">
                <span className="tool__section-label">错误</span>
                <CopyButton text={errStr} />
              </div>
              <pre className="tool__code">{errStr}</pre>
            </div>
          )}
          {Array.isArray(attachments) && attachments.length > 0 && (
            <div className="tool__section">
              <div className="tool__section-head">
                <span className="tool__section-label">附件</span>
              </div>
              <div className="tool__attach-list">
                {attachments.map((a: any, i: number) => (
                  <span key={i} className="tool__attach">{a?.filename || a?.name || `attach-${i}`}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
