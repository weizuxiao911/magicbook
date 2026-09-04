/**
 * PortsPanel — 端口面板 (底部 tab 内容)
 *
 * 对标 VS Code 端口面板:
 *   - 默认空 + 大「转发端口」按钮 (VS Code 同款空态)
 *   - 顶部 toolbar: icon 选择器 (预设图标) + 端口 + 应用名 + 转发 + 刷新
 *   - 列表行: [icon] :port [name] [process] [open][copy][✕]
 *
 * 持久化: 手动转发记录写到工作台 `.codeblitz/forwards.ports` (icon:port:name / 行).
 * 走 codeblitz IFileServiceClient → opencode /api/fs/write.
 * 重启后: 客户端读文件 → 同步到服务端 whitelist (/proxy 可用).
 *
 * 打开逻辑: 走 opencode 反代 `${base}/proxy/<port>/` (服务端转发到 127.0.0.1:<port>).
 *
 * 订阅: 面板 mount 时启动 SSE, unmount 取消.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notification } from '@opensumi/ide-components/lib/notification';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IFileServiceClient } from '@opensumi/ide-file-service';

import { PortsToken, type IPortsService, type PortEntry } from '../../service/ports';
import {
  readForwards,
  upsertForward,
  removeForward,
  type ForwardRecord,
} from './forwards-file';

const STYLES = `
.pf{display:flex;flex-direction:column;height:100%;background:transparent;color:var(--ai-fg,#d1d5db);font-size:12.5px;min-height:0}
.pf-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0;flex-wrap:nowrap}
.pf-title{font-size:12px;color:var(--ai-fg-muted,#9ca3af);font-weight:600;display:inline-flex;align-items:center;gap:6px;flex-shrink:0;min-width:48px}
.pf-title-icon{color:var(--ai-accent,#818cf8);display:inline-flex}
.pf-count{font-size:11px;color:var(--ai-fg-muted,#6b7280);background:var(--ai-hover,rgba(255,255,255,0.04));padding:1px 6px;border-radius:8px;margin-left:2px}

/* icon 触发按钮 (单按钮) + 下拉 popover */
.pf-icon-trigger{position:relative;height:28px;min-width:32px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;gap:2px;background:rgba(255,255,255,0.04);border:1px solid var(--ai-divider,rgba(255,255,255,0.1));border-radius:7px;color:var(--ai-fg,#e5e7eb);font-size:15px;cursor:pointer;flex-shrink:0;transition:all .12s;line-height:1}
.pf-icon-trigger:hover{background:rgba(99,102,241,0.1);border-color:var(--ai-accent,#6366f1)}
.pf-icon-trigger--open{background:rgba(99,102,241,0.12);border-color:var(--ai-accent,#6366f1)}
.pf-icon-trigger-caret{font-size:9px;color:var(--ai-fg-muted,#6b7280);margin-left:1px}
.pf-icon{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;background:transparent;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;border-radius:6px;transition:all .12s;line-height:1;padding:0}
.pf-icon:hover{background:rgba(255,255,255,0.08);color:var(--ai-fg,#e5e7eb)}
.pf-icon--sel{background:var(--ai-accent,#6366f1) !important;color:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.2)}
.pf-icon--sel:hover{background:var(--ai-accent-strong,#4f52d9) !important;color:#fff}
.pf-icon-popover{position:absolute;top:calc(100% + 4px);left:0;z-index:100;display:grid;grid-template-columns:repeat(6,32px);gap:2px;padding:6px;background:var(--ai-bg-elevated,#1f2028);border:1px solid var(--ai-divider,rgba(255,255,255,0.12));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.4)}
.pf-icon-popover .pf-icon{background:transparent}
.pf-icon-popover .pf-icon:hover{background:rgba(255,255,255,0.08);color:var(--ai-fg,#e5e7eb)}
.pf-icon-popover .pf-icon--sel{background:var(--ai-accent,#6366f1);color:#fff}

.pf-input-wrap{position:relative;display:flex;align-items:center;min-width:120px}
.pf-input-wrap--port{flex:0 0 110px}
.pf-input-wrap--name{flex:1;min-width:140px}
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
.pf-row{display:grid;grid-template-columns:24px 80px 1fr 1.5fr auto;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.03));transition:background .1s}
.pf-row:hover{background:var(--ai-hover,rgba(255,255,255,0.04))}
.pf-row--head{background:transparent;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.08));color:var(--ai-fg-muted,#9ca3af);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;padding:6px 14px;position:sticky;top:0;background:rgba(20,20,28,0.95);backdrop-filter:blur(4px);z-index:1}
.pf-row--head:hover{background:rgba(20,20,28,0.95)}
.pf-row-ico{font-size:16px;line-height:1;text-align:center;cursor:pointer;padding:2px 0;border-radius:4px;transition:background .12s}
.pf-row-ico:hover{background:rgba(255,255,255,0.06)}
.pf-row-port{font-weight:700;color:var(--ai-accent,#818cf8);font-size:13px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-row-name{color:var(--ai-fg,#d1d5db);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;cursor:text;padding:2px 6px;border-radius:4px;border:1px solid transparent;transition:all .12s;min-width:0}
.pf-row-name:hover{border-color:var(--ai-divider,rgba(255,255,255,0.12));background:rgba(255,255,255,0.03)}
.pf-row-name-input{background:rgba(255,255,255,0.04);border:1px solid var(--ai-accent,#6366f1);border-radius:4px;color:var(--ai-fg,#e5e7eb);font-size:12px;padding:2px 6px;outline:none;width:100%;font-family:inherit}
.pf-row-proc{color:var(--ai-fg-muted,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;min-width:0}
.pf-row-proc--manual{color:var(--ai-fg-muted,#6b7280);font-style:italic}
.pf-row-op{display:flex;gap:4px;flex-shrink:0}
.pf-opbtn{background:transparent;border:1px solid transparent;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;font-size:11.5px;padding:3px 8px;border-radius:5px;transition:all .12s}
.pf-opbtn:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#e5e7eb)}
.pf-opbtn--open:hover{color:#4ade80;border-color:rgba(74,222,128,0.3)}
.pf-opbtn--del:hover{color:#f87171;border-color:rgba(248,113,113,0.3)}

.pf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px;color:var(--ai-fg-muted,#9ca3af);font-size:12.5px;min-height:280px;gap:14px}
.pf-empty-title{font-size:13.5px;color:var(--ai-fg-muted,#d1d5db);font-weight:500;text-align:center}
.pf-empty-btn{height:34px;background:var(--ai-accent,#6366f1);border:none;color:#fff;font-size:13px;font-weight:600;padding:0 24px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .12s;box-shadow:0 1px 3px rgba(0,0,0,0.15)}
.pf-empty-btn:hover{background:var(--ai-accent-strong,#4f52d9);transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,0.2)}
.pf-empty-hint{font-size:11.5px;color:var(--ai-fg-muted,#6b7280);text-align:center;max-width:420px;line-height:1.6;margin-top:4px}
.pf-empty-hint code{font-family:monospace;background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;color:var(--ai-fg,#e5e7eb);font-size:11px}
`;

/** 预设图标 — VS Code 端口面板风格 (Codicon 同款语义 + emoji 实际渲染). */
const PRESET_ICONS = ['🔌', '🌐', '⚡', '🚀', '📦', '🔥', '⚙️', '🐮', '🎯', '💻', '🛠', '🗄'] as const;
const DEFAULT_ICON = '🔌';

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
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const PortsPanel: React.FC = () => {
  const ports = useInjectable<IPortsService>(PortsToken);
  const fileService = useInjectable<IFileServiceClient>(IFileServiceClient);

  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [forwards, setForwards] = useState<Record<number, ForwardRecord>>({});
  const [selectedIcon, setSelectedIcon] = useState<string>(DEFAULT_ICON);
  const [portInput, setPortInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [editingPort, setEditingPort] = useState<number | null>(null);
  const editingValueRef = useRef<string>('');
  const [editingIconPort, setEditingIconPort] = useState<number | null>(null);
  const [iconPopoverOpen, setIconPopoverOpen] = useState(false);
  const iconTriggerRef = useRef<HTMLDivElement>(null);
  const portInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  /** 已通知过的端口 (跨 effect 重订阅保留, 避免 React 18 StrictMode / forwards 变更触发重复订阅时弹 2 个通知). */
  const notifiedRef = useRef<Set<number>>(new Set());
  /** 标记 mount 首次同步是否完成 (避免 init 期间 UI 抖动). */
  const initRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await ports.scan();
      setEntries(list);
      return list;
    } catch (e: any) {
      notification.error({ message: `端口扫描失败: ${e?.message || e}`, type: 'error', duration: 3 });
      return [];
    }
  }, [ports]);

  /** 同步文件记录到服务端 whitelist (端口不在 server 列表时 add).
   *  文件是用户视角的"转发历史", 服务端 whitelist 是 /proxy 的可用集合. */
  const syncForwardsToServer = useCallback(async (records: ForwardRecord[]) => {
    if (records.length === 0) return;
    let serverList: PortEntry[] = [];
    try {
      serverList = await ports.scan();
    } catch {
      return;
    }
    const known = new Set(serverList.map((e) => e.port));
    for (const r of records) {
      if (!known.has(r.port)) {
        try { await ports.add(r.port); } catch { /* 静默, 用户可重试 */ }
      }
    }
  }, [ports]);

  /** 启动: 读文件 → setForwards → 同步到服务端 → 拉一次 server 列表. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let records: ForwardRecord[] = [];
      try {
        records = await readForwards(fileService);
      } catch (e: any) {
        console.warn('[ports] 读 forwards.ports 失败:', e?.message || e);
      }
      if (cancelled) return;
      const map: Record<number, ForwardRecord> = {};
      for (const r of records) map[r.port] = r;
      setForwards(map);
      await syncForwardsToServer(records);
      if (cancelled) return;
      await refresh();
      initRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [fileService, refresh, syncForwardsToServer]);

  /** 关闭 icon 下拉 (点击外部). */
  useEffect(() => {
    if (!iconPopoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (iconTriggerRef.current && !iconTriggerRef.current.contains(e.target as Node)) {
        setIconPopoverOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIconPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [iconPopoverOpen]);

  /** 订阅 SSE: 仅 ports.detected / ports.closed. */
  useEffect(() => {
    const un = ports.subscribe((e) => {
      if (e.type === 'ports.detected') {
        // 全局跨订阅 dedup: 同一端口 panel 生命周期内只弹一次通知
        if (notifiedRef.current.has(e.port)) {
          setEntries((prev) =>
            prev.some((p) => p.port === e.port)
              ? prev
              : [...prev, { port: e.port, process: e.process, detectedAt: Date.now() }]
                  .sort((a, b) => a.port - b.port),
          );
          return;
        }
        notifiedRef.current.add(e.port);
        setEntries((prev) =>
          prev.some((p) => p.port === e.port)
            ? prev
            : [...prev, { port: e.port, process: e.process, detectedAt: Date.now() }]
                .sort((a, b) => a.port - b.port),
        );
        const fr = forwards[e.port];
        const label = fr?.name || (e.process ? `${e.process}` : '');
        notification.info({
          message: `检测到服务 :${e.port}${label ? ` [${label}]` : ''}`,
          description: '点击访问应用',
          type: 'info',
          duration: 8,
          onClick: () => {
            window.open(ports.proxyUrl(e.port), '_blank', 'noopener');
          },
        });
      } else if (e.type === 'ports.closed') {
        setEntries((prev) => prev.filter((p) => p.port !== e.port));
        notifiedRef.current.delete(e.port);
      }
    });
    return un;
  }, [ports, forwards]);

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
      return;
    }
    try {
      const next = await removeForward(fileService, port);
      const map: Record<number, ForwardRecord> = {};
      for (const r of next) map[r.port] = r;
      setForwards(map);
    } catch (e: any) {
      console.warn('[ports] 删 forwards.ports 失败 (server 已删):', e?.message || e);
      setForwards((prev) => {
        const { [port]: _, ...rest } = prev;
        return rest;
      });
    }
  }, [ports, fileService]);

  const submitInput = useCallback(async () => {
    const port = Number(portInput.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      notification.error({ message: '端口号无效 (1-65535)', type: 'error', duration: 2 });
      portInputRef.current?.focus();
      return;
    }
    const name = nameInput.trim();
    const icon = selectedIcon || DEFAULT_ICON;
    setPortInput('');
    setNameInput('');
    setSelectedIcon(DEFAULT_ICON);
    try {
      await ports.add(port);
    } catch (e: any) {
      notification.error({ message: `添加失败: ${e?.message || e}`, type: 'error', duration: 3 });
      return;
    }
    try {
      const next = await upsertForward(fileService, port, icon, name);
      const map: Record<number, ForwardRecord> = {};
      for (const r of next) map[r.port] = r;
      setForwards(map);
    } catch (e: any) {
      notification.warn({ message: `已转发 :${port} 但本地记录失败: ${e?.message || e}`, type: 'warning', duration: 3 });
    }
    const cur = await refresh();
    // 若端口已存在于服务端 entries (SSE 已通知过 "检测到服务"), 跳过重复通知
    if (!cur.some((p) => p.port === port)) {
      notification.info({
        message: `已转发 :${port}${name ? ` [${name}]` : ''}`,
        type: 'info',
        duration: 2,
      });
    }
  }, [portInput, nameInput, selectedIcon, ports, fileService, refresh]);

  const beginEditName = useCallback((port: number, current: string) => {
    setEditingPort(port);
    editingValueRef.current = current;
  }, []);

  const commitEditName = useCallback(async (port: number, value: string) => {
    const trimmed = value.trim();
    setEditingPort(null);
    const cur = forwards[port];
    if (!cur) return;
    if (cur.name === trimmed) return;
    try {
      const next = await upsertForward(fileService, port, cur.icon, trimmed);
      const map: Record<number, ForwardRecord> = {};
      for (const r of next) map[r.port] = r;
      setForwards(map);
    } catch (e: any) {
      notification.error({ message: `更新名称失败: ${e?.message || e}`, type: 'error', duration: 3 });
    }
  }, [forwards, fileService]);

  const cancelEdit = useCallback(() => setEditingPort(null), []);

  const commitEditIcon = useCallback(async (port: number, icon: string) => {
    setEditingIconPort(null);
    const cur = forwards[port];
    if (!cur || cur.icon === icon) return;
    try {
      const next = await upsertForward(fileService, port, icon, cur.name);
      const map: Record<number, ForwardRecord> = {};
      for (const r of next) map[r.port] = r;
      setForwards(map);
    } catch (e: any) {
      notification.error({ message: `更新图标失败: ${e?.message || e}`, type: 'error', duration: 3 });
    }
  }, [forwards, fileService]);

  /** 合并: 服务端 entries + 文件记录 (文件记录含 icon/name, 服务端 entries 含 process/pid). */
  const merged = useMemo(() => {
    const map = new Map<number, { port: number; icon: string; name: string; process?: string; pid?: number; source: 'file' | 'scan'; detectedAt: number }>();
    for (const e of entries) {
      const fr = forwards[e.port];
      map.set(e.port, {
        port: e.port,
        icon: fr?.icon || (e.process ? '⚡' : DEFAULT_ICON),
        name: fr?.name || '',
        process: e.process,
        pid: e.pid,
        source: fr ? 'file' : 'scan',
        detectedAt: e.detectedAt,
      });
    }
    for (const r of Object.values(forwards)) {
      if (!map.has(r.port)) {
        map.set(r.port, {
          port: r.port,
          icon: r.icon,
          name: r.name,
          source: 'file',
          detectedAt: 0,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.port - b.port);
  }, [entries, forwards]);

  const canSubmit = (() => {
    const p = Number(portInput.trim());
    return Number.isInteger(p) && p >= 1 && p <= 65535;
  })();

  return (
    <div className="pf">
      <style>{STYLES}</style>
      <div className="pf-toolbar">
        <span className="pf-title">
          <span className="pf-title-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="2" />
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </span>
          端口
          {merged.length > 0 && <span className="pf-count">{merged.length}</span>}
        </span>

        <div ref={iconTriggerRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            className={'pf-icon-trigger' + (iconPopoverOpen ? ' pf-icon-trigger--open' : '')}
            onClick={() => setIconPopoverOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={iconPopoverOpen}
            title="选择图标"
          >
            <span>{selectedIcon}</span>
            <span className="pf-icon-trigger-caret">▾</span>
          </button>
          {iconPopoverOpen && (
            <div className="pf-icon-popover" role="radiogroup" aria-label="选择图标">
              {PRESET_ICONS.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  role="radio"
                  aria-checked={selectedIcon === ic}
                  className={'pf-icon' + (selectedIcon === ic ? ' pf-icon--sel' : '')}
                  onClick={() => { setSelectedIcon(ic); setIconPopoverOpen(false); }}
                  title={ic}
                >{ic}</button>
              ))}
            </div>
          )}
        </div>

        <div className="pf-input-wrap pf-input-wrap--port">
          <span className="pf-input-icon"><PortIcon /></span>
          <input
            ref={portInputRef}
            className="pf-input"
            type="text"
            inputMode="numeric"
            placeholder="端口号"
            value={portInput}
            onChange={(e) => setPortInput(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (canSubmit) void submitInput();
                else nameInputRef.current?.focus();
              }
            }}
            maxLength={5}
            aria-label="端口号"
            spellCheck={false}
          />
        </div>
        <div className="pf-input-wrap pf-input-wrap--name">
          <input
            ref={nameInputRef}
            className="pf-input"
            style={{ paddingLeft: 10 }}
            type="text"
            placeholder="应用名 (选填)"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitInput(); }}
            maxLength={48}
            aria-label="应用名"
            spellCheck={false}
          />
        </div>
        <button className="pf-add-btn" onClick={() => void submitInput()} disabled={!canSubmit} title="转发端口 (应用名选填)">
          <PlusIcon />
          <span>转发</span>
        </button>
        <button className="pf-iconbtn" onClick={() => void refresh()} title="重新扫描端口">
          <RefreshIcon />
        </button>
      </div>

      <div className="pf-list">
        {merged.length === 0 && (
          <div className="pf-empty">
            <div className="pf-empty-title">没有转发的端口。转发端口以通过 Internet 访问本地运行的服务。</div>
            <button
              className="pf-empty-btn"
              onClick={() => portInputRef.current?.focus()}
              title="在顶部输入端口号 + 应用名后回车"
            >
              <PlusIcon />
              <span>转发端口</span>
            </button>
            <div className="pf-empty-hint">
              在底部终端里启动服务, 例如 <code>npm run dev</code> 或 <code>python -m http.server 8080</code>, 服务启动后端口面板自动检测.
              <br />也可在上方选择图标 → 输入端口 → 回车手动添加.
            </div>
          </div>
        )}
        {merged.length > 0 && (
          <div className="pf-row pf-row--head">
            <span></span>
            <span>端口</span>
            <span>应用名</span>
            <span>正在运行的进程</span>
            <span></span>
          </div>
        )}
        {merged.map((m) => {
          const isNameEditing = editingPort === m.port;
          const isIconEditing = editingIconPort === m.port;
          return (
            <div className="pf-row" key={m.port}>
              {isIconEditing ? (
                <div className="pf-icon-popover" style={{ position: 'static', boxShadow: 'none', border: '1px solid var(--ai-divider,rgba(255,255,255,0.08))' }} role="radiogroup" aria-label="选择图标">
                  {PRESET_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      role="radio"
                      aria-checked={m.icon === ic}
                      className={'pf-icon' + (m.icon === ic ? ' pf-icon--sel' : '')}
                      onClick={() => void commitEditIcon(m.port, ic)}
                      title={ic}
                    >{ic}</button>
                  ))}
                </div>
              ) : (
                <>
                  <span
                    className="pf-row-ico"
                    title="点击更换图标"
                    onClick={() => { setEditingIconPort(m.port); setEditingPort(null); }}
                  >{m.icon}</span>
                  <span className="pf-row-port" title={m.pid ? `pid ${m.pid}` : ''}>:{m.port}</span>
                  {isNameEditing ? (
                    <input
                      className="pf-row-name-input"
                      autoFocus
                      defaultValue={m.name || editingValueRef.current}
                      onBlur={(ev) => void commitEditName(m.port, ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') void commitEditName(m.port, (ev.target as HTMLInputElement).value);
                        else if (ev.key === 'Escape') cancelEdit();
                      }}
                      onFocus={(ev) => ev.target.select()}
                      placeholder="备注应用名"
                    />
                  ) : (
                    <span
                      className="pf-row-name"
                      title={m.name ? '点击编辑应用名' : '点击添加应用名'}
                      onClick={() => { editingValueRef.current = m.name; beginEditName(m.port, m.name); }}
                    >{m.name || <span style={{ opacity: 0.45 }}>+ 添加应用名</span>}</span>
                  )}
                  <span
                    className={'pf-row-proc' + (!m.process ? ' pf-row-proc--manual' : '')}
                    title={m.process ? `${m.process}${m.pid ? ` (pid ${m.pid})` : ''}` : '手动转发'}
                  >
                    {m.process ? `${m.process}${m.pid ? ` · ${m.pid}` : ''}` : '手动转发'}
                  </span>
                  <div className="pf-row-op">
                    <button className="pf-opbtn pf-opbtn--open" onClick={() => openPort(m.port)} title="在浏览器中打开应用">打开</button>
                    <button className="pf-opbtn" onClick={() => void copyUrl(m.port)} title="复制反代 URL">复制</button>
                    <button className="pf-opbtn pf-opbtn--del" onClick={() => void removePort(m.port)} title="从列表移除">✕</button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
