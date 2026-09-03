import { Injectable, Autowired } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { BrowserModule, ClientAppContribution, SlotLocation } from '@opensumi/ide-core-browser';
import { ComponentContribution, ComponentRegistry } from '@opensumi/ide-core-browser/lib/layout';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';

import { ActionsView } from './ActionsView';

@Injectable()
@Domain(ComponentContribution)
export class ActionsContribution implements ComponentContribution {
  registerComponent(registry: ComponentRegistry): void {
    registry.register('actions', {
      id: 'actions',
      component: ActionsView,
    }, undefined, SlotLocation.top);
  }
}

@Injectable()
@Domain(ClientAppContribution)
export class DefaultLayoutContribution implements ClientAppContribution {
  @Autowired(IMainLayoutService)
  private readonly layoutService!: IMainLayoutService;

  onDidStart(): void {
    // 默认展开左侧资源管理器. 用户明确要求启动即展开 (即使有折叠持久化也强制).
    // 注: 早期移除了强制展开 (避免覆盖用户折叠), 现按需求恢复 — 左侧栏是主入口.
    try {
      this.layoutService.toggleSlot(SlotLocation.left, true);
    } catch { /* ignore */ }
  }
}

@Injectable()
export class ActionsModule extends BrowserModule {
  providers = [ActionsContribution, DefaultLayoutContribution];

  contributionProvider = [ComponentContribution, ClientAppContribution];
}
