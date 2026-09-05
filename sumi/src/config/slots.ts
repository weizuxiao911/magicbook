import type { IAppRendererProps } from '@codeblitzjs/ide-core';
import { SlotLocation } from '@opensumi/ide-core-browser';

import { LayoutComponent } from '../layout';

export type Slots = Pick<
  IAppRendererProps['appConfig'],
  'layoutComponent' | 'layoutConfig' | 'defaultPanels'
>;

export function buildSlots(): Slots {
  return {
    layoutComponent: LayoutComponent,
    layoutConfig: {
      [SlotLocation.top]: {
        modules: [],
      },
      [SlotLocation.action]: {
        modules: []
      },
      [SlotLocation.left]: {
        modules: [
          '@opensumi/ide-explorer',
        ],
      },
      [SlotLocation.right]: {
        modules: [],
      },
      [SlotLocation.main]: {
        modules: [
          '@opensumi/ide-editor'
        ]
      },
      [SlotLocation.bottom]: {
        modules: [
          '@opensumi/ide-terminal-next',
          '@opensumi/ide-output',
          '@opensumi/ide-markers',
        ],
      },
      [SlotLocation.extra]: {
        modules: []
      },
    } as any,
    // 冷启动无持久化(wsdb 里 currentId === undefined)时, restoreTabbarService 消费的默认面板.
    // 用 module key (与上方 layoutConfig.modules 同源), framework 经 getComponentRegistryInfo
    // 解析成 containerId 'explorer'; 槽位扩展增减不影响. 用户折叠后 wsdb 存 currentId:'' ,
    // restore 走 '' 分支保持折叠, 不会被此默认值覆盖 (尊重用户操作).
    defaultPanels: {
      [SlotLocation.left]: '@opensumi/ide-explorer',
    },
  };
}