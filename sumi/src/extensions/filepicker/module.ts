/**
 * filepicker 拓展入口 — web/src/extensions/filepicker/module.ts
 *
 * 通用服务器文件/目录选择器. 供 workspace (目录切换) / pdf (文件交互) 等复用.
 * 组件在 config/layout.tsx 挂载 (modal, 不占 slot).
 * 调用: requestFilePicker(config) from './FilePicker'
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

@Injectable()
export class FilePickerModule extends BrowserModule {
  providers = [];
}
