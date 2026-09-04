/**
 * 内置模块注册表 — core/config/modules.ts
 *
 * DI 注册: 框架级 builtin modules + 内置拓展 + service 实现模块 (各 {Name}Module).
 * 顺序: codeblitz 默认模块先 (TerminalNextModule / TaskModule), 我们 service 在中间,
 *       拓展 + FsProviderModule 最后 (FsProviderModule 要覆盖 codeblitz 默认 fs provider).
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
import { PortsExtensionModule } from '../extensions/ports';

import { AgentModule } from '../service/opencode';
import { ExtensionModule } from '../service/extension';
import { FsModule, FsProviderModule } from '../service/filesystem';
import { FileDocModule } from '../service/filesystem/doc-provider';
import { TerminalModule } from '../service/pty';
import { EditorModule } from '../service/editor';
import { StateModule } from '../service/state';
import { PortsModule } from '../service/ports';

import { EditorSessionModule } from '../contribution/editor-session';

export function getBuiltinModules(_opts?: { vsixMetadata?: any[] }): any[] {
  return [
    // codeblitz 默认 (Terminal / Task 等)
    TerminalNextModule,
    TaskModule,

    // service 层 (DI 单例)
    AgentModule,           // opencode AI 智能体能力
    ExtensionModule,       // vsix 拓展 (registry @ :7790)
    FsModule,              // 文件系统 (FilePicker IO)
    TerminalModule,        // 伪终端 (codeblitz 终端协议)
    EditorModule,          // 编辑器能力 (open / openWith)
    StateModule,           // codeblitz 状态 (workspace / recent)
    PortsModule,           // 本地服务端口发现 (面板 + 事件)

    // contribution 层 (lifecycle / UI 状态)
    EditorSessionModule,   // 编辑器 tab 持久化 (刷新后恢复)

    // 内置 UI 拓展
    ActionsModule,
    WelcomeModule,
    ChatModule,
    WorkspaceModule,
    FilePickerModule,
    PdfReaderModule,
    OpenTypeModule,
    PortsExtensionModule,  // 端口面板 (底部 tab, 服务发现提示)

    // 自定义 file scheme provider (覆盖 codeblitz 默认 DiskFileSystemProvider)
    // 放最后: codeblitz 默认 fsProviders 先就位, 我们 fsProviders.delete + registerProvider
    FsProviderModule,

    // file scheme 文档 provider (权重 30 > codeblitz 20): editor 读/保存改走主线程 FSC → HTTP
    FileDocModule,
  ];
}