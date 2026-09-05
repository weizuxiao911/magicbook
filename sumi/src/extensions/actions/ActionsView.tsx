import React, { useState, useEffect, useMemo } from 'react';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';
import { PreferenceService } from '@opensumi/ide-core-browser/lib/preferences';
import { PreferenceScope } from '@opensumi/ide-core-common/lib/preferences/preference-scope';

import { getWorkspace, subscribeWorkspace } from '../../infra/url';
import { APP_CHAT_CONFIG } from '../../config/brand';
import { BrowserToken, type IBrowserService } from '../browser';

function requestShowPicker(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('workspace:request-show'));
}

const THEME_DARK = 'opensumi-design-dark-theme';
const THEME_LIGHT = 'opensumi-design-light-theme';
const THEME_KEY = 'general.theme';

/**
 * ActionsView — 顶栏 (top 槽位)
 *
 * 现在做 4 件事:
 *  - 品牌展示 (🐮 + name, 静态)
 *  - 工作目录选择器 (logo 旁的可点按钮, 全局唯一切换入口 — 派 workspace:request-show)
 *  - 主题切换
 *  - 3 个布局 toggle: 左侧栏 / 底部栏 / 右侧栏
 *
 * 工作目录选择原下放在 chat 输入框底部, 现已上移到顶栏 logo 旁 (chat 中保留 cwd 读取但不再有切换按钮).
 */

export const ActionsView: React.FC = () => {
  const layoutService = useInjectable<IMainLayoutService>(IMainLayoutService);
  const preferenceService = useInjectable<PreferenceService>(PreferenceService);
  const browserService = useInjectable<IBrowserService>(BrowserToken as any);
  const [leftVisible, setLeftVisible] = useState(false);
  const [bottomVisible, setBottomVisible] = useState(false);
  const [rightVisible, setRightVisible] = useState(true);
  const [isDark, setIsDark] = useState(true);

  // 品牌/logo 单一来源: config/brand.ts
  const brand = useMemo(() => APP_CHAT_CONFIG.brand, []);

  // 当前工作空间: 显示在 logo 旁, 点击触发 requestShowPicker() 派 workspace:request-show → WorkspacePicker 模态.
  // 状态跟 service/state 同步 (subscribeWorkspace + storage 事件, 跨 tab/选目录后均能刷新).
  const [workspace, setWorkspaceState] = useState<string>(() => getWorkspace());
  useEffect(() => {
    const refresh = () => setWorkspaceState(getWorkspace());
    const unsub = subscribeWorkspace(refresh);
    window.addEventListener('storage', refresh);
    return () => {
      unsub();
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const workspaceName = useMemo(() => {
    if (!workspace) return '未选择工作空间';
    return workspace.split('/').filter(Boolean).pop() || workspace;
  }, [workspace]);
  const workspaceFull = workspace || '';

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
      disposables.forEach((d) => d.dispose());
    };
  }, [layoutService]);

  const toggleLeft = () => layoutService.toggleSlot(SlotLocation.left);
  const toggleBottom = () => layoutService.toggleSlot(SlotLocation.bottom);

  // right 折叠/展开: 直接驱动 width 容器的内联 width 做帧动画 (396↔0), 全程平滑无顿感.
  const toggleRight = () => {
    const right = layoutService.getTabbarService(SlotLocation.right);
    const willShow = !right.currentContainerId.get();
    const widthEl = () => {
      const slot = document.querySelector<HTMLElement>('[class*="right_slot"]') || document.querySelector<HTMLElement>('.right-slot');
      return slot?.parentElement?.parentElement as HTMLElement | null;
    };
    const DURATION = 260;

    if (willShow) {
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
          void el.offsetWidth;
          el.style.transition = `width ${DURATION}ms cubic-bezier(0.22,1,0.36,1)`;
          el.style.width = `${prevSize}px`;
          setTimeout(() => { if (el) { el.style.transition = ''; el.style.minWidth = ''; } }, DURATION + 60);
        }
      }, 90);
    } else {
      const el = widthEl();
      if (el) {
        const from = el.getBoundingClientRect().width || 396;
        el.style.minWidth = '0px';
        el.style.transition = `width ${DURATION}ms cubic-bezier(0.22,1,0.36,1)`;
        el.style.width = '0px';
        setTimeout(() => {
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
      <line x1="17.3" y1="4.9" x2="19.1" y2="6.7" />
    </svg>
  );
  const MoonIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" />
    </svg>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: '100%', padding: '0 12px', fontSize: 13 }}>
      <button
        type="button"
        onClick={() => requestShowPicker()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
          color: 'var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb))',
          padding: '4px 10px 4px 4px',
          userSelect: 'none', cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          borderRadius: 8,
          transition: 'background 0.12s ease',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--button-hoverBackground, rgba(255,255,255,0.06))'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        title={workspaceFull || '点击选择工作空间'}
      >
        {brand.logo ? (
          <span style={{ display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>{brand.logo}</span>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 6 L12 18 L19 6" />
          </svg>
        )}
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240,
        }}>{workspaceName}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        title="内置浏览器"
        style={iconBtnStyle}
        onClick={() => { void browserService.open(); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      </button>
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
