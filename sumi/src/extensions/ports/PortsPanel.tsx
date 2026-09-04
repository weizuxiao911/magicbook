/**
 * PortsPanel — 端口面板 (底部 tab 内容)
 *
 * 功能:
 *   - 列表: 端口 / 进程 / 操作 (打开 / 复制 URL / 移除)
 *   - 刷新 (GET /ports) / 手动添加端口 (POST /ports)
 *   - SSE 订阅: 新服务 detected → notification 提示 + 列表即时插入
 *
 * 打开逻辑: 走 opencode 反代 `${base}/proxy/<port>/` (服务端转发到 127.0.0.1:<port>).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { notification } from '@opensumi/ide-components/lib/notification';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';

import { PortsToken, type IPortsService, type PortEntry } from '../../service/ports';

const STYLES = `
.pf{display:flex;flex-direction:column;height:100%;background:transparent;color:var(--ai-fg,#d1d5db);font-size:12.5px;min-height:0}
.pf-bar{display:flex;align-items:center;gap:8px;padding:4px 10px;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0}
.pf-title{font-size:12px;color:var(--ai-fg-muted,#9ca3af);margin-right:auto}
.pf-btn{background:var(--ai-hover,rgba(255,255,255,0.05));border:1px solid var(--ai-divider,rgba(255,255,255,0.08));border-radius:6px;color:var(--ai-fg-muted,#cbd1d8);font-size:11.5px;padding:3px 10px;cursor:pointer}
.pf-btn:hover{background:var(--ai-accent,#6366f1);color:#fff}
.pf-add{display:flex;gap:6px;align-items:center}
.pf-add-inp{width:80px;background:rgba(255,255,255,0.04);border:1px solid var(--ai-divider,rgba(255,255,255,0.08));border-radius:6px;color:var(--ai-fg,#e5e7eb);font-size:11.5px;padding:3px 8px;outline:none}
.pf-list{flex:1;overflow-y:auto;min-height:0}
.pf-item{display:flex;align-items:center;gap:12px;padding:5px 14px;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.03))}
.pf-item:hover{background:var(--ai-hover,rgba(255,255,255,0.04))}
.pf-port{font-weight:700;color:var(--ai-accent,#818cf8);min-width:64px;font-size:12.5px}
.pf-proc{color:var(--ai-fg,#d1d5db);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.pf-empty{padding:24px;text-align:center;color:var(--ai-fg-muted,#6b7280);font-size:12px}
.pf-op{display:flex;gap:6px;flex-shrink:0}
.pf-opbtn{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;font-size:11.5px;padding:2px 6px;border-radius:4px}
.pf-opbtn:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#e5e7eb)}
.pf-opbtn--open:hover{color:#4ade80}
.pf-opbtn--del:hover{color:#f87171}
`;

export const PortsPanel: React.FC = () => {
  const ports = useInjectable<IPortsService>(PortsToken);
  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [addPort, setAddPort] = useState('');

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
      } else if (e.type === 'ports.closed') {
        setEntries((prev) => prev.filter((p) => p.port !== e.port));
      }
    });
    return un;
  }, [ports, refresh]);

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

  const addManual = useCallback(async () => {
    const p = Number(addPort.trim());
    if (!Number.isInteger(p) || p < 1 || p > 65535) return;
    setAddPort('');
    try {
      await ports.add(p);
      await refresh();
    } catch (e: any) {
      notification.error({ message: `添加失败: ${e?.message || e}`, type: 'error', duration: 3 });
    }
  }, [addPort, ports, refresh]);

  // busy guard for double refresh
  return (
    <div className="pf">
      <style>{STYLES}</style>
      <div className="pf-bar">
        <span className="pf-title">{entries.length > 0 ? `${entries.length} 个服务端口` : '端口面板'}</span>
        <div className="pf-add">
          <input
            className="pf-add-inp"
            placeholder="端口号"
            value={addPort}
            onChange={(e) => setAddPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addManual(); }}
          />
          <button className="pf-btn" onClick={() => void addManual()} disabled={!addPort.trim()}>添加</button>
        </div>
        <button className="pf-btn" onClick={() => void refresh()}>刷新</button>
      </div>
      <div className="pf-list">
        {entries.length === 0 && <div className="pf-empty">暂无检测到的服务端口 (终端里启动服务后自动出现)</div>}
        {entries.map((e) => (
          <div className="pf-item" key={e.port}>
            <span className="pf-port">{e.port}</span>
            <span className="pf-proc" title={e.process ? `${e.process}${e.pid ? ` (pid ${e.pid})` : ''}` : ''}>
              {e.process || '未知进程'}{e.pid ? ` · ${e.pid}` : ''}
            </span>
            <div className="pf-op">
              <button className="pf-opbtn pf-opbtn--open" onClick={() => openPort(e.port)} title="通过 opencode 反代打开">打开</button>
              <button className="pf-opbtn" onClick={() => void copyUrl(e.port)} title="复制反代 URL">复制URL</button>
              <button className="pf-opbtn pf-opbtn--del" onClick={() => void removePort(e.port)} title="从列表移除">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
