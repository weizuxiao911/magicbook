import React, { useEffect, useMemo, useRef, useState } from 'react';
import { modelPrefs } from '@/extensions/chat/commands/modelPrefs';
import {
  aiConnectProvider,
  aiListProviders,
  type ProviderInfo,
} from '@/extensions/chat/commands/api';

interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  providerName?: string;
  free?: boolean;
}

interface Props {
  models: ModelInfo[];
  currentModel: string;
  currentProvider?: string;
  /** 初始视图: select=模型选择, providers=模型管理(/connect) */
  initialView?: 'select' | 'providers';
  onSelect: (modelID: string, providerID: string) => void;
  onClose: () => void;
  /** 模型列表 / 服务商列表发生变化后通知父组件刷新 */
  onProvidersChanged?: () => void;
}

type View =
  | { kind: 'select'; filterProvider?: string }
  | { kind: 'providers' }
  | { kind: 'apikey'; provider: ProviderInfo };

/**
 * 模型选择 / 连接服务商 弹层 (TUI /models + /connect 风格)
 *
 * 所有视图统一为居中全局模态框 + 半透明遮罩:
 *   1. select     — 模型选择 (按 provider 分组, 底部 "连接服务商" 入口)
 *   2. providers  — 连接服务商 (搜索/选择 catalog 中的 provider)
 *   3. apikey     — 输入 API Key, 调 auth.set 连接
 */
