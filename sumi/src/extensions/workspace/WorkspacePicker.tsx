/**
 * WorkspacePicker — 工作目录选择器 (web/src/extensions/workspace/WorkspacePicker)
 *
 * 薄适配层: 监听 workspace:request-show (chat 触发) → 打开通用 filepicker (mode:'open' 只列子目录):
 * 单击目录=选中 (再点=取消), 双击=进入; 底部「打开」: 有选中 → 返回选中目录,
 * 无选中 → 返回当前浏览目录; 结果调 IStateService.setWorkspace + reload (唯一工作目录变更入口).
 *
 * 事件链:
 *   [chat 输入框] --workspace:request-show--> [WorkspacePicker]
 *   [WorkspacePicker] --filepicker:request {mode:'open'}--> [FilePicker]
 *   [FilePicker.onPick] --> [IStateService.setWorkspace] -> reload
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
        mode: 'open',
        initialPath: cwd || '/',
        onPick: (items) => {
          const dir = items[0];
          if (!dir) return;
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
