import React from 'react';
import { SlotLocation, SlotRenderer } from '@opensumi/ide-core-browser';
import { BoxPanel, SplitPanel } from '@opensumi/ide-core-browser/lib/components';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';

import { WorkspacePicker } from '../extensions/workspace/WorkspacePicker';

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
      <WorkspacePicker />
    </React.Fragment>
  );
}