export const ModelPicker: React.FC<Props> = ({
  models, currentModel, currentProvider, initialView, onSelect, onClose, onProvidersChanged,
}) => {
  const [view, setView] = useState<View>(
    initialView === 'providers' ? { kind: 'providers' } : { kind: 'select' }
  );
  const [query, setQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [allProviders, setAllProviders] = useState<ProviderInfo[] | null>(null);
  const [, forceTick] = useState(0);
  /** 键盘导航高亮索引 (ArrowUp/Down + Enter/Tab) */
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 本地隐藏偏好 (modelPrefs 变更后强制重渲染)
  useEffect(() => {
    const handler = () => forceTick((n) => n + 1);
    window.addEventListener('chat:ai-modelPrefs-changed', handler);
    return () => window.removeEventListener('chat:ai-modelPrefs-changed', handler);
  }, []);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 初始视图为 providers (/connect) 时自动拉取服务商列表
  useEffect(() => {
    if (view.kind !== 'providers' || allProviders) return;
    void openProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind]);

  // 切换视图时聚焦合适的输入框
  useEffect(() => {
    const t = setTimeout(() => {
      if (view.kind === 'apikey') keyRef.current?.focus();
      else searchRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [view.kind]);

  const prefs = modelPrefs.get();

  // ========== 视图: select (模型选择, 按 provider 分组) ==========
  // 每个选项是 {providerID, modelID} 元组, 标题=model.name, 描述=provider.name
  // 排序: opencode 系 provider 优先, 同 provider 内 free 优先再按 title 字母序
  // 搜索: 匹配 title + description + id (TUI /models 同款)
  type SelectItem = {
    providerID: string;
    modelID: string;
    title: string;
    description: string;
    category: string;
    free: boolean;
  };

  const sortedModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items: SelectItem[] = [];
    for (const m of models) {
      if (prefs.hidden.includes(m.id)) continue;
      const providerID = m.providerID || 'other';
      const providerName = prefs.providerLabels[providerID] || m.providerName || providerID;
      const title = prefs.customNames[m.id] || m.name || m.id;
      if (q) {
        const hay = (title + ' ' + providerName + ' ' + m.id + ' ' + providerID).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      items.push({
        providerID,
        modelID: m.id,
        title,
        description: providerName,
        category: providerName,
        free: !!m.free,
      });
    }
    items.sort((a, b) => {
      // opencode 系 provider 优先
      const aOpen = a.providerID.startsWith('opencode') ? 0 : 1;
      const bOpen = b.providerID.startsWith('opencode') ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      // 同 provider 内: free 优先, 再按 title 字母序
      if (a.free !== b.free) return a.free ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    return items;
  }, [models, query, prefs]);

  const selectGroups = useMemo(() => {
    const filterProvider = view.kind === 'select' ? view.filterProvider : undefined;
    const map = new Map<string, { label: string; items: SelectItem[] }>();
    for (const it of sortedModels) {
      // 连接后进入该 provider 的模型选择 (TUI /connect → DialogModel 同款)
      if (filterProvider && it.providerID !== filterProvider) continue;
      if (!map.has(it.providerID)) map.set(it.providerID, { label: it.category, items: [] });
      map.get(it.providerID)!.items.push(it);
    }
    return Array.from(map.entries()).map(([pid, g]) => ({ pid, ...g }));
  }, [sortedModels, view]);

  // active 精准匹配: (providerID, modelID) 元组, 避免同名模型跨 provider 误标
  const isCurrent = (it: SelectItem) =>
    currentModel === it.modelID && (!currentProvider || currentProvider === it.providerID);

  // 连接成功后筛选的 provider 显示名 (TUI DialogModel title 同款)
  const selectProviderName = useMemo(() => {
    if (view.kind !== 'select' || !view.filterProvider) return '';
    const pid = view.filterProvider;
    const fromProviders = allProviders?.find((p) => p.id === pid);
    if (fromProviders) return fromProviders.name;
    const fromModels = models.find((m) => m.providerID === pid);
    return fromModels?.providerName || prefs.providerLabels[pid] || pid;
  }, [view, allProviders, models, prefs]);

  // ========== 视图: providers (连接服务商, TUI /connect 同款) ==========
  const filteredCatalog = useMemo(() => {
    const list = allProviders || [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      : list;
    return [...filtered].sort((a, b) => Number(!!b.connected) - Number(!!a.connected));
  }, [allProviders, query]);

  const openProviders = async () => {
    setView({ kind: 'providers' });
    setQuery('');
    setError('');
    if (allProviders) return;
    try {
      const list = await aiListProviders();
      setAllProviders(list);
    } catch (e) {
      setError(String((e as any)?.message || e));
    }
  };

  // ========== 键盘导航 (ArrowUp/Down + Enter/Tab, TUI /models 同款) ==========
  // 当前视图扁平列表: select → 模型项; providers → 服务商项
  const navItems = useMemo(() => {
    if (view.kind === 'select') {
      return selectGroups.flatMap((g) => g.items);
    }
    if (view.kind === 'providers') {
      return filteredCatalog;
    }
    return [];
  }, [view, selectGroups, filteredCatalog]);

  // 搜索/视图变化时重置高亮到首个匹配
  useEffect(() => {
    setActiveIndex(0);
  }, [query, view.kind, view.kind === 'select' ? (view as any).filterProvider : undefined]);

  // 高亮项跟随滚动进入视野 (仅滚动 modal-body 容器, 避免整页跳动)
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const el = body.querySelector('.is-highlighted');
    if (!el) return;
    const bRect = body.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < bRect.top) body.scrollTop += eRect.top - bRect.top;
    else if (eRect.bottom > bRect.bottom) body.scrollTop += eRect.bottom - bRect.bottom;
  }, [activeIndex]);

  const handleNavKeyDown = (e: React.KeyboardEvent) => {
    if (view.kind === 'apikey') return; // apikey 视图有自己的 Enter 提交
    const n = navItems.length;
    if (n === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % n);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + n) % n);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const it = navItems[activeIndex];
      if (!it) return;
      if (view.kind === 'select') {
        const m = it as SelectItem;
        onSelect(m.modelID, m.providerID);
      } else if (view.kind === 'providers') {
        const p = it as ProviderInfo;
        setView({ kind: 'apikey', provider: p });
        setApiKey('');
        setError('');
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const it = navItems[activeIndex];
      if (!it) return;
      if (view.kind === 'select') {
        const m = it as SelectItem;
        onSelect(m.modelID, m.providerID);
      } else if (view.kind === 'providers') {
        const p = it as ProviderInfo;
        setView({ kind: 'apikey', provider: p });
        setApiKey('');
        setError('');
      }
      return;
    }
  };

  const submitApiKey = async () => {
    if (view.kind !== 'apikey') return;
    const key = apiKey.trim();
    if (!key) return;
    setConnecting(true);
    setError('');
    try {
      await aiConnectProvider(view.provider.id, key);
      onProvidersChanged?.();
      setAllProviders(null);
      // TUI /connect 同款: 连接成功后跳转该 provider 的模型选择
      setView({ kind: 'select', filterProvider: view.provider.id });
      setQuery('');
      setApiKey('');
    } catch (e) {
      setError(String((e as any)?.message || e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div
      className="chat__modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="chat__modal" role="dialog" aria-modal="true">
        {view.kind === 'select' && (
          <>
            {view.filterProvider && (
              <div className="chat__modal-header chat__modal-header--page">
                <button
                  type="button"
                  className="chat__modal-back"
                  onClick={() => setView({ kind: 'select' })}
                  title="返回"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <div className="chat__modal-title">
                  <span className="chat__modal-title-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>
                  </span>
                  选择 {selectProviderName} 的模型
                </div>
              </div>
            )}
            <div className="chat__modal-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleNavKeyDown}
                placeholder="搜索模型"
              />
            </div>

            <div className="chat__modal-body" ref={bodyRef}>
              {selectGroups.length === 0 && (
                <div className="chat__modal-empty">无匹配模型</div>
              )}
              {selectGroups.map((g) => (
                <div key={g.pid} className="chat__modal-group">
                  <div className="chat__modal-group-title">{g.label}</div>
                  {g.items.map((it) => {
                    const active = isCurrent(it);
                    const idx = (navItems as SelectItem[]).indexOf(it);
                    const highlighted = idx === activeIndex;
                    return (
                      <div
                        key={`${it.providerID}::${it.modelID}`}
                        role="button"
                        tabIndex={0}
                        className={`chat__modal-item${active ? ' is-active' : ''}${highlighted ? ' is-highlighted' : ''}`}
                        onClick={() => onSelect(it.modelID, it.providerID)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(it.modelID, it.providerID); }}
                      >
                        <span className="chat__modal-item-name">{it.title}</span>
                        {it.free && <span className="chat__modal-tag">免费</span>}
                        {active && (
                          <svg className="chat__modal-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <button
              type="button"
              className="chat__modal-foot"
              onClick={openProviders}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              <span>模型管理</span>
            </button>
          </>
        )}

        {view.kind === 'providers' && (
          <>
            <div className="chat__modal-header chat__modal-header--page">
              <button
                type="button"
                className="chat__modal-back"
                onClick={() => setView({ kind: 'select' })}
                title="返回"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div className="chat__modal-title">模型管理</div>
            </div>

            <div className="chat__modal-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleNavKeyDown}
                placeholder="搜索服务商"
              />
            </div>

            <div className="chat__modal-body" ref={bodyRef}>
              {error && <div className="chat__modal-error">{error}</div>}
              {!allProviders && <div className="chat__modal-empty">加载服务商列表中…</div>}
              {allProviders && filteredCatalog.length === 0 && (
                <div className="chat__modal-empty">无匹配服务商</div>
              )}
              {allProviders && filteredCatalog.length > 0 && (
                <div className="chat__modal-cat">
                  <div className="chat__modal-cat-title">其他</div>
                  {filteredCatalog.map((p, pi) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`chat__modal-catrow${p.connected ? ' is-connected' : ''}${pi === activeIndex ? ' is-highlighted' : ''}`}
                      onClick={() => { setView({ kind: 'apikey', provider: p }); setApiKey(''); setError(''); }}
                    >
                      <span className="chat__modal-caticon" aria-hidden="true">
                        {p.public
                          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>
                          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2 12a10 10 0 0 1 20 0"/>
                              <path d="M5 12a7 7 0 0 1 14 0"/>
                              <path d="M8 12a4 4 0 0 1 8 0"/>
                              <circle cx="12" cy="12" r="1"/>
                            </svg>}
                      </span>
                      <span className="chat__modal-catname">{p.name} ({p.id})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {view.kind === 'apikey' && (
          <>
            <div className="chat__modal-header chat__modal-header--page">
              <button
                type="button"
                className="chat__modal-back"
                onClick={() => { setView({ kind: 'providers' }); setApiKey(''); setError(''); }}
                title="返回"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div className="chat__modal-title">
                <span className="chat__modal-title-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>
                </span>
                连接 {view.provider.name} ({view.provider.id})
              </div>
            </div>

            <div className="chat__modal-body chat__modal-body--apikey">
              {error && <div className="chat__modal-error">{error}</div>}
              <p className="chat__modal-apikey-desc">
                输入你的 {view.provider.name} ({view.provider.id}) API 密钥以连接账户，并在本应用中连接 {view.provider.name} ({view.provider.id}) 模型。
              </p>
              <label className="chat__modal-apikey-label">
                {view.provider.name} ({view.provider.id}) API 密钥
              </label>
              <input
                ref={keyRef}
                type="password"
                className="chat__modal-apikey-input"
                placeholder="API 密钥"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitApiKey(); }}
              />
              <div className="chat__modal-apikey-actions">
                <button
                  type="button"
                  className="chat__modal-btn-continue"
                  onClick={submitApiKey}
                  disabled={connecting || !apiKey.trim()}
                >
                  {connecting ? '连接中…' : '继续'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
