/**
 * WorkspacePicker — 工作目录选择器 (web/src/extensions/workspace/WorkspacePicker)
 *
 * 薄适配层: 监听 workspace:request-show (chat 触发) → 打开通用 filepicker (mode:'directories'),
 * 选目录后 setCwd + reload (唯一工作目录变更入口).
 *
 * 事件链:
 *   [chat 输入框] --workspace:request-show--> [WorkspacePicker]
 *   [WorkspacePicker] --filepicker:request {mode:'directories'}--> [FilePicker]
 *   [FilePicker.onPick] --setCwd()--> [service/workspace] --reload-->
 */

import React, { useEffect } from 'react';

import { effectiveCwd } from '../../service/env';
import { setCwd } from '../../service/env';
import { requestFilePicker } from '../filepicker/FilePicker';

export const WorkspacePicker: React.FC = () => {
  useEffect(() => {
    const h = () => {
      // 打开目录选择器 (复用 filepicker, 仅目录模式); 初始路径 = 当前工作目录
      // 注意: 不传 root — workspace 需要能切到任意目录 (含上级)
      const cwd = effectiveCwd();
      requestFilePicker({
        mode: 'directories',
        initialPath: cwd || '/',
        onPick: (dir) => {
          // 唯一变更入口 (写 APP_CWD + recent + 派 workspace:changed + reload)
          setCwd(dir.path);
        },
      });
    };
    window.addEventListener('workspace:request-show', h);
    return () => window.removeEventListener('workspace:request-show', h);
  }, []);

  return null;
};
