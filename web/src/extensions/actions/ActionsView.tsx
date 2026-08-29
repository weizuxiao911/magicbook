import React, { useState, useEffect, useMemo } from 'react';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';
import { PreferenceService } from '@opensumi/ide-core-browser/lib/preferences';
import { PreferenceScope } from '@opensumi/ide-core-common/lib/preferences/preference-scope';

import { getCwd, subscribeCwd } from '../../service/env';

const THEME_DARK = 'opensumi-design-dark-theme';
const THEME_LIGHT = 'opensumi-design-light-theme';
const THEME_KEY = 'general.theme';

/**
 * ActionsView — 顶栏 (top 槽位)
 *
 * 现在只做 3 件事:
 *  - 品牌展示 (🐮 + name, 静态, 不再承担工作目录选择器)
 *  - 主题切换
 *  - 3 个布局 toggle: 左侧栏 / 底部栏 / 右侧栏
 *
 * 工作目录选择入口已下放到 chat 输入框底部 (chat 拓展的全局唯一入口).
 * 这里只读显示当前 cwd 名字 (静态, 帮助用户定位), 不提供切换.
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
    return cfg?.chatConfig?.brand || { name: 'AI 工作台', logo: '' };
  }, []);

  // 当前工作目录 (read-only 显示, 切换入口在 chat 输入框底部)
  const [cwd, setCwd] = useState<string>(() => getCwd());
  useEffect(() => {
    const refresh = () => setCwd(getCwd());
    const unsub = subscribeCwd(refresh);
    window.addEventListener('storage', refresh);
    return () => {
      unsub();
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const cwdName = useMemo(() => {
    if (!cwd) return '未选择工作目录';
    return cwd.split('/').filter(Boolean).pop() || cwd;
  }, [cwd]);

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
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          fontSize: 13, fontWeight: 700, letterSpacing: 0.2,
          color: 'var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb))',
          paddingLeft: 4, userSelect: 'none', cursor: 'default',
        }}
        title={cwd || '尚未选择工作目录'}
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
        }}>{cwdName}</span>
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
    </div>
  );
};
