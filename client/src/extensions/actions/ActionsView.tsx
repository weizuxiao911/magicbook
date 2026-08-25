import React, { useState, useEffect } from 'react';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';
import { PreferenceService } from '@opensumi/ide-core-browser/lib/preferences';
import { PreferenceScope } from '@opensumi/ide-core-common/lib/preferences/preference-scope';

import { isLoggedIn, logout } from '../login';

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
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());

  // 品牌/logo 从全局配置 (__APP_CONFIG__.chatConfig.brand) 读取, 不硬编码
  const brand = React.useMemo(() => {
    const cfg = (window as any).__APP_CONFIG__;
    return cfg?.chatConfig?.brand || { name: '魔法书', logoChar: '' };
  }, []);

  // 监听登录态 (登录/登出后更新)
  useEffect(() => {
    const onAuth = () => setLoggedIn(isLoggedIn());
    window.addEventListener('app:auth-changed', onAuth);
    const id = window.setInterval(() => setLoggedIn(isLoggedIn()), 1500);
    return () => {
      window.removeEventListener('app:auth-changed', onAuth);
      window.clearInterval(id);
    };
  }, []);

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
    // { currentId: "", size: 458 } (折叠态但容器占宽) → 刷新后右侧空栏.
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

  // right 折叠/展开: 直接驱动 width 容器的内联 width 做帧动画 (458↔0), 全程平滑无顿感.
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
      const prevSize = (right as any).prevSize || 458;
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
        const from = el.getBoundingClientRect().width || 458;
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
  const LogoutIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: '100%', padding: '0 12px', fontSize: 13 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
        color: 'var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb))',
        paddingLeft: 4, userSelect: 'none',
      }}>
        {brand.logoChar ? (
          <span style={{ display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>{brand.logoChar}</span>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 6 L12 18 L19 6" />
          </svg>
        )}
        {brand.name}
      </span>
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
      {/* 退出登录: 固定在 actions 最右 */}
      {loggedIn && (
        <button type="button" title="退出登录" onClick={logout} style={iconBtnStyle}>
          <LogoutIcon />
        </button>
      )}
    </div>
  );
};
