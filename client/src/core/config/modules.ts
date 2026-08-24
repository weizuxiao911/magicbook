/**
 * 内置模块注册表 — core/config/modules.ts
 *
 * 框架级 builtin modules + 内置拓展 + service 实现模块（DI 注册 Token）.
 */

import { TerminalNextModule } from '@opensumi/ide-terminal-next/lib/browser';
import { TaskModule } from '@opensumi/ide-task/lib/browser';
import { ActionsModule } from '../../extensions/actions';
import { WelcomeModule } from '../../extensions/welcome';
import { ChatModule } from '../../extensions/chat';
import { LoginModule } from '../../extensions/login';
import { SandboxModule } from '../../service/sandbox';
import { AgentModule } from '../../service/agent';
import { RegistryModule } from '../../service/registry';
import { FileSystemModule } from '../../service/fs';
import { TerminalModule } from '../../service/terminal';
import { EnvModule } from '../../service/env';
import { AuthModule } from '../../service/auth';

export function getBuiltinModules(_opts?: { vsixMetadata?: any[] }): any[] {
  return [
    TerminalNextModule,
    TaskModule,
    // service 实现模块（注册 Token: ISandbox/IAgent/IRegistry/IFileSystem/ITerminalServicePath/IEnvService/IAuth）
    SandboxModule,
    AgentModule,
    RegistryModule,
    FileSystemModule,
    TerminalModule,
    EnvModule,
    AuthModule,
    // 内置拓展
    ActionsModule,
    WelcomeModule,
    ChatModule,
    LoginModule,
  ];
}