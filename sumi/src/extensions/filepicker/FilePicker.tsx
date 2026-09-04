/**
 * FilePicker — 通用服务器文件/目录选择器 (web/src/extensions/filepicker)
 *
 * 参考系统文件选择器弹窗 (macOS NSOpenPanel / VS Code Open Folder) 交互:
 *
 * mode:
 *   - 'open'   打开模式: 列表只列子目录; 单击目录=选中 (再点同一目录=取消),
 *              双击目录=进入浏览; 底部「打开」: 有选中子目录 → 返回选中目录,
 *              无选中 → 返回当前所在目录 (文件不参与, 列表不显示文件).
 *   - 'select' 选择模式: 列出当前目录子目录+文件 (filter 控制显示);
 *              单击条目=勾选/取消 (多选累积, 跨目录保留); 双击目录=进入下钻;
 *              底部「选择 (n)」= 返回全部勾选条目路径.
 *
 * filter (仅 select 生效; open 恒为 directory):
 *   - 'directory'  只列目录
 *   - 'files'      列文件 (目录仍显示供双击下钻, 不可勾选)
 *   - 'none'       目录 + 文件都可勾选
 *
 * 顶部路径导航 (面包屑): 点击某段 = 切到该目录浏览; 右侧搜索框对当前列表
 * (按名称, 大小写不敏感) 实时过滤, 两种模式通用.
 *
 * 事件链:
 *   [调用方] --filepicker:request {config}--> [FilePicker]
 *   [FilePicker.onPick] --config.onPick-->     [调用方]
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { notification } from '@opensumi/ide-components/lib/notification';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';

import { normalizeCwdPath } from '../../infra/path';
import { getWorkspace } from '../../infra/url';
import { FsToken, type IFileSystem } from '../../service/filesystem';

interface DirEntry { name: string; path: string; type: 'file' | 'directory'; }

export type FilePickerMode = 'open' | 'select';
export type FilePickerFilter = 'directory' | 'files' | 'none';

export interface FilePickerConfig {
  mode: FilePickerMode;
  /** 列表显示过滤 (select 生效; open 忽略恒 directory) */
  filter?: FilePickerFilter;
  /** 确认回调. open: items 恒 1 项 (当前目录); select: 全部勾选项. */
  onPick: (items: Array<{ name: string; path: string; type: 'file' | 'directory' }>) => void;
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

