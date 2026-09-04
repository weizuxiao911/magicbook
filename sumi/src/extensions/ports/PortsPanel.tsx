/**
 * PortsPanel — 端口面板 (底部 tab 内容)
 *
 * 对标 VS Code 端口面板 (autoForwardPortsSource: "process"):
 *   - 默认空面板 + 3 步入门引导 (VS Code 简化版)
 *   - 只展示 numas 主动 spawn 的进程 (PTY/Agent) 子进程树 LISTEN + 手动添加端口
 *   - 不扫宿主全局 LISTEN, 无需维护进程名名单
 *   - 顶部单行 toolbar: 标题 + input(端口号\\名称) + 刷新 + 转发按钮 (一行内, 不割裂)
 *   - 列表行: 端口 / 名称备注 (inline 编辑) / 进程 / 打开 / 复制 / ✕
 *
 * 打开逻辑: 走 opencode 反代 `${base}/proxy/<port>/` (服务端转发到 127.0.0.1:<port>).
 *
 * 输入格式: "端口号\\应用名" 或单独 "端口号". 例: "3000" 或 "3000\\API Server"
 *
 * 订阅: 面板 mount 时启动 SSE, unmount 取消; 之前全局常驻通知已删除 (面板未开时不弹).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notification } from '@opensumi/ide-components/lib/notification';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';

import { PortsToken, type IPortsService, type PortEntry } from '../../service/ports';

const STYLES = `
.pf{display:flex;flex-direction:column;height:100%;background:transparent;color:var(--ai-fg,#d1d5db);font-size:12.5px;min-height:0}
.pf-toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0}
.pf-title{font-size:12px;color:var(--ai-fg-muted,#9ca3af);font-weight:600;display:inline-flex;align-items:center;gap:6px;flex-shrink:0}
.pf-title-icon{color:var(--ai-accent,#818cf8);display:inline-flex}
.pf-count{font-size:11px;color:var(--ai-fg-muted,#6b7280);background:var(--ai-hover,rgba(255,255,255,0.04));padding:1px 6px;border-radius:8px;margin-left:2px}
.pf-input-wrap{position:relative;display:flex;align-items:center;flex:1;min-width:120px}
.pf-input-icon{position:absolute;left:9px;color:var(--ai-fg-muted,#6b7280);pointer-events:none;display:inline-flex}
.pf-input{width:100%;height:28px;background:rgba(255,255,255,0.04);border:1px solid var(--ai-divider,rgba(255,255,255,0.1));border-radius:7px;color:var(--ai-fg,#e5e7eb);font-size:12.5px;padding:0 10px 0 28px;outline:none;transition:all .15s;font-family:inherit}
.pf-input::placeholder{color:var(--ai-fg-muted,#6b7280)}
.pf-input:focus{border-color:var(--ai-accent,#6366f1);background:rgba(99,102,255,0.08)}
.pf-add-btn{height:28px;background:var(--ai-accent,#6366f1);border:none;color:#fff;font-size:12.5px;font-weight:600;padding:0 12px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all .12s;flex-shrink:0}
.pf-add-btn:hover{background:var(--ai-accent-strong,#4f52d9)}
.pf-add-btn:disabled{opacity:.45;cursor:default;background:var(--ai-fg-muted,#6b7280)}
.pf-iconbtn{width:28px;height:28px;background:transparent;border:1px solid transparent;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;transition:all .12s;flex-shrink:0}
.pf-iconbtn:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb);border-color:var(--ai-divider,rgba(255,255,255,0.08))}

.pf-list{flex:1;overflow-y:auto;min-height:0}
.pf-item{display:flex;align-items:center;gap:12px;padding:6px 14px;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.03));transition:background .1s}
.pf-item:hover{background:var(--ai-hover,rgba(255,255,255,0.04))}
.pf-port{font-weight:700;color:var(--ai-accent,#818cf8);min-width:60px;font-size:13px;font-variant-numeric:tabular-nums}
.pf-label{display:inline-flex;align-items:center;color:var(--ai-fg,#d1d5db);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0;max-width:180px;cursor:text;padding:2px 6px;border-radius:4px;border:1px solid transparent;font-size:12px;transition:all .12s}
.pf-label:hover{border-color:var(--ai-divider,rgba(255,255,255,0.12));background:rgba(255,255,255,0.03)}
.pf-label-input{background:rgba(255,255,255,0.04);border:1px solid var(--ai-accent,#6366f1);border-radius:4px;color:var(--ai-fg,#e5e7eb);font-size:12px;padding:2px 6px;outline:none;width:160px;font-family:inherit}
.pf-proc{color:var(--ai-fg-muted,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:11px}
.pf-op{display:flex;gap:4px;flex-shrink:0}
.pf-opbtn{background:transparent;border:1px solid transparent;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;font-size:11.5px;padding:3px 8px;border-radius:5px;transition:all .12s}
.pf-opbtn:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#e5e7eb)}
.pf-opbtn--open:hover{color:#4ade80;border-color:rgba(74,222,128,0.3)}
.pf-opbtn--del:hover{color:#f87171;border-color:rgba(248,113,113,0.3)}

.pf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;color:var(--ai-fg-muted,#9ca3af);font-size:12.5px;min-height:200px}
.pf-empty-title{font-size:14px;color:var(--ai-fg-muted,#d1d5db);margin-bottom:4px;font-weight:600}
.pf-empty-sub{font-size:11.5px;color:var(--ai-fg-muted,#6b7280);margin-bottom:18px;text-align:center;max-width:380px;line-height:1.5}
.pf-steps{display:flex;flex-direction:column;gap:10px;width:100%;max-width:380px;padding:14px 16px;background:var(--ai-hover,rgba(255,255,255,0.03));border:1px solid var(--ai-divider,rgba(255,255,255,0.06));border-radius:10px;margin-bottom:14px}
.pf-step{display:flex;align-items:flex-start;gap:10px;font-size:11.5px;color:var(--ai-fg-muted,#cbd1d8);line-height:1.5}
.pf-step-num{flex-shrink:0;width:18px;height:18px;background:var(--ai-accent,rgba(99,102,255,0.2));color:var(--ai-accent,#a5b4fc);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}
.pf-step-code{font-family:monospace;background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;color:var(--ai-fg,#e5e7eb);font-size:11px}
`;

const LABELS_KEY = 'ai-ports-labels';

function loadLabels(): Record<number, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LABELS_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? (obj as Record<number, string>) : {};
  } catch {
    return {};
  }
}

function saveLabels(labels: Record<number, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LABELS_KEY, JSON.stringify(labels));
  } catch {
    /* 静默 */
  }
}

