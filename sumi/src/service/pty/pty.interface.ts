/**
 * service/pty/pty.interface.ts
 *
 * pty 服务契约: 实现 codeblitz ITerminalNodeService (从 @opensumi/ide-terminal-next).
 * ITerminalNodeService 是 codeblitz 框架内 Terminal 跟 PTY 服务通信的标准接口.
 *
 * 不定义应用级 interface — 直接 codeblitz 契约, DI 容器把 RemoteTerminalService 注册成
 * codeblitz TerminalService 后端. 消费方通过 useInjectable(ITerminalService) 拿前端 client.
 */

export type {
  ITerminalNodeService,
  ITerminalServicePath,
  IShellLaunchConfig,
  IPtyProcessProxy,
  ITerminalServiceClient,
} from '@opensumi/ide-terminal-next/lib/common';