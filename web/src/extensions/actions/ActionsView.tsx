import React, { useState, useEffect, useRef, useMemo } from 'react';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';
import { PreferenceService } from '@opensumi/ide-core-browser/lib/preferences';
import { PreferenceScope } from '@opensumi/ide-core-common/lib/preferences/preference-scope';

import { getRecent, switchToRecent } from '../workspace/recent';
import { effectiveCwd } from '../../service/env';

const THEME_DARK = 'opensumi-design-dark-theme';
const THEME_LIGHT = 'opensumi-design-light-theme';
const THEME_KEY = 'general.theme';

/**
 * ActionsView — action 槽位 (top 横条右侧)
 *
 * 3 个布局 toggle: 折叠/展开 左侧栏 / 底部栏 / 右侧栏.
 * 全部走 OpenSumi 原生 toggleSlot (不再手动操作 DOM, 验证原生 right 折叠行为).
 * 无登录/账号按钮 (webapp 独立产品, 无登录态).
 *
 * 参考: 早期实验仓 extensions/actions/ActionsView.tsx (登录/账号被砍).
 */

export const ActionsView: React.FC = () => {
  const layoutService = useInjectable<IMainLayoutService>(IMainLayoutService);
  const preferenceService = useInjectable<PreferenceService>(PreferenceService);
  const [leftVisible, setLeftVisible] = useState(false);
  const [bottomVisible, setBottomVisible] = useState(false);
  const [rightVisible, setRightVisible] = useState(true);
  const [isDark, setIsDark] = useState(true);

  // 品牌/logo 从全局配置 (__APP_CONFIG__.chatConfig.brand) 读取, 不硬编码
  const brand = useMemo(() => {
    const cfg = (window as any).__APP_CONFIG__;
    return cfg?.chatConfig?.brand || { name: 'AI 工作台', logoChar: '' };
  }, []);

  // 工作目录: APP_CWD (用户选) || __APP_CONFIG__.cwd (hostCwd 兜底)
  const [cwd, setCwd] = useState<string>(() => effectiveCwd());
  const [recent, setRecent] = useState<string[]>(() => getRecent());
  const [wsOpen, setWsOpen] = useState(false);
  const wsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const refresh = () => {
      setCwd(effectiveCwd());
      setRecent(getRecent());
    };
    window.addEventListener('workspace:show-picker', () => setWsOpen(false));
    window.addEventListener('workspace:recent-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('workspace:recent-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  useEffect(() => {
    if (!wsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wsRef.current && !wsRef.current.contains(e.target as Node)) setWsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [wsOpen]);

  const workspaceName = useMemo(() => {
    if (!cwd) return '';
    return cwd.split('/').filter(Boolean).pop() || cwd;
  }, [cwd]);
  const openPicker = () => {
    setWsOpen(false);
    window.dispatchEvent(new CustomEvent('workspace:show-picker'));
  };

  useEffect(() => {
    const current = preferenceService.get<string>(THEME_KEY, THEME_DARK);
    setIsDark(current !== THEME_LIGHT);
    const disposable = preferenceService.onPreferenceChanged((e) => {
      if (e.preferenceName === THEME_KEY) {
        setIsDark(e.newValue !== THEME_LIGHT);
      }
    });
    return () => disposable.dispose?.();
  }, [preferenceService]);

  const toggleTheme = () => {
    const next = isDark ? THEME_LIGHT : THEME_DARK;
    void preferenceService.set(THEME_KEY, next, PreferenceScope.User);
  };

  useEffect(() => {
    // 启动时: 确保 right slot 有激活的面板. OpenSumi 布局缓存可能是
    // { currentId: "", size: 396 } (折叠态但容器占宽) → 刷新后右侧空栏.
    // 延迟到容器注册完再激活 AI 面板; 仅从未激活过时激活一次,
    // 避免用户折叠后定时器又把 right 重新展开.
    let disposed = false;
    let activated = false;
    const activateRight = () => {
      if (activated) return;
      const rightService = layoutService.getTabbarService(SlotLocation.right);
      if (!rightService.currentContainerId.get()) {
        const first = rightService.containersMap.keys().next().value;
        if (first) {
          rightService.updateCurrentContainerId(first);
          activated = true;
        }
      } else {
        activated = true;
      }
    };
    // 多试几次 (容器异步注册)
    for (const delay of [100, 300, 800, 2000]) {
      setTimeout(() => { if (!disposed) activateRight(); }, delay);
    }

    const sync = (slot: string, setter: (v: boolean) => void) => () => {
      setter(layoutService.isVisible(slot));
    };
    const slots = [
      { slot: SlotLocation.left, setter: setLeftVisible },
      { slot: SlotLocation.right, setter: setRightVisible },
      { slot: SlotLocation.bottom, setter: setBottomVisible },
    ];
    const disposables: { dispose(): void }[] = [];
    let rightWasVisible = layoutService.isVisible(SlotLocation.right);
    slots.forEach(({ slot, setter }) => {
      const service = layoutService.getTabbarService(slot);
      const syncFn = sync(slot, setter);
      syncFn();
      disposables.push(service.onCurrentChange((e: any) => {
        syncFn();
        // right 面板被激活 (从隐藏 → 显示) 时通知 chat 自动聚焦输入框
        if (slot === SlotLocation.right) {
          const nowVisible = !!e?.currentId;
          if (nowVisible && !rightWasVisible) {
            window.dispatchEvent(new CustomEvent('chat:ai-reveal'));
          }
          rightWasVisible = nowVisible;
        }
      }));
      disposables.push(service.onSizeChange(syncFn));
    });
    return () => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    };
  }, [layoutService]);

  const toggleLeft = () => layoutService.toggleSlot(SlotLocation.left);
  const toggleBottom = () => layoutService.toggleSlot(SlotLocation.bottom);

  // right 折叠/展开: 直接驱动 width 容器的内联 width 做帧动画 (396↔0), 全程平滑无顿感.
  const toggleRight = () => {
    const right = layoutService.getTabbarService(SlotLocation.right);
    const willShow = !right.currentContainerId.get();
    // width 容器: right_slot 的父级 (内联 width + min-width:49px 的元素)
    const widthEl = () => {
      const slot = document.querySelector<HTMLElement>('[class*="right_slot"]') || document.querySelector<HTMLElement>('.right-slot');
      return slot?.parentElement?.parentElement as HTMLElement | null;
    };
    const DURATION = 260;

    if (willShow) {
      // 展开: 先恢复显示 + toggleSlot (OpenSumi 设 49), 等渲染完成, 再 49 → prevSize 平滑放大
      const prevSize = (right as any).prevSize || 396;
      right.updatePanelVisibility(true);
      layoutService.toggleSlot(SlotLocation.right);
      const el = widthEl();
      setTimeout(() => {
        if (el) {
          const from = el.getBoundingClientRect().width || 49;
          el.style.minWidth = '0px';
          el.style.width = `${from}px`;
          el.style.transition = 'none';
          void el.offsetWidth; // 强制重排, 建立初始帧
          el.style.transition = `width ${DURATION}ms cubic-bezier(0.22,1,0.36,1)`;
          el.style.width = `${prevSize}px`;
          setTimeout(() => { if (el) { el.style.transition = ''; el.style.minWidth = ''; } }, DURATION + 60);
        }
      }, 90);
    } else {
      // 折叠: 宽度 当前 → 0 平滑缩小 (此时不动 currentId, OpenSumi 不干扰)
      const el = widthEl();
      if (el) {
        const from = el.getBoundingClientRect().width || 396;
        el.style.minWidth = '0px';
        el.style.transition = `width ${DURATION}ms cubic-bezier(0.22,1,0.36,1)`;
        el.style.width = '0px';
        setTimeout(() => {
          // 先隐藏 (display:none), 等 hidePanel 的 debounce(60ms) + React 渲染完成,
          // 再切 currentId — 避免 handleChange 在面板仍可见时把宽度弹回 49px
          right.updatePanelVisibility(false);
          setTimeout(() => {
            layoutService.toggleSlot(SlotLocation.right);
            if (el) { el.style.transition = ''; el.style.minWidth = ''; }
          }, 90);
        }, DURATION + 20);
      } else {
        layoutService.toggleSlot(SlotLocation.right);
        right.updatePanelVisibility(false);
      }
    }
  };

  const iconBtnStyle: React.CSSProperties = {
    width: 32,
    height: 32,
    background: 'transparent',
    border: 'none',
    color: 'var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb))',
    cursor: 'pointer',
    borderRadius: 10,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const LeftIcon = ({ filled }: { filled: boolean }) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {filled ? <rect x="3" y="4" width="6" height="16" fill="currentColor" stroke="none" /> : <line x1="9" y1="4" x2="9" y2="20" />}
    </svg>
  );
  const BottomIcon = ({ filled }: { filled: boolean }) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {filled ? <rect x="3" y="16" width="18" height="4" fill="currentColor" stroke="none" /> : <line x1="3" y1="16" x2="21" y2="16" />}
    </svg>
  );
  const RightIcon = ({ filled }: { filled: boolean }) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {filled ? <rect x="15" y="4" width="6" height="16" fill="currentColor" stroke="none" /> : <line x1="15" y1="4" x2="15" y2="20" />}
    </svg>
  );
  const SunIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4.5" />
      <line x1="12" y1="19.5" x2="12" y2="22" />
      <line x1="2" y1="12" x2="4.5" y2="12" />
      <line x1="19.5" y1="12" x2="22" y2="12" />
      <line x1="4.9" y1="4.9" x2="6.7" y2="6.7" />
      <line x1="17.3" y1="17.3" x2="19.1" y2="19.1" />
      <line x1="4.9" y1="19.1" x2="6.7" y2="17.3" />
      <line x1="17.3" y1="6.7" x2="19.1" y2="4.9" />
    </svg>
  );
  const MoonIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" />
    </svg>
  );
  const FolderIcon = ({ size = 14 }: { size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
  const FolderOpenIcon = ({ size = 14 }: { size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v2" />
    </svg>
  );
  const HistoryIcon = ({ size = 13 }: { size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
  const ChevronDown = ({ size = 12 }: { size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: '100%', padding: '0 12px', fontSize: 13 }}>
      <div ref={wsRef} style={{ position: 'relative' }}>
        <button
          type="button"
          title={cwd || '打开工作目录'}
          onClick={() => setWsOpen((v) => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            height: 28, padding: '0 8px',
            background: wsOpen ? 'rgba(255,255,255,0.06)' : 'transparent',
            border: 'none', borderRadius: 6, cursor: 'pointer',
            color: cwd
              ? 'var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb))'
              : 'var(--foreground, #999)',
            fontSize: 13, fontWeight: 600, letterSpacing: 0.2,
            maxWidth: 320, userSelect: 'none',
          }}
          onMouseEnter={(e) => { if (!wsOpen) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
          onMouseLeave={(e) => { if (!wsOpen) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          {brand.logoChar ? (
            <span style={{ display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>{brand.logoChar}</span>
          ) : (
            <FolderIcon size={14} />
          )}
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240,
          }}>
            {workspaceName || '打开工作目录'}
          </span>
          <span style={{ display: 'inline-flex', opacity: 0.7, marginLeft: 2 }}>
            <ChevronDown />
          </span>
        </button>
        {wsOpen && (
          <div
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0,
              minWidth: 320, maxWidth: 480,
              background: 'var(--editor-background, #1e1e2e)',
              border: '1px solid var(--widget-border, rgba(255,255,255,0.12))',
              borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              padding: 6, zIndex: 9000,
              color: 'var(--editor-foreground, #e5e7eb)',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
              borderRadius: 6, background: 'rgba(255,255,255,0.03)', marginBottom: 4,
            }}>
              <span style={{ color: 'var(--focus-border, #6366f1)', display: 'inline-flex' }}><FolderOpenIcon /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {workspaceName || '尚未选择'}
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--foreground, #888)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={cwd || ''}>
                  {cwd || '在工作目录面板选择目录后这里会显示路径'}
                </div>
              </div>
            </div>
            {recent.length > 0 && (
              <>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px 4px', fontSize: 10, fontWeight: 600,
                  color: 'var(--foreground, #888)', textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  <HistoryIcon /> 最近
                </div>
                {recent
                  .filter((p) => p !== cwd)
                  .slice(0, 5)
                  .map((p) => {
                    const name = p.split('/').filter(Boolean).pop() || p;
                    return (
                      <button
                        key={p}
                        type="button"
                        role="menuitem"
                        onClick={() => { setWsOpen(false); switchToRecent(p); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          padding: '6px 10px', background: 'none', border: 'none',
                          borderRadius: 5, cursor: 'pointer', textAlign: 'left',
                          color: 'var(--editor-foreground, #e5e7eb)', fontSize: 12,
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                        title={p}
                      >
                        <span style={{ color: 'var(--foreground, #888)', display: 'inline-flex' }}><FolderIcon /></span>
                        <span style={{ fontWeight: 500, flexShrink: 0 }}>{name}</span>
                        <span style={{
                          color: 'var(--foreground, #666)', fontSize: 11,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          direction: 'rtl', textAlign: 'left', minWidth: 0, flex: 1, marginLeft: 6,
                        }}>{p}</span>
                      </button>
                    );
                  })}
                <div style={{ height: 1, background: 'var(--widget-border, rgba(255,255,255,0.08))', margin: '6px 4px' }} />
              </>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={openPicker}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 10px', background: 'none', border: 'none',
                borderRadius: 5, cursor: 'pointer', textAlign: 'left',
                color: 'var(--editor-foreground, #e5e7eb)', fontSize: 12, fontWeight: 500,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.18)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ color: 'var(--focus-border, #6366f1)', display: 'inline-flex' }}><FolderOpenIcon /></span>
              <span>选择其他工作目录...</span>
            </button>
          </div>
        )}
      </div>
      <span style={{ flex: 1 }} />
      <button type="button" title={isDark ? '切换到浅色主题' : '切换到深色主题'} onClick={toggleTheme} style={iconBtnStyle}>
        {isDark ? <SunIcon /> : <MoonIcon />}
      </button>
      <button type="button" title={leftVisible ? '折叠左侧栏' : '展开左侧栏'} onClick={toggleLeft} style={iconBtnStyle}>
        <LeftIcon filled={leftVisible} />
      </button>
      <button type="button" title={bottomVisible ? '折叠底部栏' : '展开底部栏'} onClick={toggleBottom} style={iconBtnStyle}>
        <BottomIcon filled={bottomVisible} />
      </button>
      <button type="button" title={rightVisible ? '折叠右侧栏' : '展开右侧栏'} onClick={toggleRight} style={iconBtnStyle}>
        <RightIcon filled={rightVisible} />
      </button>
    </div>
  );
};
