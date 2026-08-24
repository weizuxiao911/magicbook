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
    this.layoutService.toggleSlot(SlotLocation.left, true);
  }
}

@Injectable()
export class ActionsModule extends BrowserModule {
  providers = [ActionsContribution, DefaultLayoutContribution];

  contributionProvider = [ComponentContribution, ClientAppContribution];
}
