/**
 * service/pty/index.ts — 公共 API barrel
 *
 * 对外导出: codeblitz Terminal 接口类型 + DI module + impl + shell-ops helpers.
 * shell-ops (POSIX/PS/cmd 命令构造) 也对外暴露, 给 service/filesystem 用 (写文件走 PTY).
 */

export type {
  ITerminalNodeService,
  ITerminalServicePath,
  IShellLaunchConfig,
  IPtyProcessProxy,
  ITerminalServiceClient,
} from './pty.interface';

export {
  TerminalModule,
  RemoteTerminalService,
  wrapFsPtyCommand,
  pickFsPtyShell,
} from './pty.service';

export type { Platform, ShellKind, ShellOps } from './shell-ops';
export { detectPlatform, pickShellKind, getShellOps, pickShell, shellQuotePosix } from './shell-ops';