import React from 'react';
import { SlotLocation, SlotRenderer } from '@opensumi/ide-core-browser';
import { BoxPanel, SplitPanel } from '@opensumi/ide-core-browser/lib/components';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';

/**
 * LayoutComponent — core/config/layout.tsx
 *
 * 默认布局: top + main + right 三槽位显示.
 *   - left（资源管理器）/ bottom（终端）保留但默认收起
 *   - right（chat 面板）: 未登录时显示「去登录」按钮, 点击触发登录（login 槽位）
 *
 * 结构:
 *   - top-to-bottom BoxPanel: top 槽位 + 主 SplitPanel
 *   - main-horizontal: left（收起）+ main-vertical（main + bottom 收起）+ right
 */
export function LayoutComponent(): React.ReactElement {
  useInjectable<IMainLayoutService>(IMainLayoutService);

  return (
    <React.Fragment>
      <BoxPanel direction="top-to-bottom">
        <SlotRenderer slot="top" />
        <SplitPanel overflow="hidden" id="main-horizontal" flex={1}>
          <SlotRenderer
            slot={SlotLocation.left}
            isTabbar
            defaultSize={240}
            defaultCollapsed={true}
            minResize={120}
            minSize={49}
          />
          <SplitPanel id="main-vertical" minResize={300} flexGrow={1} direction="top-to-bottom">
            <SlotRenderer flex={2} flexGrow={1} minResize={200} slot={SlotLocation.main} />
            <SlotRenderer flex={1} minResize={160} slot={SlotLocation.bottom} isTabbar defaultSize={200} defaultCollapsed={true} />
          </SplitPanel>
          <SlotRenderer slot={SlotLocation.right} isTabbar defaultSize={396} minResize={240} minSize={49} />
        </SplitPanel>
      </BoxPanel>
      {/* 登录面板: 挂载 login 拓展, 默认隐藏, 由 chat「去登录」按钮经 auth:show-login 事件唤起 */}
      <SlotRenderer slot="login" id="login-slot" />
    </React.Fragment>
  );
}