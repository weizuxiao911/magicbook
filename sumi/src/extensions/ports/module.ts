/**
 * extensions/ports/module.ts — 端口面板 + 服务发现提示
 *
 * 对标 VSCode 端口面板:
 *   - 底部新 tab「端口」: 列表 (端口/进程/操作: 打开/复制URL/移除)
 *   - 服务启动自动提示 (SSE ports.detected → notification, 面板未开也提示)
 *   - 打开 = 走 opencode 反代 /proxy/<port>/ (统一经 opencode, 未来远程/容器模式可用)
 *   - 手动添加端口 (扫描不到的服务) / 刷新
 *
 * 常驻提示: PortsNotifierContribution (ClientAppContribution, 与面板挂载解耦).
 */

import { Autowired, Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { BrowserModule, ClientAppContribution, SlotLocation } from '@opensumi/ide-core-browser';
import { ComponentContribution, ComponentRegistry } from '@opensumi/ide-core-browser/lib/layout';
import { notification } from '@opensumi/ide-components/lib/notification';
import React from 'react';

import { PortsToken, type IPortsService } from '../../service/ports';

import { PortsPanel } from './PortsPanel';

@Injectable()
@Domain(ComponentContribution)
export class PortsContribution implements ComponentContribution {
  registerComponent(registry: ComponentRegistry): void {
    registry.register('ports-panel', {
      id: 'ports-panel',
      component: PortsPanel,
    }, {
      containerId: 'ports-panel',
      iconClass: 'codicon codicon-radio-tower',
      title: '端口',
    }, SlotLocation.bottom);
  }
}

/** 常驻: 服务启动/关闭提示 (不依赖面板是否挂载). */
@Injectable()
@Domain(ClientAppContribution)
export class PortsNotifierContribution implements ClientAppContribution {
  @Autowired(PortsToken)
  private readonly ports!: IPortsService;

  onDidStart(): void {
    const notified = new Set<number>();
    try {
      this.ports.subscribe((e) => {
        if (e.type === 'ports.detected') {
          if (notified.has(e.port)) return;
          notified.add(e.port);
          notification.info({
            message: `检测到服务 :${e.port}${e.process ? ` (${e.process})` : ''}`,
            btn: React.createElement(
              'button',
              {
                type: 'button',
                className: 'kt-button',
                onClick: () => {
                  const url = this.ports.proxyUrl(e.port)
                  window.open(url, '_blank', 'noopener')
                },
              },
              '打开应用',
            ),
            type: 'info',
            duration: 8,
          });
        }
        // closed 不打扰 (列表自动消失即可)
      });
      console.log('[ports] notifier 订阅就绪');
    } catch (err) {
      console.warn('[ports] notifier subscribe failed:', err);
    }
  }
}

@Injectable()
export class PortsExtensionModule extends BrowserModule {
  providers = [PortsContribution, PortsNotifierContribution];
  contributionProvider = [ComponentContribution, ClientAppContribution];
}
