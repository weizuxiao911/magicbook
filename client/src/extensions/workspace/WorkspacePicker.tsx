import React, { useState, useCallback, useRef, useEffect } from 'react';
import { getSandboxService } from '../../service/sandbox';

interface DirEntry { name: string; path: string; }

const QUICK = [
  { name: '用户', path: '~' },
  { name: '桌面', path: '~/Desktop' },
  { name: '文档', path: '~/Documents' },
  { name: '下载', path: '~/Downloads' },
];

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
  const inputRef = useRef<HTMLInputElement>(null);
  const mkRef = useRef<HTMLInputElement>(null);

  const doBrowse = useCallback(async (dir: string) => {
    if (!dir.trim()) return;
    setLoading(true); setError('');
    try {
      const r = await getSandboxService().browse(dir);
      setCurrentPath(r.path);
      setDirs(r.directories);
      setSelected(null); setActive(0);
    } catch (e: any) { setError(e?.message || '读取失败'); setDirs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const h = () => {
      setOpen(true); setDirs([]); setSelected(null); setError(''); setMkMode(false); setMkName('');
      setTimeout(() => { inputRef.current?.focus(); doBrowse('~'); }, 100);
    };
    window.addEventListener('workspace:show-picker', h);
    return () => window.removeEventListener('workspace:show-picker', h);
  }, [doBrowse]);

  const confirm = useCallback(async (dir: string) => {
    setLoading(true); setError('');
    try {
      const rt = await getSandboxService().setWorkspace(dir);
      getSandboxService().applyRuntime(rt);
      localStorage.setItem('APP_CWD', dir);
      window.location.reload();
    } catch (e: any) { setError(e?.message || '切换失败'); }
    finally { setLoading(false); }
  }, []);

  const handleMkdir = useCallback(async () => {
    const name = mkName.trim();
    if (!name || !currentPath) return;
    setLoading(true); setError('');
    try {
      await getSandboxService().mkdir(currentPath, name);
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
          <span className="wp-title">选择工作目录</span>
          <button className="wp-x" onClick={() => setOpen(false)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
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
            <div className="wp-side-title">快速访问</div>
            {QUICK.map((q) => (
              <button key={q.path} type="button" className="wp-side-item" onClick={() => doBrowse(q.path)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <span>{q.name}</span>
              </button>
            ))}
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
.wp-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)}
.wp-modal{width:640px;max-width:90vw;height:480px;max-height:80vh;display:flex;flex-direction:column;background:var(--editor-background,#1e1e2e);border:1px solid var(--widget-border,rgba(255,255,255,0.1));border-radius:10px;color:var(--foreground,#ccc)}
.wp-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--widget-border,rgba(255,255,255,0.06));font-size:14px;font-weight:600;flex-shrink:0}
.wp-title{font-size:14px;font-weight:600}
.wp-x{background:none;border:none;color:var(--foreground,#888);cursor:pointer;padding:4px;display:flex;flex-shrink:0}
.wp-bread{display:flex;align-items:center;padding:6px 12px;gap:2px;font-size:12px;border-bottom:1px solid var(--widget-border,rgba(255,255,255,0.04));flex-shrink:0;overflow-x:auto;min-height:28px}
.wp-bread-item{background:none;border:none;color:var(--foreground,#999);cursor:pointer;padding:2px 4px;border-radius:3px;white-space:nowrap;font-size:12px}
.wp-bread-item:hover{background:rgba(255,255,255,0.08);color:var(--foreground,#ddd)}
.wp-bread-sep{color:var(--foreground,#555);font-size:12px}
.wp-bread-up{background:none;border:none;color:var(--foreground,#888);cursor:pointer;padding:2px 6px;border-radius:3px;display:flex;flex-shrink:0}
.wp-bread-up:hover{background:rgba(255,255,255,0.08);color:var(--foreground,#ddd)}
.wp-body{flex:1;display:flex;overflow:hidden}
.wp-side{width:120px;flex-shrink:0;padding:8px 0;border-right:1px solid var(--widget-border,rgba(255,255,255,0.04));overflow-y:auto}
.wp-side-title{padding:4px 12px;font-size:11px;font-weight:600;color:var(--foreground,#666);text-transform:uppercase;letter-spacing:0.5px}
.wp-side-item{display:flex;align-items:center;gap:6px;width:100%;padding:6px 12px;background:none;border:none;color:var(--foreground,#aaa);font-size:12px;cursor:pointer;text-align:left}
.wp-side-item svg{flex-shrink:0;color:var(--focus-border,#6366f1)}
.wp-side-item:hover{background:rgba(255,255,255,0.05)}
.wp-main{flex:1;overflow-y:auto;padding:4px 0}
.wp-loading,.wp-empty{padding:24px;text-align:center;color:var(--foreground,#666);font-size:13px}
.wp-err{margin:8px;padding:8px;background:rgba(239,68,68,0.15);border-radius:6px;color:#f87171;font-size:12px}
.wp-list{display:flex;flex-direction:column}
.wp-ctx{position:fixed;z-index:11000;background:var(--editor-background,#1e1e2e);border:1px solid var(--widget-border,rgba(255,255,255,0.1));border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.4);overflow:hidden;min-width:120px}
.wp-ctx-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;background:none;border:none;color:var(--foreground,#ccc);font-size:13px;cursor:pointer;text-align:left}
.wp-ctx-item svg{flex-shrink:0;color:var(--focus-border,#6366f1)}
.wp-ctx-item:hover{background:rgba(255,255,255,0.08);color:var(--foreground,#fff)}
.wp-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;background:none;border:none;color:var(--foreground,#bbb);font-size:13px;cursor:pointer;text-align:left}
.wp-item svg{flex-shrink:0;color:var(--focus-border,#6366f1)}
.wp-item.highlight{background:rgba(255,255,255,0.04)}
.wp-item.selected{background:rgba(99,102,241,0.15);color:var(--foreground,#fff)}
.wp-item:hover{background:rgba(255,255,255,0.06)}
.wp-item-name{font-weight:500;flex-shrink:0}
.wp-item-path{font-size:11px;color:var(--foreground,#555);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px}
.wp-item-enter{background:none;border:none;color:var(--foreground,#666);cursor:pointer;padding:2px;display:flex;flex-shrink:0;margin-left:auto;opacity:0;transition:opacity 0.15s}
.wp-item:hover .wp-item-enter{opacity:1}
.wp-item-enter:hover{color:var(--foreground,#ddd)}
.wp-foot{display:flex;align-items:center;padding:10px 16px;border-top:1px solid var(--widget-border,rgba(255,255,255,0.06));flex-shrink:0;gap:12px}
.wp-foot-left{flex-shrink:0}
.wp-foot-mk{display:flex;align-items:center;gap:4px;padding:4px 8px;background:none;border:1px dashed var(--widget-border,rgba(255,255,255,0.15));border-radius:4px;color:var(--foreground,#888);font-size:12px;cursor:pointer}
.wp-foot-mk:hover{color:var(--foreground,#ccc);border-color:var(--widget-border,rgba(255,255,255,0.3))}
.wp-mk{display:flex;align-items:center;gap:6px}
.wp-mk-inp{width:140px;padding:4px 8px;background:var(--input-background,rgba(255,255,255,0.06));border:1px solid var(--focus-border,#6366f1);border-radius:4px;outline:none;font-size:12px;color:var(--foreground,#e0e0e0)}
.wp-mk-btn{padding:4px 10px;background:var(--button-background,#6366f1);border:none;border-radius:4px;color:var(--button-foreground,#fff);font-size:12px;cursor:pointer}
.wp-mk-btn:disabled{opacity:0.5}
.wp-mk-cancel{padding:4px 8px;background:none;border:none;color:var(--foreground,#888);font-size:12px;cursor:pointer}
.wp-mk-cancel:hover{color:var(--foreground,#ccc)}
.wp-foot-path{display:flex;align-items:center;gap:6px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.wp-btn{padding:7px 20px;background:var(--button-background,#6366f1);border:none;border-radius:6px;color:var(--button-foreground,#fff);font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0}
.wp-btn:disabled{opacity:0.4;cursor:not-allowed}
`;