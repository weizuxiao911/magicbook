/**
 * 内置模块注册表 — core/config/modules.ts
 *
 * 框架级 builtin modules + 内置拓展 + service 实现模块（DI 注册 Token）.
 */

import { TerminalNextModule } from '@opensumi/ide-terminal-next/lib/browser';
import { TaskModule } from '@opensumi/ide-task/lib/browser';
import { ActionsModule } from '../extensions/actions';
import { WelcomeModule } from '../extensions/welcome';
import { ChatModule } from '../extensions/chat';
import { WorkspaceModule } from '../extensions/workspace';
import { FilePickerModule } from '../extensions/filepicker';
import { PdfReaderModule } from '../extensions/pdf';
import { OpenTypeModule } from '../extensions/opentype';
import { AgentModule } from '../service/agent';
import { RegistryModule } from '../service/registry';
import { FileSystemModule } from '../service/fs';
import { TerminalModule } from '../service/terminal';
import { EnvModule } from '../service/env';
import { FsProviderModule } from './fs';

export function getBuiltinModules(_opts?: { vsixMetadata?: any[] }): any[] {
  return [
    TerminalNextModule,
    TaskModule,
    AgentModule,
    RegistryModule,
    FileSystemModule,
    TerminalModule,
    EnvModule,
    ActionsModule,
    WelcomeModule,
    ChatModule,
    WorkspaceModule,
    FilePickerModule,
    PdfReaderModule,
    OpenTypeModule,
    // 注册自定义 file scheme provider (覆盖 codeblitz 默认 DiskFileSystemProvider)
    // 放在最后, 确保 codeblitz 默认 fsProviders 先就位, 我们再 fsProviders.delete + registerProvider
    FsProviderModule,
  ];
}