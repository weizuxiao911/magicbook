import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import { appBaseUrl, cwdHeader, effectiveCwd } from '../../service/env';
import { setCwd } from '../../service/workspace';
import { getRecent } from './recent';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

interface DirEntry { name: string; path: string; }

const QUICK = [
  { name: '用户', path: '~' },
  { name: '桌面', path: '~/Desktop' },
  { name: '文档', path: '~/Documents' },
  { name: '下载', path: '~/Downloads' },
];

async function browseDir(path: string): Promise<{ path: string; directories: DirEntry[] }> {
  // SDK client.file.list: 返回 FileNode[] (name, path, type, ...), 用 path 字段名直接取
  const client = await getFsClient();
  const { data, error } = await client.file.list({ path: '.', directory: path });
  if (error) throw new Error(`browse failed: ${(error as any)?.message || 'unknown'}`);
  const entries: Array<{ name: string; path: string; type: 'file' | 'directory' }> = Array.isArray(data) ? (data as any) : [];
  const directories = entries
    .filter((e) => e.type === 'directory')
    .map((e) => ({
      name: e.name,
      path: path.replace(/\/+$/, '') + '/' + e.path.replace(/^\/+/, ''),
    }));
  return { path: path.replace(/\/+$/, ''), directories };
}

let _fsClient: any = null;
let _fsSessionId: string | null = null;

async function getFsClient(): Promise<any> {
  if (_fsClient) return _fsClient;
  const base = appBaseUrl();
  if (!base) throw new Error('app base url not ready');
  _fsClient = createOpencodeClient({
    baseUrl: base,
    headers: cwdHeader(),
    responseStyle: 'fields',
    throwOnError: true,
  });
  return _fsClient;
}

async function getFsSession(): Promise<string> {
  if (_fsSessionId) return _fsSessionId;
  const client = await getFsClient();
  const { data, error } = await client.session.create({ title: 'fs-shim' });
  if (error || !data?.id) throw new Error('fs session create failed');
  const id = data.id as string;
  _fsSessionId = id;
  return id;
}

async function mkdirDir(parent: string, name: string): Promise<{ ok: boolean; path: string }> {
  const target = parent.replace(/\/+$/, '') + '/' + name;
  const sid = await getFsSession();
  const client = await getFsClient();
  const cmd = `mkdir -p ${shellQuote(target)} && echo __OK__`;
  const { data, error } = await client.session.shell({
    sessionID: sid,
    agent: 'build',
    command: cmd,
  });
  if (error) throw error;
  const ok = JSON.stringify(data).includes('__OK__');
  return { ok, path: target };
}

export const WorkspacePicker: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [mkMode, setMkMode] = useState(false);
  const [mkName, setMkName] = useState('');
  const [active, setActive] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [recent, setRecent] = useState<string[]>(() => getRecent());
  // 监听 recent 变化 (e.g. 切到某条 recent 后 addRecent 触发)
// 用户家目录: opencode /path 返回, 用于展开 QUICK 里的 ~ 路径 (opencode 不展开 ~, 必须给绝对路径)
const [home, setHome] = useState('');

