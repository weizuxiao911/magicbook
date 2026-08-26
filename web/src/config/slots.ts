import type { IAppRendererProps } from '@codeblitzjs/ide-core';
import { SlotLocation } from '@opensumi/ide-core-browser';

import { LayoutComponent } from './layout';

export type Slots = Pick<
  IAppRendererProps['appConfig'],
  'layoutComponent' | 'layoutConfig'
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
  };
}