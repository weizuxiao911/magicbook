/**
 * FilePicker — 通用服务器文件/目录选择器 (web/src/extensions/filepicker)
 *
 * 复用能力: 浏览服务器目录 (opencode SDK file.list) + 面包屑 + 搜索 + 新建目录.
 * 可配置模式 (通过 filepicker:request 事件, detail.config):
 *   - mode: 'all'          → 目录 + 文件都可选
 *   - mode: 'directories'  → 仅目录 (workspace 切换用)
 *   - mode: 'files'        → 仅文件 (pdf 文件交互用)
 *   - mode: { ext: [...] } → 仅指定扩展名的文件 (如 ['png','pdf'])
 *   - onPick: ({name, path, type}) => void   选中回调 (path 为 IDE 相对路径 /foo/bar)
 *   - onCancel: () => void                    关闭回调
 *
 * 事件链:
 *   [调用方] --filepicker:request {config}--> [FilePicker]
 *   [FilePicker.onPick] --config.onPick-->     [调用方]
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { notification } from '@opensumi/ide-components/lib/notification';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';

import { normalizeCwdPath } from '../../infra/path';
import { FsToken, type IFileSystem } from '../../service/filesystem';

interface DirEntry { name: string; path: string; type: 'file' | 'directory'; }

export type FilePickerMode = 'all' | 'directories' | 'files' | { ext: string[] };

export interface FilePickerConfig {
  mode: FilePickerMode;
  onPick: (f: { name: string; path: string; type: 'file' | 'directory' }) => void;
  onCancel?: () => void;
  /** 初始目录 (默认当前工作目录) */
  initialPath?: string;
  /** 浏览根目录 (绝对路径): 不能 goUp/面包屑离开 root 范围 */
  root?: string;
}

async function browseDir(fs: IFileSystem, path: string): Promise<{ path: string; entries: DirEntry[] }> {
  const raw = await fs.listDir(path);
  const list: DirEntry[] = raw.map((e) => ({
    name: e.name,
    path: path.replace(/\/+$/, '') + '/' + e.name,
    type: e.type,
  }));
  return { path: path.replace(/\/+$/, ''), entries: list };
}

async function mkdirDir(fs: IFileSystem, parent: string, name: string): Promise<{ ok: boolean; path: string }> {
  const target = parent.replace(/\/+$/, '') + '/' + name;
  const ok = await fs.mkdirAbs(target);
  return { ok, path: target };
}

/** 判断 entry 是否符合当前模式 */
function entryVisible(entry: DirEntry, mode: FilePickerMode): boolean {
  if (entry.type === 'directory') {
    // 目录: 所有模式都显示 (all/directories 可选; files 模式目录可进入但不可选)
    return true;
  }
  if (mode === 'all') return true;
  if (mode === 'directories') return false; // 仅目录 → 不显示文件
  if (mode === 'files') return true;
  // {ext: [...]}: 只显示指定扩展名文件
  const exts = mode.ext || [];
  const dot = entry.name.lastIndexOf('.');
  const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
  return exts.includes(ext);
}

/** entry 是否可被选中 (模式决定) */
function entrySelectable(entry: DirEntry, mode: FilePickerMode): boolean {
  if (entry.type === 'directory') return mode === 'all' || mode === 'directories';
  return mode === 'all' || mode === 'files' || (typeof mode !== 'string' && mode.ext.includes(entry.name.split('.').pop()?.toLowerCase() || ''));
}