/** ~ → 实际家目录, 给 opencode 绝对路径 (opencode 不展开 ~) */
const expandHome = (p: string): string => {
  if (!home) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
};
  const inputRef = useRef<HTMLInputElement>(null);
  const mkRef = useRef<HTMLInputElement>(null);

  const doBrowse = useCallback(async (dir: string) => {
    if (!dir.trim()) return;
    setLoading(true); setError('');
    try {
      const r = await browseDir(dir);
      setCurrentPath(r.path);
      setDirs(r.directories);
      setSelected(null); setActive(0);
    } catch (e: any) { setError(e?.message || '读取失败'); setDirs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const h = async () => {
      setOpen(true); setDirs([]); setSelected(null); setError(''); setMkMode(false); setMkName('');
      setRecent(getRecent()); // 打开时刷新一次
      setTimeout(async () => {
        inputRef.current?.focus();
        // 初始路径: APP_CWD (用户选) 优先; 没设才走 hostCwd (opencode /path 注入) → 现拉一次 (兜底)
        // 顺便拿 home 展开 QUICK 里的 ~ 路径
        let start = effectiveCwd();
        if (!start) {
          try {
            const base = appBaseUrl();
            const res = await fetch(`${base}/path`, { headers: { Accept: 'application/json' } });
            if (res.ok) {
              const j = await res.json();
              if (j?.directory) start = j.directory;
              if (j?.home) setHome(j.home);
            }
          } catch { /* ignore, 走 / 兜底 */ }
        }
        doBrowse(start || '/');
      }, 100);
    };
    window.addEventListener('workspace:request-show', h);
    // recent 列表变化 (切到某条 recent 触发 addRecent → workspace:recent-changed)
    const onRecentChanged = () => setRecent(getRecent());
    window.addEventListener('workspace:recent-changed', onRecentChanged);
    return () => {
      window.removeEventListener('workspace:request-show', h);
      window.removeEventListener('workspace:recent-changed', onRecentChanged);
    };
  }, [doBrowse]);

  const confirm = useCallback(async (dir: string) => {
    setLoading(true); setError('');
    try {
      // 唯一变更入口 (写 APP_CWD + recent + 派 workspace:changed + reload)
      setCwd(dir);
    } catch (e: any) { setError(e?.message || '切换失败'); }
    finally { setLoading(false); }
  }, []);

  const handleMkdir = useCallback(async () => {
    const name = mkName.trim();
    if (!name || !currentPath) return;
    setLoading(true); setError('');
    try {
      await mkdirDir(currentPath, name);
      setMkMode(false); setMkName(''); setCtxMenu(null);
      doBrowse(currentPath);
    } catch (e: any) { setError(e?.message || '创建失败'); }
    finally { setLoading(false); }
  }, [mkName, currentPath, doBrowse]);

  const openMkdir = useCallback(() => {
    setMkMode(true); setMkName(''); setCtxMenu(null);
    setTimeout(() => mkRef.current?.focus(), 50);
  }, []);

  const enterDir = useCallback((entry: DirEntry) => doBrowse(entry.path), [doBrowse]);
  const goUp = useCallback(() => {
    if (!currentPath || currentPath === '/') return;
    doBrowse(currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/');
  }, [currentPath, doBrowse]);

  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];

  if (!open) return null;

  return (
    <div className="wp-overlay" onMouseDown={(e) => { setCtxMenu(null); if (e.target === e.currentTarget) setOpen(false); }}>
      <style>{S}</style>
      <div className="wp-modal">
        <div className="wp-hdr">
          <div className="wp-title">
            <span className="wp-title-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </span>
            <div className="wp-title-text">
              <span className="wp-title-name">选择工作目录</span>
              <span className="wp-title-sub">{currentPath || '尚未选择'}</span>
            </div>
          </div>
          <button className="wp-x" onClick={() => setOpen(false)} title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div className="wp-bread">
          {segments.map((seg, i) => {
            const p = '/' + segments.slice(0, i + 1).join('/');
            return (
              <React.Fragment key={p}>
                {i > 0 && <span className="wp-bread-sep">›</span>}
                <button className="wp-bread-item" onClick={() => doBrowse(p)}>{seg}</button>
              </React.Fragment>
            );
          })}
          <div style={{ flex: 1 }} />
          {currentPath && currentPath !== '/' && (
            <button className="wp-bread-up" onClick={goUp} title="上级目录">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
            </button>
          )}
        </div>
        <div className="wp-body">
          <div className="wp-side">
            <div className="wp-side-title">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
              快速访问
            </div>
            {QUICK.map((q) => (
              <button key={q.path} type="button" className="wp-side-item" onClick={() => doBrowse(expandHome(q.path))}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <span>{q.name}</span>
              </button>
            ))}
            {recent.filter((p) => p !== currentPath).slice(0, 5).length > 0 && (
              <>
                <div className="wp-side-title" style={{ marginTop: 10 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>
                  最近
                </div>
                {recent
                  .filter((p) => p !== currentPath)
                  .slice(0, 5)
                  .map((p) => {
                    const name = p.split('/').filter(Boolean).pop() || p;
                    return (
                      <button
                        key={p}
                        type="button"
                        className="wp-side-item wp-side-item--recent"
                        title={p}
                        onClick={() => setCwd(p)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                        <span>{name}</span>
                      </button>
                    );
                  })}
              </>
            )}
          </div>
          <div className="wp-main" onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}>
            {loading && <div className="wp-loading">加载中…</div>}
            {error && <div className="wp-err">{error}</div>}
            {!loading && !error && dirs.length === 0 && <div className="wp-empty">空目录</div>}
            {!loading && dirs.length > 0 && (
              <div className="wp-list">
                {dirs.map((entry, i) => (
                  <button key={entry.path} type="button" className={`wp-item${i === active ? ' highlight' : ''}${selected === entry.path ? ' selected' : ''}`}
                    onClick={() => setSelected(entry.path)} onDoubleClick={() => enterDir(entry)} onMouseEnter={() => setActive(i)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    <span className="wp-item-name">{entry.name}</span>
                    <span className="wp-item-path">{entry.path}</span>
                    <button className="wp-item-enter" onClick={(e) => { e.stopPropagation(); enterDir(entry); }} title="进入">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                  </button>
                ))}
              </div>
            )}

            {ctxMenu && (
              <div className="wp-ctx" style={{ top: ctxMenu.y - 60, left: ctxMenu.x - 60 }} onMouseDown={(e) => e.stopPropagation()}>
                <button type="button" className="wp-ctx-item" onClick={openMkdir}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  <span>新建目录</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="wp-foot">
          {mkMode && (
            <div className="wp-mk">
              <input ref={mkRef} className="wp-mk-inp" type="text" value={mkName} onChange={(e) => setMkName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleMkdir(); if (e.key === 'Escape') { setMkMode(false); setMkName(''); } }}
                placeholder="目录名称" disabled={loading} autoFocus />
              <button className="wp-mk-btn" onClick={handleMkdir} disabled={loading || !mkName.trim()}>创建</button>
              <button className="wp-mk-cancel" onClick={() => { setMkMode(false); setMkName(''); }}>取消</button>
            </div>
          )}
          <div className="wp-foot-path">
            {selected ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>{selected}</span></>
              : <span style={{ color: 'var(--foreground,#666)' }}>选择一个目录</span>}
          </div>
          <button type="button" className="wp-btn" onClick={() => selected && confirm(selected)} disabled={!selected || loading}>
            {loading ? '切换中…' : '打开'}
          </button>
        </div>
      </div>
    </div>
  );
};

const S = `
/* 玻璃质感 + 居中模态 — 跟 chat__modal-overlay 同款 */
.wp-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);padding:24px;animation:wp-fade .14s ease-out}
@keyframes wp-fade{from{opacity:0}to{opacity:1}}
.wp-modal{width:680px;max-width:100%;height:520px;max-height:min(calc(100vh - 72px),600px);display:flex;flex-direction:column;background:var(--ai-glass-bg,#1c1c22);-webkit-backdrop-filter:var(--ai-glass-blur,blur(18px) saturate(160%));backdrop-filter:var(--ai-glass-blur,blur(18px) saturate(160%));border:1px solid var(--ai-glass-edge,rgba(255,255,255,0.12));border-radius:16px;box-shadow:var(--ai-pop-shadow,0 16px 40px rgba(0,0,0,0.5));color:var(--ai-fg,#e5e7eb);overflow:hidden;animation:wp-pop .16s ease-out}
@keyframes wp-pop{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}

/* Header */
.wp-hdr{display:flex;align-items:center;gap:10px;padding:20px 22px 14px;flex-shrink:0}
.wp-title{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;color:var(--ai-fg,#e5e7eb);flex:1;min-width:0}
.wp-title-icon{color:var(--ai-accent,#6366f1);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--ai-accent-soft,rgba(99,102,241,0.18));border-radius:7px;flex-shrink:0}
.wp-title-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.wp-title-name{font-size:15px;font-weight:600;color:var(--ai-fg,#e5e7eb);line-height:1.2}
.wp-title-sub{font-size:11.5px;color:var(--ai-fg-muted,#9ca3af);font-weight:400;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px}
.wp-x{width:30px;height:30px;background:transparent;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;flex-shrink:0;transition:all .12s}
.wp-x:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}

/* Breadcrumb */
.wp-bread{display:flex;align-items:center;padding:6px 18px;gap:2px;font-size:12.5px;border-top:1px solid var(--ai-divider,rgba(255,255,255,0.06));border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0;overflow-x:auto;min-height:34px;background:rgba(255,255,255,0.02)}
.wp-bread-item{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:3px 6px;border-radius:4px;white-space:nowrap;font-size:12.5px;transition:all .12s}
.wp-bread-item:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.wp-bread-sep{color:var(--ai-fg-muted,#6b7280);font-size:11px;opacity:.5;user-select:none}
.wp-bread-up{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:4px 6px;border-radius:4px;display:flex;flex-shrink:0;transition:all .12s}
.wp-bread-up:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.wp-bread-up:disabled{opacity:.3;cursor:default}
.wp-bread-up:disabled:hover{background:transparent;color:var(--ai-fg-muted,#9ca3af)}

/* Body: sidebar + main */
.wp-body{flex:1;display:flex;overflow:hidden;min-height:0}
.wp-side{width:160px;flex-shrink:0;padding:14px 10px;border-right:1px solid var(--ai-divider,rgba(255,255,255,0.06));overflow-y:auto;background:rgba(0,0,0,0.15)}
.wp-side-title{padding:6px 10px 4px;font-size:10.5px;font-weight:600;color:var(--ai-fg-muted,#6b7280);text-transform:uppercase;letter-spacing:0.6px;display:flex;align-items:center;gap:4px}
.wp-side-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;background:none;border:none;color:var(--ai-fg-muted,#cbd1d8);font-size:12.5px;cursor:pointer;text-align:left;border-radius:6px;transition:all .12s;overflow:hidden}
.wp-side-item svg{flex-shrink:0;color:var(--ai-accent,#6366f1);opacity:.85}
.wp-side-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-side-item:hover{background:var(--ai-hover,rgba(255,255,255,0.05));color:var(--ai-fg,#e5e7eb)}
.wp-side-item:hover svg{opacity:1}
.wp-side-item--recent{font-size:12px}

/* Main */
.wp-main{flex:1;overflow-y:auto;padding:8px 10px}
.wp-loading,.wp-empty{padding:48px 16px;text-align:center;color:var(--ai-fg-muted,#6b7280);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px}
.wp-loading svg,.wp-empty svg{color:var(--ai-fg-muted,#4b5563)}
.wp-err{margin:10px;padding:10px 14px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.2);border-radius:8px;color:#fca5a5;font-size:12.5px}
.wp-list{display:flex;flex-direction:column;gap:1px}
.wp-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 12px;background:transparent;border:none;border-radius:7px;color:var(--ai-fg,#d1d5db);font-size:13px;cursor:pointer;text-align:left;transition:all .1s}
.wp-item svg{flex-shrink:0;color:var(--ai-accent,#6366f1);opacity:.8}
.wp-item.highlight{background:var(--ai-hover,rgba(255,255,255,0.05))}
.wp-item.selected{background:var(--ai-active,rgba(99,102,241,0.16));color:var(--ai-fg,#fff)}
.wp-item.selected svg{opacity:1}
.wp-item:hover{background:var(--ai-hover,rgba(255,255,255,0.06))}
.wp-item-name{font-weight:500;flex-shrink:0;font-size:13px}
.wp-item-path{font-size:11.5px;color:var(--ai-fg-muted,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px;flex:1;min-width:0}
.wp-item-enter{background:none;border:none;color:var(--ai-fg-muted,#6b7280);cursor:pointer;padding:3px;display:flex;flex-shrink:0;margin-left:auto;opacity:0;transition:all .15s;border-radius:4px}
.wp-item:hover .wp-item-enter{opacity:1}
.wp-item-enter:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#e5e7eb)}

/* Context menu (right click) */
.wp-ctx{position:fixed;z-index:11000;background:var(--ai-bg-elev,#1c1c22);border:1px solid var(--ai-border,rgba(255,255,255,0.1));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden;min-width:140px;padding:4px}
.wp-ctx-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;background:none;border:none;color:var(--ai-fg-muted,#d1d5db);font-size:12.5px;cursor:pointer;text-align:left;border-radius:5px;transition:all .1s}
.wp-ctx-item svg{flex-shrink:0;color:var(--ai-accent,#6366f1)}
.wp-ctx-item:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#fff)}

/* Footer */
.wp-foot{display:flex;align-items:center;padding:12px 18px;border-top:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0;gap:12px;background:rgba(0,0,0,0.12)}
.wp-foot-path{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ai-fg-muted,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.wp-foot-path svg{flex-shrink:0;color:var(--ai-accent,#6366f1);opacity:.8}
.wp-foot-path span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-mk{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.wp-mk-inp{flex:1;min-width:0;padding:7px 10px;background:var(--ai-input-bg,rgba(255,255,255,0.06));border:1px solid var(--ai-accent,#6366f1);border-radius:6px;outline:none;font-size:12.5px;color:var(--ai-fg,#e5e7eb);font-family:inherit}
.wp-mk-inp:focus{box-shadow:0 0 0 3px var(--ai-accent-soft,rgba(99,102,241,0.18))}
.wp-mk-btn{padding:7px 14px;background:var(--ai-accent,#6366f1);border:none;border-radius:6px;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;flex-shrink:0;transition:all .12s}
.wp-mk-btn:hover:not(:disabled){background:color-mix(in srgb,var(--ai-accent,#6366f1) 88%,#fff)}
.wp-mk-btn:disabled{opacity:.4;cursor:not-allowed}
.wp-mk-cancel{padding:7px 10px;background:none;border:none;color:var(--ai-fg-muted,#9ca3af);font-size:12.5px;cursor:pointer;flex-shrink:0;border-radius:6px;transition:all .12s}
.wp-mk-cancel:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.wp-btn{padding:8px 22px;background:var(--ai-accent,#6366f1);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0;transition:all .12s;box-shadow:0 1px 0 color-mix(in srgb,var(--ai-accent,#6366f1) 60%,#000) inset}
.wp-btn:hover:not(:disabled){background:color-mix(in srgb,var(--ai-accent,#6366f1) 88%,#fff);transform:translateY(-1px);box-shadow:0 4px 12px var(--ai-accent-soft,rgba(99,102,241,0.4))}
.wp-btn:active:not(:disabled){transform:translateY(0)}
.wp-btn:disabled{opacity:.4;cursor:not-allowed}
`;
