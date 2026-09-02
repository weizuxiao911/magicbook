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
    // 不再强制 toggleSlot(left, true) — 之前为保证 left slot 展开, 但导致用户折叠后
    // 刷新页面又自动展开, 干扰用户. OpenSumi 框架自身把 layout state 持久化到 localStorage,
    // 不需要 numas 启动时强制覆盖.
  }
}

@Injectable()
export class ActionsModule extends BrowserModule {
  providers = [ActionsContribution, DefaultLayoutContribution];

  contributionProvider = [ComponentContribution, ClientAppContribution];
}
