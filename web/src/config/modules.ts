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
// import { PdfReaderModule } from '../extensions/pdf';  // 内置 PDF 暂不启用, 改用 extensions/pdf vsix 走 registry 分发
import { HtmlModule } from '../extensions/html';
import { AgentModule } from '../service/agent';
import { RegistryModule } from '../service/registry';
import { FileSystemModule } from '../service/fs';
import { TerminalModule } from '../service/terminal';
import { EnvModule } from '../service/env';

export function getBuiltinModules(_opts?: { vsixMetadata?: any[] }): any[] {
  return [
    TerminalNextModule,
    TaskModule,
    // service 实现模块
    AgentModule,
    RegistryModule,
    FileSystemModule,
    TerminalModule,
    EnvModule,
    // 内置拓展
    ActionsModule,
    WelcomeModule,
    ChatModule,
    WorkspaceModule,
    // PdfReaderModule,  // 内置 PDF 不启用, registry/vsix/numas.pdf-0.1.0.vsix 替代
    HtmlModule,
  ];
}