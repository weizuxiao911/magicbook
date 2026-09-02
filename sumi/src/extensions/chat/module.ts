import { Injectable } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { BrowserModule, SlotLocation } from '@opensumi/ide-core-browser';
import { ComponentContribution, ComponentRegistry } from '@opensumi/ide-core-browser/lib/layout';

import { Chat } from './webview/Chat';
import { getBrand } from './scheme';

@Injectable()
@Domain(ComponentContribution)
export class ChatContribution implements ComponentContribution {
  registerComponent(registry: ComponentRegistry): void {
    registry.register('chat-panel', {
      id: 'chat-panel',
      component: Chat,
    }, {
      containerId: 'chat-panel',
      iconClass: 'codicon codicon-sparkle',
      title: `${getBrand()?.name || 'AI'} 对话`,
    }, SlotLocation.right);
  }
}

@Injectable()
export class ChatModule extends BrowserModule {
  providers = [ChatContribution];

  contributionProvider = ComponentContribution;
}