/**
 * extensions/ports/module.ts — 端口面板
 *
 * 对标 VS Code 端口面板 (autoForwardPortsSource: "process"):
 *   - 底部新 tab「端口」: 默认空 (仿 VS Code "没有转动的端口...")
 *   - 服务启动自动提示: 由面板内 SSE 订阅触发 (面板未挂载时不弹通知, 避免猫叫声)
 *   - 打开 = 走 opencode 反代 /proxy/<port>/ (统一经 opencode, 未来远程/容器模式可用)
 *   - 手动添加端口 (扫描不到的服务) / 刷新
 *
 * VS Code 同款体验:
 *   - 默认面板空, 用户主动「转发端口」或终端启动服务后才出现
 *   - 面板未挂载 = 无通知 (panel-only subscription)
 *   - 名称备注 (Port Attributes 简化版) 由面板内联编辑, localStorage 持久化
 */

import { Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { BrowserModule, SlotLocation } from '@opensumi/ide-core-browser';
import { ComponentContribution, ComponentRegistry } from '@opensumi/ide-core-browser/lib/layout';

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

@Injectable()
export class PortsExtensionModule extends BrowserModule {
  providers = [PortsContribution];
  contributionProvider = [ComponentContribution];
}