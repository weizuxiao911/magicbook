/**
 * WorkspacePicker — 工作目录选择器 (web/src/extensions/workspace/WorkspacePicker)
 *
 * 薄适配层: 监听 workspace:request-show (chat 触发) → 打开通用 filepicker (mode:'directories'),
 * 选目录后调 IStateService.setCwd + reload (唯一工作目录变更入口, DI 单例).
 *
 * 事件链:
 *   [chat 输入框] --workspace:request-show--> [WorkspacePicker]
 *   [WorkspacePicker] --filepicker:request {mode:'directories'}--> [FilePicker]
 *   [FilePicker.onPick] --> [IStateService.setCwd] -> reload
 */

import React, { useEffect } from 'react';

import { effectiveCwd } from '../../infra/url';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { StateToken, type IStateService } from '../../service/state';
import { requestFilePicker } from '../filepicker/FilePicker';

export const WorkspacePicker: React.FC = () => {
  const state = useInjectable<IStateService>(StateToken);
  useEffect(() => {
    const h = () => {
      const cwd = effectiveCwd();
      requestFilePicker({
        mode: 'directories',
        initialPath: cwd || '/',
        onPick: (dir) => {
          // 唯一变更入口 (写 URL ?directory + APP_CWD + recent + 派 workspace:changed + reload)
          state.setWorkspace(dir.path);
        },
      });
    };
    window.addEventListener('workspace:request-show', h);
    return () => window.removeEventListener('workspace:request-show', h);
  }, [state]);

  return null;
};