function defaultLabel(e: PortEntry): string {
  if (e.process) return e.process.trim().slice(0, 16) || '未知进程';
  return '手动转发';
}

/** 解析 "端口号\\名称" 或单独 "端口号". 返回 { port, label } 或 null. */
function parseInput(raw: string): { port: number; label: string } | null {
  const text = raw.trim();
  if (!text) return null;
  // 仅允许反斜杠分隔, 前段为端口号, 后段任意名称
  const idx = text.indexOf("\\");
  let portText: string;
  let label = "";
  if (idx >= 0) {
    portText = text.slice(0, idx).trim();
    label = text.slice(idx + 1).trim();
  } else {
    portText = text;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, label };
}

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const PortIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="6" y1="10" x2="6.01" y2="10" />
    <line x1="10" y1="10" x2="10.01" y2="10" />
  </svg>
);

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const PortsPanel: React.FC = () => {
  const ports = useInjectable<IPortsService>(PortsToken);
  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [input, setInput] = useState('');
  const [labels, setLabels] = useState<Record<number, string>>(() => loadLabels());
  const [editingPort, setEditingPort] = useState<number | null>(null);
  const editingValueRef = useRef<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await ports.scan();
      setEntries(list);
    } catch (e: any) {
      notification.error({ message: `端口扫描失败: ${e?.message || e}`, type: 'error', duration: 3 });
    }
  }, [ports]);

  useEffect(() => {
    void refresh();
    const un = ports.subscribe((e) => {
      if (e.type === 'ports.detected') {
        setEntries((prev) => {
          if (prev.some((p) => p.port === e.port)) return prev;
          return [...prev, { port: e.port, process: e.process, detectedAt: Date.now() }]
            .sort((a, b) => a.port - b.port);
        });
        const customLabel = labels[e.port];
        const nameText = customLabel || (e.process ? `${e.process}` : '');
        notification.info({
          message: `检测到服务 :${e.port}${nameText ? ` [${nameText}]` : ''}`,
          description: '点击通知, 经 opencode 打开服务',
          type: 'info',
          duration: 8,
          onClick: () => {
            window.open(ports.proxyUrl(e.port), '_blank', 'noopener');
          },
        });
      } else if (e.type === 'ports.closed') {
        setEntries((prev) => prev.filter((p) => p.port !== e.port));
      }
    });
    return un;
  }, [ports, refresh, labels]);

  const openPort = useCallback((port: number) => {
    window.open(ports.proxyUrl(port), '_blank', 'noopener');
  }, [ports]);

  const copyUrl = useCallback(async (port: number) => {
    try {
      await navigator.clipboard.writeText(ports.proxyUrl(port));
      notification.info({ message: `已复制: ${ports.proxyUrl(port)}`, type: 'info', duration: 2 });
    } catch {
      notification.error({ message: '复制失败', type: 'error', duration: 2 });
    }
  }, [ports]);

  const removePort = useCallback(async (port: number) => {
    try {
      await ports.remove(port);
      setEntries((prev) => prev.filter((p) => p.port !== port));
    } catch (e: any) {
      notification.error({ message: `移除失败: ${e?.message || e}`, type: 'error', duration: 3 });
    }
  }, [ports]);

  const submitInput = useCallback(async () => {
    const parsed = parseInput(input);
    if (!parsed) {
      notification.error({ message: '格式: 端口号 或 端口号\\名称', type: 'error', duration: 3 });
      inputRef.current?.focus();
      return;
    }
    const { port, label } = parsed;
    setInput('');
    try {
      await ports.add(port);
      if (label) {
        setLabels((prev) => {
          const next = { ...prev, [port]: label };
          saveLabels(next);
          return next;
        });
      }
      await refresh();
      notification.info({
        message: `已转发 :${port}${label ? ` [${label}]` : ''}`,
        type: 'info',
        duration: 2,
      });
    } catch (e: any) {
      notification.error({ message: `添加失败: ${e?.message || e}`, type: 'error', duration: 3 });
    }
  }, [input, ports, refresh]);

  const beginEdit = useCallback((port: number, current: string) => {
    setEditingPort(port);
    editingValueRef.current = current;
  }, []);

  const commitEdit = useCallback((port: number, value: string) => {
    const trimmed = value.trim();
    setLabels((prev) => {
      const next = { ...prev };
      if (trimmed) next[port] = trimmed;
      else delete next[port];
      saveLabels(next);
      return next;
    });
    setEditingPort(null);
  }, []);

  const cancelEdit = useCallback(() => setEditingPort(null), []);

  const sortedEntries = useMemo(() => entries.slice().sort((a, b) => a.port - b.port), [entries]);

  const canSubmit = parseInput(input) !== null;

  return (
    <div className="pf">
      <style>{STYLES}</style>
      {/* 顶部 toolbar: 标题 + input(端口号\\名称) + 刷新 + 转发 全部一行 */}
      <div className="pf-toolbar">
        <span className="pf-title">
          <span className="pf-title-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="2" />
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </span>
          端口
          {entries.length > 0 && <span className="pf-count">{entries.length}</span>}
        </span>
        <div className="pf-input-wrap">
          <span className="pf-input-icon"><PortIcon /></span>
          <input
            ref={inputRef}
            className="pf-input"
            type="text"
            placeholder="端口号\\名称, 如 3000 或 3000\\API Server"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitInput(); }}
            maxLength={64}
            spellCheck={false}
          />
        </div>
        <button className="pf-add-btn" onClick={() => void submitInput()} disabled={!canSubmit} title="添加端口 (格式: 端口号 或 端口号\\名称)">
          <PlusIcon />
          <span>转发</span>
        </button>
        <button className="pf-iconbtn" onClick={() => void refresh()} title="重新扫描端口">
          <RefreshIcon />
        </button>
      </div>
      <div className="pf-list">
        {entries.length === 0 && (
          <div className="pf-empty">
            <div className="pf-empty-title">没有转发的端口</div>
            <div className="pf-empty-sub">转发端口以通过 Internet 访问本地运行的服务</div>
            <div className="pf-steps">
              <div className="pf-step">
                <span className="pf-step-num">1</span>
                <span>在底部终端里启动你的服务, 例如 <span className="pf-step-code">npm run dev</span> 或 <span className="pf-step-code">python -m http.server 8080</span></span>
              </div>
              <div className="pf-step">
                <span className="pf-step-num">2</span>
                <span>服务启动后端口面板自动检测并出现在列表中, 顶部会弹出通知</span>
              </div>
              <div className="pf-step">
                <span className="pf-step-num">3</span>
                <span>点击「打开」经 opencode 反代访问 (<span className="pf-step-code">localhost:24096/proxy/&lt;port&gt;</span>)</span>
              </div>
            </div>
            <div className="pf-empty-sub" style={{ marginBottom: 0 }}>或在上方输入框填写「端口号」或「端口号\名称」手动添加</div>
          </div>
        )}
        {sortedEntries.map((e) => {
          const label = labels[e.port] ?? defaultLabel(e);
          const isEditing = editingPort === e.port;
          return (
            <div className="pf-item" key={e.port}>
              <span className="pf-port">:{e.port}</span>
              {isEditing ? (
                <input
                  className="pf-label-input"
                  autoFocus
                  defaultValue={editingValueRef.current}
                  onBlur={(ev) => commitEdit(e.port, ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') commitEdit(e.port, (ev.target as HTMLInputElement).value);
                    else if (ev.key === 'Escape') cancelEdit();
                  }}
                  onFocus={(ev) => ev.target.select()}
                  placeholder="备注名称"
                />
              ) : (
                <span className="pf-label" title="点击编辑备注" onClick={() => beginEdit(e.port, label)}>{label}</span>
              )}
              <span className="pf-proc" title={e.process ? `${e.process}${e.pid ? ` (pid ${e.pid})` : ''}` : '手动转发'}>
                {e.process || '手动转发'}{e.pid ? ` · ${e.pid}` : ''}
              </span>
              <div className="pf-op">
                <button className="pf-opbtn pf-opbtn--open" onClick={() => openPort(e.port)} title="通过 opencode 反代打开">打开</button>
                <button className="pf-opbtn" onClick={() => void copyUrl(e.port)} title="复制反代 URL">复制</button>
                <button className="pf-opbtn pf-opbtn--del" onClick={() => void removePort(e.port)} title="从列表移除">✕</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};