export const FilePicker: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  /** select 模式: 勾选集合 (跨目录累积). open 模式恒空. */
  const [checked, setChecked] = useState<Map<string, DirEntry>>(new Map());
  /** open 模式: 选中的子目录 (单选, 仅当前列表视图内有效; 导航/切换目录即清空). select 模式恒空. */
  const [openPick, setOpenPick] = useState<DirEntry | null>(null);
  /** 面包屑右侧搜索词: 对当前列表按名称实时过滤 (两种模式通用, 切换目录时保留) */
  const [query, setQuery] = useState('');
  const fs = useInjectable<any>(FsToken as any);
  const configRef = useRef<FilePickerConfig | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);

  const notifyError = useCallback((msg: string) => {
    notification.error({ message: msg, type: 'error', duration: 3 });
  }, []);

  const cfg = configRef.current;
  const mode: FilePickerMode = cfg?.mode || 'open';
  // open 模式: 只列目录; select 模式按调用方 filter
  const filter: FilePickerFilter = mode === 'open' ? 'directory' : (cfg?.filter || 'none');
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
      setActive(0);
      setOpenPick(null); // open 模式: 进入其它目录后旧选中作废 (选中仅当前列表视图有效)
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
      setEntries([]); setChecked(new Map()); setOpenPick(null); setQuery('');
      setTimeout(() => {
        // 初始目录: config.initialPath 优先, 否则当前工作目录 (均在 root 内)
        // 必须 normalizeCwdPath: Windows 历史 APP_CWD 可能是 '/D:/...' 错误形态,
        // 直接当浏览起点 → listDir header '/D:/...' → server 按 POSIX 根解析 → 500
        const stored = (() => { try { return normalizeCwdPath(localStorage.getItem('APP_CWD') || ''); } catch { return ''; } })();
        const fallback = normalizeCwdPath(getWorkspace());
        const start = normalizeCwdPath(cfg.initialPath || '') || stored || fallback || '/';
        doBrowse(withinRoot(start) ? start : (rootRef.current || start));
      }, 100);
    };
    window.addEventListener('filepicker:request', onRequest);
    return () => window.removeEventListener('filepicker:request', onRequest);
  }, [doBrowse, withinRoot]);

  /** select 模式: 勾选 / 取消勾选 */
  const toggleCheck = useCallback((entry: DirEntry) => {
    setChecked((prev) => {
      const next = new Map(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });
  }, []);

  /** open 模式确认: 有选中的子目录 → 打开选中目录; 无选中 → 打开当前所在目录 */
  const handleOpenPick = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg || !currentPath) return;
    configRef.current = null;
    setOpen(false);
    const target = openPick;
    const path = target ? target.path : currentPath;
    const parts = path.split('/').filter(Boolean);
    cfg.onPick([{ name: target ? target.name : (parts[parts.length - 1] || path), path, type: 'directory' }]);
  }, [currentPath, openPick]);

  /** select 模式确认: 返回勾选项 */
  const handleSelectPick = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg || checked.size === 0) return;
    configRef.current = null;
    setOpen(false);
    cfg.onPick(Array.from(checked.values()));
  }, [checked]);

  const handleCancel = useCallback(() => {
    const cfg = configRef.current;
    configRef.current = null;
    setOpen(false);
    cfg?.onCancel?.();
  }, []);

  const enterDir = useCallback((entry: DirEntry) => {
    if (entry.type === 'directory') doBrowse(entry.path);
  }, [doBrowse]);

  /** 条目是否显示: 目录恒显示 (供进入/勾选/选中); 文件按 filter */
  const entryVisible = useCallback((entry: DirEntry, f: FilePickerFilter): boolean => {
    if (entry.type === 'directory') return true;
    if (f === 'directory') return false;
    return f === 'files' || f === 'none';
  }, []);

  /** 条目是否可勾选 (select 模式) */
  const entryCheckable = useCallback((entry: DirEntry, f: FilePickerFilter): boolean => {
    if (entry.type === 'directory') return f === 'directory' || f === 'none';
    return f === 'files' || f === 'none';
  }, []);

  if (!open) return null;

  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const searching = query.trim().length > 0;
  const q = query.trim().toLowerCase();
  // 过滤顺序: mode/filter 显示规则 → 搜索词按名称匹配 (大小写不敏感)
  const visible = entries.filter((entry) => {
    if (!entryVisible(entry, filter)) return false;
    if (!searching) return true;
    return entry.name.toLowerCase().includes(q);
  });
  const titleName = mode === 'open' ? '选择目录'
    : filter === 'directory' ? '选择目录'
    : filter === 'files' ? '选择文件'
    : '选择文件或目录';
  const footHint = checked.size > 0 ? `已选择 ${checked.size} 项` : '';

  return (
    <div className="fp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
      <style>{STYLES}</style>
      <div className="fp-modal">
        <div className="fp-hdr">
          <div className="fp-title">
            <span className="fp-title-icon">📁</span>
            <div className="fp-title-text">
              <span className="fp-title-name">{titleName}</span>
            </div>
          </div>
          <button className="fp-x" onClick={handleCancel} title="关闭">✕</button>
        </div>
        {/* 路径导航 (面包屑): 点击段 = 切到该目录; 右侧搜索框实时过滤当前列表 */}
        <div className="fp-nav">
          <div className="fp-nav-path" ref={inputRef}>
            <span className="fp-nav-icon">📁</span>
            {segments.length === 0 && <span className="fp-nav-item fp-nav-item--cur">/</span>}
            {segments.map((seg, i) => {
              const p = '/' + segments.slice(0, i + 1).join('/');
              const root = rootRef.current;
              const inRoot = !root || p === root.replace(/\/+$/, '') || p.startsWith(root.replace(/\/+$/, '') + '/');
              const last = i === segments.length - 1;
              return (
                <React.Fragment key={p}>
                  {i > 0 && <span className="fp-nav-sep">›</span>}
                  {inRoot ? (
                    <button className={`fp-nav-item${last ? ' fp-nav-item--cur' : ''}`} onClick={() => doBrowse(p)}>{seg}</button>
                  ) : (
                    <span className="fp-nav-item fp-nav-item--locked">{seg}</span>
                  )}
                </React.Fragment>
              );
            })}
          </div>
          <div className="fp-search">
            <svg className="fp-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></svg>
            <input
              className="fp-search-input"
              type="text"
              placeholder="搜索当前目录…"
              value={query}
              spellCheck={false}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            />
            {searching && (
              <button className="fp-search-clear" title="清空搜索" onClick={() => setQuery('')}>✕</button>
            )}
          </div>
        </div>
        <div className="fp-body">
          <div className="fp-main">
            {loading && <div className="fp-loading">加载中…</div>}
            {!loading && visible.length === 0 && <div className="fp-empty">{searching ? `无匹配「${query.trim()}」的结果` : '空目录'}</div>}
            {!loading && visible.length > 0 && (
              <div className="fp-list">
                {visible.map((entry, idx) => {
                  const i = idx;
                  const isDir = entry.type === 'directory';
                  const checkableEntry = mode === 'select' && entryCheckable(entry, filter);
                  const isChecked = checked.has(entry.path);
                  const showCheck = mode === 'select';
                  const isPicked = openPick?.path === entry.path;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={`fp-item${i === active ? ' highlight' : ''}${isChecked ? ' checked' : ''}${isPicked ? ' selected' : ''}`}
                      onClick={() => {
                        if (mode === 'open') {
                          // 打开模式: 单击目录=选中 (再点同一目录=取消); 双击=进入
                          setOpenPick((prev) => (prev?.path === entry.path ? null : entry));
                          return;
                        }
                        // select 模式
                        if (isDir && !checkableEntry) { enterDir(entry); return; } // files filter: 目录不可勾选 → 单击进入
                        toggleCheck(entry);
                      }}
                      onDoubleClick={() => { if (isDir) enterDir(entry); }}
                      onMouseEnter={() => setActive(i)}
                    >
                      {showCheck && checkableEntry && (
                        <span className={`fp-check${isChecked ? ' fp-check--on' : ''}`}>{isChecked ? '✓' : ''}</span>
                      )}
                      {isDir ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                      )}
                      <span className="fp-item-name">{entry.name}</span>
                      <span className="fp-item-path">{entry.path}</span>
                      {!isDir && mode === 'select' && checkableEntry && (
                        <button className="fp-item-enter" onClick={(e) => { e.stopPropagation(); toggleCheck(entry); }} title={isChecked ? '取消选择' : '选择'}>
                          {isChecked ? '✓ 已选' : '选择'}
                        </button>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="fp-foot">
          {mode === 'open' && <div className="fp-foot-path">📁 {(openPick ? openPick.path : currentPath) || '尚未选择'}</div>}
          {mode === 'select' && <div className="fp-foot-hint">{footHint}</div>}
          <button type="button" className="fp-cancel" onClick={handleCancel}>取消</button>
          {mode === 'open' ? (
            <button type="button" className="fp-open-btn" onClick={handleOpenPick} disabled={!currentPath}>打开</button>
          ) : (
            <button type="button" className="fp-open-btn" onClick={handleSelectPick} disabled={checked.size === 0}>
              {checked.size > 0 ? `选择 (${checked.size})` : '选择'}
            </button>
          )}
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
.fp-hdr{display:flex;align-items:center;gap:10px;padding:20px 22px 12px;flex-shrink:0}
.fp-title{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;color:var(--ai-fg,#e5e7eb);flex:1;min-width:0}
.fp-title-icon{color:var(--ai-accent,#6366f1);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--ai-accent-soft,rgba(99,102,241,0.18));border-radius:7px;flex-shrink:0;font-size:14px}
.fp-title-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.fp-title-name{font-size:15px;font-weight:600;color:var(--ai-fg,#e5e7eb);line-height:1.2}
.fp-title-sub{font-size:11.5px;color:var(--ai-fg-muted,#9ca3af);font-weight:400;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px}
.fp-x{width:30px;height:30px;background:transparent;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;flex-shrink:0;transition:all .12s}
.fp-x:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.fp-nav{display:flex;align-items:center;gap:10px;font-size:12.5px;padding:8px 20px 6px;flex-shrink:0;border-bottom:1px solid var(--ai-divider,rgba(255,255,255,0.05))}
.fp-nav-path{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.fp-nav-path::-webkit-scrollbar{display:none}
.fp-nav-icon{color:var(--ai-fg-muted,#6b7280);margin-right:4px;flex-shrink:0;font-size:12px}
.fp-search{position:relative;display:flex;align-items:center;flex-shrink:0}
.fp-search-icon{position:absolute;left:8px;color:var(--ai-fg-muted,#6b7280);pointer-events:none;flex-shrink:0}
.fp-search-input{width:200px;height:28px;background:rgba(127,127,127,0.12);border:1px solid var(--ai-divider,rgba(255,255,255,0.1));border-radius:8px;color:var(--ai-fg,#e5e7eb);font-size:12px;padding:0 24px 0 26px;outline:none;transition:all .15s;box-sizing:border-box}
.fp-search-input::placeholder{color:var(--ai-fg-muted,#6b7280)}
.fp-search-input:focus{border-color:var(--ai-accent,#6366f1);background:rgba(99,102,241,0.08)}
.fp-search-clear{position:absolute;right:5px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;color:var(--ai-fg-muted,#6b7280);cursor:pointer;border-radius:4px;font-size:11px;padding:0;line-height:1}
.fp-search-clear:hover{background:var(--ai-hover,rgba(255,255,255,0.08));color:var(--ai-fg,#e5e7eb)}
.fp-nav-item{background:none;border:none;color:var(--ai-fg-muted,#9ca3af);cursor:pointer;padding:2px 5px;border-radius:4px;white-space:nowrap;font-size:12.5px;transition:all .12s;flex-shrink:0}
.fp-nav-item--cur{color:var(--ai-fg,#e5e7eb);font-weight:600}
.fp-nav-item--locked{opacity:.4;cursor:default}
.fp-nav-item--locked:hover{background:transparent}
.fp-nav-item:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#e5e7eb)}
.fp-nav-sep{color:var(--ai-fg-muted,#6b7280);font-size:11px;opacity:.5;user-select:none;flex-shrink:0}
.fp-body{flex:1;display:flex;overflow:hidden;min-height:0}
.fp-main{flex:1;overflow-y:auto;padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px;min-height:0}
.fp-loading,.fp-empty{padding:48px 16px;text-align:center;color:var(--ai-fg-muted,#6b7280);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px}
.fp-list{display:flex;flex-direction:column;gap:1px;flex:1}
.fp-item{display:flex;align-items:center;gap:10px;width:100%;padding:7px 12px;background:transparent;border:none;border-radius:7px;color:var(--ai-fg,#d1d5db);font-size:13px;cursor:pointer;text-align:left;transition:all .1s}
.fp-item svg{flex-shrink:0;color:var(--ai-accent,#6366f1);opacity:.8}
.fp-item.highlight{background:var(--ai-hover,rgba(255,255,255,0.05))}
.fp-item.checked{background:var(--ai-active,rgba(99,102,241,0.16));color:var(--ai-fg,#fff)}
.fp-item.checked svg{opacity:1}
.fp-item:hover{background:var(--ai-hover,rgba(255,255,255,0.06))}
.fp-item.selected{background:var(--ai-accent,#6366f1);color:#fff}
.fp-item.selected svg{opacity:1}
.fp-item.selected:hover{background:var(--ai-accent-strong,#4f52d9)}
.fp-check{width:16px;height:16px;border:1px solid var(--ai-fg-muted,#6b7280);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#fff;flex-shrink:0;background:transparent;transition:all .12s}
.fp-check--on{background:var(--ai-accent,#6366f1);border-color:var(--ai-accent,#6366f1)}
.fp-item-name{font-weight:500;flex-shrink:0;font-size:13px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-item-path{font-size:11.5px;color:var(--ai-fg-muted,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px;flex:1;min-width:0}
.fp-item-enter{background:var(--ai-hover,rgba(255,255,255,0.06));border:1px solid var(--ai-divider,rgba(255,255,255,0.1));color:var(--ai-fg-muted,#cbd1d8);font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;flex-shrink:0;margin-left:auto;transition:all .15s}
.fp-item-enter:hover{background:var(--ai-accent,#6366f1);color:#fff;border-color:var(--ai-accent,#6366f1)}
.fp-foot{display:flex;align-items:center;padding:12px 18px;border-top:1px solid var(--ai-divider,rgba(255,255,255,0.06));flex-shrink:0;gap:12px;background:rgba(0,0,0,0.12)}
.fp-foot-path{flex:1;font-size:12.5px;color:var(--ai-fg,#d1d5db);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.fp-foot-hint{flex:1;font-size:12px;color:var(--ai-fg-muted,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-cancel{background:none;border:1px solid var(--ai-divider,rgba(255,255,255,0.1));color:var(--ai-fg-muted,#cbd1d8);font-size:12.5px;padding:8px 18px;border-radius:8px;cursor:pointer}
.fp-cancel:hover{background:var(--ai-hover,rgba(255,255,255,0.06));color:var(--ai-fg,#fff)}
.fp-open-btn{background:var(--ai-accent,#6366f1);border:none;color:#fff;font-size:13px;font-weight:600;padding:8px 22px;border-radius:8px;cursor:pointer;transition:all .12s}
.fp-open-btn:hover{background:var(--ai-accent-strong,#4f52d9)}
.fp-open-btn:disabled{opacity:.45;cursor:default;background:var(--ai-fg-muted,#6b7280)}
`;