export const FilePicker: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mkMode, setMkMode] = useState(false);
  const [mkName, setMkName] = useState('');
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const fs = useInjectable<any>(FsToken as any);
  const configRef = useRef<FilePickerConfig | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mkRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const notifyError = useCallback((msg: string) => {
    notification.error({ message: msg, type: 'error', duration: 3 });
  }, []);

  const mode = configRef.current?.mode || 'all';
  /** root 绝对路径 (浏览上限, config.root 传入) */
  const rootRef = useRef<string>('');

  /** 是否在 root 范围内 */
  const withinRoot = useCallback((absPath: string): boolean => {
    const root = rootRef.current;
    if (!root) return true;
    return absPath === root || absPath.startsWith(root.replace(/\/+$/, '') + '/');
  }, []);

  const doBrowse = useCallback(async (dir: string) => {
    if (!dir.trim()) return;
    // 不能浏览 root 之外
    if (!withinRoot(dir)) {
      doBrowse(rootRef.current);
      return;
    }
    setLoading(true);
    try {
      const r = await browseDir(fs, dir);
      setCurrentPath(r.path);
      setEntries(r.entries);
      setSelected(null); setActive(0);
    } catch (e: any) {
      notifyError(e?.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, [notifyError, withinRoot]);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const cfg: FilePickerConfig | null = d.config || null;
      if (!cfg) return;
      configRef.current = cfg;
      rootRef.current = cfg.root || '';
      setOpen(true);
      setEntries([]); setSelected(null); setMkMode(false); setMkName('');
      setTimeout(() => {
        inputRef.current?.focus();
        // 初始目录: config.initialPath 优先, 否则当前工作目录 (均在 root 内)
        // 必须 normalizeCwdPath: Windows 历史 APP_CWD 可能是 '/D:/...' 错误形态,
        // 直接当浏览起点 → listDir header '/D:/...' → server 按 POSIX 根解析 → 500
        const stored = (() => { try { return normalizeCwdPath(localStorage.getItem('APP_CWD') || ''); } catch { return ''; } })();
        const fallback = normalizeCwdPath((window as any).__APP_CONFIG__?.cwd || '');
        const start = normalizeCwdPath(cfg.initialPath || '') || stored || fallback || '/';
        doBrowse(withinRoot(start) ? start : (rootRef.current || start));
      }, 100);
    };
    window.addEventListener('filepicker:request', onRequest);
    return () => window.removeEventListener('filepicker:request', onRequest);
  }, [doBrowse, withinRoot]);

  const handlePick = useCallback((entry: DirEntry) => {
    if (!entrySelectable(entry, configRef.current?.mode || 'all')) return;
    const cfg = configRef.current;
    if (!cfg) return;
    configRef.current = null;
    setOpen(false);
    cfg.onPick({ name: entry.name, path: entry.path, type: entry.type });
  }, []);

  const handleCancel = useCallback(() => {
    const cfg = configRef.current;
    configRef.current = null;
    setOpen(false);
    cfg?.onCancel?.();
  }, []);

  const handleMkdir = useCallback(async () => {
    const name = mkName.trim();
    if (!name || !currentPath) return;
    setLoading(true);
    try {
      await mkdirDir(fs, currentPath, name);
      setMkMode(false); setMkName('');
      doBrowse(currentPath);
    } catch (e: any) { notifyError(e?.message || '创建失败'); }
    finally { setLoading(false); }
  }, [mkName, currentPath, doBrowse, notifyError]);

  const enterDir = useCallback((entry: DirEntry) => {
    if (entry.type === 'directory') doBrowse(entry.path);
  }, [doBrowse]);

  const goUp = useCallback(() => {
    const root = rootRef.current;
    if (!currentPath || currentPath === '/' || currentPath === root) return;
    const parent = currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    // 不能越出 root
    if (root && parent !== root && !parent.startsWith(root.replace(/\/+$/, '') + '/')) return;
    doBrowse(parent);
  }, [currentPath, doBrowse]);

  if (!open) return null;

  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];
  // 按模式过滤可见条目 (目录总是可见; 文件按模式)
  const visible = entries.filter((entry) => entryVisible(entry, mode));
  // 搜索过滤
  const q = query.trim().toLowerCase();
  const filtered = q ? visible.filter((e) => e.name.toLowerCase().includes(q)) : visible;
  const titleName = mode === 'directories' ? '选择目录'
    : mode === 'files' ? '选择文件'
    : typeof mode !== 'string' ? `选择 ${mode.ext.join('/')} 文件`
    : '选择文件或目录';

  return (
    <div className="fp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
      <style>{STYLES}</style>
      <div className="fp-modal">
        <div className="fp-hdr">
          <div className="fp-title">
            <span className="fp-title-icon">📁</span>
            <div className="fp-title-text">
              <span className="fp-title-name">{titleName}</span>
              <span className="fp-title-sub">{currentPath || '尚未选择'}</span>
            </div>
          </div>
          <button className="fp-x" onClick={handleCancel} title="关闭">✕</button>
        </div>
        <div className="fp-bread">
          {segments.map((seg, i) => {
            const p = '/' + segments.slice(0, i + 1).join('/');
            const root = rootRef.current;
            const withinRoot = !root || p === root.replace(/\/+$/, '') || p.startsWith(root.replace(/\/+$/, '') + '/');
            return (
              <React.Fragment key={p}>
                {i > 0 && <span className="fp-bread-sep">›</span>}
                {withinRoot ? (
                  <button className="fp-bread-item" onClick={() => doBrowse(p)}>{seg}</button>
                ) : (
                  <span className="fp-bread-item fp-bread-item--locked">{seg}</span>
                )}
              </React.Fragment>
            );
          })}
          <div style={{ flex: 1 }} />
          {currentPath && currentPath !== '/' && (
            <button className="fp-bread-up" onClick={goUp} title="上级目录">↑</button>
          )}
        </div>
        <div className="fp-body">
          <div className="fp-main">
            <div className="fp-main-tools">
              <div className="fp-search">
                <input
                  ref={searchRef}
                  type="text"
                  className="fp-search-inp"
                  placeholder="搜索…"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                />
                {query && (
                  <button type="button" className="fp-search-clear" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>✕</button>
                )}
              </div>
              <button type="button" className="fp-mk-btn-top" title="新建目录" onClick={() => { setMkMode(true); setMkName(''); setTimeout(() => mkRef.current?.focus(), 50); }}>＋</button>
            </div>
            {loading && <div className="fp-loading">加载中…</div>}
            {!loading && filtered.length === 0 && <div className="fp-empty">空目录</div>}
            {!loading && filtered.length > 0 && (
              <div className="fp-list">
                {filtered.map((entry) => {
                  const i = visible.indexOf(entry);
                  const selectable = entrySelectable(entry, mode);
                  const isDir = entry.type === 'directory';
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={`fp-item${i === active ? ' highlight' : ''}${selected === entry.path ? ' selected' : ''}${!selectable ? ' fp-item--disabled' : ''}`}
                      onClick={() => {
                        if (isDir && !selectable) { doBrowse(entry.path); return; } // files 模式: 目录点击进入
                        setSelected(entry.path);
                        if (!isDir || mode === 'all' || mode === 'directories') {
                          if (selectable) handlePick(entry);
                        }
                      }}
                      onDoubleClick={() => { if (isDir) enterDir(entry); else if (selectable) handlePick(entry); }}
                      onMouseEnter={() => setActive(i)}
                    >
                      {isDir ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                      )}
                      <span className="fp-item-name">{entry.name}</span>
                      <span className="fp-item-path">{entry.path}</span>
                      {isDir && (
                        <button className="fp-item-enter" onClick={(e) => { e.stopPropagation(); enterDir(entry); }} title="进入">→</button>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="fp-foot">
          {mkMode && (
            <div className="fp-mk">
              <input ref={mkRef} className="fp-mk-inp" type="text" value={mkName} onChange={(e) => setMkName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleMkdir(); if (e.key === 'Escape') { setMkMode(false); setMkName(''); } }}
                placeholder="目录名称" disabled={loading} autoFocus />
              <button className="fp-mk-btn" onClick={handleMkdir} disabled={loading || !mkName.trim()}>创建</button>
              <button className="fp-mk-cancel" onClick={() => { setMkMode(false); setMkName(''); }}>取消</button>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="fp-cancel" onClick={handleCancel}>取消</button>
        </div>
      </div>
    </div>
  );
};

/** 触发 filepicker 打开 (其他拓展调用) */
export function requestFilePicker(config: FilePickerConfig): void {
  window.dispatchEvent(new CustomEvent('filepicker:request', { detail: { config } }));
}

const STYLES = `
.fp-overlay{position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);padding:24px;animation:fp-fade .14s ease-out}
@keyframes fp-fade{from{opacity:0}to{opacity:1}}
.fp-modal{width:680px;max-width:100%;height:min(70vh,640px);max-height:min(calc(100vh - 72px),640px);display:flex;flex-direction:column;background:var(--ai-glass-bg,#1c1c22);-webkit-backdrop-filter:var(--ai-glass-blur,blur(18px) saturate(160%));backdrop-filter:var(--ai-glass-blur,blur(18px) saturate(160%));border:1px solid var(--ai-glass-edge,rgba(255,255,255,0.12));border-radius:16px;box-shadow:var(--ai-pop-shadow,0 16px 40px rgba(0,0,0,0.5));color:var(--ai-fg,#e5e7eb);overflow:hidden;animation:fp-pop .16s ease-out}
@keyframes fp-pop{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}
.fp-hdr{display:flex;align-items:center;gap:10px;padding:20px 22px 14px;flex-shrink:0}
.fp-title{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;color:var(--ai-fg,#e5e7eb);flex:1;min-width:0}
.fp-title-icon{color:var(--ai-accent,#6366f1);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--ai-accent-soft,rgba(99,102,241,0.18));border-radius:7px;flex-shrink:0;font-size:14px}
.fp-title-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.fp-title-name{font-size:15px;font-weight:600;color:var(--ai-fg,#e5e7eb);line-height:1.2}
.fp-title-sub{font-size:11.5px;color:var(--ai-fg-muted,#9ca3af);font-weight:400;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px}
.fp-x{width:30px;height:30px;background:transparent;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;flex-shrink:0;transition:all .12s}
.fp-x:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.fp-bread{display:flex;align-items:center;padding:6px 18px;gap:2px;font-size:12.5px;border-top:1px solid var(--ai-divider,rgba(255,255,255,0.06));border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0;overflow-x:auto;min-height:34px;background:rgba(255,255,255,0.02)}
.fp-bread-item{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:3px 6px;border-radius:4px;white-space:nowrap;font-size:12.5px;transition:all .12s}
.fp-bread-item--locked{opacity:.4;cursor:default}
.fp-bread-item--locked:hover{background:transparent}
.fp-bread-item:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.fp-bread-sep{color:var(--ai-fg-muted,#6b7280);font-size:11px;opacity:.5;user-select:none}
.fp-bread-up{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:4px 6px;border-radius:4px;display:flex;flex-shrink:0;transition:all .12s}
.fp-bread-up:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.fp-body{flex:1;display:flex;overflow:hidden;min-height:0}
.fp-main{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-height:0}
.fp-main-tools{display:flex;align-items:center;gap:8px;flex-shrink:0;padding:4px 0}
.fp-search{flex:1;display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(255,255,255,0.04);border:1px solid var(--ai-divider,rgba(255,255,255,0.08));border-radius:8px;color:var(--ai-fg-muted,#6b7280);height:38px}
.fp-search:focus-within{border-color:var(--ai-accent,#6366f1);color:var(--ai-fg,#e5e7eb)}
.fp-search-inp{flex:1;background:none;border:none;outline:none;color:inherit;font-size:13.5px;min-width:0;height:100%}
.fp-search-inp::placeholder{color:var(--ai-fg-muted,#6b7280)}
.fp-search-clear{background:none;border:none;color:inherit;cursor:pointer;padding:0;display:flex;align-items:center;opacity:.6}
.fp-search-clear:hover{opacity:1}
.fp-mk-btn-top{width:32px;height:32px;padding:0;background:var(--ai-hover,rgba(255,255,255,0.05));border:1px solid var(--ai-divider,rgba(255,255,255,0.08));border-radius:8px;color:var(--ai-fg-muted,#cbd1d8);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.fp-mk-btn-top:hover{background:var(--ai-accent,#6366f1);color:#fff;border-color:var(--ai-accent,#6366f1)}
.fp-loading,.fp-empty{padding:48px 16px;text-align:center;color:var(--ai-fg-muted,#6b7280);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px}
.fp-list{display:flex;flex-direction:column;gap:1px}
.fp-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 12px;background:transparent;border:none;border-radius:7px;color:var(--ai-fg,#d1d5db);font-size:13px;cursor:pointer;text-align:left;transition:all .1s}
.fp-item svg{flex-shrink:0;color:var(--ai-accent,#6366f1);opacity:.8}
.fp-item.highlight{background:var(--ai-hover,rgba(255,255,255,0.05))}
.fp-item.selected{background:var(--ai-active,rgba(99,102,241,0.16));color:var(--ai-fg,#fff)}
.fp-item.selected svg{opacity:1}
.fp-item:hover{background:var(--ai-hover,rgba(255,255,255,0.06))}
.fp-item--disabled{opacity:.45;cursor:default}
.fp-item--disabled:hover{background:transparent}
.fp-item-name{font-weight:500;flex-shrink:0;font-size:13px}
.fp-item-path{font-size:11.5px;color:var(--ai-fg-muted,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px;flex:1;min-width:0}
.fp-item-enter{background:none;border:none;color:var(--ai-fg-muted,#6b7280);cursor:pointer;padding:3px;display:flex;flex-shrink:0;margin-left:auto;opacity:0;transition:all .15s;border-radius:4px}
.fp-item:hover .fp-item-enter{opacity:1}
.fp-item-enter:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#e5e7eb)}
.fp-foot{display:flex;align-items:center;padding:12px 18px;border-top:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0;gap:12px;background:rgba(0,0,0,0.12)}
.fp-mk{display:flex;align-items:center;gap:8px;flex:1}
.fp-mk-inp{flex:1;background:rgba(255,255,255,0.04);border:1px solid var(--ai-divider,rgba(255,255,255,0.08));border-radius:8px;padding:8px 12px;color:var(--ai-fg,#e5e7eb);font-size:13px;outline:none}
.fp-mk-inp:focus{border-color:var(--ai-accent,#6366f1)}
.fp-mk-btn{background:var(--ai-accent,#6366f1);border:none;color:#fff;font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer}
.fp-mk-btn:disabled{opacity:.5;cursor:default}
.fp-mk-cancel{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);font-size:12.5px;cursor:pointer;padding:8px 10px;border-radius:8px}
.fp-mk-cancel:hover{background:var(--ai-hover,rgba(255,255,255,0.06))}
.fp-cancel{background:none;border:1px solid var(--ai-divider,rgba(255,255,255,0.1));color:var(--ai-fg-muted,#cbd1d8);font-size:12.5px;padding:8px 18px;border-radius:8px;cursor:pointer}
.fp-cancel:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#fff)}
`;
